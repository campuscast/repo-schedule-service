import * as fc from 'fast-check';
import { InvariantValidator } from '../../src/invariants/invariant-validator.service';
import { AutoTransformService } from '../../src/auto-transform/auto-transform.service';

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
