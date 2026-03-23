import { BadRequestException } from '@nestjs/common';
import { ScheduleService } from '../src/schedule/schedule.service';

type MockRepo = {
  findAndCount: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepo(): MockRepo {
  return {
    findAndCount: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

describe('ScheduleService validate/publish QA contract', () => {
  let scheduleRepo: MockRepo;
  let slotRepo: MockRepo;
  let versionRepo: MockRepo;
  let releaseRepo: MockRepo;
  let service: ScheduleService;
  let fetchMock: jest.Mock;
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(() => {
    scheduleRepo = makeRepo();
    slotRepo = makeRepo();
    versionRepo = makeRepo();
    releaseRepo = makeRepo();
    service = new ScheduleService(
      scheduleRepo as any,
      slotRepo as any,
      versionRepo as any,
      releaseRepo as any,
      {} as any,
      {
        build: jest.fn(() => ({ slots: [], assets: [], publications: [] })),
        hashManifest: jest.fn(() => 'manifest-hash'),
      } as any,
    );

    Object.defineProperty(service as any, 'auditClient', {
      value: { append: jest.fn() },
      writable: true,
    });

    originalFetch = global.fetch;
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    if (originalFetch) {
      (global as any).fetch = originalFetch;
    } else {
      delete (global as any).fetch;
    }
    jest.restoreAllMocks();
  });

  it('normalizes validate response when QA payload omits valid/passed', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue({
      schedule_id: 'schedule-1',
      zone_id: 'zone-1',
      slots: [],
    } as any);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        has_fatal: false,
        issues: [],
      }),
    } as any);

    const result = await service.validate('schedule-1');

    expect(result).toEqual({
      valid: true,
      has_fatal: false,
      issues: [],
    });
  });

  it('allows publish when QA returns has_fatal=false and no issues', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue({
      schedule_id: 'schedule-2',
      zone_id: 'zone-1',
      slots: [],
      current_version: 1,
    } as any);

    releaseRepo.save.mockImplementation(async (value) => value);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          has_fatal: false,
          issues: [],
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          signature: 'sig-1',
          key_id: 'key-1',
        }),
      } as any);

    const result = await service.publish('schedule-2', 1, []);

    expect(releaseRepo.save).toHaveBeenCalledTimes(1);
    expect(result.validation_passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.release_id).toBeTruthy();
  });

  it('blocks publish when QA reports fatal issues', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue({
      schedule_id: 'schedule-3',
      zone_id: 'zone-1',
      slots: [],
      current_version: 1,
    } as any);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        has_fatal: true,
        issues: [
          { severity: 'error', code: 'OVERLAP', message: 'Slots overlap' },
        ],
      }),
    } as any);

    await expect(service.publish('schedule-3', 1, [])).rejects.toBeInstanceOf(BadRequestException);
    expect(releaseRepo.save).not.toHaveBeenCalled();
  });
});
