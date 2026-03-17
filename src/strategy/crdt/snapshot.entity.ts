import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('schedule_snapshots')
@Index(['schedule_id', 'epoch'])
export class ScheduleSnapshot {
  @PrimaryGeneratedColumn('uuid')
  snapshot_id: string;

  @Column()
  schedule_id: string;

  @Column()
  epoch: number;

  @Column('jsonb')
  slots: any[]; // materialized state at epoch

  @Column({ type: 'varchar', nullable: true })
  snapshot_hash: string | null;

  @Column({ type: 'varchar', nullable: true })
  last_operation_id: string | null; // pointer to last op included

  @CreateDateColumn()
  created_at: Date;
}
