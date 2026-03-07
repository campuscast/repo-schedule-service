import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial migration placeholder.
 * Tables: schedules, schedule_slots, schedule_versions, schedule_releases, op_log, schedule_snapshots
 *
 * In development, synchronize:true auto-creates tables from entities.
 * For production, generate real migrations with:
 *   npm run migrate:generate -- src/migrations/Init
 */
export class Init1700000000000 implements MigrationInterface {
  name = 'Init1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Auto-generated migration will be placed here.
    // Run: npm run migrate:generate
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert migration
  }
}
