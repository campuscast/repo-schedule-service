import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Schedule } from './schedule.entity';
import { ScheduleSlot } from './schedule-slot.entity';
import { ScheduleVersion } from '../versions/schedule-version.entity';
import { ScheduleRelease } from '../releases/schedule-release.entity';
import { OpLogEntry } from '../strategy/crdt/op-log.entity';
import { ScheduleSnapshot } from '../strategy/crdt/snapshot.entity';
import { ScheduleController } from './schedule.controller';
import { ReleasesController } from '../releases/releases.controller';
import { ScheduleService } from './schedule.service';
import { SyncStrategyRouter } from '../strategy/strategy-router.service';
import { LockingStrategy } from '../strategy/locking/locking.strategy';
import { CRDTStrategy } from '../strategy/crdt/crdt.strategy';
import { InvariantValidator } from '../invariants/invariant-validator.service';
import { AutoTransformService } from '../auto-transform/auto-transform.service';
import { ManifestBuilder } from '../manifest/manifest-builder.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Schedule,
      ScheduleSlot,
      ScheduleVersion,
      ScheduleRelease,
      OpLogEntry,
      ScheduleSnapshot,
    ]),
  ],
  controllers: [ScheduleController, ReleasesController],
  providers: [
    ScheduleService,
    SyncStrategyRouter,
    LockingStrategy,
    CRDTStrategy,
    InvariantValidator,
    AutoTransformService,
    ManifestBuilder,
  ],
  exports: [ScheduleService],
})
export class ScheduleModule {}
