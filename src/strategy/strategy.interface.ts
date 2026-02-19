/**
 * SyncStrategy — switchable strategy for schedule editing.
 * Selected per-zone based on zone policy `crdt_enabled` flag.
 *
 * LockingStrategy (Core): Redis pessimistic lock, direct save.
 * CRDTStrategy (Optional): op log, causal merge, snapshots.
 */
export interface SyncStrategy {
  /** Acquire edit rights (lock or no-op for CRDT) */
  acquireLock(scheduleId: string, userId: string, ttlSeconds: number): Promise<LockResult>;

  /** Release edit rights */
  releaseLock(scheduleId: string, lockToken: string): Promise<boolean>;

  /** Save schedule state (direct for locking, op-based for CRDT) */
  saveSlots(scheduleId: string, slots: any[], lockToken?: string): Promise<void>;

  /** Ingest operations (no-op for locking, core for CRDT) */
  ingestOps(scheduleId: string, ops: any[]): Promise<IngestResult>;

  /** Get current materialized state */
  getSnapshot(scheduleId: string): Promise<any>;
}

export interface LockResult {
  acquired: boolean;
  lock_token?: string;
  locked_by?: string;
  expires_at?: Date;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  results: OpResult[];
}

export interface OpResult {
  operation_id: string;
  accepted: boolean;
  reason?: string;
  compensating_ops?: any[];
  explanation?: string;
}
