import { Controller, Get, Param, Query } from '@nestjs/common';
import { ScheduleService } from '../schedule/schedule.service';

@Controller('releases')
export class ReleasesController {
  constructor(private readonly svc: ScheduleService) {}

  @Get('latest')
  async getLatest(@Query('device_id') deviceId: string) {
    const release = await this.svc.getLatestReleaseForDevice(deviceId);
    return this.svc.toReleaseDto(release);
  }

  @Get(':releaseId/manifest')
  async getManifest(@Param('releaseId') id: string) {
    return this.svc.getReleaseManifest(id);
  }

  @Get(':releaseId')
  async getRelease(@Param('releaseId') id: string) {
    const release = await this.svc.getRelease(id);
    return this.svc.toReleaseDto(release);
  }
}
