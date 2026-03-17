import { Controller, Post, Get, Delete, Param, Body, Query } from '@nestjs/common';
import { ScheduleService } from './schedule.service';

@Controller('schedules')
export class ScheduleController {
  constructor(private readonly svc: ScheduleService) {}

  @Post()
  async create(@Body() body: { zone_id: string; name: string }) {
    return this.svc.create(body.zone_id, body.name);
  }

  @Get()
  async list(@Query('zone_id') zoneId: string, @Query('page') page = 1, @Query('page_size') pageSize = 20) {
    const [data, total] = await this.svc.listByZone(zoneId, +page, +pageSize);
    return { data, pagination: { total, page: +page, page_size: +pageSize } };
  }

  @Get(':scheduleId')
  async get(@Param('scheduleId') id: string) {
    return this.svc.findOne(id);
  }

  @Post(':scheduleId/lock')
  async acquireLock(
    @Param('scheduleId') id: string,
    @Body() body: { user_id: string; ttl_seconds?: number },
  ) {
    return this.svc.acquireLock(id, body.user_id, body.ttl_seconds ?? 300);
  }

  @Delete(':scheduleId/lock')
  async releaseLock(
    @Param('scheduleId') id: string,
    @Body() body: { lock_token: string },
  ) {
    const released = await this.svc.releaseLock(id, body.lock_token);
    return { released };
  }

  @Post(':scheduleId/save')
  async saveDraft(
    @Param('scheduleId') id: string,
    @Body() body: { slots: any[]; lock_token: string },
  ) {
    return this.svc.saveDraft(id, body.slots, body.lock_token);
  }

  @Post(':scheduleId/ops')
  async ingestOps(
    @Param('scheduleId') id: string,
    @Body() body: { ops: any[] },
  ) {
    return this.svc.ingestOps(id, body.ops);
  }

  @Get(':scheduleId/snapshot')
  async getSnapshot(
    @Param('scheduleId') id: string,
    @Query('after_op_id') afterOpId?: string,
  ) {
    return this.svc.getSnapshot(id, afterOpId);
  }

  @Post(':scheduleId/version')
  async createVersion(
    @Param('scheduleId') id: string,
    @Body() body: { description: string },
  ) {
    return this.svc.createVersion(id, body.description);
  }

  @Post(':scheduleId/publish')
  async publish(
    @Param('scheduleId') id: string,
    @Body() body: { version_number: number; target_group_ids?: string[] },
  ) {
    return this.svc.publish(id, body.version_number, body.target_group_ids ?? []);
  }

  @Post(':scheduleId/validate')
  async validate(@Param('scheduleId') id: string) {
    return this.svc.validate(id);
  }
}
