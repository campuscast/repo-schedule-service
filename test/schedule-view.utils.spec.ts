import {
  buildDaySummaries,
  computeRangeForView,
  mergeDaySlots,
  slotOverlapsRange,
} from '../src/schedule/schedule-view.utils';

describe('schedule-view.utils', () => {
  it('builds day summaries with overlap duration mapping', () => {
    const from = new Date('2026-03-20T00:00:00.000Z');
    const to = new Date('2026-03-22T00:00:00.000Z');
    const summaries = buildDaySummaries(
      [
        {
          slot_id: 'slot-1',
          asset_id: 'asset-1',
          start_time: '2026-03-20T01:00:00.000Z',
          end_time: '2026-03-20T02:30:00.000Z',
        },
        {
          slot_id: 'slot-2',
          publication_id: 'pub-1',
          start_time: '2026-03-20T23:30:00.000Z',
          end_time: '2026-03-21T00:30:00.000Z',
        },
      ],
      from,
      to,
    );

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      date: '2026-03-20',
      slot_count: 2,
      asset_slots: 1,
      publication_slots: 1,
      total_duration_minutes: 120,
    });
    expect(summaries[1]).toMatchObject({
      date: '2026-03-21',
      slot_count: 1,
      total_duration_minutes: 30,
    });
  });

  it('computes week window from anchor date', () => {
    const range = computeRangeForView({
      view: 'week',
      date: '2026-03-20', // Friday
    });

    expect(range.from.toISOString()).toBe('2026-03-16T00:00:00.000Z'); // Monday
    expect(range.to.toISOString()).toBe('2026-03-23T00:00:00.000Z');
  });

  it('replaces only selected day slots when merging editor payload', () => {
    const merged = mergeDaySlots({
      date: '2026-03-20',
      existingSlots: [
        {
          slot_id: 'old-day-slot',
          start_time: '2026-03-20T10:00:00.000Z',
          end_time: '2026-03-20T11:00:00.000Z',
        },
        {
          slot_id: 'other-day-slot',
          start_time: '2026-03-21T10:00:00.000Z',
          end_time: '2026-03-21T11:00:00.000Z',
        },
      ],
      nextDaySlots: [
        {
          slot_id: 'new-day-slot',
          start_time: '2026-03-20T12:00:00.000Z',
          end_time: '2026-03-20T13:00:00.000Z',
        },
      ],
    });

    expect(merged.map((slot) => slot.slot_id).sort()).toEqual(['new-day-slot', 'other-day-slot']);
  });

  it('detects range overlap correctly', () => {
    const overlaps = slotOverlapsRange(
      {
        slot_id: 'slot-1',
        start_time: '2026-03-20T09:00:00.000Z',
        end_time: '2026-03-20T10:00:00.000Z',
      },
      new Date('2026-03-20T09:30:00.000Z'),
      new Date('2026-03-20T11:00:00.000Z'),
    );
    expect(overlaps).toBe(true);
  });
});
