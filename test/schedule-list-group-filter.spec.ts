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
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

function makeQueryBuilder(rawRows: Array<{ schedule_id: string }>) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rawRows),
  };
  return qb;
}

describe('ScheduleService.listByZone group filter', () => {
  let scheduleRepo: MockRepo;
  let slotRepo: MockRepo;
  let versionRepo: MockRepo;
  let releaseRepo: MockRepo;
  let service: ScheduleService;

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
      makeRepo() as any,
      makeRepo() as any,
      {} as any,
      {} as any,
    );
  });

  it('returns empty list when no schedules match group filter', async () => {
    slotRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));

    const result = await service.listByZone('zone-1', 1, 20, 'group-1');

    expect(result).toEqual([[], 0]);
    expect(scheduleRepo.findAndCount).not.toHaveBeenCalled();
  });

  it('loads schedules by ids resolved from group slots', async () => {
    const qb = makeQueryBuilder([{ schedule_id: 'schedule-1' }, { schedule_id: 'schedule-2' }]);
    slotRepo.createQueryBuilder.mockReturnValue(qb);
    scheduleRepo.findAndCount.mockResolvedValue([
      [{ schedule_id: 'schedule-1', zone_id: 'zone-1', name: 'Morning' }],
      1,
    ]);

    await service.listByZone('zone-1', 2, 10, 'group-1');

    expect(qb.where).toHaveBeenCalledWith('slot.zone_id = :zoneId', { zoneId: 'zone-1' });
    expect(qb.andWhere).toHaveBeenCalledWith('slot.group_id = :groupId', { groupId: 'group-1' });
    expect(scheduleRepo.findAndCount).toHaveBeenCalledTimes(1);

    const args = scheduleRepo.findAndCount.mock.calls[0][0] as Record<string, any>;
    expect(args.where.zone_id).toBe('zone-1');
    expect(args.where.schedule_id).toBeDefined();
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
  });
});
