export interface ProposedOperation {
  operation: string;
  parameters: Record<string, unknown>;
  justification: string;
}

export interface PlanProposal {
  intent: string;
  operations: ProposedOperation[];
  confidence: number;
  explanation: string;
  uncertainty?: string;
}

export interface MinimizedContext {
  requesterName: string;
  timestamp: number;
}

export interface IAIPlannerProvider {
  name: string;
  generatePlan(requestText: string, context: MinimizedContext): Promise<PlanProposal>;
  validatePlanSchema(plan: unknown): { valid: boolean; errors?: string[] };
}

export class LocalHeuristicPlanner implements IAIPlannerProvider {
  public readonly name = 'local-heuristic-v1';

  private static readonly ALLOWED_OPERATIONS = new Set([
    'system:get_os_info',
    'system:get_memory_info',
    'system:get_battery_status',
    'system:get_disk_space',
    'app:launch',
  ]);

  public validatePlanSchema(plan: unknown): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!plan || typeof plan !== 'object') {
      return { valid: false, errors: ['Plan must be a valid non-null object'] };
    }

    const p = plan as Record<string, unknown>;
    if (typeof p.intent !== 'string' || !p.intent.trim()) {
      errors.push('Missing or invalid "intent" string');
    }
    if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) {
      errors.push('Invalid "confidence" value (must be float between 0.0 and 1.0)');
    }
    if (typeof p.explanation !== 'string') {
      errors.push('Missing or invalid "explanation" string');
    }
    if (!Array.isArray(p.operations)) {
      errors.push('"operations" must be an array');
    } else {
      for (let i = 0; i < p.operations.length; i++) {
        const op = p.operations[i];
        if (!op || typeof op !== 'object') {
          errors.push(`Operation at index ${i} is not an object`);
          continue;
        }
        const opObj = op as Record<string, unknown>;
        if (typeof opObj.operation !== 'string' || !LocalHeuristicPlanner.ALLOWED_OPERATIONS.has(opObj.operation)) {
          errors.push(`Operation '${String(opObj.operation)}' at index ${i} is not allowlisted`);
        }
        if (!opObj.parameters || typeof opObj.parameters !== 'object' || Array.isArray(opObj.parameters)) {
          errors.push(`Parameters for operation at index ${i} must be an object`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  public async generatePlan(requestText: string, _context: MinimizedContext): Promise<PlanProposal> {
    const text = requestText.toLowerCase().trim();

    // 1. System info requests
    if (text.includes('os') || text.includes('system') || text.includes('specs') || text.includes('version')) {
      return {
        intent: 'Query Windows OS version and specs',
        operations: [
          {
            operation: 'system:get_os_info',
            parameters: {},
            justification: 'User asked for OS/system information',
          },
        ],
        confidence: 0.95,
        explanation: 'Interpreted as read-only OS fact query',
      };
    }

    if (text.includes('ram') || text.includes('memory')) {
      return {
        intent: 'Query system memory status',
        operations: [
          {
            operation: 'system:get_memory_info',
            parameters: {},
            justification: 'User asked for RAM/memory metrics',
          },
        ],
        confidence: 0.95,
        explanation: 'Interpreted as read-only memory query',
      };
    }

    if (text.includes('battery') || text.includes('power') || text.includes('charge')) {
      return {
        intent: 'Query laptop battery status',
        operations: [
          {
            operation: 'system:get_battery_status',
            parameters: {},
            justification: 'User asked for battery status',
          },
        ],
        confidence: 0.9,
        explanation: 'Interpreted as battery query',
      };
    }

    // Guard against destructive intent
    if (text.includes('format') || text.includes('delete') || text.includes('wipe') || text.includes('destroy') || text.includes('remove') || text.includes('drop')) {
      return {
        intent: 'Prohibited destructive action',
        operations: [],
        confidence: 0.99,
        explanation: 'Destructive or file modification actions are strictly prohibited by policy',
        uncertainty: 'Action violates safety invariants',
      };
    }

    if (text.includes('disk') || text.includes('storage') || text.includes('drive space')) {
      return {
        intent: 'Query C: drive disk space',
        operations: [
          {
            operation: 'system:get_disk_space',
            parameters: { drive: 'C:' },
            justification: 'User asked for disk/storage status',
          },
        ],
        confidence: 0.9,
        explanation: 'Interpreted as C: disk space query',
      };
    }

    // 2. Application launch requests
    if (text.includes('notepad') || text.includes('notes')) {
      return {
        intent: 'Launch Notepad application',
        operations: [
          {
            operation: 'app:launch',
            parameters: { appId: 'notepad' },
            justification: 'User requested launching Notepad',
          },
        ],
        confidence: 0.95,
        explanation: 'Interpreted as launching allowlisted Notepad application',
      };
    }

    if (text.includes('calc') || text.includes('calculator')) {
      return {
        intent: 'Launch Calculator application',
        operations: [
          {
            operation: 'app:launch',
            parameters: { appId: 'calc' },
            justification: 'User requested launching Calculator',
          },
        ],
        confidence: 0.95,
        explanation: 'Interpreted as launching allowlisted Calculator application',
      };
    }

    if (text.includes('paint') || text.includes('draw')) {
      return {
        intent: 'Launch Paint application',
        operations: [
          {
            operation: 'app:launch',
            parameters: { appId: 'mspaint' },
            justification: 'User requested launching Paint',
          },
        ],
        confidence: 0.95,
        explanation: 'Interpreted as launching allowlisted Paint application',
      };
    }

    // Default: ambiguous or unsupported
    return {
      intent: 'Unknown intent',
      operations: [],
      confidence: 0.1,
      explanation: 'Could not map request to any allowlisted capability',
      uncertainty: 'Request does not match any authorized capability',
    };
  }
}
