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
  memory?: string[];
}

export interface IAIPlannerProvider {
  name: string;
  generatePlan(requestText: string, context: MinimizedContext): Promise<PlanProposal>;
  validatePlanSchema(plan: unknown): { valid: boolean; errors?: string[] };
}

export class LocalHeuristicPlanner implements IAIPlannerProvider {
  public readonly name = 'local-heuristic-v1';

  private static readonly ALLOWED_OPERATIONS = new Set([
    'memory:save',
    'memory:list',
    'memory:delete',
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
    'desktop:paste_clipboard',
    'desktop:inspect_window',
    'desktop:click_control',
    'desktop:set_value',
    'desktop:list_windows',
    'desktop:focus_window',
    'file:list',
    'file:search',
    'file:read',
    'file:write',
    'file:edit',
    'file:delete',
    'file:restore',
    'terminal:run',
    'schedule:create',
    'schedule:list',
    'schedule:cancel',
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

  public async generatePlan(requestText: string, context: MinimizedContext): Promise<PlanProposal> {
    const text = requestText.toLowerCase().trim();

    const rememberName = requestText.match(/\bremember\s+(?:that\s+)?(?:my|owner|user)\s+name\s+is\s+(.+?)\s*$/i);
    if (rememberName && rememberName[1].trim()) {
      return { intent: 'Save owner name to personal memory', operations: [{ operation: 'memory:save', parameters: { category: 'preference', content: 'owner name: ' + rememberName[1].trim() }, justification: 'Owner explicitly requested remembering their name' }], confidence: 0.96, explanation: 'Will save your name in encrypted personal memory after approval.' };
    }
    if (/\b(what do you remember|list my memories|show my memories|what have you remembered)\b/i.test(requestText)) {
      return { intent: 'List owner-controlled personal memories', operations: [{ operation: 'memory:list', parameters: {}, justification: 'Owner asked to review saved memories' }], confidence: 0.9, explanation: 'Will retrieve the owner-controlled memory list from encrypted local storage.' };
    }

    const forgetMemory = requestText.match(/\b(?:forget|delete)\s+(?:the\s+)?memory\s+([a-f0-9]{32})\b/i);
    if (forgetMemory) {
      return { intent: 'Delete a personal memory', operations: [{ operation: 'memory:delete', parameters: { id: forgetMemory[1] }, justification: 'Owner requested deletion of a specific memory id' }], confidence: 0.94, explanation: 'Will request approval before deleting this memory entry.' };
    }
    const rememberAnything = requestText.match(/\bremember\s+(?:that\s+)?(.+?)\s*$/i);
    if (rememberAnything && rememberAnything[1].trim()) {
      return { intent: 'Save an owner-approved memory', operations: [{ operation: 'memory:save', parameters: { category: 'general', content: rememberAnything[1].trim() }, justification: 'Owner explicitly requested remembering this fact' }], confidence: 0.84, explanation: 'Will store this in encrypted personal memory after approval, unless it contains credentials or sensitive financial data.' };
    }
    // Scheduling. Each run is re-planned and re-authorized when it fires; nothing is pre-approved.
    const scheduleOnce = requestText.match(/\bschedule\s+(?:in\s+)?(\d{1,4})\s+(minutes?|hours?)\s*(?:to\s+|:\s*)(.+)$/i);
    if (scheduleOnce && scheduleOnce[3].trim()) {
      const delayMs = Number(scheduleOnce[1]) * (/^hour/i.test(scheduleOnce[2]) ? 3_600_000 : 60_000);
      return { intent: 'Schedule a one-time request', operations: [{ operation: 'schedule:create', parameters: { requestText: scheduleOnce[3].trim(), runAt: context.timestamp + delayMs }, justification: 'Owner asked for a delayed request' }], confidence: 0.85, explanation: 'Will create the schedule after approval. When it fires it is planned and authorized again, and state-changing steps will need fresh approval.' };
    }
    const scheduleEvery = requestText.match(/\bevery\s+(\d{1,4})\s+(minutes?|hours?)\s*(?:to\s+|:\s*)(.+)$/i);
    if (scheduleEvery && scheduleEvery[3].trim()) {
      const everyMinutes = Number(scheduleEvery[1]) * (/^hour/i.test(scheduleEvery[2]) ? 60 : 1);
      return { intent: 'Schedule a recurring request', operations: [{ operation: 'schedule:create', parameters: { requestText: scheduleEvery[3].trim(), runAt: context.timestamp + everyMinutes * 60_000, everyMinutes }, justification: 'Owner asked for a recurring request' }], confidence: 0.85, explanation: 'Will create the recurring schedule after approval. Every run is authorized again and state-changing steps need fresh approval.' };
    }
    if (/\b(list|show)\s+(?:my\s+)?schedules\b/i.test(requestText)) {
      return { intent: 'List scheduled requests', operations: [{ operation: 'schedule:list', parameters: {}, justification: 'Owner asked to review schedules' }], confidence: 0.9, explanation: 'Will list this device\'s scheduled requests.' };
    }
    const cancelSchedule = requestText.match(/\bcancel\s+schedule\s+(job-[a-f0-9]+)\b/i);
    if (cancelSchedule) {
      return { intent: 'Cancel a scheduled request', operations: [{ operation: 'schedule:cancel', parameters: { id: cancelSchedule[1] }, justification: 'Owner asked to cancel a schedule' }], confidence: 0.92, explanation: 'Will cancel that schedule after approval.' };
    }

    // Workspace files. Paths are resolved inside approved workspace folders only; deletes are recoverable quarantine moves.
    const restoreFile = requestText.match(/\brestore\s+(?:quarantined\s+)?(?:file\s+)?(q-[a-f0-9]{16})\b/i);
    if (restoreFile) {
      return { intent: 'Restore a quarantined file', operations: [{ operation: 'file:restore', parameters: { quarantineId: restoreFile[1] }, justification: 'Owner asked to undo a file deletion' }], confidence: 0.92, explanation: 'Will move the quarantined file back after approval, without overwriting anything.' };
    }
    const deleteFile = requestText.match(/\b(?:delete|remove|trash)\s+(?:the\s+)?file\s+["“]?([^\s"”]+)["”]?\s*$/i);
    if (deleteFile) {
      return { intent: 'Move one workspace file to quarantine', operations: [{ operation: 'file:delete', parameters: { path: deleteFile[1] }, justification: 'Owner named a single file to delete' }], confidence: 0.85, explanation: 'Will move that one file to a recoverable quarantine after approval. Folders and bulk deletes are not supported.' };
    }
    const editFile = requestText.match(/\bin\s+file\s+["“]?([^\s"”]+)["”]?\s+replace\s+["“](.+?)["”]\s+with\s+["“](.*?)["”]\s*$/i);
    if (editFile) {
      return { intent: 'Edit text in a workspace file', operations: [{ operation: 'file:edit', parameters: { path: editFile[1], find: editFile[2], replace: editFile[3] }, justification: 'Owner specified the exact text to replace' }], confidence: 0.85, explanation: 'Will replace that exact text once (after saving a backup) following approval.' };
    }
    const createFile = requestText.match(/\b(?:create|make|write|save)\s+(?:a\s+)?(?:new\s+)?file\s+(?:named|called)\s+["“]?([^\s"”]+)["”]?\s+(?:with|containing)\s+(?:the\s+)?(?:text\s+|content\s+)?["“]?(.+?)["”]?\s*$/i);
    if (createFile) {
      return { intent: 'Create a new workspace file', operations: [{ operation: 'file:write', parameters: { path: createFile[1], content: createFile[2] }, justification: 'Owner supplied the file name and content' }], confidence: 0.85, explanation: 'Will create the file after approval. An existing file is never overwritten.' };
    }
    const searchFiles = requestText.match(/\b(?:find|search\s+for)\s+(?:a\s+)?files?\s+(?:named|called|matching)\s+["“]?(.+?)["”]?\s*$/i);
    if (searchFiles) {
      return { intent: 'Search workspace file names', operations: [{ operation: 'file:search', parameters: { query: searchFiles[1].trim() }, justification: 'Owner asked for files by name' }], confidence: 0.85, explanation: 'Will search file names (not contents) inside the approved workspace.' };
    }
    const readFile = requestText.match(/\b(?:read|show\s+me|open)\s+(?:the\s+)?file\s+["“]?([^\s"”]+)["”]?\s*$/i);
    if (readFile) {
      return { intent: 'Read a workspace text file', operations: [{ operation: 'file:read', parameters: { path: readFile[1] }, justification: 'Owner named a file to read' }], confidence: 0.85, explanation: 'Will read that text file after approval; credential-like files are always refused.' };
    }
    const listFiles = requestText.match(/\b(?:list|show)\s+(?:the\s+|my\s+)?files(?:\s+(?:in|under)\s+(?:folder\s+)?["“]?([^\s"”]+)["”]?)?\s*$/i);
    if (listFiles) {
      return { intent: 'List workspace files', operations: [{ operation: 'file:list', parameters: { path: listFiles[1] || '.' }, justification: 'Owner asked to list files' }], confidence: 0.85, explanation: 'Will list names in the approved workspace folder.' };
    }

    // Allowlisted, non-shell commands only (see terminalRunner.ts). Shell metacharacters never match.
    const runCommand = requestText.match(/\brun\s+(?:the\s+command\s+)?(git|node|python|hostname)((?:\s+[^\s;&|<>`$"']+){0,8})\s*$/i);
    if (runCommand) {
      const args = runCommand[2].trim() ? runCommand[2].trim().split(/\s+/) : [];
      return { intent: 'Run an allowlisted read-only command', operations: [{ operation: 'terminal:run', parameters: { command: runCommand[1].toLowerCase(), args }, justification: 'Owner named an allowlisted command' }], confidence: 0.85, explanation: 'Will run that command without a shell, inside the workspace, after approval. Only read-only commands are allowlisted.' };
    }

    // Window discovery and focus.
    if (/\b(?:what|which)\s+(?:apps?|windows|applications|programs)\s+(?:are\s+)?(?:open|running)\b|\b(?:list|show)\s+(?:my\s+)?(?:open\s+)?windows\b/i.test(requestText)) {
      return { intent: 'List open application windows', operations: [{ operation: 'desktop:list_windows', parameters: {}, justification: 'Owner asked what is open' }], confidence: 0.88, explanation: 'Will list open window titles; payment and financial apps are excluded.' };
    }
    const focusWindow = requestText.match(/\b(?:switch\s+to|focus(?:\s+on)?|bring\s+up)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 ._-]{0,40}?)(?:\s+window)?\s*$/i);
    if (focusWindow && focusWindow[1].trim()) {
      return { intent: 'Bring an application window to the foreground', operations: [{ operation: 'desktop:focus_window', parameters: { titleContains: focusWindow[1].trim() }, justification: 'Owner named the window to focus' }], confidence: 0.8, explanation: 'Will focus exactly one matching window after approval and confirm Windows granted focus.' };
    }

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

    if (/\b(inspect|describe|what is in)\s+(?:the\s+)?(?:current|active|foreground)\s+window\b/i.test(requestText)) {
      return { intent: 'Inspect current foreground window controls', operations: [{ operation: 'desktop:inspect_window', parameters: {}, justification: 'User requested current-window context' }], confidence: 0.86, explanation: 'Will inspect accessible control names in the foreground window; control values are not read.' };
    }
    const clickControl = requestText.match(/\bclick\s+(?:the\s+)?(?:button|control)\s+(?:named\s+)?["“]?(.+?)["”]?\s*$/i);
    if (clickControl && clickControl[1].trim()) {
      return { intent: 'Click an exact named foreground control', operations: [{ operation: 'desktop:click_control', parameters: { name: clickControl[1].trim() }, justification: 'User specified an exact control name' }], confidence: 0.82, explanation: 'Will click only if exactly one accessible control matches, after approval.' };
    }
    const setControl = requestText.match(/\bset\s+(?:the\s+)?(?:field|control)\s+["“]?(.+?)["”]?\s+to\s+["“]?(.+?)["”]?\s*$/i);
    if (setControl && setControl[1].trim() && setControl[2].trim()) {
      return { intent: 'Set a named foreground control value', operations: [{ operation: 'desktop:set_value', parameters: { name: setControl[1].trim(), text: setControl[2].trim() }, justification: 'User specified a named field and explicit value' }], confidence: 0.78, explanation: 'Will update only a unique non-password, non-financial accessible field after approval and verify its value.' };
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
    const ownerName = (context.memory || []).map((item) => {
      const match = item.match(/\b(?:owner|user|my)\s+name\s*(?:is|:)\s*([A-Za-z][A-Za-z .'-]{0,79})/i);
      return match?.[1]?.trim().replace(/[.!,;]+$/, '');
    }).find((value) => Boolean(value));
    if (/\bopen\s+(?:the\s+)?notepad\b.*\bwrite\s+(?:my name|my full name)\b/i.test(requestText)) {
      if (!ownerName) return { intent: 'Owner profile detail required', operations: [], confidence: 0.95, explanation: 'I do not have a verified owner name configured. Tell me the exact name to write or save it in your owner profile first.', uncertainty: 'Owner name is not available in verified profile context.' };
      return { intent: 'Launch Notepad and enter the saved owner name', operations: [{ operation: 'desktop:launch_and_type', parameters: { appId: 'notepad', text: ownerName }, justification: 'Use owner name from approved personal memory' }], confidence: 0.95, explanation: 'Will open Notepad and enter the owner name saved in personal memory after approval.' };
    }
    if (/\b(?:write|type|enter)\s+(?:my name|my full name)\b/i.test(requestText)) {
      if (!ownerName) return { intent: 'Owner profile detail required', operations: [], confidence: 0.95, explanation: 'I do not have a verified owner name configured. Tell me the exact name to write or save it in your owner profile first.', uncertainty: 'Owner name is not available in verified profile context.' };
      return { intent: 'Enter the saved owner name', operations: [{ operation: 'desktop:type_text', parameters: { text: ownerName }, justification: 'Use owner name from approved personal memory' }], confidence: 0.95, explanation: 'Will enter the owner name saved in personal memory after approval.' };
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
    if (/\bcopy\s+(?:this|the selected text)\s+and\s+paste\s+(?:it\s+)?(?:in|into)\s+(?:notepad|notes)\b/i.test(requestText)) {
      return {
        intent: 'Copy current selection into Notepad',
        operations: [
          { operation: 'desktop:copy_selection', parameters: {}, justification: 'Copy the explicitly referenced current selection' },
          { operation: 'app:launch', parameters: { appId: 'notepad' }, justification: 'Open Notepad as the requested destination' },
          { operation: 'desktop:paste_clipboard', parameters: {}, justification: 'Paste the copied selection into the foreground Notepad window' },
        ],
        confidence: 0.82,
        explanation: 'This workflow copies the current selection, opens Notepad, and pastes it. JARVIS will request approval for each state-changing step.',
      };
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

    const genericOpen = requestText.match(/^\s*(?:please\s+)?open\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 ._+()\-]{0,79})\s*$/i);
    if (genericOpen && genericOpen[1].trim()) {
      const appName = genericOpen[1].trim();
      if (/\b(phonepe|paytm|google\s*pay|gpay|paypal|wallet|banking|payment)\b/i.test(appName)) {
        return { intent: 'Application excluded by owner policy', operations: [], confidence: 0.99, explanation: 'JARVIS does not launch or automate payment and financial applications.', uncertainty: 'Application is excluded by owner policy.' };
      }
      return { intent: 'Launch installed Windows application', operations: [{ operation: 'app:launch', parameters: { appId: appName }, justification: 'User requested an installed application by name' }], confidence: 0.78, explanation: 'Will search the Windows Start menu for a unique application match and request approval before launching it.' };
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
