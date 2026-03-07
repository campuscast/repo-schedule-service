import { Module } from '@nestjs/common';
import { MetricsModule } from '@campuscast/shared-libs';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from './schedule/schedule.module';
import { Schedule } from './schedule/schedule.entity';
import { ScheduleSlot } from './schedule/schedule-slot.entity';
import { ScheduleVersion } from './versions/schedule-version.entity';
import { ScheduleRelease } from './releases/schedule-release.entity';
import { OpLogEntry } from './strategy/crdt/op-log.entity';
import { ScheduleSnapshot } from './strategy/crdt/snapshot.entity';
import { HealthController } from './common/health.controller';
import { appConfig, dbConfig, redisConfig, validate } from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, dbConfig, redisConfig],
      validate,
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL || 'postgresql://campuscast:campuscast@localhost:5432/schedule_db',
      entities: [Schedule, ScheduleSlot, ScheduleVersion, ScheduleRelease, OpLogEntry, ScheduleSnapshot],
      synchronize: process.env.NODE_ENV === 'development',
    }),
    ScheduleModule,
      MetricsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
