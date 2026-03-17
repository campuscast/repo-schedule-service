import * as fc from 'fast-check';
import { InvariantValidator } from '../../src/invariants/invariant-validator.service';
import { AutoTransformService } from '../../src/auto-transform/auto-transform.service';
import { normalizeSchedule } from '../../src/strategy/crdt/merge-policy';

const validator = new InvariantValidator();
const autoTransform = new AutoTransformService();

/** Helper: apply ops to a Map-based state (mirrors crdt.strategy materialize) */
function applyOps(ops: { op_type: string; slot: any }[]): any[] {
  const state = new Map<string, any>();
  for (const op of ops) {
    switch (op.op_type) {
      case 'add_slot':
        state.set(op.slot.slot_id, { ...op.slot });
        break;
      case 'remove_slot':
        state.delete(op.slot.slot_id);
        break;
      case 'update_slot':
        if (state.has(op.slot.slot_id)) {
          state.set(op.slot.slot_id, { ...state.get(op.slot.slot_id), ...op.slot });
        }
        break;
      case 'move_slot':
        if (state.has(op.slot.slot_id)) {
          state.set(op.slot.slot_id, {
            ...state.get(op.slot.slot_id),
            start_time: op.slot.start_time,
            end_time: op.slot.end_time,
          });
        }
        break;
    }
  }
  return Array.from(state.values());
}

/** Arbitrary: generate a slot with ISO timestamps */
const slotArb = fc.record({
  slot_id: fc.uuid(),
  zone_id: fc.constant('zone-1'),
  group_id: fc.constant('group-1'),
  start: fc.integer({ min: 0, max: 86400000 }),
  duration: fc.integer({ min: 60000, max: 3600000 }),
  priority: fc.integer({ min: -10, max: 110 }),
}).map(({ slot_id, zone_id, group_id, start, duration, priority }) => ({
  slot_id,
  zone_id,
  group_id,
  start_time: new Date(start).toISOString(),
  end_time: new Date(start + duration).toISOString(),
  priority,
}));

describe('CRDT Convergence (Property-Based)', () => {
  it('should converge to same state regardless of op order (commutative add)', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb, { minLength: 2, maxLength: 15 }),
        (slots) => {
          const ops = slots.map(slot => ({ op_type: 'add_slot', slot }));

          // Apply in original order
          const state1 = applyOps(ops);
          // Apply in reversed order
          const state2 = applyOps([...ops].reverse());

          const sorted1 = state1.sort((a, b) => a.slot_id.localeCompare(b.slot_id));
          const sorted2 = state2.sort((a, b) => a.slot_id.localeCompare(b.slot_id));

          expect(sorted1).toEqual(sorted2);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('add then remove then re-add restores the slot', () => {
    fc.assert(
      fc.property(
        slotArb,
        (slot) => {
          const ops = [
            { op_type: 'add_slot', slot },
            { op_type: 'remove_slot', slot: { slot_id: slot.slot_id } },
            { op_type: 'add_slot', slot },
          ];
          const state = applyOps(ops);
          expect(state.length).toBe(1);
          expect(state[0].slot_id).toBe(slot.slot_id);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should detect all overlapping slots in same group+zone', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50000000 }),
        fc.integer({ min: 1000, max: 3600000 }),
        (startMs, duration) => {
          const slotA = {
            slot_id: 'a', zone_id: 'z1', group_id: 'g1',
            start_time: new Date(startMs).toISOString(),
            end_time: new Date(startMs + duration).toISOString(),
            priority: 50,
          };
          const slotB = {
            slot_id: 'b', zone_id: 'z1', group_id: 'g1',
            start_time: new Date(startMs + Math.floor(duration / 2)).toISOString(),
            end_time: new Date(startMs + duration + Math.floor(duration / 2)).toISOString(),
            priority: 50,
          };
          const violations = validator.validate([slotA, slotB]);
          expect(violations.some(v => v.code === 'SLOT_OVERLAP')).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('non-overlapping sequential slots produce zero overlap violations', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 10 }),
        (durations) => {
          let cursor = 0;
          const slots = durations.map((dur, i) => {
            const start = cursor;
            cursor += dur * 60000;
            return {
              slot_id: `slot-${i}`, zone_id: 'z1', group_id: 'g1',
              start_time: new Date(start).toISOString(),
              end_time: new Date(cursor).toISOString(),
              priority: 50,
            };
          });
          const violations = validator.validate(slots);
          expect(violations.filter(v => v.code === 'SLOT_OVERLAP').length).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should detect out-of-range priorities (negative)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: -1 }),
        (badPriority) => {
          const slot = {
            slot_id: 'neg', zone_id: 'z1', group_id: 'g1',
            start_time: new Date(0).toISOString(),
            end_time: new Date(3600000).toISOString(),
            priority: badPriority,
          };
          expect(validator.validate([slot]).some(v => v.code === 'INVALID_PRIORITY')).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('should detect out-of-range priorities (>100)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 101, max: 1000 }),
        (badPriority) => {
          const slot = {
            slot_id: 'high', zone_id: 'z1', group_id: 'g1',
            start_time: new Date(0).toISOString(),
            end_time: new Date(3600000).toISOString(),
            priority: badPriority,
          };
          expect(validator.validate([slot]).some(v => v.code === 'INVALID_PRIORITY')).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('auto-transform always clamps priorities to [0,100]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -500, max: 500 }),
        (priority) => {
          const slot = {
            slot_id: 'test', zone_id: 'z1', group_id: 'g1',
            start_time: new Date(0).toISOString(),
            end_time: new Date(3600000).toISOString(),
            priority,
          };
          const violations = validator.validate([slot]);
          if (violations.length === 0) return;

          const fixes = autoTransform.fix([slot], violations);
          const fixedSlot = { ...slot };
          for (const fix of fixes.compensating_ops) {
            if (fix.op_type === 'update_slot') Object.assign(fixedSlot, fix.slot);
          }
          const recheck = validator.validate([fixedSlot]);
          expect(recheck.filter(v => v.code === 'INVALID_PRIORITY').length).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('auto-transform for overlaps shifts slot B after slot A', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50000000 }),
        fc.integer({ min: 60000, max: 3600000 }),
        fc.integer({ min: 1, max: 3599999 }),
        (startMs, duration, overlapAmount) => {
          const overlap = Math.min(overlapAmount, duration - 1);
          const slotA = {
            slot_id: 'a', zone_id: 'z1', group_id: 'g1',
            start_time: new Date(startMs).toISOString(),
            end_time: new Date(startMs + duration).toISOString(),
            priority: 50,
          };
          const slotB = {
            slot_id: 'b', zone_id: 'z1', group_id: 'g1',
            start_time: new Date(startMs + duration - overlap).toISOString(),
            end_time: new Date(startMs + duration - overlap + duration).toISOString(),
            priority: 50,
          };

          const violations = validator.validate([slotA, slotB]);
          if (violations.length === 0) return;

          const fixes = autoTransform.fix([slotA, slotB], violations);
          expect(fixes.compensating_ops.length).toBeGreaterThan(0);

          const fixedB = { ...slotB };
          for (const fix of fixes.compensating_ops) {
            if (fix.op_type === 'move_slot' && fix.slot.slot_id === 'b') {
              fixedB.start_time = fix.slot.start_time;
              fixedB.end_time = fix.slot.end_time;
            }
          }
          const recheck = validator.validate([slotA, fixedB]);
          expect(recheck.filter(v => v.code === 'SLOT_OVERLAP').length).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ============================================================================
// Merge-policy-aware convergence tests (v2)
//
// These use timestamp-ordered replay — mirrors CRDTStrategy.replayRaw which
// sorts ops by (lamport_ts ASC, operation_id ASC) before applying.
// ============================================================================

interface TimedOp {
  op_type: string;
  operation_id: string;
  lamport_ts: number;
  slot: any;
}

/** Replay ops in (lamport_ts, operation_id) order then normalize.
 *  Mirrors CRDTStrategy.materialize v2 exactly. */
function replayAndNormalize(ops: TimedOp[]): any[] {
  const sorted = [...ops].sort((a, b) =>
    a.lamport_ts - b.lamport_ts || a.operation_id.localeCompare(b.operation_id),
  );
  const state = new Map<string, any>();
  for (const op of sorted) {
    switch (op.op_type) {
      case 'add_slot':
        state.set(op.slot.slot_id, { ...op.slot });
        break;
      case 'remove_slot':
        state.delete(op.slot.slot_id);
        break;
      case 'update_slot':
        if (state.has(op.slot.slot_id)) {
          state.set(op.slot.slot_id, { ...state.get(op.slot.slot_id), ...op.slot });
        }
        break;
      case 'move_slot':
        if (state.has(op.slot.slot_id)) {
          state.set(op.slot.slot_id, {
            ...state.get(op.slot.slot_id),
            start_time: op.slot.start_time,
            end_time: op.slot.end_time,
          });
        }
        break;
    }
  }
  const { slots } = normalizeSchedule(Array.from(state.values()));
  return slots;
}

function byId(slots: any[]): any[] {
  return [...slots].sort((a: any, b: any) => a.slot_id.localeCompare(b.slot_id));
}

function canonical(slots: any[]): any[] {
  return byId(slots).map((s: any) => ({
    slot_id: s.slot_id,
    start_time: s.start_time,
    end_time: s.end_time,
    priority: s.priority ?? 0,
  }));
}

describe('CRDT Convergence with Merge Policy (v2)', () => {
  it('add-only ops: any delivery order converges to overlap-free state', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb, { minLength: 2, maxLength: 10 }),
        (slots) => {
          const ops: TimedOp[] = slots.map((slot, i) => ({
            op_type: 'add_slot',
            operation_id: `op-${i}`,
            lamport_ts: (i + 1) * 100,
            slot,
          }));

          // Different delivery orders — same lamport_ts-sorted replay
          const r1 = replayAndNormalize(ops);
          const r2 = replayAndNormalize([...ops].reverse());

          expect(canonical(r1)).toEqual(canonical(r2));

          // No overlaps within same group+zone
          for (let i = 0; i < r1.length; i++) {
            for (let j = i + 1; j < r1.length; j++) {
              if (r1[i].zone_id === r1[j].zone_id && r1[i].group_id === r1[j].group_id) {
                const aEnd = new Date(r1[i].end_time).getTime();
                const bStart = new Date(r1[j].start_time).getTime();
                const aStart = new Date(r1[i].start_time).getTime();
                const bEnd = new Date(r1[j].end_time).getTime();
                expect(aStart < bEnd && aEnd > bStart).toBe(false);
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('mixed add+update+move ops converge regardless of delivery order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50000000 }),
        fc.integer({ min: 60000, max: 3600000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (startMs, dur, p1, p2) => {
          const ops: TimedOp[] = [
            { op_type: 'add_slot', operation_id: 'op-1', lamport_ts: 100, slot: { slot_id: 's1', zone_id: 'z1', group_id: 'g1', start_time: new Date(startMs).toISOString(), end_time: new Date(startMs + dur).toISOString(), priority: p1 } },
            { op_type: 'add_slot', operation_id: 'op-2', lamport_ts: 200, slot: { slot_id: 's2', zone_id: 'z1', group_id: 'g1', start_time: new Date(startMs + Math.floor(dur / 2)).toISOString(), end_time: new Date(startMs + dur + Math.floor(dur / 2)).toISOString(), priority: p2 } },
            { op_type: 'update_slot', operation_id: 'op-3', lamport_ts: 300, slot: { slot_id: 's1', priority: Math.min(100, p1 + 10) } },
          ];

          const r1 = replayAndNormalize(ops);
          const r2 = replayAndNormalize([...ops].reverse());
          const r3 = replayAndNormalize([ops[2], ops[0], ops[1]]);

          expect(canonical(r1)).toEqual(canonical(r2));
          expect(canonical(r1)).toEqual(canonical(r3));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('add+remove: removed slot no longer displaces others', () => {
    const ops: TimedOp[] = [
      { op_type: 'add_slot', operation_id: 'op-1', lamport_ts: 100, slot: { slot_id: 'x', zone_id: 'z1', group_id: 'g1', start_time: new Date(0).toISOString(), end_time: new Date(3600000).toISOString(), priority: 90 } },
      { op_type: 'add_slot', operation_id: 'op-2', lamport_ts: 200, slot: { slot_id: 'y', zone_id: 'z1', group_id: 'g1', start_time: new Date(1800000).toISOString(), end_time: new Date(5400000).toISOString(), priority: 50 } },
      { op_type: 'remove_slot', operation_id: 'op-3', lamport_ts: 300, slot: { slot_id: 'x' } },
    ];

    // Regardless of delivery order, lamport_ts-sorted replay always gives:
    // add x → add y → remove x → state = {y}
    const r1 = replayAndNormalize(ops);
    const r2 = replayAndNormalize([...ops].reverse());

    expect(canonical(r1)).toEqual(canonical(r2));
    expect(r1).toHaveLength(1);
    expect(r1[0].slot_id).toBe('y');
    // y keeps original position since x (the overlap source) was removed
    expect(r1[0].start_time).toBe(new Date(1800000).toISOString());
  });

  it('normalization after merge produces valid state per InvariantValidator', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb, { minLength: 2, maxLength: 10 }),
        (slots) => {
          const ops: TimedOp[] = slots.map((slot, i) => ({
            op_type: 'add_slot',
            operation_id: `op-${i}`,
            lamport_ts: (i + 1) * 100,
            slot,
          }));
          const normalized = replayAndNormalize(ops);
          const violations = validator.validate(normalized);
          expect(violations.filter(v => v.code === 'SLOT_OVERLAP')).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('priority-aware resolution: higher priority slot keeps position', () => {
    const ops: TimedOp[] = [
      { op_type: 'add_slot', operation_id: 'op-1', lamport_ts: 100, slot: { slot_id: 'h', zone_id: 'z1', group_id: 'g1', start_time: new Date(0).toISOString(), end_time: new Date(3600000).toISOString(), priority: 95 } },
      { op_type: 'add_slot', operation_id: 'op-2', lamport_ts: 200, slot: { slot_id: 'l', zone_id: 'z1', group_id: 'g1', start_time: new Date(1800000).toISOString(), end_time: new Date(5400000).toISOString(), priority: 10 } },
    ];

    const result = replayAndNormalize(ops);
    const rHigh = result.find((s: any) => s.slot_id === 'h')!;
    const rLow = result.find((s: any) => s.slot_id === 'l')!;

    expect(rHigh.start_time).toBe(new Date(0).toISOString());
    expect(new Date(rLow.start_time).getTime()).toBeGreaterThanOrEqual(new Date(rHigh.end_time).getTime());
  });

  it('different delivery orders: same op set always converges (property)', () => {
    const timedOpArb = fc.oneof(
      fc.record({
        operation_id: fc.uuid(),
        lamport_ts: fc.integer({ min: 1, max: 10000 }),
        slot_id: fc.constantFrom('s1', 's2', 's3'),
        start: fc.integer({ min: 0, max: 86400000 }),
        dur: fc.integer({ min: 60000, max: 3600000 }),
        priority: fc.integer({ min: 0, max: 100 }),
      }).map(({ operation_id, lamport_ts, slot_id, start, dur, priority }) => ({
        op_type: 'add_slot' as const,
        operation_id,
        lamport_ts,
        slot: { slot_id, zone_id: 'z1', group_id: 'g1', start_time: new Date(start).toISOString(), end_time: new Date(start + dur).toISOString(), priority },
      })),
      fc.record({
        operation_id: fc.uuid(),
        lamport_ts: fc.integer({ min: 1, max: 10000 }),
        slot_id: fc.constantFrom('s1', 's2', 's3'),
      }).map(({ operation_id, lamport_ts, slot_id }) => ({
        op_type: 'remove_slot' as const,
        operation_id,
        lamport_ts,
        slot: { slot_id },
      })),
      fc.record({
        operation_id: fc.uuid(),
        lamport_ts: fc.integer({ min: 1, max: 10000 }),
        slot_id: fc.constantFrom('s1', 's2', 's3'),
        priority: fc.integer({ min: 0, max: 100 }),
      }).map(({ operation_id, lamport_ts, slot_id, priority }) => ({
        op_type: 'update_slot' as const,
        operation_id,
        lamport_ts,
        slot: { slot_id, priority },
      })),
    );

    fc.assert(
      fc.property(
        fc.array(timedOpArb, { minLength: 3, maxLength: 15 }),
        (ops) => {
          const r1 = replayAndNormalize(ops);
          const r2 = replayAndNormalize([...ops].reverse());
          expect(canonical(r1)).toEqual(canonical(r2));

          // No overlaps
          for (let i = 0; i < r1.length; i++) {
            for (let j = i + 1; j < r1.length; j++) {
              if (r1[i].zone_id === r1[j].zone_id && r1[i].group_id === r1[j].group_id) {
                const aStart = new Date(r1[i].start_time).getTime();
                const aEnd = new Date(r1[i].end_time).getTime();
                const bStart = new Date(r1[j].start_time).getTime();
                const bEnd = new Date(r1[j].end_time).getTime();
                expect(aStart < bEnd && aEnd > bStart).toBe(false);
              }
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
