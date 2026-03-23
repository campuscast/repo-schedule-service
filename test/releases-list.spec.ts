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
  };
}

describe('ScheduleService.listReleases', () => {
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
      {} as any,
      {} as any,
    );
  });

  it('returns filtered release list with schedule names and manifest summary', async () => {
    releaseRepo.findAndCount.mockResolvedValue([
      [
        {
          release_id: 'release-1',
          schedule_id: 'schedule-1',
          version_number: 5,
          zone_id: 'zone-1',
          status: 'active',
          target_group_ids: ['group-1'],
          manifest_json: {
            slots: [{ slot_id: 'slot-1' }],
            assets: [{ asset_id: 'asset-1' }],
            publications: [{ publication_id: 'pub-1' }],
          },
          manifest_hash: 'hash-1',
          manifest_signature: 'sig-1',
          manifest_key_id: 'key-1',
          published_at: new Date('2026-03-20T10:00:00.000Z'),
        },
      ],
      1,
    ]);
    scheduleRepo.find.mockResolvedValue([{ schedule_id: 'schedule-1', name: 'Morning Loop' }]);

    const result = await service.listReleases({
      zone_id: 'zone-1',
      status: 'active',
      page: 2,
      page_size: 10,
    });

    expect(releaseRepo.findAndCount).toHaveBeenCalledTimes(1);
    expect(scheduleRepo.find).toHaveBeenCalledTimes(1);
    expect(result.pagination).toEqual({ total: 1, page: 2, page_size: 10 });
    expect(result.data[0]).toMatchObject({
      release_id: 'release-1',
      schedule_name: 'Morning Loop',
      target_group_ids: ['group-1'],
      manifest_present: true,
      manifest_summary: {
        slot_count: 1,
        asset_count: 1,
        publication_count: 1,
        manifest_hash: 'hash-1',
        has_signature: true,
      },
    });
  });
});
