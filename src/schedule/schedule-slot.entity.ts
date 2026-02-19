import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Schedule } from './schedule.entity';

@Entity('schedule_slots')
@Index(['schedule_id', 'start_time'])
@Index(['zone_id', 'start_time', 'end_time'])
export class ScheduleSlot {
  @PrimaryGeneratedColumn('uuid')
  slot_id: string;

  @Column()
  schedule_id: string;

  @Column({ nullable: true })
  asset_id: string;

  @Column('timestamptz')
  start_time: Date;

  @Column('timestamptz')
  end_time: Date;

  @Column({ default: 0 })
  priority: number;

  @Column()
  zone_id: string;

  @Column({ nullable: true })
  group_id: string;

  @Column('jsonb', { default: '{}' })
  metadata: Record<string, string>;

  @ManyToOne(() => Schedule, s => s.slots)
  @JoinColumn({ name: 'schedule_id' })
  schedule: Schedule;
}
