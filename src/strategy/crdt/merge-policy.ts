/**
 * Schedule CRDT Merge Policy — deterministic, priority-aware conflict resolution.
 *
 * This module is a pure function with zero side effects. It takes a set of
 * schedule slots (the raw materialized state after op-log replay) and returns
 * a normalized set where:
 *
 *   1. No two slots within the same (zone_id, group_id) overlap in time.
 *   2. Higher-priority slots keep their original time position.
 *   3. Lower-priority slots that overlap are shifted forward (preserving duration).
 *   4. Equal-priority tie-break: earlier start_time wins; if still equal, lower
 *      slot_id (lexicographic) wins — fully deterministic on every node.
 *   5. Priorities outside [0, 100] are clamped before resolution.
 *
 * Guarantees:
 *   - Determinism: same input → same output regardless of input order.
 *   - Idempotency: normalizeSchedule(normalizeSchedule(x)) ≡ normalizeSchedule(x).
 *   - Duration preservation: every slot keeps its original duration.
 *   - No-overlap within (zone_id, group_id) in the output.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlotData {
  slot_id: string;
  zone_id: string;
  group_id?: string | null;
  start_time: string;
  end_time: string;
  priority?: number;
  [key: string]: any;
}

export interface NormalizationAdjustment {
  slot_id: string;
  original_start: string;
  original_end: string;
  adjusted_start: string;
  adjusted_end: string;
  displaced_by: string;
  reason: string;
}

export interface NormalizationResult {
  slots: SlotData[];
  adjustments: NormalizationAdjustment[];
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const MIN_PRIORITY = 0;
const MAX_PRIORITY = 100;

function clampPriority(p: number | undefined | null): number {
  const v = p ?? 0;
  if (v < MIN_PRIORITY) return MIN_PRIORITY;
  if (v > MAX_PRIORITY) return MAX_PRIORITY;
  return v;
}

// ---------------------------------------------------------------------------
// Time helpers — work exclusively in epoch-ms for precision
// ---------------------------------------------------------------------------

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

function toISO(ms: number): string {
  return new Date(ms).toISOString();
}

function slotsOverlap(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

// ---------------------------------------------------------------------------
// Core: group key
// ---------------------------------------------------------------------------

function groupKey(slot: SlotData): string {
  // Use null-safe concatenation with a separator that cannot appear in IDs
  return `${slot.zone_id ?? ''}\0${slot.group_id ?? ''}`;
}

// ---------------------------------------------------------------------------
// Core: normalize a single (zone_id, group_id) group
// ---------------------------------------------------------------------------

function normalizeGroup(slots: SlotData[]): NormalizationResult {
  if (slots.length === 0) return { slots: [], adjustments: [] };
  if (slots.length === 1) {
    const s = { ...slots[0], priority: clampPriority(slots[0].priority) };
    return { slots: [s], adjustments: [] };
  }

  // 1. Clamp priorities
  const clamped = slots.map(s => ({ ...s, priority: clampPriority(s.priority) }));

  // 2. Deterministic sort: higher priority first → earlier start → lower slot_id
  const sorted = clamped.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const aStart = toMs(a.start_time);
    const bStart = toMs(b.start_time);
    if (aStart !== bStart) return aStart - bStart;
    return a.slot_id.localeCompare(b.slot_id);
  });

  // 3. Greedy placement — higher-priority slots placed first, immovable.
  //    Lower-priority slots shift forward past any overlap.
  const placed: SlotData[] = [];
  const adjustments: NormalizationAdjustment[] = [];

  for (const slot of sorted) {
    const candidate = { ...slot };
    const duration = toMs(candidate.end_time) - toMs(candidate.start_time);
    const origStart = candidate.start_time;
    const origEnd = candidate.end_time;
    let displacedBy: string | null = null;

    // Iteratively shift until no overlap with any already-placed slot.
    // Terminates because each shift moves candidate.start strictly forward,
    // and there are finitely many placed slots.
    let stable = false;
    let guard = placed.length + 1; // upper bound on iterations

    while (!stable && guard-- > 0) {
      stable = true;
      const cStart = toMs(candidate.start_time);
      const cEnd = toMs(candidate.end_time);

      for (const p of placed) {
        const pStart = toMs(p.start_time);
        const pEnd = toMs(p.end_time);

        if (slotsOverlap(cStart, cEnd, pStart, pEnd)) {
          candidate.start_time = toISO(pEnd);
          candidate.end_time = toISO(pEnd + duration);
          displacedBy = p.slot_id;
          stable = false;
          break; // restart overlap scan from the beginning
        }
      }
    }

    if (candidate.start_time !== origStart) {
      adjustments.push({
        slot_id: candidate.slot_id,
        original_start: origStart,
        original_end: origEnd,
        adjusted_start: candidate.start_time,
        adjusted_end: candidate.end_time,
        displaced_by: displacedBy!,
        reason: `Overlap with higher-priority or earlier slot ${displacedBy}`,
      });
    }

    placed.push(candidate);
  }

  return { slots: placed, adjustments };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a set of schedule slots — resolve all intra-group overlaps
 * using priority-aware deterministic conflict resolution.
 *
 * This is a **pure function**: same input always produces the same output,
 * regardless of input ordering.
 */
export function normalizeSchedule(slots: SlotData[]): NormalizationResult {
  if (slots.length === 0) return { slots: [], adjustments: [] };

  // Group by (zone_id, group_id)
  const groups = new Map<string, SlotData[]>();
  for (const slot of slots) {
    const key = groupKey(slot);
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(slot);
  }

  const allSlots: SlotData[] = [];
  const allAdj: NormalizationAdjustment[] = [];

  // Process groups in deterministic (sorted) key order
  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const { slots: gs, adjustments } = normalizeGroup(groups.get(key)!);
    allSlots.push(...gs);
    allAdj.push(...adjustments);
  }

  return { slots: allSlots, adjustments: allAdj };
}
