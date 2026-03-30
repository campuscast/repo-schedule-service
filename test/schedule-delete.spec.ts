import { NotFoundException } from '@nestjs/common';
import { ScheduleService } from '../src/schedule/schedule.service';
import { Schedule } from '../src/schedule/schedule.entity';
import { ScheduleSlot } from '../src/schedule/schedule-slot.entity';
import { ScheduleVersion } from '../src/versions/schedule-version.entity';
import { ScheduleRelease } from '../src/releases/schedule-release.entity';
import { OpLogEntry } from '../src/strategy/crdt/op-log.entity';
import { ScheduleSnapshot } from '../src/strategy/crdt/snapshot.entity';

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
  manager: {
    transaction: jest.Mock;
  };
};

function makeRepo(managerDelete: jest.Mock): MockRepo {
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
    manager: {
      transaction: jest.fn(async (fn) => fn({ delete: managerDelete })),
    },
  };
}

describe('ScheduleService.deleteSchedule', () => {
  it('deletes schedule and related rows, including releases and slots', async () => {
    const managerDelete = jest.fn().mockResolvedValue(undefined);
    const scheduleRepo = makeRepo(managerDelete);
    const slotRepo = makeRepo(managerDelete);
    const versionRepo = makeRepo(managerDelete);
    const releaseRepo = makeRepo(managerDelete);
    const opLogRepo = makeRepo(managerDelete);
    const snapshotRepo = makeRepo(managerDelete);

    scheduleRepo.findOne.mockResolvedValue({
      schedule_id: 'schedule-1',
      zone_id: 'zone-1',
      name: 'Morning loop',
      lock_token: 'token-1',
    });

    const releaseLock = jest.fn().mockResolvedValue(true);
    const strategyRouter = {
      select: jest.fn().mockResolvedValue({ releaseLock }),
    };

    const service = new ScheduleService(
      scheduleRepo as any,
      slotRepo as any,
      versionRepo as any,
      releaseRepo as any,
      opLogRepo as any,
      snapshotRepo as any,
      strategyRouter as any,
      {} as any,
    );

    Object.defineProperty(service as any, 'auditClient', {
      value: { append: jest.fn() },
      writable: true,
    });

    const result = await service.deleteSchedule('schedule-1');

    expect(strategyRouter.select).toHaveBeenCalledWith('zone-1');
    expect(releaseLock).toHaveBeenCalledWith('schedule-1', 'token-1');
    expect(scheduleRepo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(managerDelete).toHaveBeenCalledWith(ScheduleRelease, { schedule_id: 'schedule-1' });
    expect(managerDelete).toHaveBeenCalledWith(ScheduleVersion, { schedule_id: 'schedule-1' });
    expect(managerDelete).toHaveBeenCalledWith(OpLogEntry, { schedule_id: 'schedule-1' });
    expect(managerDelete).toHaveBeenCalledWith(ScheduleSnapshot, { schedule_id: 'schedule-1' });
    expect(managerDelete).toHaveBeenCalledWith(ScheduleSlot, { schedule_id: 'schedule-1' });
    expect(managerDelete).toHaveBeenCalledWith(Schedule, { schedule_id: 'schedule-1' });
    expect(result).toEqual({ deleted: true, schedule_id: 'schedule-1' });
  });

  it('throws NotFoundException when schedule does not exist', async () => {
    const managerDelete = jest.fn().mockResolvedValue(undefined);
    const scheduleRepo = makeRepo(managerDelete);
    const slotRepo = makeRepo(managerDelete);
    const versionRepo = makeRepo(managerDelete);
    const releaseRepo = makeRepo(managerDelete);
    const opLogRepo = makeRepo(managerDelete);
    const snapshotRepo = makeRepo(managerDelete);

    scheduleRepo.findOne.mockResolvedValue(null);

    const service = new ScheduleService(
      scheduleRepo as any,
      slotRepo as any,
      versionRepo as any,
      releaseRepo as any,
      opLogRepo as any,
      snapshotRepo as any,
      {} as any,
      {} as any,
    );

    await expect(service.deleteSchedule('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
