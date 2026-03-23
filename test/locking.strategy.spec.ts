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
        status: 'locked',
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
});
