import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Canonical ManifestAsset shape — aligned with repo-contracts/json-schemas/manifest/release-manifest.schema.json.
 * Uses `content_type`, `file_size`, and `metadata` to support desktop player and future publication editor.
 */
export interface ManifestAsset {
  asset_id: string;
  filename: string;
  content_type?: string;
  file_size?: number;
  sha256_hash: string;
  download_url: string;
  metadata?: Record<string, unknown>;
}

/**
 * Canonical ScheduleManifest shape — uses `version_number` and `assets` (not `version`/`files`).
 * Aligned with repo-contracts canonical schema.
 */
export interface ScheduleManifest {
  release_id: string;
  schedule_id: string;
  zone_id: string;
  version_number: number;
  slots: any[];
  assets: ManifestAsset[];
  manifest_hash?: string;
  signature?: string;
  key_id?: string;
  created_at: string;
}

/**
 * ManifestBuilder — assembles manifest for a schedule release.
 * Maps to L3A: ManifestBuilder component.
 */
@Injectable()
export class ManifestBuilder {
  private readonly logger = new Logger(ManifestBuilder.name);

  build(params: {
    release_id: string;
    schedule_id: string;
    zone_id: string;
    version_number: number;
    slots: any[];
    assets: ManifestAsset[];
  }): ScheduleManifest {
    const manifest: ScheduleManifest = {
      release_id: params.release_id,
      schedule_id: params.schedule_id,
      zone_id: params.zone_id,
      version_number: params.version_number,
      assets: params.assets,
      slots: params.slots,
      created_at: new Date().toISOString(),
    };

    this.logger.log(`Manifest built: release=${params.release_id} assets=${params.assets.length} slots=${params.slots.length}`);
    return manifest;
  }

  hashManifest(manifest: ScheduleManifest): string {
    const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
    return createHash('sha256').update(canonical).digest('hex');
  }
}
