import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncStrategy, LockResult, IngestResult, OpResult } from '../strategy.interface';
import { OpLogEntry } from './op-log.entity';
import { ScheduleSnapshot } from './snapshot.entity';
import { InvariantValidator } from '../../invariants/invariant-validator.service';
import { AutoTransformService } from '../../auto-transform/auto-transform.service';
import { ScheduleSlot } from '../../schedule/schedule-slot.entity';
import { createHash } from 'crypto';

/**
 * CRDTStrategy (Optional) — operation log + deterministic merge.
 * Maps to L3A diagram: CRDTStrategy (Optional) component.
 *
 * Flow: append ops -> validate invariants -> auto-transform if needed -> snapshot/compaction.
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
    // CRDT mode: no locking needed
    return { acquired: true, lock_token: 'crdt-no-lock' };
  }

  async releaseLock(): Promise<boolean> {
    return true; // no-op
  }

  async saveSlots(scheduleId: string, slots: any[]): Promise<void> {
    // In CRDT mode, direct save is converted to ops internally
    this.logger.warn('Direct saveSlots in CRDT mode — converting to add_slot ops');
    const ops = slots.map(slot => ({
      op_type: 'add_slot',
      causal: { operation_id: `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`, client_id: 'server', lamport_ts: Date.now() },
      slot,
    }));
    await this.ingestOps(scheduleId, ops);
  }

  async ingestOps(scheduleId: string, ops: any[]): Promise<IngestResult> {
    const results: OpResult[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const op of ops) {
      try {
        // 1. Append to op log
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
        await this.opLogRepo.save(entry);

        // 2. Materialize current state
        const currentSlots = await this.materialize(scheduleId);

        // 3. Validate invariants
        const violations = this.invariantValidator.validate(currentSlots);

        if (violations.length > 0) {
          // 4. Attempt auto-transform (split/shift/priority)
          const fixes = this.autoTransform.fix(currentSlots, violations);

          if (fixes.compensating_ops.length > 0) {
            // Apply compensating ops
            for (const fixOp of fixes.compensating_ops) {
              const fixEntry = this.opLogRepo.create({
                schedule_id: scheduleId,
                operation_id: `autofix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                op_type: fixOp.op_type,
                client_id: 'system:auto-transform',
                lamport_ts: Date.now(),
                slot_data: fixOp.slot,
                params: { reason: fixOp.explanation },
              });
              await this.opLogRepo.save(fixEntry);
            }

            results.push({
              operation_id: op.causal?.operation_id,
              accepted: true,
              compensating_ops: fixes.compensating_ops,
              explanation: fixes.explanation,
            });
            accepted++;
          } else {
            // Cannot fix — reject
            results.push({
              operation_id: op.causal?.operation_id,
              accepted: false,
              reason: `Invariant violations: ${violations.map(v => v.message).join('; ')}`,
            });
            rejected++;
            // Remove the appended op (mark as tombstone)
            await this.opLogRepo.update({ operation_id: op.causal?.operation_id }, { is_tombstone: true });
          }
        } else {
          results.push({ operation_id: op.causal?.operation_id, accepted: true });
          accepted++;
        }
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

    // 5. Check if compaction needed
    await this.maybeCompact(scheduleId);

    return { accepted, rejected, results };
  }

  async getSnapshot(scheduleId: string) {
    const slots = await this.materialize(scheduleId);
    const latestSnapshot = await this.snapshotRepo.findOne({
      where: { schedule_id: scheduleId },
      order: { epoch: 'DESC' },
    });

    return {
      schedule_id: scheduleId,
      epoch: latestSnapshot?.epoch || 0,
      slots,
      snapshot_hash: this.hashSlots(slots),
    };
  }

  /** Replay op log to get current materialized state */
  private async materialize(scheduleId: string): Promise<any[]> {
    // Get latest snapshot as base
    const snapshot = await this.snapshotRepo.findOne({
      where: { schedule_id: scheduleId },
      order: { epoch: 'DESC' },
    });

    let state: Map<string, any> = new Map();
    if (snapshot) {
      for (const slot of snapshot.slots) {
        state.set(slot.slot_id, slot);
      }
    }

    // Replay ops after snapshot, sorted by lamport_ts then operation_id for determinism
    const ops = await this.opLogRepo.find({
      where: { schedule_id: scheduleId, is_tombstone: false },
      order: { lamport_ts: 'ASC', operation_id: 'ASC' },
    });

    const afterEpoch = snapshot?.epoch || 0;
    // Filter ops that belong to current or later epoch (vector_clock aware ordering)
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
            state.set(op.slot_data.slot_id, { ...state.get(op.slot_data.slot_id), start_time: op.slot_data.start_time, end_time: op.slot_data.end_time });
          }
          break;
      }
    }

    return Array.from(state.values());
  }

  /** Periodic compaction: create snapshot + advance epoch */
  private async maybeCompact(scheduleId: string): Promise<void> {
    const opCount = await this.opLogRepo.count({ where: { schedule_id: scheduleId, is_tombstone: false } });
    const COMPACTION_THRESHOLD = parseInt(process.env.CRDT_COMPACTION_THRESHOLD || '100', 10);

    if (opCount >= COMPACTION_THRESHOLD) {
      const slots = await this.materialize(scheduleId);
      const latestSnapshot = await this.snapshotRepo.findOne({
        where: { schedule_id: scheduleId },
        order: { epoch: 'DESC' },
      });
      const newEpoch = (latestSnapshot?.epoch || 0) + 1;

      await this.snapshotRepo.save(this.snapshotRepo.create({
        schedule_id: scheduleId,
        epoch: newEpoch,
        slots,
        snapshot_hash: this.hashSlots(slots),
      }));

      this.logger.log(`Compacted schedule=${scheduleId} epoch=${newEpoch} ops=${opCount}`);
    }
  }

  private hashSlots(slots: any[]): string {
    return createHash('sha256').update(JSON.stringify(slots)).digest('hex');
  }
}
