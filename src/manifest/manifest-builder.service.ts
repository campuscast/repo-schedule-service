import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

export interface ManifestEntry {
  asset_id: string;
  filename: string;
  sha256_hash: string;
  download_url: string;
  size: number;
}

export interface ScheduleManifest {
  release_id: string;
  schedule_id: string;
  zone_id: string;
  version: number;
  files: ManifestEntry[];
  slots: any[];
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
    version: number;
    slots: any[];
    files: ManifestEntry[];
  }): ScheduleManifest {
    const manifest: ScheduleManifest = {
      release_id: params.release_id,
      schedule_id: params.schedule_id,
      zone_id: params.zone_id,
      version: params.version,
      files: params.files,
      slots: params.slots,
      created_at: new Date().toISOString(),
    };

    this.logger.log(`Manifest built: release=${params.release_id} files=${params.files.length} slots=${params.slots.length}`);
    return manifest;
  }

  hashManifest(manifest: ScheduleManifest): string {
    const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
    return createHash('sha256').update(canonical).digest('hex');
  }
}
