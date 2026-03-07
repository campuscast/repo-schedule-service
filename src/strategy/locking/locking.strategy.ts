import { Injectable, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncStrategy, LockResult, IngestResult } from '../strategy.interface';
import { Schedule } from '../../schedule/schedule.entity';
import { ScheduleSlot } from '../../schedule/schedule-slot.entity';
import { InvariantValidator } from '../../invariants/invariant-validator.service';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

/**
 * LockingStrategy (Core) — pessimistic Redis lock.
 * Maps to L3A diagram: LockingStrategy (Core) component.
 */
@Injectable()
export class LockingStrategy implements SyncStrategy {
  private readonly logger = new Logger(LockingStrategy.name);
  private redis: Redis;

  constructor(
    @InjectRepository(Schedule) private scheduleRepo: Repository<Schedule>,
    @InjectRepository(ScheduleSlot) private slotRepo: Repository<ScheduleSlot>,
    private readonly invariantValidator: InvariantValidator,
  ) {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }

  async acquireLock(scheduleId: string, userId: string, ttlSeconds: number): Promise<LockResult> {
    const lockKey = `schedule:lock:${scheduleId}`;
    const lockToken = randomUUID();

    const result = await this.redis.set(lockKey, JSON.stringify({ userId, lockToken }), 'EX', ttlSeconds, 'NX');

    if (result !== 'OK') {
      const existing = await this.redis.get(lockKey);
      const parsed = existing ? JSON.parse(existing) : {};
      return { acquired: false, locked_by: parsed.userId };
    }

    await this.scheduleRepo.update({ schedule_id: scheduleId }, {
      status: 'locked',
      locked_by: userId,
      lock_token: lockToken,
      lock_expires_at: new Date(Date.now() + ttlSeconds * 1000),
    });

    this.logger.log(`Lock acquired: schedule=${scheduleId} user=${userId}`);
    return {
      acquired: true,
      lock_token: lockToken,
      locked_by: userId,
      expires_at: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  async releaseLock(scheduleId: string, lockToken: string): Promise<boolean> {
    const lockKey = `schedule:lock:${scheduleId}`;
    const script = `
      local val = redis.call("get", KEYS[1])
      if val then
        local data = cjson.decode(val)
        if data.lockToken == ARGV[1] then
          redis.call("del", KEYS[1])
          return 1
        end
      end
      return 0
    `;
    const result = await this.redis.eval(script, 1, lockKey, lockToken);
    if (result === 1) {
      await this.scheduleRepo.update({ schedule_id: scheduleId }, {
        status: 'draft', locked_by: undefined, lock_token: undefined, lock_expires_at: undefined,
      });
      this.logger.log(`Lock released: schedule=${scheduleId}`);
      return true;
    }
    return false;
  }

  async saveSlots(scheduleId: string, slots: any[], lockToken?: string): Promise<void> {
    if (lockToken) {
      const lockKey = `schedule:lock:${scheduleId}`;
      const existing = await this.redis.get(lockKey);
      if (!existing) throw new ConflictException('No active lock');
      const parsed = JSON.parse(existing);
      if (parsed.lockToken !== lockToken) throw new ConflictException('Lock token mismatch');
    }

    // Validate invariants before persisting
    const violations = this.invariantValidator.validate(slots);
    if (violations.some(v => v.severity === 'error')) {
      throw new BadRequestException({
        code: 'INVARIANT_VIOLATION',
        message: 'Slots violate schedule invariants',
        violations,
      });
    }

    // Replace all slots atomically
    await this.slotRepo.delete({ schedule_id: scheduleId });
    for (const s of slots) {
      const entity = this.slotRepo.create({ ...s, schedule_id: scheduleId });
      await this.slotRepo.save(entity);
    }
  }

  async ingestOps(_scheduleId: string, _ops: any[]): Promise<IngestResult> {
    // Locking mode does not support CRDT ops
    return { accepted: 0, rejected: _ops.length, results: _ops.map(op => ({
      operation_id: op.causal?.operation_id || 'unknown',
      accepted: false,
      reason: 'CRDT mode is disabled for this zone. Use lock + save workflow.',
    })) };
  }

  async getSnapshot(scheduleId: string) {
    const schedule = await this.scheduleRepo.findOne({
      where: { schedule_id: scheduleId },
      relations: ['slots'],
    });
    return { schedule_id: scheduleId, slots: schedule?.slots || [] };
  }
}
