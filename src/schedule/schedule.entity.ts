import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, Index } from 'typeorm';
import { ScheduleSlot } from './schedule-slot.entity';

@Entity('schedules')
@Index(['zone_id', 'created_at'])
export class Schedule {
  @PrimaryGeneratedColumn('uuid')
  schedule_id: string;

  @Column()
  zone_id: string;

  @Column()
  name: string;

  @Column({ default: 'draft' })
  status: string; // "draft", "locked", "published"

  @Column({ default: 0 })
  current_version: number;

  @Column({ nullable: true })
  locked_by: string;

  @Column({ nullable: true })
  lock_token: string;

  @Column({ nullable: true, type: 'timestamptz' })
  lock_expires_at: Date;

  @OneToMany(() => ScheduleSlot, s => s.schedule)
  slots: ScheduleSlot[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
