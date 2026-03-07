import { Injectable, Logger } from '@nestjs/common';
import { SyncStrategy } from './strategy.interface';
import { LockingStrategy } from './locking/locking.strategy';
import { CRDTStrategy } from './crdt/crdt.strategy';

/**
 * SyncStrategyRouter — selects strategy per zone based on feature flag.
 * Maps to L3A diagram: SyncStrategyRouter component.
 */
@Injectable()
export class SyncStrategyRouter {
  private readonly logger = new Logger(SyncStrategyRouter.name);
  private readonly zonePolicyUrl = process.env.ZONE_SERVICE_URL || 'http://localhost:3002';
  private readonly crdtGloballyEnabled = (process.env.CRDT_GLOBAL_ENABLED || 'true') === 'true';

  constructor(
    private readonly lockingStrategy: LockingStrategy,
    private readonly crdtStrategy: CRDTStrategy,
  ) {}

  /**
   * Select strategy for a given zone.
   * In production, queries ZonePolicyClient for `crdt_enabled`.
   */
  async select(zoneId: string): Promise<SyncStrategy> {
    let zonePolicyCrdtEnabled = false;
    try {
      const res = await fetch(`${this.zonePolicyUrl}/zones/${encodeURIComponent(zoneId)}/policy`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const policy = await res.json() as { crdt_enabled?: boolean };
        zonePolicyCrdtEnabled = policy.crdt_enabled === true;
      }
    } catch (err) {
      this.logger.warn(`Zone policy fetch failed for zone=${zoneId}: ${(err as Error).message}`);
    }

    if (this.crdtGloballyEnabled && zonePolicyCrdtEnabled) {
      this.logger.debug('Using CRDT strategy');
      return this.crdtStrategy;
    }
    this.logger.debug('Using Locking (Core) strategy');
    return this.lockingStrategy;
  }
}
