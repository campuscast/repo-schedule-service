import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('schedule_versions')
@Index(['schedule_id', 'version_number'])
export class ScheduleVersion {
  @PrimaryGeneratedColumn('uuid')
  version_id: string;

  @Column()
  schedule_id: string;

  @Column()
  version_number: number;

  @Column({ nullable: true })
  description: string;

  @Column('jsonb', { default: '[]' })
  slots_snapshot: any[]; // frozen copy of slots at version time

  @CreateDateColumn()
  created_at: Date;
}
