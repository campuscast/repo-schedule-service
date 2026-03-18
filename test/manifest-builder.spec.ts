import { ManifestBuilder } from '../src/manifest/manifest-builder.service';

describe('ManifestBuilder publications support', () => {
  const builder = new ManifestBuilder();

  it('builds manifest with publications and stable hash', () => {
    const manifest = builder.build({
      release_id: 'release-1',
      schedule_id: 'schedule-1',
      zone_id: 'zone-1',
      version_number: 3,
      slots: [
        {
          slot_id: 'slot-1',
          publication_id: 'pub-1',
          start_time: '2030-01-01T10:00:00Z',
          end_time: '2030-01-01T11:00:00Z',
          priority: 10,
          zone_id: 'zone-1',
        },
      ],
      assets: [
        {
          asset_id: 'asset-1',
          filename: 'slide.png',
          content_type: 'image/png',
          file_size: 1024,
          sha256_hash: 'hash-1',
          download_url: 'https://cdn.example.com/slide.png',
          metadata: {},
        },
      ],
      publications: [
        {
          publication_id: 'pub-1',
          zone_id: 'zone-1',
          title: 'Morning news',
          type: 'slideshow',
          status: 'active',
          version: 2,
          items: [{ type: 'custom_slide' }],
          metadata: {},
        },
      ],
    });

    expect(manifest.publications).toHaveLength(1);
    expect(manifest.publications?.[0].publication_id).toBe('pub-1');

    const hashA = builder.hashManifest(manifest);
    const hashB = builder.hashManifest({
      ...manifest,
      publications: [...(manifest.publications || [])],
      slots: [...manifest.slots],
      assets: [...manifest.assets],
    });

    expect(hashA).toBe(hashB);
  });
});
