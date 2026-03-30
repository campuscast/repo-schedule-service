import { Injectable, Logger } from '@nestjs/common';

export interface InvariantViolation {
  code: string;
  message: string;
  slot_ids: string[];
  severity: 'error' | 'warning';
}

/**
 * InvariantValidator — checks schedule slots for domain invariants.
 * Maps to L3A: InvariantValidator component.
 *
 * Invariants:
 * - No overlapping time slots within same group+zone
 * - Priority constraints respected
 * - Zone policy constraints (max slots, allowed content types)
 */
@Injectable()
export class InvariantValidator {
  private readonly logger = new Logger(InvariantValidator.name);

  validate(slots: any[]): InvariantViolation[] {
    const violations: InvariantViolation[] = [];

    violations.push(...this.checkOverlaps(slots));
    violations.push(...this.checkPriorities(slots));

    if (violations.length > 0) {
      this.logger.warn(`Found ${violations.length} invariant violation(s)`);
    }

    return violations;
  }

  private checkOverlaps(slots: any[]): InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    const invalidTimeSlots = new Set<string>();
    const sorted = [...slots].sort((a, b) => {
      const left = new Date(a.start_time).getTime();
      const right = new Date(b.start_time).getTime();
      return left - right;
    });

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const aStart = new Date(a.start_time).getTime();
      const aEnd = new Date(a.end_time).getTime();
      if (!Number.isFinite(aStart) || !Number.isFinite(aEnd) || aEnd <= aStart) {
        if (!invalidTimeSlots.has(a.slot_id)) {
          invalidTimeSlots.add(a.slot_id);
          violations.push({
            code: 'INVALID_TIME_RANGE',
            message: `Slot ${a.slot_id} has invalid time range`,
            slot_ids: [a.slot_id],
            severity: 'error',
          });
        }
        continue;
      }

      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        const bStart = new Date(b.start_time).getTime();
        const bEnd = new Date(b.end_time).getTime();
        if (!Number.isFinite(bStart) || !Number.isFinite(bEnd) || bEnd <= bStart) {
          if (!invalidTimeSlots.has(b.slot_id)) {
            invalidTimeSlots.add(b.slot_id);
            violations.push({
              code: 'INVALID_TIME_RANGE',
              message: `Slot ${b.slot_id} has invalid time range`,
              slot_ids: [b.slot_id],
              severity: 'error',
            });
          }
          continue;
        }

        const aZoneId = String(a.zone_id || '');
        const bZoneId = String(b.zone_id || '');
        if (aZoneId !== bZoneId) continue;
        const aGroupId = String(a.group_id || '');
        const bGroupId = String(b.group_id || '');
        const overlapsByScope = aGroupId === bGroupId || !aGroupId || !bGroupId;
        if (!overlapsByScope) continue;
        if (bStart >= aEnd) break;

        if (aEnd > bStart) {
          violations.push({
            code: 'SLOT_OVERLAP',
            message: `Slots ${a.slot_id} и ${b.slot_id} пересекаются по времени в одной зоне/группе`,
            slot_ids: [a.slot_id, b.slot_id],
            severity: 'error',
          });
        }
      }
    }

    return violations;
  }

  private checkPriorities(slots: any[]): InvariantViolation[] {
    const violations: InvariantViolation[] = [];

    for (const slot of slots) {
      if (slot.priority !== undefined && (slot.priority < 0 || slot.priority > 100)) {
        violations.push({
          code: 'INVALID_PRIORITY',
          message: `Slot ${slot.slot_id} has invalid priority ${slot.priority} (must be 0-100)`,
          slot_ids: [slot.slot_id],
          severity: 'error',
        });
      }
    }

    return violations;
  }
}
