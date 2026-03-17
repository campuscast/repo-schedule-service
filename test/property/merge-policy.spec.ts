import * as fc from 'fast-check';
import { normalizeSchedule, SlotData, NormalizationResult } from '../../src/strategy/crdt/merge-policy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function duration(slot: SlotData): number {
  return ms(slot.end_time) - ms(slot.start_time);
}

function overlaps(a: SlotData, b: SlotData): boolean {
  return ms(a.start_time) < ms(b.end_time) && ms(a.end_time) > ms(b.start_time);
}

/** Sort slots by slot_id for stable comparison */
function byId(slots: SlotData[]): SlotData[] {
  return [...slots].sort((a, b) => a.slot_id.localeCompare(b.slot_id));
}

/** Strip extra fields for equality comparison (keep canonical fields only) */
function canonical(slots: SlotData[]): Pick<SlotData, 'slot_id' | 'start_time' | 'end_time' | 'priority'>[] {
  return byId(slots).map(s => ({
    slot_id: s.slot_id,
    start_time: s.start_time,
    end_time: s.end_time,
    priority: s.priority ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a slot with controlled time and priority ranges */
const slotArb = (opts?: { minPriority?: number; maxPriority?: number }) =>
  fc.record({
    slot_id: fc.uuid(),
    zone_id: fc.constant('zone-1'),
    group_id: fc.constant('group-1'),
    start: fc.integer({ min: 0, max: 86400000 }), // within 24h
    dur: fc.integer({ min: 60000, max: 3600000 }),  // 1min–1h
    priority: fc.integer({
      min: opts?.minPriority ?? 0,
      max: opts?.maxPriority ?? 100,
    }),
  }).map(({ slot_id, zone_id, group_id, start, dur, priority }) => ({
    slot_id,
    zone_id,
    group_id,
    start_time: new Date(start).toISOString(),
    end_time: new Date(start + dur).toISOString(),
    priority,
  }));

/** Generate a slot with out-of-range priority for clamping tests */
const slotArbWild = fc.record({
  slot_id: fc.uuid(),
  zone_id: fc.constant('zone-1'),
  group_id: fc.constant('group-1'),
  start: fc.integer({ min: 0, max: 86400000 }),
  dur: fc.integer({ min: 60000, max: 3600000 }),
  priority: fc.integer({ min: -500, max: 500 }),
}).map(({ slot_id, zone_id, group_id, start, dur, priority }) => ({
  slot_id,
  zone_id,
  group_id,
  start_time: new Date(start).toISOString(),
  end_time: new Date(start + dur).toISOString(),
  priority,
}));

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('normalizeSchedule — unit tests', () => {
  it('returns empty for empty input', () => {
    const { slots, adjustments } = normalizeSchedule([]);
    expect(slots).toEqual([]);
    expect(adjustments).toEqual([]);
  });

  it('returns single slot unchanged (with clamped priority)', () => {
    const input: SlotData[] = [{
      slot_id: 'a', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    }];
    const { slots, adjustments } = normalizeSchedule(input);
    expect(slots).toHaveLength(1);
    expect(slots[0].start_time).toBe(input[0].start_time);
    expect(adjustments).toHaveLength(0);
  });

  it('non-overlapping slots are unchanged', () => {
    const input: SlotData[] = [
      { slot_id: 'a', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 50 },
      { slot_id: 'b', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T02:00:00.000Z', end_time: '2024-01-01T03:00:00.000Z', priority: 50 },
    ];
    const { slots, adjustments } = normalizeSchedule(input);
    expect(adjustments).toHaveLength(0);
    expect(slots).toHaveLength(2);
  });

  it('higher priority slot keeps position, lower priority shifts', () => {
    const A: SlotData = {
      slot_id: 'a', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 30,
    };
    const B: SlotData = {
      slot_id: 'b', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:30:00.000Z',
      end_time: '2024-01-01T01:30:00.000Z',
      priority: 80,
    };
    const { slots, adjustments } = normalizeSchedule([A, B]);

    const slotA = slots.find(s => s.slot_id === 'a')!;
    const slotB = slots.find(s => s.slot_id === 'b')!;

    // B has higher priority — keeps original position
    expect(slotB.start_time).toBe(B.start_time);
    expect(slotB.end_time).toBe(B.end_time);

    // A has lower priority — shifted after B
    expect(ms(slotA.start_time)).toBeGreaterThanOrEqual(ms(slotB.end_time));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].slot_id).toBe('a');
    expect(adjustments[0].displaced_by).toBe('b');
  });

  it('equal priority tie-break: earlier start_time wins', () => {
    const A: SlotData = {
      slot_id: 'zzz', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    };
    const B: SlotData = {
      slot_id: 'aaa', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:30:00.000Z',
      end_time: '2024-01-01T01:30:00.000Z',
      priority: 50,
    };
    const { slots } = normalizeSchedule([A, B]);

    const slotA = slots.find(s => s.slot_id === 'zzz')!;
    const slotB = slots.find(s => s.slot_id === 'aaa')!;

    // A starts earlier — keeps position (even though slot_id is higher)
    expect(slotA.start_time).toBe(A.start_time);
    // B shifted
    expect(ms(slotB.start_time)).toBeGreaterThanOrEqual(ms(slotA.end_time));
  });

  it('equal priority + equal start_time: lower slot_id wins', () => {
    const A: SlotData = {
      slot_id: 'b-slot', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    };
    const B: SlotData = {
      slot_id: 'a-slot', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    };
    const { slots, adjustments } = normalizeSchedule([A, B]);

    const slotA = slots.find(s => s.slot_id === 'a-slot')!;
    const slotBSlot = slots.find(s => s.slot_id === 'b-slot')!;

    // a-slot has lower slot_id — wins, keeps original position
    expect(slotA.start_time).toBe('2024-01-01T00:00:00.000Z');
    // b-slot shifted
    expect(ms(slotBSlot.start_time)).toBeGreaterThanOrEqual(ms(slotA.end_time));
    expect(adjustments.some(a => a.slot_id === 'b-slot')).toBe(true);
  });

  it('three-slot cascade: highest priority placed first, others cascade', () => {
    const slots: SlotData[] = [
      { slot_id: 'c', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 30 },
      { slot_id: 'a', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 90 },
      { slot_id: 'b', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 60 },
    ];
    const { slots: result } = normalizeSchedule(slots);

    const rA = result.find(s => s.slot_id === 'a')!;
    const rB = result.find(s => s.slot_id === 'b')!;
    const rC = result.find(s => s.slot_id === 'c')!;

    // a (p=90) keeps original
    expect(rA.start_time).toBe('2024-01-01T00:00:00.000Z');
    // b (p=60) after a
    expect(ms(rB.start_time)).toBeGreaterThanOrEqual(ms(rA.end_time));
    // c (p=30) after b
    expect(ms(rC.start_time)).toBeGreaterThanOrEqual(ms(rB.end_time));

    // no overlaps
    expect(overlaps(rA, rB)).toBe(false);
    expect(overlaps(rA, rC)).toBe(false);
    expect(overlaps(rB, rC)).toBe(false);
  });

  it('different groups do not interact', () => {
    const A: SlotData = {
      slot_id: 'a', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    };
    const B: SlotData = {
      slot_id: 'b', zone_id: 'z1', group_id: 'g2',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    };
    const { slots, adjustments } = normalizeSchedule([A, B]);
    // Different groups — both keep original positions
    expect(adjustments).toHaveLength(0);
    expect(slots).toHaveLength(2);
    expect(slots.find(s => s.slot_id === 'a')!.start_time).toBe(A.start_time);
    expect(slots.find(s => s.slot_id === 'b')!.start_time).toBe(B.start_time);
  });

  it('different zones do not interact', () => {
    const A: SlotData = {
      slot_id: 'a', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    };
    const B: SlotData = {
      slot_id: 'b', zone_id: 'z2', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 50,
    };
    const { adjustments } = normalizeSchedule([A, B]);
    expect(adjustments).toHaveLength(0);
  });

  it('priority clamping: negative priority clamped to 0', () => {
    const A: SlotData = {
      slot_id: 'a', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: -50,
    };
    const { slots } = normalizeSchedule([A]);
    expect(slots[0].priority).toBe(0);
  });

  it('priority clamping: >100 clamped to 100', () => {
    const A: SlotData = {
      slot_id: 'a', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 200,
    };
    const { slots } = normalizeSchedule([A]);
    expect(slots[0].priority).toBe(100);
  });

  it('duration is preserved when slot is shifted', () => {
    const A: SlotData = {
      slot_id: 'a', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T02:00:00.000Z', // 2h
      priority: 80,
    };
    const B: SlotData = {
      slot_id: 'b', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T01:00:00.000Z',
      end_time: '2024-01-01T01:30:00.000Z', // 30min
      priority: 20,
    };
    const { slots } = normalizeSchedule([A, B]);
    const shifted = slots.find(s => s.slot_id === 'b')!;
    expect(duration(shifted)).toBe(30 * 60 * 1000); // 30 min preserved
  });

  it('handles null group_id — slots with null grouped together', () => {
    const A: SlotData = {
      slot_id: 'a', zone_id: 'z1', group_id: null,
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T01:00:00.000Z',
      priority: 80,
    };
    const B: SlotData = {
      slot_id: 'b', zone_id: 'z1', group_id: null,
      start_time: '2024-01-01T00:30:00.000Z',
      end_time: '2024-01-01T01:30:00.000Z',
      priority: 50,
    };
    const { adjustments } = normalizeSchedule([A, B]);
    // Same null group — overlap resolved
    expect(adjustments.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// PROPERTY TESTS — CRDT guarantees
// ============================================================================

describe('normalizeSchedule — commutativity (input-order independence)', () => {
  it('any permutation of the same slots produces identical output', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 2, maxLength: 10 }),
        (slots) => {
          const perm1 = normalizeSchedule(slots);
          const perm2 = normalizeSchedule([...slots].reverse());

          expect(canonical(perm1.slots)).toEqual(canonical(perm2.slots));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('random shuffle produces identical output', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 3, maxLength: 12 }),
        fc.integer({ min: 1, max: 1000 }),
        (slots, seed) => {
          // Deterministic shuffle using seed
          const shuffled = [...slots];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = (seed + i * 31) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }

          const r1 = normalizeSchedule(slots);
          const r2 = normalizeSchedule(shuffled);

          expect(canonical(r1.slots)).toEqual(canonical(r2.slots));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('normalizeSchedule — idempotency', () => {
  it('normalizing twice gives same result', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 1, maxLength: 10 }),
        (slots) => {
          const once = normalizeSchedule(slots);
          const twice = normalizeSchedule(once.slots);

          expect(canonical(once.slots)).toEqual(canonical(twice.slots));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('second normalization produces zero adjustments', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 2, maxLength: 8 }),
        (slots) => {
          const once = normalizeSchedule(slots);
          const twice = normalizeSchedule(once.slots);

          expect(twice.adjustments).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('normalizeSchedule — no-overlap invariant', () => {
  it('output never has overlapping slots within same group+zone', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 2, maxLength: 15 }),
        (slots) => {
          const { slots: result } = normalizeSchedule(slots);

          // Check all pairs within same group+zone
          for (let i = 0; i < result.length; i++) {
            for (let j = i + 1; j < result.length; j++) {
              const a = result[i];
              const b = result[j];
              if (a.zone_id === b.zone_id && a.group_id === b.group_id) {
                expect(overlaps(a, b)).toBe(false);
              }
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('normalizeSchedule — priority preservation', () => {
  it('higher priority slot never gets displaced for a lower priority slot', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 2, maxLength: 10 }),
        (slots) => {
          const { adjustments } = normalizeSchedule(slots);

          for (const adj of adjustments) {
            // Find the displaced slot's original priority
            const displacedSlot = slots.find(s => s.slot_id === adj.slot_id)!;
            const displacerSlot = slots.find(s => s.slot_id === adj.displaced_by)!;

            const displacedPriority = Math.max(0, Math.min(100, displacedSlot.priority ?? 0));
            const displacerPriority = Math.max(0, Math.min(100, displacerSlot.priority ?? 0));

            // Displacer must have >= priority (after clamping)
            expect(displacerPriority).toBeGreaterThanOrEqual(displacedPriority);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('normalizeSchedule — duration preservation', () => {
  it('every slot keeps its original duration', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 1, maxLength: 10 }),
        (slots) => {
          const { slots: result } = normalizeSchedule(slots);

          for (const original of slots) {
            const normalized = result.find(s => s.slot_id === original.slot_id);
            if (normalized) {
              expect(duration(normalized)).toBe(duration(original));
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('normalizeSchedule — priority clamping', () => {
  it('all output priorities are in [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.array(slotArbWild, { minLength: 1, maxLength: 10 }),
        (slots) => {
          const { slots: result } = normalizeSchedule(slots);
          for (const s of result) {
            expect(s.priority).toBeGreaterThanOrEqual(0);
            expect(s.priority).toBeLessThanOrEqual(100);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('normalizeSchedule — slot count preservation', () => {
  it('output has exactly the same number of slots as input', () => {
    fc.assert(
      fc.property(
        fc.array(slotArb(), { minLength: 0, maxLength: 15 }),
        (slots) => {
          const { slots: result } = normalizeSchedule(slots);
          expect(result).toHaveLength(slots.length);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ============================================================================
// CONFLICT SCENARIOS — deterministic winner behavior
// ============================================================================

describe('normalizeSchedule — conflict scenarios', () => {
  it('overlap with different priorities: higher priority wins time slot', () => {
    const highP: SlotData = {
      slot_id: 'high', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T10:00:00.000Z',
      end_time: '2024-01-01T11:00:00.000Z',
      priority: 90,
    };
    const lowP: SlotData = {
      slot_id: 'low', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T10:30:00.000Z',
      end_time: '2024-01-01T11:30:00.000Z',
      priority: 10,
    };

    // Same result regardless of input order
    const r1 = normalizeSchedule([highP, lowP]);
    const r2 = normalizeSchedule([lowP, highP]);

    expect(canonical(r1.slots)).toEqual(canonical(r2.slots));

    // High priority keeps position
    const high1 = r1.slots.find(s => s.slot_id === 'high')!;
    expect(high1.start_time).toBe(highP.start_time);

    // Low priority shifted after high
    const low1 = r1.slots.find(s => s.slot_id === 'low')!;
    expect(ms(low1.start_time)).toBeGreaterThanOrEqual(ms(high1.end_time));
  });

  it('overlap with equal priorities: earlier start wins', () => {
    const earlier: SlotData = {
      slot_id: 'later-id', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T10:00:00.000Z',
      end_time: '2024-01-01T11:00:00.000Z',
      priority: 50,
    };
    const later: SlotData = {
      slot_id: 'earlier-id', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T10:30:00.000Z',
      end_time: '2024-01-01T11:30:00.000Z',
      priority: 50,
    };

    const r1 = normalizeSchedule([earlier, later]);
    const r2 = normalizeSchedule([later, earlier]);

    expect(canonical(r1.slots)).toEqual(canonical(r2.slots));

    // Earlier-starting slot keeps position (regardless of slot_id)
    const e = r1.slots.find(s => s.slot_id === 'later-id')!;
    expect(e.start_time).toBe('2024-01-01T10:00:00.000Z');
  });

  it('overlap with equal priorities + equal start: lower slot_id wins', () => {
    const A: SlotData = {
      slot_id: 'aaa', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T10:00:00.000Z',
      end_time: '2024-01-01T11:00:00.000Z',
      priority: 50,
    };
    const B: SlotData = {
      slot_id: 'zzz', zone_id: 'z1', group_id: 'g1',
      start_time: '2024-01-01T10:00:00.000Z',
      end_time: '2024-01-01T11:00:00.000Z',
      priority: 50,
    };

    const r1 = normalizeSchedule([A, B]);
    const r2 = normalizeSchedule([B, A]);

    expect(canonical(r1.slots)).toEqual(canonical(r2.slots));

    // 'aaa' has lower slot_id — keeps position
    const a = r1.slots.find(s => s.slot_id === 'aaa')!;
    expect(a.start_time).toBe('2024-01-01T10:00:00.000Z');

    // 'zzz' shifted
    const z = r1.slots.find(s => s.slot_id === 'zzz')!;
    expect(ms(z.start_time)).toBeGreaterThanOrEqual(ms(a.end_time));
  });
});

// ============================================================================
// INTEGRATION: full CRDT replay + normalization pipeline
// ============================================================================

/** Mirror of CRDTStrategy.replayRaw — applies ops in (lamport_ts, operation_id) order */
function replayRaw(ops: { op_type: string; operation_id: string; lamport_ts: number; slot: any }[]): any[] {
  const state = new Map<string, any>();
  const sorted = [...ops].sort((a, b) => a.lamport_ts - b.lamport_ts || a.operation_id.localeCompare(b.operation_id));

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
  return Array.from(state.values());
}

/** Full pipeline: replay + normalize (mirrors CRDTStrategy.materialize) */
function materialize(ops: { op_type: string; operation_id: string; lamport_ts: number; slot: any }[]): SlotData[] {
  const raw = replayRaw(ops);
  const { slots } = normalizeSchedule(raw);
  return slots;
}

describe('Full CRDT pipeline — replay + normalization', () => {
  it('mixed ops in different delivery order converge to same state', () => {
    const ops = [
      { op_type: 'add_slot', operation_id: 'op-1', lamport_ts: 100, slot: { slot_id: 's1', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 80 } },
      { op_type: 'add_slot', operation_id: 'op-2', lamport_ts: 200, slot: { slot_id: 's2', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:30:00.000Z', end_time: '2024-01-01T01:30:00.000Z', priority: 50 } },
      { op_type: 'update_slot', operation_id: 'op-3', lamport_ts: 300, slot: { slot_id: 's1', priority: 90 } },
      { op_type: 'move_slot', operation_id: 'op-4', lamport_ts: 400, slot: { slot_id: 's2', start_time: '2024-01-01T00:15:00.000Z', end_time: '2024-01-01T01:15:00.000Z' } },
    ];

    const r1 = materialize(ops);
    const r2 = materialize([...ops].reverse());
    const r3 = materialize([ops[2], ops[0], ops[3], ops[1]]);

    expect(canonical(r1)).toEqual(canonical(r2));
    expect(canonical(r1)).toEqual(canonical(r3));

    // s1 (p=90) should keep position, s2 (p=50) should be shifted
    const s1 = r1.find(s => s.slot_id === 's1')!;
    const s2 = r1.find(s => s.slot_id === 's2')!;
    expect(s1.priority).toBe(90);
    expect(ms(s2.start_time)).toBeGreaterThanOrEqual(ms(s1.end_time));
  });

  it('add + remove: removed slot disappears from output', () => {
    const ops = [
      { op_type: 'add_slot', operation_id: 'op-1', lamport_ts: 100, slot: { slot_id: 's1', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 50 } },
      { op_type: 'add_slot', operation_id: 'op-2', lamport_ts: 200, slot: { slot_id: 's2', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 80 } },
      { op_type: 'remove_slot', operation_id: 'op-3', lamport_ts: 300, slot: { slot_id: 's2' } },
    ];

    const r1 = materialize(ops);
    const r2 = materialize([...ops].reverse());

    expect(canonical(r1)).toEqual(canonical(r2));
    expect(r1).toHaveLength(1);
    expect(r1[0].slot_id).toBe('s1');
    // s2 removed — s1 keeps original position (no overlap anymore)
    expect(r1[0].start_time).toBe('2024-01-01T00:00:00.000Z');
  });

  it('duplicate operations (same operation_id logic): replaying same ops is idempotent', () => {
    const ops = [
      { op_type: 'add_slot', operation_id: 'op-1', lamport_ts: 100, slot: { slot_id: 's1', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 50 } },
    ];

    const once = materialize(ops);
    // Simulate duplicate by replaying same op (in real system, deduped by operation_id unique constraint)
    const twice = materialize([...ops, ...ops]);

    expect(canonical(once)).toEqual(canonical(twice));
  });

  it('convergence after reconnect: client A and B with different op subsets', () => {
    const opsA = [
      { op_type: 'add_slot', operation_id: 'op-1', lamport_ts: 100, slot: { slot_id: 's1', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:00:00.000Z', end_time: '2024-01-01T01:00:00.000Z', priority: 70 } },
      { op_type: 'add_slot', operation_id: 'op-2', lamport_ts: 200, slot: { slot_id: 's2', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:30:00.000Z', end_time: '2024-01-01T01:30:00.000Z', priority: 40 } },
    ];
    const opsB = [
      { op_type: 'add_slot', operation_id: 'op-3', lamport_ts: 150, slot: { slot_id: 's3', zone_id: 'z1', group_id: 'g1', start_time: '2024-01-01T00:15:00.000Z', end_time: '2024-01-01T01:15:00.000Z', priority: 90 } },
    ];

    // After sync, both have all ops
    const allOps = [...opsA, ...opsB];

    const rAFirst = materialize([...opsA, ...opsB]);
    const rBFirst = materialize([...opsB, ...opsA]);
    const rMixed = materialize([opsA[0], opsB[0], opsA[1]]);

    expect(canonical(rAFirst)).toEqual(canonical(rBFirst));
    expect(canonical(rAFirst)).toEqual(canonical(rMixed));

    // s3 (p=90) wins, s1 (p=70) and s2 (p=40) shifted
    const s3 = rAFirst.find(s => s.slot_id === 's3')!;
    expect(s3.start_time).toBe('2024-01-01T00:15:00.000Z'); // keeps position
  });
});

// ============================================================================
// PROPERTY: full pipeline commutativity with mixed ops
// ============================================================================

describe('Full CRDT pipeline — property-based convergence', () => {
  const opArb = fc.oneof(
    // add_slot
    fc.record({
      operation_id: fc.uuid(),
      lamport_ts: fc.integer({ min: 1, max: 10000 }),
      slot_id: fc.constantFrom('s1', 's2', 's3', 's4'),
      start: fc.integer({ min: 0, max: 86400000 }),
      dur: fc.integer({ min: 60000, max: 3600000 }),
      priority: fc.integer({ min: 0, max: 100 }),
    }).map(({ operation_id, lamport_ts, slot_id, start, dur, priority }) => ({
      op_type: 'add_slot',
      operation_id,
      lamport_ts,
      slot: {
        slot_id,
        zone_id: 'z1',
        group_id: 'g1',
        start_time: new Date(start).toISOString(),
        end_time: new Date(start + dur).toISOString(),
        priority,
      },
    })),
    // update_slot
    fc.record({
      operation_id: fc.uuid(),
      lamport_ts: fc.integer({ min: 1, max: 10000 }),
      slot_id: fc.constantFrom('s1', 's2', 's3', 's4'),
      priority: fc.integer({ min: 0, max: 100 }),
    }).map(({ operation_id, lamport_ts, slot_id, priority }) => ({
      op_type: 'update_slot',
      operation_id,
      lamport_ts,
      slot: { slot_id, priority },
    })),
    // move_slot
    fc.record({
      operation_id: fc.uuid(),
      lamport_ts: fc.integer({ min: 1, max: 10000 }),
      slot_id: fc.constantFrom('s1', 's2', 's3', 's4'),
      start: fc.integer({ min: 0, max: 86400000 }),
      dur: fc.integer({ min: 60000, max: 3600000 }),
    }).map(({ operation_id, lamport_ts, slot_id, start, dur }) => ({
      op_type: 'move_slot',
      operation_id,
      lamport_ts,
      slot: {
        slot_id,
        start_time: new Date(start).toISOString(),
        end_time: new Date(start + dur).toISOString(),
      },
    })),
    // remove_slot
    fc.record({
      operation_id: fc.uuid(),
      lamport_ts: fc.integer({ min: 1, max: 10000 }),
      slot_id: fc.constantFrom('s1', 's2', 's3', 's4'),
    }).map(({ operation_id, lamport_ts, slot_id }) => ({
      op_type: 'remove_slot',
      operation_id,
      lamport_ts,
      slot: { slot_id },
    })),
  );

  it('mixed ops: different delivery orders converge to same materialized state', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 3, maxLength: 20 }),
        (ops) => {
          const r1 = materialize(ops);
          const r2 = materialize([...ops].reverse());

          expect(canonical(r1)).toEqual(canonical(r2));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('mixed ops: no overlaps in materialized state', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 3, maxLength: 20 }),
        (ops) => {
          const result = materialize(ops);

          for (let i = 0; i < result.length; i++) {
            for (let j = i + 1; j < result.length; j++) {
              const a = result[i];
              const b = result[j];
              if (a.zone_id === b.zone_id && a.group_id === b.group_id) {
                expect(overlaps(a, b)).toBe(false);
              }
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('mixed ops: materialization is idempotent (re-normalizing output gives same result)', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 2, maxLength: 15 }),
        (ops) => {
          const result = materialize(ops);
          const reNormalized = normalizeSchedule(result);

          expect(canonical(result)).toEqual(canonical(reNormalized.slots));
          expect(reNormalized.adjustments).toHaveLength(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('mixed ops: all priorities in output are in [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 1, maxLength: 15 }),
        (ops) => {
          const result = materialize(ops);
          for (const s of result) {
            if (s.priority !== undefined) {
              expect(s.priority).toBeGreaterThanOrEqual(0);
              expect(s.priority).toBeLessThanOrEqual(100);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
