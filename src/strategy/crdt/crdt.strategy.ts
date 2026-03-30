import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { SyncStrategy, LockResult, LockRefreshResult, IngestResult, OpResult } from '../strategy.interface';
import { OpLogEntry } from './op-log.entity';
import { ScheduleSnapshot } from './snapshot.entity';
import { InvariantValidator } from '../../invariants/invariant-validator.service';
import { AutoTransformService } from '../../auto-transform/auto-transform.service';
import { ScheduleSlot } from '../../schedule/schedule-slot.entity';
import { normalizeSchedule } from './merge-policy';
import { createHash } from 'crypto';

/**
 * CRDTStrategy (Optional) — operation log + deterministic merge.
 *
 * Merge semantics (v2 — priority-aware normalization):
 *
 *   1. All valid operations are appended to the op log (append-only, immutable).
 *   2. State is derived deterministically by replaying ops sorted by
 *      (lamport_ts ASC, operation_id ASC) from the latest snapshot.
 *   3. After raw replay, `normalizeSchedule()` resolves intra-group overlaps
 *      using priority-aware conflict resolution:
 *        - higher priority slot keeps its time position;
 *        - lower priority slot shifts forward (duration preserved);
 *        - equal priority tie-break: earlier start_time, then lower slot_id.
 *   4. Normalization is a pure function — no side effects, no log writes.
 *      This guarantees that any node replaying the same op set converges
 *      to the identical materialized state.
 *   5. Snapshots store RAW (pre-normalization) state so that incremental
 *      replay from a snapshot + normalization equals full replay + normalization.
 */
@Injectable()
export class CRDTStrategy implements SyncStrategy {
  private readonly logger = new Logger(CRDTStrategy.name);

  constructor(
    @InjectRepository(OpLogEntry) private opLogRepo: Repository<OpLogEntry>,
    @InjectRepository(ScheduleSnapshot) private snapshotRepo: Repository<ScheduleSnapshot>,
    @InjectRepository(ScheduleSlot) private slotRepo: Repository<ScheduleSlot>,
    private readonly invariantValidator: InvariantValidator,
    private readonly autoTransform: AutoTransformService,
  ) {}

  async acquireLock(): Promise<LockResult> {
    return { acquired: true, lock_token: 'crdt-no-lock' };
  }

  async releaseLock(): Promise<boolean> {
    return true;
  }

  async refreshLock(_scheduleId: string, _lockToken: string, _ttlSeconds: number): Promise<LockRefreshResult> {
    return {
      refreshed: true,
      lock_token: 'crdt-no-lock',
    };
  }

  async saveSlots(scheduleId: string, slots: any[]): Promise<void> {
    this.logger.warn('Direct saveSlots in CRDT mode — converting to add_slot ops');
    const ops = slots.map(slot => ({
      op_type: 'add_slot',
      causal: {
        operation_id: `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        client_id: 'server',
        lamport_ts: Date.now(),
      },
      slot,
    }));
    await this.ingestOps(scheduleId, ops);
  }

  // ---------------------------------------------------------------------------
  // ingestOps — append to log, materialize with normalization, validate
  // ---------------------------------------------------------------------------

  async ingestOps(scheduleId: string, ops: any[]): Promise<IngestResult> {
    const results: OpResult[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const op of ops) {
      try {
        // 1. Append to op log (immutable, append-only)
        const entry = this.opLogRepo.create({
          schedule_id: scheduleId,
          operation_id: op.causal?.operation_id,
          op_type: op.op_type,
          client_id: op.causal?.client_id,
          user_id: op.actor?.user_id || op.causal?.user_id,
          device_id: op.actor?.device_id || op.causal?.device_id,
          lamport_ts: op.causal?.lamport_ts || Date.now(),
          vector_clock: op.causal?.vector_clock || {},
          parent_op_id: op.causal?.parent_op_id,
          session_id: op.causal?.session_id,
          slot_data: op.slot,
          params: op.params || {},
          signature: op.signature?.signature,
          key_id: op.signature?.key_id,
        });
        try {
          await this.opLogRepo.save(entry);
        } catch (saveErr: any) {
          if (saveErr?.code === '23505' || saveErr?.message?.includes('duplicate key')) {
            results.push({ operation_id: op.causal?.operation_id, accepted: true, reason: 'already_applied' });
            accepted++;
            continue;
          }
          throw saveErr;
        }

        // 2. Materialize with normalization (pure, deterministic)
        const currentSlots = await this.materialize(scheduleId);

        // 3. Post-normalization validation — should find zero violations.
        //    Acts as a safety assertion, not a control flow gate.
        const violations = this.invariantValidator.validate(currentSlots);

        if (violations.length > 0) {
          // Normalization should have resolved all overlaps and clamped priorities.
          // If we still see violations, log an error but do NOT reject the op —
          // the op itself is valid; the violation is a normalization gap.
          this.logger.error(
            `Post-normalization violations (unexpected): ${JSON.stringify(violations)}`,
          );
        }

        results.push({ operation_id: op.causal?.operation_id, accepted: true });
        accepted++;
      } catch (err) {
        this.logger.error(`Op ingest failed: ${(err as Error).message}`, (err as Error).stack);
        results.push({
          operation_id: op.causal?.operation_id,
          accepted: false,
          reason: `Internal error: ${(err as Error).message}`,
        });
        rejected++;
      }
    }

    await this.maybeCompact(scheduleId);
    return { accepted, rejected, results };
  }

  // ---------------------------------------------------------------------------
  // Snapshot / delta
  // ---------------------------------------------------------------------------

  async getSnapshot(scheduleId: string, afterOpId?: string) {
    const slots = await this.materialize(scheduleId);
    const latestSnapshot = await this.snapshotRepo.findOne({
      where: { schedule_id: scheduleId },
      order: { epoch: 'DESC' },
    });
    const lastOp = await this.opLogRepo.findOne({
      where: { schedule_id: scheduleId, is_tombstone: false },
      order: { lamport_ts: 'DESC', operation_id: 'DESC' },
    });

    const result: Record<string, any> = {
      schedule_id: scheduleId,
      epoch: latestSnapshot?.epoch || 0,
      slots,
      snapshot_hash: this.hashSlots(slots),
      last_operation_id: lastOp?.operation_id ?? null,
    };

    if (afterOpId) {
      const missingOps = await this.getOpsAfter(scheduleId, afterOpId);
      if (missingOps !== null && missingOps.length <= 50) {
        result.missing_ops = missingOps.map(o => ({
          op_type: o.op_type,
          operation_id: o.operation_id,
          slot_data: o.slot_data,
          lamport_ts: o.lamport_ts,
          client_id: o.client_id,
        }));
      }
    }

    return result;
  }

  async getOpsAfter(scheduleId: string, afterOperationId: string, limit = 51): Promise<OpLogEntry[] | null> {
    const referenceOp = await this.opLogRepo.findOne({
      where: { schedule_id: scheduleId, operation_id: afterOperationId },
    });
    if (!referenceOp) return null;

    const ops = await this.opLogRepo.find({
      where: {
        schedule_id: scheduleId,
        is_tombstone: false,
        lamport_ts: MoreThanOrEqual(referenceOp.lamport_ts),
      },
      order: { lamport_ts: 'ASC', operation_id: 'ASC' },
      take: limit,
    });

    return ops.filter(o => {
      if (Number(o.lamport_ts) === Number(referenceOp.lamport_ts)) {
        return o.operation_id > afterOperationId;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Materialization
  // ---------------------------------------------------------------------------

  /**
   * Raw replay — LWW per slot_id, no normalization.
   * Used for snapshot storage (snapshots must store raw state so that
   * incremental replay + normalization ≡ full replay + normalization).
   */
  private async replayRaw(scheduleId: string): Promise<any[]> {
    const snapshot = await this.snapshotRepo.findOne({
      where: { schedule_id: scheduleId },
      order: { epoch: 'DESC' },
    });

    const state: Map<string, any> = new Map();
    if (snapshot) {
      for (const slot of snapshot.slots) {
        state.set(slot.slot_id, slot);
      }
    }

    const ops = await this.opLogRepo.find({
      where: { schedule_id: scheduleId, is_tombstone: false },
      order: { lamport_ts: 'ASC', operation_id: 'ASC' },
    });

    const afterEpoch = snapshot?.epoch || 0;
    const relevant = ops.filter(o => o.epoch >= afterEpoch);

    for (const op of relevant) {
      switch (op.op_type) {
        case 'add_slot':
          state.set(op.slot_data.slot_id, op.slot_data);
          break;
        case 'remove_slot':
          state.delete(op.slot_data.slot_id);
          break;
        case 'update_slot':
          if (state.has(op.slot_data.slot_id)) {
            state.set(op.slot_data.slot_id, { ...state.get(op.slot_data.slot_id), ...op.slot_data });
          }
          break;
        case 'move_slot':
          if (state.has(op.slot_data.slot_id)) {
            state.set(op.slot_data.slot_id, {
              ...state.get(op.slot_data.slot_id),
              start_time: op.slot_data.start_time,
              end_time: op.slot_data.end_time,
            });
          }
          break;
      }
    }

    return Array.from(state.values());
  }

  /**
   * Materialize — raw replay + deterministic normalization.
   * Returns the canonical, conflict-resolved schedule state.
   */
  private async materialize(scheduleId: string): Promise<any[]> {
    const rawSlots = await this.replayRaw(scheduleId);
    const { slots } = normalizeSchedule(rawSlots);
    return slots;
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  private async maybeCompact(scheduleId: string): Promise<void> {
    const opCount = await this.opLogRepo.count({
      where: { schedule_id: scheduleId, is_tombstone: false },
    });
    const COMPACTION_THRESHOLD = parseInt(process.env.CRDT_COMPACTION_THRESHOLD || '100', 10);

    if (opCount >= COMPACTION_THRESHOLD) {
      // Snapshot stores RAW state — normalization is applied at read time
      const rawSlots = await this.replayRaw(scheduleId);
      const latestSnapshot = await this.snapshotRepo.findOne({
        where: { schedule_id: scheduleId },
        order: { epoch: 'DESC' },
      });
      const lastOp = await this.opLogRepo.findOne({
        where: { schedule_id: scheduleId, is_tombstone: false },
        order: { lamport_ts: 'DESC', operation_id: 'DESC' },
      });
      const newEpoch = (latestSnapshot?.epoch || 0) + 1;

      await this.snapshotRepo.save(this.snapshotRepo.create({
        schedule_id: scheduleId,
        epoch: newEpoch,
        slots: rawSlots,
        snapshot_hash: this.hashSlots(rawSlots),
        last_operation_id: lastOp?.operation_id ?? null,
      }));

      this.logger.log(`Compacted schedule=${scheduleId} epoch=${newEpoch} ops=${opCount}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private hashSlots(slots: any[]): string {
    const sorted = [...slots].sort((a, b) => (a.slot_id ?? '').localeCompare(b.slot_id ?? ''));
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  }
}
