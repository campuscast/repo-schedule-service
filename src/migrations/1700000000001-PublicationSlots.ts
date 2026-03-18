import { MigrationInterface, QueryRunner } from 'typeorm';

export class PublicationSlots1700000000001 implements MigrationInterface {
  name = 'PublicationSlots1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "schedule_slots"
      ADD COLUMN IF NOT EXISTS "publication_id" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "schedule_slots"
      DROP COLUMN IF EXISTS "publication_id"
    `);
  }
}
