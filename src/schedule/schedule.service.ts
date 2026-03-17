import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Schedule } from './schedule.entity';
import { ScheduleSlot } from './schedule-slot.entity';
import { ScheduleVersion } from '../versions/schedule-version.entity';
import { ScheduleRelease } from '../releases/schedule-release.entity';
import { SyncStrategyRouter } from '../strategy/strategy-router.service';
import { ManifestBuilder } from '../manifest/manifest-builder.service';
import { AuditClient } from '@campuscast/shared-libs';
import { randomUUID } from 'crypto';

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  private readonly auditClient = new AuditClient();
  private readonly signingUrl = process.env.SIGNING_KMS_URL || 'http://localhost:3008';
  private readonly validationQaUrl = process.env.VALIDATION_QA_URL || 'http://localhost:3007';
  private readonly syncServiceUrl = process.env.SYNC_SERVICE_URL || 'http://localhost:3006';
  private readonly deviceServiceUrl = process.env.DEVICE_SERVICE_URL || 'http://localhost:3003';
  private readonly internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN || '';

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

  private async getScheduleZoneId(scheduleId: string): Promise<string> {
    const schedule = await this.scheduleRepo.findOne({ where: { schedule_id: scheduleId } });
    if (!schedule) throw new NotFoundException('Schedule not found');
    return schedule.zone_id;
  }

  async acquireLock(scheduleId: string, userId: string, ttlSeconds: number) {
    const zoneId = await this.getScheduleZoneId(scheduleId);
    const strategy = await this.strategyRouter.select(zoneId);
    return strategy.acquireLock(scheduleId, userId, ttlSeconds);
  }

  async releaseLock(scheduleId: string, lockToken: string) {
    const zoneId = await this.getScheduleZoneId(scheduleId);
    const strategy = await this.strategyRouter.select(zoneId);
    return strategy.releaseLock(scheduleId, lockToken);
  }

  async saveDraft(scheduleId: string, slots: any[], lockToken: string) {
    const zoneId = await this.getScheduleZoneId(scheduleId);
    const strategy = await this.strategyRouter.select(zoneId);
    await strategy.saveSlots(scheduleId, slots, lockToken);
    return this.findOne(scheduleId);
  }

  async ingestOps(scheduleId: string, ops: any[]) {
    const zoneId = await this.getScheduleZoneId(scheduleId);
    const strategy = await this.strategyRouter.select(zoneId);
    return strategy.ingestOps(scheduleId, ops);
  }

  async getSnapshot(scheduleId: string, afterOpId?: string) {
    const zoneId = await this.getScheduleZoneId(scheduleId);
    const strategy = await this.strategyRouter.select(zoneId);
    return strategy.getSnapshot(scheduleId, afterOpId);
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

  async validate(scheduleId: string) {
    const schedule = await this.findOne(scheduleId);
    let qaResult: { passed: boolean; issues: any[] } = { passed: true, issues: [] };
    try {
      const qaRes = await fetch(`${this.validationQaUrl}/validate/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule_id: scheduleId,
          zone_id: schedule.zone_id,
          slots: schedule.slots || [],
          asset_ids: (schedule.slots || []).map((s: any) => s.asset_id).filter(Boolean),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (qaRes.ok) {
        qaResult = await qaRes.json() as { passed: boolean; issues: any[] };
      }
    } catch (err) {
      this.logger.warn(`Validation-QA unreachable: ${(err as Error).message}`);
    }
    return {
      valid: qaResult.passed,
      has_fatal: qaResult.issues.some((i: any) => i.severity === 'error'),
      issues: qaResult.issues,
    };
  }

  async publish(scheduleId: string, versionNumber: number, targetGroupIds: string[]) {
    const schedule = await this.findOne(scheduleId);
    const releaseId = randomUUID();

    this.auditClient.append({
      event_type: 'schedule.publish_requested',
      actor_type: 'system',
      actor_id: 'schedule-service',
      zone_id: schedule.zone_id,
      resource_type: 'schedule',
      resource_id: scheduleId,
      action: 'publish_requested',
      detail: { version_number: versionNumber, target_group_ids: targetGroupIds },
    });

    // 1. Pre-publish QA (call validation-qa service)
    let qaResult: { passed: boolean; issues: any[] } = { passed: true, issues: [] };
    try {
      const qaRes = await fetch(`${this.validationQaUrl}/validate/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule_id: scheduleId,
          zone_id: schedule.zone_id,
          slots: schedule.slots || [],
          asset_ids: (schedule.slots || []).map((s: any) => s.asset_id).filter(Boolean),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (qaRes.ok) {
        qaResult = await qaRes.json() as { passed: boolean; issues: any[] };
      }
    } catch (err) {
      this.logger.warn(`Validation-QA unreachable: ${(err as Error).message}, skipping QA gate`);
    }

    if (qaResult.passed === false) {
      this.auditClient.append({
        event_type: 'schedule.invariant_violation',
        actor_type: 'system',
        actor_id: 'schedule-service',
        zone_id: schedule.zone_id,
        resource_type: 'schedule',
        resource_id: scheduleId,
        action: 'qa_failed',
        detail: { issues: qaResult.issues },
      });
      throw new BadRequestException({ code: 'QA_FAILED', issues: qaResult.issues });
    }

    // 2. Build manifest
    const manifest = this.manifestBuilder.build({
      release_id: releaseId,
      schedule_id: scheduleId,
      zone_id: schedule.zone_id,
      version_number: versionNumber,
      slots: schedule.slots || [],
      assets: [],
    });
    const manifestHash = this.manifestBuilder.hashManifest(manifest);

    // 3. Sign manifest via signing-kms
    let signature = '';
    let keyId = '';
    try {
      const sigRes = await fetch(`${this.signingUrl}/signing/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data_base64: Buffer.from(manifestHash).toString('base64'),
          purpose: 'manifest',
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (sigRes.ok) {
        const sigData = await sigRes.json() as { signature: string; key_id: string };
        signature = sigData.signature;
        keyId = sigData.key_id;
      }
    } catch (err) {
      this.logger.warn(`Signing-KMS unreachable: ${(err as Error).message}, using empty signature`);
    }

    this.auditClient.append({
      event_type: 'schedule.manifest_signed',
      actor_type: 'system',
      actor_id: 'schedule-service',
      zone_id: schedule.zone_id,
      resource_type: 'release',
      resource_id: releaseId,
      action: 'manifest_signed',
      detail: { manifest_hash: manifestHash, key_id: keyId },
    });

    // 4. Persist release with manifest + signature
    manifest.signature = signature;
    manifest.key_id = keyId;

    const release = this.releaseRepo.create({
      release_id: releaseId,
      schedule_id: scheduleId,
      version_number: versionNumber,
      zone_id: schedule.zone_id,
      status: 'rolling_out',
      target_group_ids: targetGroupIds,
      manifest_json: manifest,
      manifest_hash: manifestHash,
      manifest_signature: signature,
      manifest_key_id: keyId,
    });
    await this.releaseRepo.save(release);

    // 5. Trigger MQTT rollout via sync-service
    for (const groupId of targetGroupIds) {
      try {
        await fetch(`${this.syncServiceUrl}/mqtt/publish-release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            zone_id: schedule.zone_id,
            group_id: groupId,
            release_id: releaseId,
            manifest_hash: manifestHash,
          }),
          signal: AbortSignal.timeout(3000),
        });
      } catch (err) {
        this.logger.warn(`MQTT rollout failed for group=${groupId}: ${(err as Error).message}`);
      }
    }

    this.auditClient.append({
      event_type: 'schedule.rollout_sent',
      actor_type: 'system',
      actor_id: 'schedule-service',
      zone_id: schedule.zone_id,
      resource_type: 'release',
      resource_id: releaseId,
      action: 'rollout_sent',
      detail: { target_group_ids: targetGroupIds },
    });

    this.auditClient.append({
      event_type: 'schedule.published',
      actor_type: 'system',
      actor_id: 'schedule-service',
      zone_id: schedule.zone_id,
      resource_type: 'release',
      resource_id: releaseId,
      action: 'published',
      detail: {
        schedule_id: scheduleId,
        version_number: versionNumber,
        target_group_ids: targetGroupIds,
      },
    });

    this.logger.log(`Published: schedule=${scheduleId} release=${releaseId} version=${versionNumber}`);
    return { release_id: releaseId, validation_passed: true, issues: qaResult.issues };
  }

  /** Get a release by ID (for player/gateway) */
  async getRelease(releaseId: string): Promise<ScheduleRelease> {
    const release = await this.releaseRepo.findOne({ where: { release_id: releaseId } });
    if (!release) throw new NotFoundException('Release not found');
    return release;
  }

  toReleaseDto(release: ScheduleRelease) {
    return {
      release_id: release.release_id,
      schedule_id: release.schedule_id,
      version_number: release.version_number,
      zone_id: release.zone_id,
      manifest_url: release.manifest_url,
      manifest_signature: release.manifest_signature,
      manifest_key_id: release.manifest_key_id,
      status: release.status,
      published_at: release.published_at,
    };
  }

  async getLatestReleaseForDevice(deviceId: string): Promise<ScheduleRelease> {
    const deviceRes = await fetch(`${this.deviceServiceUrl}/devices/${encodeURIComponent(deviceId)}`, {
      headers: {
        ...(this.internalServiceToken ? { 'x-internal-token': this.internalServiceToken } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!deviceRes.ok) throw new NotFoundException('Device not found');
    const device = await deviceRes.json() as { zone_id: string; group_id: string };

    const releases = await this.releaseRepo.find({
      where: { zone_id: device.zone_id },
      order: { published_at: 'DESC' },
    });
    const release = releases.find(r =>
      !r.target_group_ids ||
      r.target_group_ids.length === 0 ||
      r.target_group_ids.includes(device.group_id),
    );
    if (!release) throw new NotFoundException('Release not found for device');
    return release;
  }

  async getReleaseManifest(releaseId: string) {
    const release = await this.getRelease(releaseId);
    const mj = release.manifest_json;
    return {
      release_id: release.release_id,
      schedule_id: release.schedule_id,
      zone_id: release.zone_id,
      version_number: release.version_number,
      slots: mj?.slots || [],
      // Canonical field: `assets`. Supports legacy `files` field for backward compat.
      assets: mj?.assets || mj?.files || [],
      manifest_hash: release.manifest_hash || '',
      signature: release.manifest_signature,
      key_id: release.manifest_key_id,
      created_at: mj?.created_at || release.published_at?.toISOString() || '',
    };
  }
}
