import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Real initial migration for schedule_db.
 * Tables: schedules, schedule_slots, schedule_versions, schedule_releases, op_log, schedule_snapshots
 */
export class Init1700000000000 implements MigrationInterface {
  name = 'Init1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "schedules" (
        "schedule_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "zone_id" character varying NOT NULL,
        "name" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "current_version" integer NOT NULL DEFAULT 0,
        "locked_by" character varying,
        "lock_token" character varying,
        "lock_expires_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_schedules" PRIMARY KEY ("schedule_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_schedules_zone_created"
        ON "schedules" ("zone_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "schedule_slots" (
        "slot_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schedule_id" uuid NOT NULL,
        "asset_id" character varying,
        "start_time" TIMESTAMP WITH TIME ZONE NOT NULL,
        "end_time" TIMESTAMP WITH TIME ZONE NOT NULL,
        "priority" integer NOT NULL DEFAULT 0,
        "zone_id" character varying NOT NULL,
        "group_id" character varying,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_schedule_slots" PRIMARY KEY ("slot_id"),
        CONSTRAINT "FK_schedule_slots_schedule" FOREIGN KEY ("schedule_id")
          REFERENCES "schedules"("schedule_id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_slots_schedule_start"
        ON "schedule_slots" ("schedule_id", "start_time")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_slots_zone_time"
        ON "schedule_slots" ("zone_id", "start_time", "end_time")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "schedule_versions" (
        "version_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schedule_id" character varying NOT NULL,
        "version_number" integer NOT NULL,
        "description" character varying,
        "slots_snapshot" jsonb NOT NULL DEFAULT '[]',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_schedule_versions" PRIMARY KEY ("version_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_versions_schedule_num"
        ON "schedule_versions" ("schedule_id", "version_number")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "schedule_releases" (
        "release_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schedule_id" character varying NOT NULL,
        "version_number" integer NOT NULL,
        "zone_id" character varying NOT NULL,
        "manifest_url" character varying,
        "manifest_json" jsonb,
        "manifest_hash" character varying,
        "manifest_signature" character varying,
        "manifest_key_id" character varying,
        "status" character varying NOT NULL DEFAULT 'pending',
        "target_group_ids" text,
        "published_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_schedule_releases" PRIMARY KEY ("release_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_releases_zone_published"
        ON "schedule_releases" ("zone_id", "published_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "op_log" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schedule_id" character varying NOT NULL,
        "operation_id" character varying NOT NULL,
        "op_type" character varying NOT NULL,
        "client_id" character varying NOT NULL,
        "user_id" character varying,
        "device_id" character varying,
        "lamport_ts" bigint NOT NULL,
        "vector_clock" jsonb NOT NULL DEFAULT '{}',
        "parent_op_id" character varying,
        "session_id" character varying,
        "slot_data" jsonb NOT NULL,
        "params" jsonb NOT NULL DEFAULT '{}',
        "signature" character varying,
        "key_id" character varying,
        "epoch" integer NOT NULL DEFAULT 0,
        "is_tombstone" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_op_log" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_op_log_operation_id" UNIQUE ("operation_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_oplog_schedule_lamport"
        ON "op_log" ("schedule_id", "lamport_ts")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_oplog_schedule_epoch"
        ON "op_log" ("schedule_id", "epoch")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "schedule_snapshots" (
        "snapshot_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schedule_id" character varying NOT NULL,
        "epoch" integer NOT NULL,
        "slots" jsonb NOT NULL,
        "snapshot_hash" character varying,
        "last_operation_id" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_schedule_snapshots" PRIMARY KEY ("snapshot_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_snapshots_schedule_epoch"
        ON "schedule_snapshots" ("schedule_id", "epoch")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "op_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_releases"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_slots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "schedules"`);
  }
}
