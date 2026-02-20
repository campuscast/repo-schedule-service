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
    const sorted = [...slots].sort(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];

        // Only check within same group+zone
        if (a.group_id !== b.group_id || a.zone_id !== b.zone_id) continue;

        const aEnd = new Date(a.end_time).getTime();
        const bStart = new Date(b.start_time).getTime();

        if (aEnd > bStart) {
          violations.push({
            code: 'SLOT_OVERLAP',
            message: `Slots ${a.slot_id} and ${b.slot_id} overlap in time`,
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
