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
    'desktop:launch_and_type',
    'desktop:type_text',
    'desktop:paste_text',
    'desktop:hotkey',
    'desktop:zoom',
    'desktop:copy_selection',
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

    // Reject destructive language before broad system-information matching.
    if (/\b(format|delete|wipe|destroy|remove|drop)\b/.test(text)) {
      return {
        intent: 'Prohibited destructive action',
        operations: [],
        confidence: 0.99,
        explanation: 'Destructive or file modification actions are strictly prohibited by policy',
        uncertainty: 'Action violates safety invariants',
      };
    }

    // Prefer specific system facts before the broader OS/system-intent terms.
    if (/\b(ram|memory)\b/.test(text)) {
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

    if (/\b(battery|power|charge)\b/.test(text)) {
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

    if (/\b(disk|storage)\b|drive\s+space/.test(text)) {
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

    // Explicit desktop interaction requests. The policy gateway still requires approval.
    if (/\b(zoom in|zoom closer|enlarge)\b/.test(text)) {
      return { intent: 'Zoom in on the foreground application', operations: [{ operation: 'desktop:zoom', parameters: { direction: 'in' }, justification: 'User explicitly requested zoom in' }], confidence: 0.9, explanation: 'Will send the foreground app zoom-in shortcut after approval.' };
    }
    if (/\b(zoom out|zoom smaller|shrink)\b/.test(text)) {
      return { intent: 'Zoom out on the foreground application', operations: [{ operation: 'desktop:zoom', parameters: { direction: 'out' }, justification: 'User explicitly requested zoom out' }], confidence: 0.9, explanation: 'Will send the foreground app zoom-out shortcut after approval.' };
    }
    if (/\b(reset zoom|normal zoom)\b/.test(text)) {
      return { intent: 'Reset foreground application zoom', operations: [{ operation: 'desktop:zoom', parameters: { direction: 'reset' }, justification: 'User explicitly requested zoom reset' }], confidence: 0.9, explanation: 'Will send the foreground app zoom reset shortcut after approval.' };
    }
    if (/\bopen\s+(?:the\s+)?notepad\b.*\bwrite\s+(?:my name|my full name)\b/i.test(requestText)) {
      return { intent: 'Owner profile detail required', operations: [], confidence: 0.95, explanation: 'I do not have a verified owner name configured. Tell me the exact name to write or save it in your owner profile first.', uncertainty: 'Owner name is not available in verified profile context.' };
    }
    const launchAndType = requestText.match(/\bopen\s+(?:the\s+)?(notepad|calculator|paint)\b.*\b(?:write|type|enter)\s+[“"]?(.+?)[”"]?\s*$/i);
    if (launchAndType && launchAndType[2].trim()) {
      const appId = launchAndType[1].toLowerCase() === 'calculator' ? 'calc' : launchAndType[1].toLowerCase() === 'paint' ? 'mspaint' : 'notepad';
      return { intent: 'Launch an allowlisted application and enter explicit text', operations: [{ operation: 'desktop:launch_and_type', parameters: { appId, text: launchAndType[2].trim() }, justification: 'User requested a bounded app launch followed by explicit text entry' }], confidence: 0.88, explanation: 'Will launch the requested allowlisted application and enter the supplied text after approval.' };
    }
    const typeMatch = requestText.match(/\b(?:type|write|enter)\s+(?:the following\s+)?[“"]?(.+?)[”"]?\s*$/i);
    if (typeMatch && typeMatch[1].trim()) {
      return { intent: 'Enter explicit text in the foreground application', operations: [{ operation: 'desktop:type_text', parameters: { text: typeMatch[1].trim() }, justification: 'User provided the text to enter' }], confidence: 0.88, explanation: 'Will paste the explicitly supplied text into the foreground application after approval.' };
    }
    const pasteMatch = requestText.match(/\bpaste\s+(?:the following\s+)?[“"]?(.+?)[”"]?\s+(?:here|there|into\s+(?:this|the\s+current)\s+(?:app|document|note))\s*$/i);
    if (pasteMatch && pasteMatch[1].trim()) {
      return { intent: 'Paste explicit text in the foreground application', operations: [{ operation: 'desktop:paste_text', parameters: { text: pasteMatch[1].trim() }, justification: 'User specified text and destination context' }], confidence: 0.8, explanation: 'Will paste the supplied text into the foreground application after approval.' };
    }
    if (/\b(copy|copy this|copy selected text)\b/.test(text)) {
      return { intent: 'Copy selected text from the foreground application', operations: [{ operation: 'desktop:copy_selection', parameters: {}, justification: 'User explicitly requested copying the current selection' }], confidence: 0.82, explanation: 'Will copy the foreground selection after approval; clipboard data may be sensitive.' };
    }

    // 2. Application launch requests
    if (/\b(notepad|note\s*pad|notes)\b/.test(text)) {
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

    if (/\b(calc|calculator)\b/.test(text)) {
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

    if (/\b(paint|draw)\b/.test(text)) {
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

    if (/\b(os|windows|version|specs|system)\b/.test(text)) {
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
