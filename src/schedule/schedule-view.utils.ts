export type CalendarView = 'day' | 'week' | 'month' | 'year';

export type SlotLike = {
  slot_id: string;
  start_time: string | Date;
  end_time: string | Date;
  asset_id?: string | null;
  publication_id?: string | null;
};

export type DaySummary = {
  date: string;
  slot_count: number;
  asset_slots: number;
  publication_slots: number;
  total_duration_minutes: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: string | Date): Date {
  if (value instanceof Date) {
    return value;
  }
  return new Date(value);
}

function assertValidDate(date: Date, message: string): void {
  if (Number.isNaN(date.getTime())) {
    throw new Error(message);
  }
}

export function parseDateOnly(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  assertValidDate(date, `Invalid date: ${value}`);
  return date;
}

export function formatDateOnlyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function startOfUtcWeek(date: Date): Date {
  const day = date.getUTCDay();
  const offsetToMonday = (day + 6) % 7;
  return addUtcDays(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())), -offsetToMonday);
}

export function endExclusiveForDay(start: Date): Date {
  return addUtcDays(start, 1);
}

export function slotOverlapsRange(slot: SlotLike, fromInclusive: Date, toExclusive: Date): boolean {
  const start = toDate(slot.start_time);
  const end = toDate(slot.end_time);
  return start < toExclusive && end > fromInclusive;
}

export function computeRangeForView(params: {
  view: CalendarView;
  date?: string;
  from?: string;
  to?: string;
}): { from: Date; to: Date; anchor: Date } {
  const now = new Date();
  const anchor = params.date ? parseDateOnly(params.date) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (params.from && params.to) {
    const from = parseDateOnly(params.from);
    const toInclusive = parseDateOnly(params.to);
    return { from, to: endExclusiveForDay(toInclusive), anchor };
  }

  if (params.view === 'day') {
    const from = anchor;
    return { from, to: endExclusiveForDay(from), anchor };
  }

  if (params.view === 'week') {
    const from = startOfUtcWeek(anchor);
    return { from, to: addUtcDays(from, 7), anchor };
  }

  if (params.view === 'month') {
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
    return { from, to, anchor };
  }

  const from = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
  const to = new Date(Date.UTC(anchor.getUTCFullYear() + 1, 0, 1));
  return { from, to, anchor };
}

export function buildDaySummaries(slots: SlotLike[], fromInclusive: Date, toExclusive: Date): DaySummary[] {
  const summaries: DaySummary[] = [];
  for (let cursor = fromInclusive; cursor < toExclusive; cursor = addUtcDays(cursor, 1)) {
    const dayStart = cursor;
    const dayEnd = endExclusiveForDay(dayStart);
    const daySlots = slots.filter((slot) => slotOverlapsRange(slot, dayStart, dayEnd));

    const totalDuration = daySlots.reduce((sum, slot) => {
      const start = toDate(slot.start_time);
      const end = toDate(slot.end_time);
      const overlapStart = start > dayStart ? start : dayStart;
      const overlapEnd = end < dayEnd ? end : dayEnd;
      const minutes = Math.max(0, Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 60000));
      return sum + minutes;
    }, 0);

    summaries.push({
      date: formatDateOnlyUtc(dayStart),
      slot_count: daySlots.length,
      asset_slots: daySlots.filter((slot) => Boolean(slot.asset_id)).length,
      publication_slots: daySlots.filter((slot) => Boolean(slot.publication_id)).length,
      total_duration_minutes: totalDuration,
    });
  }
  return summaries;
}

export function mergeDaySlots(params: {
  existingSlots: SlotLike[];
  date: string;
  nextDaySlots: SlotLike[];
}): SlotLike[] {
  const dayStart = parseDateOnly(params.date);
  const dayEnd = endExclusiveForDay(dayStart);
  const preserved = params.existingSlots.filter((slot) => !slotOverlapsRange(slot, dayStart, dayEnd));
  return [...preserved, ...params.nextDaySlots];
}
