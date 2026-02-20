import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Schedule } from './schedule.entity';
import { ScheduleSlot } from './schedule-slot.entity';
import { ScheduleVersion } from '../versions/schedule-version.entity';
import { ScheduleRelease } from '../releases/schedule-release.entity';
import { SyncStrategyRouter } from '../strategy/strategy-router.service';
import { ManifestBuilder } from '../manifest/manifest-builder.service';
import { randomUUID } from 'crypto';

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    @InjectRepository(Schedule) private readonly scheduleRepo: Repository<Schedule>,
    @InjectRepository(ScheduleSlot) private readonly slotRepo: Repository<ScheduleSlot>,
    @InjectRepository(ScheduleVersion) private readonly versionRepo: Repository<ScheduleVersion>,
    @InjectRepository(ScheduleRelease) private readonly releaseRepo: Repository<ScheduleRelease>,
    private readonly strategyRouter: SyncStrategyRouter,
    private readonly manifestBuilder: ManifestBuilder,
  ) {}

  async create(zoneId: string, name: string): Promise<Schedule> {
    const schedule = this.scheduleRepo.create({ zone_id: zoneId, name, status: 'draft' });
    return this.scheduleRepo.save(schedule);
  }

  async findOne(scheduleId: string): Promise<Schedule> {
    const schedule = await this.scheduleRepo.findOne({
      where: { schedule_id: scheduleId },
      relations: ['slots'],
    });
    if (!schedule) throw new NotFoundException('Schedule not found');
    return schedule;
  }

  async listByZone(zoneId: string, page: number, pageSize: number) {
    return this.scheduleRepo.findAndCount({
      where: { zone_id: zoneId },
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { created_at: 'DESC' },
    });
  }

  async acquireLock(scheduleId: string, userId: string, ttlSeconds: number, crdtEnabled: boolean) {
    const strategy = this.strategyRouter.select(crdtEnabled);
    return strategy.acquireLock(scheduleId, userId, ttlSeconds);
  }

  async releaseLock(scheduleId: string, lockToken: string, crdtEnabled: boolean) {
    const strategy = this.strategyRouter.select(crdtEnabled);
    return strategy.releaseLock(scheduleId, lockToken);
  }

  async saveDraft(scheduleId: string, slots: any[], lockToken: string, crdtEnabled: boolean) {
    const strategy = this.strategyRouter.select(crdtEnabled);
    await strategy.saveSlots(scheduleId, slots, lockToken);
    return this.findOne(scheduleId);
  }

  async ingestOps(scheduleId: string, ops: any[], crdtEnabled: boolean) {
    const strategy = this.strategyRouter.select(crdtEnabled);
    return strategy.ingestOps(scheduleId, ops);
  }

  async getSnapshot(scheduleId: string, crdtEnabled: boolean) {
    const strategy = this.strategyRouter.select(crdtEnabled);
    return strategy.getSnapshot(scheduleId);
  }

  async createVersion(scheduleId: string, description: string) {
    const schedule = await this.findOne(scheduleId);
    const versionNumber = schedule.current_version + 1;

    const version = this.versionRepo.create({
      schedule_id: scheduleId,
      version_number: versionNumber,
      description,
      slots_snapshot: schedule.slots || [],
    });
    await this.versionRepo.save(version);

    schedule.current_version = versionNumber;
    await this.scheduleRepo.save(schedule);

    return version;
  }

  async publish(scheduleId: string, versionNumber: number, targetGroupIds: string[]) {
    const schedule = await this.findOne(scheduleId);
    const releaseId = randomUUID();

    const manifest = this.manifestBuilder.build({
      release_id: releaseId,
      schedule_id: scheduleId,
      zone_id: schedule.zone_id,
      version: versionNumber,
      slots: schedule.slots || [],
      files: [], // TODO: resolve from content service
    });

    const release = this.releaseRepo.create({
      release_id: releaseId,
      schedule_id: scheduleId,
      version_number: versionNumber,
      zone_id: schedule.zone_id,
      status: 'pending',
      target_group_ids: targetGroupIds,
    });
    await this.releaseRepo.save(release);

    this.logger.log(`Published: schedule=${scheduleId} release=${releaseId} version=${versionNumber}`);
    return { release_id: releaseId, validation_passed: true, issues: [] };
  }
}
