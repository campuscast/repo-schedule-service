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

export interface ManifestPublication {
  publication_id: string;
  zone_id: string;
  title: string;
  type: string;
  status: string;
  version: number;
  items: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
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
  publications?: ManifestPublication[];
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

  private normalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => this.normalize(item));

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const raw = (value as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      out[key] = this.normalize(raw);
    }
    return out;
  }

  build(params: {
    release_id: string;
    schedule_id: string;
    zone_id: string;
    version_number: number;
    slots: any[];
    assets: ManifestAsset[];
    publications?: ManifestPublication[];
  }): ScheduleManifest {
    const manifest: ScheduleManifest = {
      release_id: params.release_id,
      schedule_id: params.schedule_id,
      zone_id: params.zone_id,
      version_number: params.version_number,
      assets: params.assets,
      publications: params.publications || [],
      slots: params.slots,
      created_at: new Date().toISOString(),
    };

    this.logger.log(`Manifest built: release=${params.release_id} assets=${params.assets.length} slots=${params.slots.length}`);
    return manifest;
  }

  hashManifest(manifest: ScheduleManifest): string {
    const canonical = JSON.stringify(this.normalize(manifest));
    return createHash('sha256').update(canonical).digest('hex');
  }
}
