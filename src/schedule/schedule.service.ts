import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThan, LessThanOrEqual, MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import { Schedule } from './schedule.entity';
import { ScheduleSlot } from './schedule-slot.entity';
import { ScheduleVersion } from '../versions/schedule-version.entity';
import { ScheduleRelease } from '../releases/schedule-release.entity';
import { SyncStrategyRouter } from '../strategy/strategy-router.service';
import { ManifestBuilder } from '../manifest/manifest-builder.service';
import { AuditClient } from '@campuscast/shared-libs';
import { randomUUID } from 'crypto';
import {
  buildDaySummaries,
  computeRangeForView,
  endExclusiveForDay,
  formatDateOnlyUtc,
  mergeDaySlots,
  parseDateOnly,
  type CalendarView,
  type SlotLike,
} from './schedule-view.utils';

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  private readonly auditClient = new AuditClient();
  private readonly signingUrl = process.env.SIGNING_KMS_URL || 'http://localhost:3008';
  private readonly validationQaUrl = process.env.VALIDATION_QA_URL || 'http://localhost:3007';
  private readonly syncServiceUrl = process.env.SYNC_SERVICE_URL || 'http://localhost:3006';
  private readonly contentServiceUrl = process.env.CONTENT_SERVICE_URL || 'http://localhost:3004';
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

  private normalizeQaValidationResult(payload: unknown): { valid: boolean; has_fatal: boolean; issues: any[] } {
    const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const issues = Array.isArray(data.issues) ? data.issues : [];
    const hasFatalFromIssues = issues.some(
      (issue) => issue && typeof issue === 'object' && (issue as { severity?: unknown }).severity === 'error',
    );
    const explicitHasFatal = typeof data.has_fatal === 'boolean' ? data.has_fatal : undefined;
    const explicitValid = typeof data.valid === 'boolean'
      ? data.valid
      : (typeof data.passed === 'boolean' ? data.passed : undefined);
    const hasFatal = explicitHasFatal ?? (explicitValid === false ? true : hasFatalFromIssues);

    return {
      valid: !hasFatal,
      has_fatal: hasFatal,
      issues,
    };
  }

  private async runQaValidation(scheduleId: string, schedule: Schedule) {
    try {
      const qaRes = await fetch(`${this.validationQaUrl}/validate/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule_id: scheduleId,
          zone_id: schedule.zone_id,
          slots: schedule.slots || [],
          asset_ids: (schedule.slots || []).map((s: any) => s.asset_id).filter(Boolean),
          publication_ids: (schedule.slots || []).map((s: any) => s.publication_id).filter(Boolean),
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!qaRes.ok) {
        return { valid: true, has_fatal: false, issues: [] };
      }

      const payload = await qaRes.json();
      return this.normalizeQaValidationResult(payload);
    } catch (err) {
      this.logger.warn(`Validation-QA unreachable: ${(err as Error).message}`);
      return { valid: true, has_fatal: false, issues: [] };
    }
  }

  async findOne(scheduleId: string): Promise<Schedule> {
    const schedule = await this.scheduleRepo.findOne({
      where: { schedule_id: scheduleId },
      relations: ['slots'],
    });
    if (!schedule) throw new NotFoundException('Schedule not found');
    return schedule;
  }

  async listByZone(zoneId: string, page: number, pageSize: number, groupId?: string) {
    if (!groupId) {
      return this.scheduleRepo.findAndCount({
        where: { zone_id: zoneId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        order: { created_at: 'DESC' },
      });
    }

    const rows = await this.slotRepo
      .createQueryBuilder('slot')
      .select('DISTINCT slot.schedule_id', 'schedule_id')
      .where('slot.zone_id = :zoneId', { zoneId })
      .andWhere('slot.group_id = :groupId', { groupId })
      .getRawMany<{ schedule_id: string }>();
    const scheduleIds = rows.map((row) => row.schedule_id).filter(Boolean);
    if (!scheduleIds.length) {
      return [[], 0] as const;
    }

    return this.scheduleRepo.findAndCount({
      where: { zone_id: zoneId, schedule_id: In(scheduleIds) },
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { created_at: 'DESC' },
    });
  }

  private async getSlotsByRange(scheduleId: string, fromInclusive: Date, toExclusive: Date): Promise<ScheduleSlot[]> {
    return this.slotRepo.find({
      where: {
        schedule_id: scheduleId,
        start_time: LessThan(toExclusive),
        end_time: MoreThan(fromInclusive),
      },
      order: { start_time: 'ASC', priority: 'DESC' },
    });
  }

  async getCalendarView(scheduleId: string, params: { view: CalendarView; date?: string; from?: string; to?: string }) {
    const schedule = await this.findOne(scheduleId);
    let range: ReturnType<typeof computeRangeForView>;
    try {
      range = computeRangeForView({
        view: params.view,
        date: params.date,
        from: params.from,
        to: params.to,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid date parameters');
    }
    const slots = await this.getSlotsByRange(scheduleId, range.from, range.to);
    const daySummaries = buildDaySummaries(slots as unknown as SlotLike[], range.from, range.to);

    const monthSummaryMap = new Map<string, { month: string; slot_count: number; total_duration_minutes: number }>();
    for (const summary of daySummaries) {
      const month = summary.date.slice(0, 7);
      const current = monthSummaryMap.get(month) || { month, slot_count: 0, total_duration_minutes: 0 };
      current.slot_count += summary.slot_count;
      current.total_duration_minutes += summary.total_duration_minutes;
      monthSummaryMap.set(month, current);
    }

    return {
      schedule_id: schedule.schedule_id,
      schedule_name: schedule.name,
      zone_id: schedule.zone_id,
      view: params.view,
      range: {
        from: formatDateOnlyUtc(range.from),
        to: formatDateOnlyUtc(new Date(range.to.getTime() - 1)),
        anchor: formatDateOnlyUtc(range.anchor),
      },
      summaries: daySummaries,
      months: Array.from(monthSummaryMap.values()).sort((a, b) => a.month.localeCompare(b.month)),
      slots,
    };
  }

  async getDayView(scheduleId: string, date: string) {
    const schedule = await this.findOne(scheduleId);
    let dayStart: Date;
    try {
      dayStart = parseDateOnly(date);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid date');
    }
    const dayEnd = endExclusiveForDay(dayStart);
    const slots = await this.getSlotsByRange(scheduleId, dayStart, dayEnd);

    const sorted = [...slots].sort(
      (a, b) => a.start_time.getTime() - b.start_time.getTime() || b.priority - a.priority,
    );
    const summary = buildDaySummaries(sorted as unknown as SlotLike[], dayStart, dayEnd)[0];

    return {
      schedule_id: schedule.schedule_id,
      schedule_name: schedule.name,
      status: schedule.status,
      zone_id: schedule.zone_id,
      date,
      summary,
      slots: sorted,
    };
  }

  async saveDay(scheduleId: string, date: string, slots: Partial<ScheduleSlot>[], lockToken?: string) {
    const schedule = await this.findOne(scheduleId);
    const nextDaySlots = slots.map((slot) => {
      const start = new Date(String(slot.start_time || ''));
      const end = new Date(String(slot.end_time || ''));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
        throw new BadRequestException('Invalid slot time range');
      }
      return {
        slot_id: slot.slot_id || randomUUID(),
        schedule_id: scheduleId,
        asset_id: String(slot.asset_id || ''),
        publication_id: String(slot.publication_id || ''),
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        priority: Number(slot.priority || 0),
        zone_id: String(slot.zone_id || schedule.zone_id),
        group_id: String(slot.group_id || ''),
        metadata: slot.metadata || {},
      } as SlotLike;
    });

    let merged: SlotLike[];
    try {
      merged = mergeDaySlots({
        existingSlots: schedule.slots as unknown as SlotLike[],
        date,
        nextDaySlots,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid date');
    }

    const zoneId = await this.getScheduleZoneId(scheduleId);
    const strategy = await this.strategyRouter.select(zoneId);
    await strategy.saveSlots(scheduleId, merged, lockToken);
    return this.getDayView(scheduleId, date);
  }

  async getScheduleUsage(zoneId: string) {
    const slots = await this.slotRepo.find({
      where: { zone_id: zoneId },
      select: ['asset_id', 'publication_id'],
    });

    const assets: Record<string, number> = {};
    const publications: Record<string, number> = {};

    for (const slot of slots) {
      if (slot.asset_id) {
        assets[slot.asset_id] = (assets[slot.asset_id] || 0) + 1;
      }
      if (slot.publication_id) {
        publications[slot.publication_id] = (publications[slot.publication_id] || 0) + 1;
      }
    }

    return {
      zone_id: zoneId,
      assets,
      publications,
    };
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
    return this.runQaValidation(scheduleId, schedule);
  }

  private async resolveManifestDependencies(schedule: Schedule) {
    const assetIds = Array.from(
      new Set((schedule.slots || []).map((slot: any) => slot.asset_id).filter(Boolean)),
    );
    const publicationIds = Array.from(
      new Set((schedule.slots || []).map((slot: any) => slot.publication_id).filter(Boolean)),
    );

    if (assetIds.length === 0 && publicationIds.length === 0) {
      return { assets: [], publications: [] };
    }

    const resolveRes = await fetch(`${this.contentServiceUrl}/content/resolve-manifest-deps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zone_id: schedule.zone_id,
        asset_ids: assetIds,
        publication_ids: publicationIds,
      }),
      signal: AbortSignal.timeout(7000),
    });

    if (!resolveRes.ok) {
      const detail = await resolveRes.text();
      this.logger.error(`Asset resolution failed: status=${resolveRes.status} detail=${detail}`);
      throw new BadRequestException({
        code: 'ASSET_RESOLUTION_FAILED',
        message: 'Failed to resolve content assets for manifest',
      });
    }

    const payload = await resolveRes.json() as {
      assets?: any[];
      missing_asset_ids?: string[];
      publications?: any[];
      missing_publication_ids?: string[];
    };

    if (payload.missing_asset_ids && payload.missing_asset_ids.length > 0) {
      throw new BadRequestException({
        code: 'ASSET_DESCRIPTOR_MISSING',
        missing_asset_ids: payload.missing_asset_ids,
      });
    }

    if (payload.missing_publication_ids && payload.missing_publication_ids.length > 0) {
      throw new BadRequestException({
        code: 'PUBLICATION_DESCRIPTOR_MISSING',
        missing_publication_ids: payload.missing_publication_ids,
      });
    }

    return {
      assets: payload.assets || [],
      publications: payload.publications || [],
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
    const qaResult = await this.runQaValidation(scheduleId, schedule);
    if (qaResult.has_fatal) {
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

    // 2. Build manifest with resolved content assets
    const resolved = await this.resolveManifestDependencies(schedule);
    const manifest = this.manifestBuilder.build({
      release_id: releaseId,
      schedule_id: scheduleId,
      zone_id: schedule.zone_id,
      version_number: versionNumber,
      slots: schedule.slots || [],
      assets: resolved.assets,
      publications: resolved.publications,
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
    return { release_id: releaseId, validation_passed: true, issues: qaResult.issues, rollout_status: 'rolling_out' };
  }

  async listReleases(filters: {
    schedule_id?: string;
    zone_id?: string;
    status?: string;
    published_from?: string;
    published_to?: string;
    page?: number;
    page_size?: number;
  }) {
    const page = Math.max(1, Number(filters.page || 1));
    const pageSize = Math.max(1, Math.min(100, Number(filters.page_size || 20)));
    const where: Record<string, unknown> = {};

    if (filters.schedule_id) where.schedule_id = filters.schedule_id;
    if (filters.zone_id) where.zone_id = filters.zone_id;
    if (filters.status) where.status = filters.status;

    const publishedFrom = filters.published_from ? new Date(filters.published_from) : null;
    const publishedTo = filters.published_to
      ? new Date(filters.published_to.includes('T') ? filters.published_to : `${filters.published_to}T23:59:59.999Z`)
      : null;
    if (publishedFrom && Number.isNaN(publishedFrom.getTime())) {
      throw new BadRequestException('Invalid published_from');
    }
    if (publishedTo && Number.isNaN(publishedTo.getTime())) {
      throw new BadRequestException('Invalid published_to');
    }

    if (publishedFrom && publishedTo) {
      where.published_at = Between(publishedFrom, publishedTo);
    } else if (publishedFrom) {
      where.published_at = MoreThanOrEqual(publishedFrom);
    } else if (publishedTo) {
      where.published_at = LessThanOrEqual(publishedTo);
    }

    const [rows, total] = await this.releaseRepo.findAndCount({
      where,
      order: { published_at: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const scheduleIds = Array.from(new Set(rows.map((row) => row.schedule_id).filter(Boolean)));
    const schedules = scheduleIds.length
      ? await this.scheduleRepo.find({
          where: { schedule_id: In(scheduleIds) },
          select: ['schedule_id', 'name'],
        })
      : [];
    const scheduleNameMap = new Map(schedules.map((schedule) => [schedule.schedule_id, schedule.name]));

    return {
      data: rows.map((row) => this.toReleaseDto(row, scheduleNameMap.get(row.schedule_id))),
      pagination: { total, page, page_size: pageSize },
    };
  }

  /** Get a release by ID (for player/gateway) */
  async getRelease(releaseId: string): Promise<ScheduleRelease> {
    const release = await this.releaseRepo.findOne({ where: { release_id: releaseId } });
    if (!release) throw new NotFoundException('Release not found');
    return release;
  }

  async deleteRelease(releaseId: string) {
    const release = await this.getRelease(releaseId);
    await this.releaseRepo.delete({ release_id: releaseId });

    this.auditClient.append({
      event_type: 'schedule.release_deleted',
      actor_type: 'system',
      actor_id: 'schedule-service',
      zone_id: release.zone_id,
      resource_type: 'release',
      resource_id: release.release_id,
      action: 'deleted',
      detail: {
        schedule_id: release.schedule_id,
        version_number: release.version_number,
      },
    });

    return {
      deleted: true,
      release_id: releaseId,
    };
  }

  getManifestSummary(release: ScheduleRelease) {
    const manifest = release.manifest_json || {};
    const slots = Array.isArray(manifest.slots) ? manifest.slots : [];
    const assets = Array.isArray(manifest.assets || manifest.files) ? (manifest.assets || manifest.files) : [];
    const publications = Array.isArray(manifest.publications) ? manifest.publications : [];
    return {
      slot_count: slots.length,
      asset_count: assets.length,
      publication_count: publications.length,
      manifest_hash: release.manifest_hash || '',
      has_signature: Boolean(release.manifest_signature),
    };
  }

  toReleaseDto(release: ScheduleRelease, scheduleName?: string) {
    return {
      release_id: release.release_id,
      schedule_id: release.schedule_id,
      schedule_name: scheduleName || '',
      version_number: release.version_number,
      zone_id: release.zone_id,
      target_group_ids: release.target_group_ids || [],
      manifest_url: release.manifest_url || '',
      manifest_signature: release.manifest_signature || '',
      manifest_key_id: release.manifest_key_id || '',
      manifest_present: Boolean(release.manifest_json || release.manifest_hash || release.manifest_url),
      status: release.status,
      published_at: release.published_at,
      manifest_summary: this.getManifestSummary(release),
    };
  }

  async getLatestReleaseForDevice(deviceId: string): Promise<ScheduleRelease> {
    const deviceRes = await fetch(`${this.deviceServiceUrl}/devices/${encodeURIComponent(deviceId)}/runtime`, {
      headers: {
        ...(this.internalServiceToken ? { 'x-internal-token': this.internalServiceToken } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (deviceRes.status === 404) throw new NotFoundException('Device not found');
    if (!deviceRes.ok) throw new ServiceUnavailableException('Device runtime validation unavailable');
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
      publications: mj?.publications || [],
      manifest_hash: release.manifest_hash || '',
      signature: release.manifest_signature,
      key_id: release.manifest_key_id,
      created_at: mj?.created_at || release.published_at?.toISOString() || '',
    };
  }
}
