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

  constructor(
    private readonly lockingStrategy: LockingStrategy,
    private readonly crdtStrategy: CRDTStrategy,
  ) {}

  /**
   * Select strategy for a given zone.
   * In production, queries ZonePolicyClient for `crdt_enabled`.
   */
  select(crdtEnabled: boolean): SyncStrategy {
    if (crdtEnabled) {
      this.logger.debug('Using CRDT strategy');
      return this.crdtStrategy;
    }
    this.logger.debug('Using Locking (Core) strategy');
    return this.lockingStrategy;
  }
}
