import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('schedule_releases')
@Index(['zone_id', 'published_at'])
export class ScheduleRelease {
  @PrimaryGeneratedColumn('uuid')
  release_id: string;

  @Column()
  schedule_id: string;

  @Column()
  version_number: number;

  @Column()
  zone_id: string;

  @Column({ nullable: true })
  manifest_url: string;

  @Column('jsonb', { nullable: true })
  manifest_json: any;

  @Column({ nullable: true })
  manifest_hash: string;

  @Column({ nullable: true })
  manifest_signature: string;

  @Column({ nullable: true })
  manifest_key_id: string;

  @Column({ default: 'pending' })
  status: string; // "pending", "rolling_out", "active", "rolled_back"

  @Column('simple-array', { nullable: true })
  target_group_ids: string[];

  @CreateDateColumn()
  published_at: Date;
}
