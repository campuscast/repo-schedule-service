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
import { Init1700000000000 } from './migrations/1700000000000-Init';
import { PublicationSlots1700000000001 } from './migrations/1700000000001-PublicationSlots';
import { HealthController } from './common/health.controller';
import { appConfig, dbConfig, redisConfig, validate } from './config';

const dbSynchronize = process.env.DB_SYNCHRONIZE === 'true';
const dbMigrationsRun = process.env.DB_MIGRATIONS_RUN !== 'false';

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
      migrations: [Init1700000000000, PublicationSlots1700000000001],
      migrationsRun: dbMigrationsRun,
      synchronize: dbSynchronize,
      logging: process.env.NODE_ENV === 'development',
    }),
    ScheduleModule,
      MetricsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
