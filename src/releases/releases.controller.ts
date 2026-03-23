import { Controller, Delete, Get, Param, Query } from '@nestjs/common';
import { ScheduleService } from '../schedule/schedule.service';

@Controller('releases')
export class ReleasesController {
  constructor(private readonly svc: ScheduleService) {}

  @Get()
  async list(
    @Query('schedule_id') scheduleId?: string,
    @Query('zone_id') zoneId?: string,
    @Query('status') status?: string,
    @Query('published_from') publishedFrom?: string,
    @Query('published_to') publishedTo?: string,
    @Query('page') page = 1,
    @Query('page_size') pageSize = 20,
  ) {
    return this.svc.listReleases({
      schedule_id: scheduleId,
      zone_id: zoneId,
      status,
      published_from: publishedFrom,
      published_to: publishedTo,
      page: +page,
      page_size: +pageSize,
    });
  }

  @Get('latest')
  async getLatest(@Query('device_id') deviceId: string) {
    const release = await this.svc.getLatestReleaseForDevice(deviceId);
    return this.svc.toReleaseDto(release);
  }

  @Get(':releaseId/manifest')
  async getManifest(@Param('releaseId') id: string) {
    return this.svc.getReleaseManifest(id);
  }

  @Get(':releaseId/manifest-summary')
  async getManifestSummary(@Param('releaseId') id: string) {
    const release = await this.svc.getRelease(id);
    return {
      release_id: release.release_id,
      schedule_id: release.schedule_id,
      zone_id: release.zone_id,
      ...this.svc.getManifestSummary(release),
    };
  }

  @Get(':releaseId')
  async getRelease(@Param('releaseId') id: string) {
    const release = await this.svc.getRelease(id);
    return this.svc.toReleaseDto(release);
  }

  @Delete(':releaseId')
  async deleteRelease(@Param('releaseId') id: string) {
    return this.svc.deleteRelease(id);
  }
}
