import { Injectable, Logger } from '@nestjs/common';
import { InvariantViolation } from '../invariants/invariant-validator.service';

export interface AutoTransformResult {
  compensating_ops: CompensatingOp[];
  explanation: string;
}

export interface CompensatingOp {
  op_type: string;
  slot: any;
  explanation: string;
}

/**
 * AutoTransformService — split/shift/priority fixes for invariant violations.
 * Maps to L3A: AutoTransformExplainer component.
 *
 * Generates compensating operations with human-readable explanations.
 */
@Injectable()
export class AutoTransformService {
  private readonly logger = new Logger(AutoTransformService.name);

  fix(slots: any[], violations: InvariantViolation[]): AutoTransformResult {
    const compensating_ops: CompensatingOp[] = [];
    const explanations: string[] = [];

    for (const violation of violations) {
      switch (violation.code) {
        case 'SLOT_OVERLAP':
          compensating_ops.push(...this.fixOverlap(slots, violation));
          explanations.push(`Auto-shifted overlapping slots: ${violation.slot_ids.join(', ')}`);
          break;
        case 'INVALID_PRIORITY':
          compensating_ops.push(...this.fixPriority(slots, violation));
          explanations.push(`Auto-clamped priority for slot: ${violation.slot_ids.join(', ')}`);
          break;
        default:
          this.logger.warn(`No auto-fix for violation code: ${violation.code}`);
      }
    }

    return {
      compensating_ops,
      explanation: explanations.join('; '),
    };
  }

  private fixOverlap(slots: any[], violation: InvariantViolation): CompensatingOp[] {
    if (violation.slot_ids.length < 2) return [];

    const [idA, idB] = violation.slot_ids;
    const slotA = slots.find(s => s.slot_id === idA);
    const slotB = slots.find(s => s.slot_id === idB);

    if (!slotA || !slotB) return [];

    // Strategy: shift slotB to start after slotA ends
    const aEnd = new Date(slotA.end_time).getTime();
    const bDuration = new Date(slotB.end_time).getTime() - new Date(slotB.start_time).getTime();

    return [{
      op_type: 'move_slot',
      slot: {
        slot_id: slotB.slot_id,
        start_time: new Date(aEnd).toISOString(),
        end_time: new Date(aEnd + bDuration).toISOString(),
      },
      explanation: `Shifted slot ${idB} to start after slot ${idA} ends (was overlapping)`,
    }];
  }

  private fixPriority(slots: any[], violation: InvariantViolation): CompensatingOp[] {
    return violation.slot_ids.map(slotId => {
      const slot = slots.find(s => s.slot_id === slotId);
      const clampedPriority = Math.max(0, Math.min(100, slot?.priority ?? 0));

      return {
        op_type: 'update_slot',
        slot: { slot_id: slotId, priority: clampedPriority },
        explanation: `Clamped priority for slot ${slotId} to ${clampedPriority}`,
      };
    });
  }
}
