import { LockingStrategy } from '../src/strategy/locking/locking.strategy';

let redisMock: {
  set: jest.Mock;
  get: jest.Mock;
  ttl: jest.Mock;
  eval: jest.Mock;
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => redisMock);
});

function makeRepo() {
  return {
    update: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };
}

describe('LockingStrategy.acquireLock', () => {
  beforeEach(() => {
    redisMock = {
      set: jest.fn(),
      get: jest.fn(),
      ttl: jest.fn(),
      eval: jest.fn(),
    };
  });

  it('returns existing lock token for same user (idempotent reacquire)', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = { validate: jest.fn().mockReturnValue([]) };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    redisMock.set.mockResolvedValue(null);
    redisMock.get.mockResolvedValue(JSON.stringify({ userId: 'user-1', lockToken: 'token-1' }));
    redisMock.ttl.mockResolvedValue(120);
    scheduleRepo.update.mockResolvedValue(undefined);

    const result = await strategy.acquireLock('schedule-1', 'user-1', 300);

    expect(result.acquired).toBe(true);
    expect(result.lock_token).toBe('token-1');
    expect(result.locked_by).toBe('user-1');
    expect(redisMock.ttl).toHaveBeenCalledWith('schedule:lock:schedule-1');
    expect(scheduleRepo.update).toHaveBeenCalledWith(
      { schedule_id: 'schedule-1' },
      expect.objectContaining({
        locked_by: 'user-1',
        lock_token: 'token-1',
      }),
    );
  });

  it('keeps lock denied for another user', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = { validate: jest.fn().mockReturnValue([]) };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    redisMock.set.mockResolvedValue(null);
    redisMock.get.mockResolvedValue(JSON.stringify({ userId: 'owner-1', lockToken: 'token-1' }));

    const result = await strategy.acquireLock('schedule-1', 'user-2', 300);

    expect(result).toEqual({ acquired: false, locked_by: 'owner-1' });
    expect(scheduleRepo.update).not.toHaveBeenCalled();
  });

  it('releases lock and clears lock fields in schedule row', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = { validate: jest.fn().mockReturnValue([]) };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    redisMock.eval.mockResolvedValue(1);

    const released = await strategy.releaseLock('schedule-1', 'token-1');

    expect(released).toBe(true);
    expect(scheduleRepo.update).toHaveBeenCalledWith(
      { schedule_id: 'schedule-1' },
      {
        locked_by: null,
        lock_token: null,
        lock_expires_at: null,
      },
    );
  });

  it('refreshes lock TTL for the same token', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = { validate: jest.fn().mockReturnValue([]) };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    redisMock.eval.mockResolvedValue(JSON.stringify({
      refreshed: true,
      lockedBy: 'owner-1',
      lockToken: 'token-1',
    }));
    scheduleRepo.update.mockResolvedValue(undefined);

    const result = await strategy.refreshLock('schedule-1', 'token-1', 600);

    expect(result.refreshed).toBe(true);
    expect(result.lock_token).toBe('token-1');
    expect(result.locked_by).toBe('owner-1');
    expect(redisMock.eval).toHaveBeenCalled();
    expect(scheduleRepo.update).toHaveBeenCalledWith(
      { schedule_id: 'schedule-1' },
      expect.objectContaining({
        locked_by: 'owner-1',
        lock_token: 'token-1',
      }),
    );
  });

  it('fails refresh when token does not match current lock', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = { validate: jest.fn().mockReturnValue([]) };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    redisMock.eval.mockResolvedValue(JSON.stringify({
      refreshed: false,
      lockedBy: 'owner-1',
    }));

    const result = await strategy.refreshLock('schedule-1', 'token-x', 600);

    expect(result).toEqual({
      refreshed: false,
      locked_by: 'owner-1',
    });
    expect(scheduleRepo.update).not.toHaveBeenCalled();
  });

  it('saves two non-overlapping slots with valid lock token', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = { validate: jest.fn().mockReturnValue([]) };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    redisMock.get.mockResolvedValue(JSON.stringify({ userId: 'user-1', lockToken: 'token-1' }));

    const slots = [
      {
        slot_id: 'slot-1',
        start_time: '2026-03-25T09:00:00.000Z',
        end_time: '2026-03-25T10:00:00.000Z',
        zone_id: 'zone-1',
        group_id: '',
      },
      {
        slot_id: 'slot-2',
        start_time: '2026-03-25T10:00:00.000Z',
        end_time: '2026-03-25T11:00:00.000Z',
        zone_id: 'zone-1',
        group_id: '',
      },
    ];

    slotRepo.create.mockImplementation((value) => value);
    slotRepo.save.mockResolvedValue(undefined);
    slotRepo.delete.mockResolvedValue(undefined);
    scheduleRepo.update.mockResolvedValue(undefined);

    await strategy.saveSlots('schedule-1', slots, 'token-1');

    expect(slotRepo.delete).toHaveBeenCalledWith({ schedule_id: 'schedule-1' });
    expect(slotRepo.save).toHaveBeenCalledTimes(2);
    expect(scheduleRepo.update).toHaveBeenCalledWith({ schedule_id: 'schedule-1' }, { status: 'draft' });
  });

  it('rejects save without lock token', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = { validate: jest.fn().mockReturnValue([]) };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    await expect(strategy.saveSlots('schedule-1', [], undefined)).rejects.toMatchObject({
      response: { message: 'Lock is required before saving' },
    });
  });

  it('returns readable overlap invariant message on conflicting slots', async () => {
    const scheduleRepo = makeRepo();
    const slotRepo = makeRepo();
    const invariantValidator = {
      validate: jest.fn().mockReturnValue([
        {
          code: 'SLOT_OVERLAP',
          message: 'Slots a и b пересекаются по времени в одной зоне/группе',
          slot_ids: ['a', 'b'],
          severity: 'error',
        },
      ]),
    };
    const strategy = new LockingStrategy(scheduleRepo as any, slotRepo as any, invariantValidator as any);

    redisMock.get.mockResolvedValue(JSON.stringify({ userId: 'user-1', lockToken: 'token-1' }));

    await expect(strategy.saveSlots('schedule-1', [{ slot_id: 'a' }, { slot_id: 'b' }], 'token-1')).rejects.toMatchObject({
      response: {
        code: 'INVARIANT_VIOLATION',
        message: 'Слоты пересекаются по времени в одной зоне/группе или содержат некорректные параметры',
      },
    });
  });
});
