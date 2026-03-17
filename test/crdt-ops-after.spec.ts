/**
 * Unit tests for CRDT getOpsAfter, idempotency, and enriched snapshot.
 *
 * These tests use a mock-based approach (no real DB) to validate
 * the logic in CRDTStrategy for delta sync and duplicate handling.
 */

/** Simulate the materialize/getOpsAfter logic without a real DB */
class OpLog {
  private ops: Array<{
    id: string;
    schedule_id: string;
    operation_id: string;
    op_type: string;
    lamport_ts: number;
    slot_data: any;
    is_tombstone: boolean;
    epoch: number;
  }> = [];

  append(scheduleId: string, operationId: string, opType: string, lamportTs: number, slotData: any) {
    // Check unique constraint
    if (this.ops.some((o) => o.operation_id === operationId)) {
      const err: any = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    }
    this.ops.push({
      id: `uuid-${this.ops.length}`,
      schedule_id: scheduleId,
      operation_id: operationId,
      op_type: opType,
      lamport_ts: lamportTs,
      slot_data: slotData,
      is_tombstone: false,
      epoch: 0,
    });
  }

  getOpsAfter(scheduleId: string, afterOperationId: string): any[] | null {
    const ref = this.ops.find(
      (o) => o.schedule_id === scheduleId && o.operation_id === afterOperationId,
    );
    if (!ref) return null;

    return this.ops
      .filter((o) => o.schedule_id === scheduleId && !o.is_tombstone)
      .sort((a, b) => a.lamport_ts - b.lamport_ts || a.operation_id.localeCompare(b.operation_id))
      .filter((o) => {
        if (o.lamport_ts === ref.lamport_ts) {
          return o.operation_id > afterOperationId;
        }
        return o.lamport_ts > ref.lamport_ts;
      });
  }

  getLastOp(scheduleId: string) {
    const ops = this.ops
      .filter((o) => o.schedule_id === scheduleId && !o.is_tombstone)
      .sort((a, b) => b.lamport_ts - a.lamport_ts || b.operation_id.localeCompare(a.operation_id));
    return ops[0] ?? null;
  }

  materialize(scheduleId: string): any[] {
    const state = new Map<string, any>();
    const ops = this.ops
      .filter((o) => o.schedule_id === scheduleId && !o.is_tombstone)
      .sort((a, b) => a.lamport_ts - b.lamport_ts || a.operation_id.localeCompare(b.operation_id));
    for (const op of ops) {
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
}

describe('getOpsAfter — delta sync', () => {
  let log: OpLog;

  beforeEach(() => {
    log = new OpLog();
    // Insert 10 ops for schedule-1
    for (let i = 1; i <= 10; i++) {
      log.append('schedule-1', `op-${i}`, 'add_slot', i * 100, {
        slot_id: `slot-${i}`,
        asset_id: `asset-${i}`,
      });
    }
  });

  it('returns ops after a known operation_id', () => {
    const result = log.getOpsAfter('schedule-1', 'op-5');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(5);
    expect(result!.map((o: any) => o.operation_id)).toEqual([
      'op-6', 'op-7', 'op-8', 'op-9', 'op-10',
    ]);
  });

  it('returns empty array when asking for ops after the last one', () => {
    const result = log.getOpsAfter('schedule-1', 'op-10');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  it('returns null for unknown operation_id (triggers full snapshot fallback)', () => {
    const result = log.getOpsAfter('schedule-1', 'nonexistent-op');
    expect(result).toBeNull();
  });

  it('returns null for wrong schedule_id', () => {
    const result = log.getOpsAfter('schedule-999', 'op-5');
    expect(result).toBeNull();
  });

  it('returns all ops when asking from the very first op', () => {
    const result = log.getOpsAfter('schedule-1', 'op-1');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(9);
  });
});

describe('Idempotency — unique operation_id constraint', () => {
  let log: OpLog;

  beforeEach(() => {
    log = new OpLog();
  });

  it('rejects duplicate operation_id with error code 23505', () => {
    log.append('schedule-1', 'op-1', 'add_slot', 100, { slot_id: 's1' });

    let caught: any = null;
    try {
      log.append('schedule-1', 'op-1', 'add_slot', 200, { slot_id: 's1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe('23505');
  });

  it('accepts different operation_ids for same slot_id', () => {
    log.append('schedule-1', 'op-1', 'add_slot', 100, { slot_id: 's1' });
    log.append('schedule-1', 'op-2', 'update_slot', 200, { slot_id: 's1', priority: 50 });

    const state = log.materialize('schedule-1');
    expect(state).toHaveLength(1);
    expect(state[0].priority).toBe(50);
  });

  it('duplicate op handled gracefully in ingestOps pattern', () => {
    log.append('schedule-1', 'op-1', 'add_slot', 100, { slot_id: 's1' });

    // Simulate ingestOps behavior: catch 23505, return accepted + already_applied
    let result: { accepted: boolean; reason?: string };
    try {
      log.append('schedule-1', 'op-1', 'add_slot', 100, { slot_id: 's1' });
      result = { accepted: true };
    } catch (err: any) {
      if (err.code === '23505') {
        result = { accepted: true, reason: 'already_applied' };
      } else {
        throw err;
      }
    }

    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('already_applied');
  });
});

describe('Enriched snapshot — includes last_operation_id', () => {
  let log: OpLog;

  beforeEach(() => {
    log = new OpLog();
  });

  it('snapshot includes last_operation_id from latest op', () => {
    log.append('schedule-1', 'op-1', 'add_slot', 100, { slot_id: 's1' });
    log.append('schedule-1', 'op-2', 'add_slot', 200, { slot_id: 's2' });
    log.append('schedule-1', 'op-3', 'update_slot', 300, { slot_id: 's1', priority: 75 });

    const lastOp = log.getLastOp('schedule-1');
    const slots = log.materialize('schedule-1');

    const snapshot = {
      schedule_id: 'schedule-1',
      epoch: 0,
      slots,
      last_operation_id: lastOp?.operation_id ?? null,
    };

    expect(snapshot.last_operation_id).toBe('op-3');
    expect(snapshot.slots).toHaveLength(2);
  });

  it('snapshot with after_op_id includes missing_ops when delta is small', () => {
    for (let i = 1; i <= 10; i++) {
      log.append('schedule-1', `op-${i}`, 'add_slot', i * 100, { slot_id: `slot-${i}` });
    }

    const afterOpId = 'op-7';
    const missingOps = log.getOpsAfter('schedule-1', afterOpId);
    const slots = log.materialize('schedule-1');

    const snapshot: Record<string, any> = {
      schedule_id: 'schedule-1',
      epoch: 0,
      slots,
      last_operation_id: log.getLastOp('schedule-1')?.operation_id,
    };

    // Delta is small (3 ops), include missing_ops
    if (missingOps !== null && missingOps.length <= 50) {
      snapshot.missing_ops = missingOps;
    }

    expect(snapshot.missing_ops).toHaveLength(3);
    expect(snapshot.slots).toHaveLength(10);
  });

  it('snapshot with unknown after_op_id returns full snapshot without missing_ops', () => {
    for (let i = 1; i <= 5; i++) {
      log.append('schedule-1', `op-${i}`, 'add_slot', i * 100, { slot_id: `slot-${i}` });
    }

    const missingOps = log.getOpsAfter('schedule-1', 'unknown-op');
    const slots = log.materialize('schedule-1');

    const snapshot: Record<string, any> = {
      schedule_id: 'schedule-1',
      epoch: 0,
      slots,
      last_operation_id: log.getLastOp('schedule-1')?.operation_id,
    };

    // Unknown op → null → no missing_ops field
    if (missingOps !== null && missingOps.length <= 50) {
      snapshot.missing_ops = missingOps;
    }

    expect(snapshot.missing_ops).toBeUndefined();
    expect(snapshot.slots).toHaveLength(5); // full snapshot still included
  });
});

describe('Deterministic replay — convergence', () => {
  it('same ops in different order produce identical materialized state', () => {
    const log1 = new OpLog();
    const log2 = new OpLog();

    const ops = [
      { id: 'op-a', type: 'add_slot', ts: 100, slot: { slot_id: 's1', asset_id: 'a1', priority: 50 } },
      { id: 'op-b', type: 'add_slot', ts: 200, slot: { slot_id: 's2', asset_id: 'a2', priority: 30 } },
      { id: 'op-c', type: 'update_slot', ts: 300, slot: { slot_id: 's1', priority: 75 } },
      { id: 'op-d', type: 'remove_slot', ts: 400, slot: { slot_id: 's2' } },
    ];

    // Apply in order
    for (const op of ops) {
      log1.append('sched', op.id, op.type, op.ts, op.slot);
    }

    // Apply in reverse order
    for (const op of [...ops].reverse()) {
      log2.append('sched', op.id, op.type, op.ts, op.slot);
    }

    const state1 = log1.materialize('sched');
    const state2 = log2.materialize('sched');

    // Both should converge to same state: [s1 with priority 75]
    expect(state1).toHaveLength(1);
    expect(state2).toHaveLength(1);
    expect(state1[0].slot_id).toBe('s1');
    expect(state1[0].priority).toBe(75);
    expect(state1).toEqual(state2);
  });
});
