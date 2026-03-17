import { DataSource } from 'typeorm';
import { Schedule } from './src/schedule/schedule.entity';
import { ScheduleSlot } from './src/schedule/schedule-slot.entity';
import { ScheduleVersion } from './src/versions/schedule-version.entity';
import { ScheduleRelease } from './src/releases/schedule-release.entity';
import { OpLogEntry } from './src/strategy/crdt/op-log.entity';
import { ScheduleSnapshot } from './src/strategy/crdt/snapshot.entity';
import { Init1700000000000 } from './src/migrations/1700000000000-Init';

export default new DataSource({
  type: 'postgres',
  url:
    process.env.DATABASE_URL ||
    'postgresql://campuscast:campuscast@localhost:5432/schedule_db',
  entities: [
    Schedule,
    ScheduleSlot,
    ScheduleVersion,
    ScheduleRelease,
    OpLogEntry,
    ScheduleSnapshot,
  ],
  migrations: [Init1700000000000],
});
