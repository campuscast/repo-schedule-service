import { Controller, Get } from '@nestjs/common';
@Controller('health')
export class HealthController {
  @Get() check() { return { status: 'ok', service: 'schedule-service' }; }
  @Get('ready') ready() { return { status: 'ok' }; }
  @Get('live') live() { return { status: 'ok' }; }
}
