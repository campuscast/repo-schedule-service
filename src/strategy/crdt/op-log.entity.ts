import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * OpLogEntry — journal of CRDT operations (only when CRDT mode enabled).
 * Append-only. Compacted periodically via snapshots + epoch.
 */
@Entity('op_log')
@Index(['schedule_id', 'lamport_ts'])
@Index(['schedule_id', 'epoch'])
export class OpLogEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  schedule_id: string;

  @Column()
  operation_id: string; // globally unique

  @Column()
  op_type: string; // "add_slot", "remove_slot", "update_slot", "move_slot"

  @Column()
  client_id: string;

  @Column('bigint')
  lamport_ts: number;

  @Column('jsonb', { default: '{}' })
  vector_clock: Record<string, number>;

  @Column({ nullable: true })
  parent_op_id: string;

  @Column({ nullable: true })
  session_id: string;

  @Column('jsonb')
  slot_data: any; // ScheduleSlot data

  @Column('jsonb', { default: '{}' })
  params: Record<string, string>;

  @Column({ nullable: true })
  signature: string;

  @Column({ nullable: true })
  key_id: string;

  @Column({ default: 0 })
  epoch: number; // compaction epoch

  @Column({ default: false })
  is_tombstone: boolean;

  @CreateDateColumn()
  created_at: Date;
}
