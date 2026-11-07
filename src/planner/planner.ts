import { DEVELOPER_OPERATIONS } from '../developer/operations.js';
import { planDeveloperRequest } from '../developer/developerPlanner.js';

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

function splitForegroundTarget(value: string): { name: string; expectProcess?: string } {
  const match = value.match(/\s+in\s+([A-Za-z0-9._-]{1,64})\s*$/i);
  if (!match) return { name: value.trim() };
  const name = value.slice(0, match.index).trim().replace(/[\"'“”]+$/g, '').trim();
  const expectProcess = match[1].replace(/\.exe$/i, '');
  return name ? { name, expectProcess } : { name: value.trim() };
}
function normalizeVoiceDirective(value: string): string {
  let directive = String(value || '')
    .trim()
    .replace(/[，。！？]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:(?:(?:hey|hello|hi|ok|okay)\s+)?jarvis\b[,.!:]?\s*)+/i, '')
    .trim();

  // Convert conversational launch requests into one explicit launch intent.
  // This does not add any new executable operation or bypass policy checks.
  directive = directive
    .replace(/^(?:would you mind|can you|could you|would you|please)\s+(?:please\s+)?(?:get me|bring me|open|launch|start|run|fire up)\s+/i, 'open ')
    .replace(/^(?:get me|bring me|fire up)\s+/i, 'open ')
    .replace(/^(open|launch|start|run)\s+up\s+/i, '$1 ')
    .replace(/^(?:i want you to|i need you to)\s+(open|launch|start|run)\s+/i, '$1 ')
    .replace(/^(?:please)\s+(open|launch|start|run|bring up)\s+/i, '$1 ')
    .replace(/\s+(?:please|for me|thanks|thank you)[.!?]*$/i, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return directive;
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
    'desktop:read_control',
    'desktop:click_control',
    'desktop:set_value',
    'desktop:list_windows',
    'memory:update',
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
    'app:inventory',
    'comms:handoff_email',
    'comms:unsupported',
    ...DEVELOPER_OPERATIONS,
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

  public async generatePlan(rawRequestText: string, context: MinimizedContext): Promise<PlanProposal> {
    const requestText = normalizeVoiceDirective(rawRequestText);
    const text = requestText.toLowerCase().trim();

    // Developer assistant (JARVIS-US-063): explicit, repo-scoped phrases only.
    const developerPlan = planDeveloperRequest(requestText);
    if (developerPlan) return developerPlan;

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
    const memoryCategory = ['preference', 'project', 'routine', 'general'].find((category) => text.startsWith('remember ' + category + ':'));
    if (memoryCategory) {
      const memoryContent = requestText.slice(('remember ' + memoryCategory + ':').length).trim();
      if (memoryContent) return { intent: 'Save a categorized personal memory', operations: [{ operation: 'memory:save', parameters: { category: memoryCategory, content: memoryContent }, justification: 'Owner explicitly requested saving a categorized memory' }], confidence: 0.9, explanation: 'Will save this categorized memory in encrypted local storage after approval.' };
    }
    const rememberAnything = requestText.match(/\bremember\s+(?:that\s+)?(.+?)\s*$/i);
    if (rememberAnything && rememberAnything[1].trim()) {
      return { intent: 'Save an owner-approved memory', operations: [{ operation: 'memory:save', parameters: { category: 'general', content: rememberAnything[1].trim() }, justification: 'Owner explicitly requested remembering this fact' }], confidence: 0.84, explanation: 'Will store this in encrypted personal memory after approval, unless it contains credentials or sensitive financial data.' };
    }
    // Scheduling. Each run is re-planned and re-authorized when it fires; nothing is pre-approved.
    const updateMemory = requestText.match(/\b(?:update|correct)\s+memory\s+([a-f0-9]{32})\s+(?:to|with)\s+(.+)$/i);
    if (updateMemory && updateMemory[2].trim()) {
      return { intent: 'Correct a saved memory', operations: [{ operation: 'memory:update', parameters: { id: updateMemory[1], content: updateMemory[2].trim() }, justification: 'Owner asked to correct a memory' }], confidence: 0.88, explanation: 'Will replace that memory\'s text after approval, unless it contains credentials or instruction-like text.' };
    }
    const scheduleDelayedRepeat = requestText.match(/\bschedule\s+in\s+(\d{1,4})\s+(minutes?|hours?)\s+then\s+every\s+(\d{1,4})\s+(minutes?|hours?)\s+(?:to\s+|:\s*)(.+)$/i);
    if (scheduleDelayedRepeat && scheduleDelayedRepeat[5].trim()) {
      const delayMs = Number(scheduleDelayedRepeat[1]) * (/^hour/i.test(scheduleDelayedRepeat[2]) ? 3_600_000 : 60_000);
      const everyMinutes = Number(scheduleDelayedRepeat[3]) * (/^hour/i.test(scheduleDelayedRepeat[4]) ? 60 : 1);
      return { intent: 'Schedule a delayed recurring request', operations: [{ operation: 'schedule:create', parameters: { requestText: scheduleDelayedRepeat[5].trim(), runAt: context.timestamp + delayMs, everyMinutes }, justification: 'Owner requested a recurring request with a specific initial delay' }], confidence: 0.86, explanation: 'Will create the delayed recurring schedule after approval. Every run is planned and authorized again; state-changing steps need fresh approval.' };
    }
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

    if (/\b(?:what|which|list|show)\s+(?:installed\s+)?(?:apps|applications)\b/i.test(requestText)) {
      return { intent: 'List application capabilities', operations: [{ operation: 'app:inventory', parameters: {}, justification: 'Owner asked which applications JARVIS can see' }], confidence: 0.88, explanation: 'Will list allowlisted applications and, if enabled, Start-menu names. Presence in the list is not a claim that every operation works in that app.' };
    }

    const emailDraft = requestText.match(/\b(?:draft|prepare|compose)\s+(?:an?\s+)?email\s+to\s+(\S+)\s+(?:cc\s+(\S+)\s+)?(?:with\s+)?subject\s+["“](.+?)["”]\s+(?:body|saying)\s+["“](.+?)["”]\s*$/i);
    if (emailDraft) {
      return {
        intent: 'Prepare an email draft for owner-approved local handoff',
        operations: [{
          operation: 'comms:handoff_email',
          parameters: { to: emailDraft[1], cc: emailDraft[2] || '', subject: emailDraft[3], body: emailDraft[4] },
          justification: 'Owner supplied recipient, subject and body for review',
        }],
        confidence: 0.9,
        explanation: 'Will bind approval to this exact recipient and message, then prepare a local mail compose handoff. JARVIS will not send the email or claim delivery.',
      };
    }
    if (/\b(?:send|write|compose)\s+(?:an?\s+)?e-?mail\b|\bsend\b.+\be-?mail\b/i.test(requestText) && !emailDraft) {
      return {
        intent: 'Email send is blocked until a complete reviewed draft exists',
        operations: [],
        confidence: 0.95,
        explanation: 'I can prepare an email after you give the exact To address, subject, and body (for example: draft email to name@example.com subject "Hello" body "Please review"). I will not send mail because a draft was generated. Approval is bound to that exact content.',
        uncertainty: 'Complete recipient, subject and body are required before an email handoff can be approved.',
      };
    }
    if (/\b(whatsapp|sms|text message|cellular call|phone call|voip|teams meeting|teams message)\b/i.test(requestText)) {
      const channel = /\bwhatsapp\b/i.test(requestText) ? 'whatsapp' : /\bsms|text message\b/i.test(requestText) ? 'sms' : /\bteams\b/i.test(requestText) ? 'teams' : /\bvoip\b/i.test(requestText) ? 'voip' : 'cellular-call';
      return {
        intent: 'Unsupported communications channel',
        operations: [{ operation: 'comms:unsupported', parameters: { channel, reason: 'No authorized ' + channel + ' adapter is implemented. JARVIS will not claim this communication was sent or connected.' }, justification: 'Owner asked for a channel that has no safe adapter' }],
        confidence: 0.97,
        explanation: 'This communications path is not implemented. I will not open an unofficial client or report success. Use the native app yourself if you need to send or call.',
      };
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

    const readControl = requestText.match(/\b(?:read|inspect|get)\s+(?:the\s+)?(?:value\s+of\s+)?(?:the\s+)?control\s+["“]?(.+?)["”]?\s*$/i);
    if (readControl && readControl[1].trim()) {
      const target = splitForegroundTarget(readControl[1]);
      return {
        intent: 'Read a uniquely named foreground UI control',
        operations: [{ operation: 'desktop:read_control', parameters: target, justification: 'Owner explicitly requested reading one named UI control' }],
        confidence: 0.82,
        explanation: 'Will request approval, bind to the named foreground process when supplied, read only a uniquely named accessible control, and redact password and credential/financial fields. Apps that do not expose a ValuePattern may return no value.',
      };
    }

    if (/\b(?:what|which)\s+(?:app|application|program|window)\s+(?:is\s+)?(?:currently\s+)?(?:active|in\s+the\s+foreground)\b|\bwhat(?:'s| is)\s+(?:the\s+)?(?:active|current)\s+window\b|\bwhich\s+window\s+am\s+i\s+using\b/i.test(requestText)) {
      return {
        intent: 'Identify the active application window',
        operations: [{ operation: 'desktop:inspect_window', parameters: {}, justification: 'Owner asked which application is currently active' }],
        confidence: 0.9,
        explanation: 'Will report the foreground application and window title, plus accessible control names; it will not read control values.',
      };
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

    const inspectWindow = requestText.match(/\b(?:inspect|describe|show)\s+(?:(?:the\s+)?(?:current|active|foreground)\s+)?window(?:\s+in\s+([A-Za-z0-9._-]{1,64}))?\s*$/i)
      || requestText.match(/\b(?:inspect|describe|show)\s+(?:the\s+)?([A-Za-z0-9._-]{1,64})\s+window\s*$/i);
    if (inspectWindow) {
      const expectProcess = inspectWindow[1]?.replace(/\.exe$/i, '');
      return {
        intent: expectProcess ? 'Inspect a specifically named application window' : 'Inspect current foreground window controls',
        operations: [{ operation: 'desktop:inspect_window', parameters: expectProcess ? { expectProcess } : {}, justification: expectProcess ? 'User explicitly named the application to inspect' : 'User requested current-window context' }],
        confidence: 0.86,
        explanation: expectProcess
          ? 'Will inspect accessible control names only if the foreground process matches the named application; control values are not read.'
          : 'Will inspect accessible control names in the foreground window; control values are not read.',
      };
    }

    const clickControl = requestText.match(/\bclick\s+(?:the\s+)?(?:button|control)\s+(?:named\s+)?["“]?(.+?)["”]?\s*$/i);
    if (clickControl && clickControl[1].trim()) {
      const target = splitForegroundTarget(clickControl[1]);
      return { intent: 'Click an exact named foreground control', operations: [{ operation: 'desktop:click_control', parameters: target, justification: 'User specified an exact control name' }], confidence: 0.82, explanation: 'Will bind to the named process when supplied and invoke only if exactly one accessible control matches, after approval.' };
    }
    const setControl = requestText.match(/\bset\s+(?:the\s+)?(?:field|control)\s+["“]?(.+?)["”]?\s+to\s+["“]?(.+?)["”]?\s*$/i);
    if (setControl && setControl[1].trim() && setControl[2].trim()) {
      const target = splitForegroundTarget(setControl[1]);
      return { intent: 'Set a named foreground control value', operations: [{ operation: 'desktop:set_value', parameters: { ...target, text: setControl[2].trim() }, justification: 'User specified a named field and explicit value' }], confidence: 0.78, explanation: 'Will update only a unique non-password, non-financial accessible field in the named process when supplied, after approval, and verify its value.' };
    }

    // Explicit desktop interaction requests. The policy gateway still requires approval.
    const zoomRequest = requestText.match(/\b(zoom\s+in|zoom\s+closer|enlarge|zoom\s+out|zoom\s+smaller|shrink|reset\s+zoom|normal\s+zoom)\s+(?:in|on)\s+([A-Za-z0-9._-]{1,64})\s*$/i)
      || requestText.match(/\b(zoom\s+in|zoom\s+closer|enlarge|zoom\s+out|zoom\s+smaller|shrink|reset\s+zoom|normal\s+zoom)\s*$/i);
    if (zoomRequest) {
      const phrase = zoomRequest[1].toLowerCase();
      const direction = /reset|normal/.test(phrase) ? 'reset' : /out|smaller|shrink/.test(phrase) ? 'out' : 'in';
      const expectProcess = zoomRequest[2]?.replace(/\.exe$/i, '');
      if (!expectProcess) return { intent: 'Zoom destination required', operations: [], confidence: 0.98, explanation: 'Name the application to zoom, for example “zoom in on Chrome”. JARVIS will not send shortcuts to an unknown foreground window.', uncertainty: 'No explicit destination process was supplied for zoom.' };
      return { intent: 'Zoom the named application', operations: [{ operation: 'desktop:zoom', parameters: { direction, expectProcess }, justification: 'User explicitly named the zoom direction and destination process' }], confidence: 0.9, explanation: 'Will send the zoom shortcut only if the foreground process matches the named application, after approval.' };
    }
    const hotkeyRequest = requestText.match(/\b(?:press|hit)\s+(ctrl|control|alt|shift)(?:\s*\+\s*|\s+)(c|v|a|s|f|n|z|y|enter|tab|escape|esc)\s+in\s+([A-Za-z0-9._-]{1,64})\s*$/i);
    if (hotkeyRequest) {
      const modifier = hotkeyRequest[1].toLowerCase() === 'control' ? 'CTRL' : hotkeyRequest[1].toUpperCase();
      const key = hotkeyRequest[2].toUpperCase() === 'ESCAPE' ? 'ESC' : hotkeyRequest[2].toUpperCase();
      return { intent: 'Send an allowlisted shortcut to the named application', operations: [{ operation: 'desktop:hotkey', parameters: { keys: [modifier, key], expectProcess: hotkeyRequest[3].replace(/\.exe$/i, '') }, justification: 'User supplied an allowlisted key combination and named its destination process' }], confidence: 0.9, explanation: 'Will send the shortcut only if the foreground process matches the named application, after approval.' };
    }
    if (/\b(?:press|hit)\s+(?:ctrl|control|alt|shift)\b/i.test(requestText)) {
      return { intent: 'Shortcut destination or key combination required', operations: [], confidence: 0.98, explanation: 'Provide a supported key combination and application, for example “press Ctrl+S in Notepad”.', uncertainty: 'The shortcut is incomplete or has no explicit destination process.' };
    }
    const ownerName = (context.memory || []).map((item) => {
      const match = item.match(/\b(?:owner|user|my)\s+name\s*(?:is|:)\s*([A-Za-z][A-Za-z .'-]{0,79})/i);
      return match?.[1]?.trim().replace(/[.!,;]+$/, '');
    }).find((value) => Boolean(value));
    if (/\bopen\s+(?:the\s+)?notepad\b.*\bwrite\s+(?:my name|my full name)\b/i.test(requestText)) {
      if (!ownerName) return { intent: 'Owner profile detail required', operations: [], confidence: 0.95, explanation: 'I do not have a verified owner name configured. Tell me the exact name to write or save it in your owner profile first.', uncertainty: 'Owner name is not available in verified profile context.' };
      return { intent: 'Launch Notepad and enter the saved owner name', operations: [{ operation: 'desktop:launch_and_type', parameters: { appId: 'notepad', text: ownerName }, justification: 'Use owner name from approved personal memory' }], confidence: 0.95, explanation: 'Will open Notepad and enter the owner name saved in personal memory after approval.' };
    }
    const launchOwnerName = requestText.match(/\b(?:open|launch|start)\s+(?:the\s+)?(notepad|calculator|paint)\b.*\b(?:write|type|enter)\s+(?:my name|my full name)\s*$/i);
    if (launchOwnerName) {
      if (!ownerName) return { intent: 'Owner profile detail required', operations: [], confidence: 0.95, explanation: 'I do not have a verified owner name configured. Tell me the exact name to write or save it in your owner profile first.', uncertainty: 'Owner name is not available in verified profile context.' };
      const appId = launchOwnerName[1].toLowerCase() === 'calculator' ? 'calc' : launchOwnerName[1].toLowerCase() === 'paint' ? 'mspaint' : 'notepad';
      return { intent: 'Launch an allowlisted application and enter the saved owner name', operations: [{ operation: 'desktop:launch_and_type', parameters: { appId, text: ownerName }, justification: 'Use verified owner profile data in the explicitly requested application' }], confidence: 0.95, explanation: 'Will launch the named application, verify its target window, and enter the saved owner name after approval.' };
    }
    const ownerNameRequest = requestText.match(/\b(?:write|type|enter)\s+(?:my name|my full name)\s*(?:in\s+([A-Za-z0-9._-]{1,64}))?\s*$/i);
    if (ownerNameRequest) {
      if (!ownerName) return { intent: 'Owner profile detail required', operations: [], confidence: 0.95, explanation: 'I do not have a verified owner name configured. Tell me the exact name to write or save it in your owner profile first.', uncertainty: 'Owner name is not available in verified profile context.' };
      const targetProcess = ownerNameRequest[1]?.replace(/\.exe$/i, '');
      if (!targetProcess) return { intent: 'Typing destination required', operations: [], confidence: 0.98, explanation: 'I have the saved owner name, but I will not type into whichever window happens to be active. Say “type my name in Notepad” or name the exact target application.', uncertainty: 'No explicit destination process was supplied for text entry.' };
      return { intent: 'Enter the saved owner name in the named application', operations: [{ operation: 'desktop:type_text', parameters: { text: ownerName, expectProcess: targetProcess }, justification: 'Use verified owner profile data and pin text entry to the explicitly named process' }], confidence: 0.95, explanation: 'Will enter the saved owner name only if the foreground window belongs to the named application, after approval.' };
    }
    const launchAndType = requestText.match(/\b(?:open|launch|start)\s+(?:the\s+)?(notepad|calculator|paint)\b\s*(?:and|then|,)?\s*(?:please\s+)?(?:write|type|enter)\s+(.+?)\s*$/i);
    if (launchAndType) {
      const appId = launchAndType[1].toLowerCase() === 'calculator' ? 'calc' : launchAndType[1].toLowerCase() === 'paint' ? 'mspaint' : 'notepad';
      let suppliedText = launchAndType[2].trim();
      if ((suppliedText.startsWith('"') && suppliedText.endsWith('"')) || (suppliedText.startsWith('“') && suppliedText.endsWith('”')) || (suppliedText.startsWith("'") && suppliedText.endsWith("'"))) {
        suppliedText = suppliedText.slice(1, -1).trim();
      }
      if (!suppliedText || suppliedText.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(suppliedText)) {
        return { intent: 'Combined desktop instruction needs clearer text', operations: [], confidence: 0.96, explanation: 'The text to enter must be a single line containing 1–500 printable characters. No application was launched and no text was entered.', uncertainty: 'The requested text is empty, too long, or contains unsupported control characters.' };
      }
      return { intent: 'Launch an allowlisted application and enter explicit text', operations: [{ operation: 'desktop:launch_and_type', parameters: { appId, text: suppliedText }, justification: 'User requested a bounded app launch followed by explicit text entry' }], confidence: 0.9, explanation: 'Will launch the requested allowlisted application, verify its target window, and enter the supplied text only after approval.' };
    }
    const typeMatch = requestText.match(/\b(?:type|write|enter)\s+(?:the following\s+)?[“"]?(.+?)\s*$/i);
    if (typeMatch && typeMatch[1].trim()) {
      const target = splitForegroundTarget(typeMatch[1].trim());
      const explicitText = target.name.replace(/^[“"']|[”"']$/g, '').trim();
      if (!target.expectProcess) return { intent: 'Typing destination required', operations: [], confidence: 0.98, explanation: 'I will not type into whichever window happens to be active. Specify the destination, for example “type Hello in Notepad”.', uncertainty: 'No explicit destination process was supplied for text entry.' };
      if (!explicitText || explicitText.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(explicitText)) return { intent: 'Text entry needs clearer input', operations: [], confidence: 0.96, explanation: 'The text must contain 1–500 printable characters. No text was entered.', uncertainty: 'Text is empty, too long, or contains unsupported control characters.' };
      return { intent: 'Enter explicit text in the named application', operations: [{ operation: 'desktop:type_text', parameters: { text: explicitText, expectProcess: target.expectProcess }, justification: 'User supplied text and explicitly named the destination process' }], confidence: 0.9, explanation: 'Will enter the supplied text only if the foreground window belongs to the named application, after approval.' };
    }
    // "copy this [in Chrome] and paste it in Notepad": a bounded three-step workflow.
    // The copy source must be named, matching the single-step copy rule below.
    const copyThenPaste = requestText.match(/\bcopy\s+(?:this|that|it|the\s+selection|(?:the\s+)?selected\s+text)(?:\s+(?:in|from)\s+([A-Za-z0-9._-]{1,64}))?\s*(?:,\s*)?(?:and|then)\s+(?:then\s+)?paste\s+(?:it|this|that)\s+(?:in|into)\s+([A-Za-z0-9._-]{1,64})\s*$/i);
    if (copyThenPaste) {
      const source = copyThenPaste[1]?.replace(/\.exe$/i, '');
      const destination = copyThenPaste[2].replace(/\.exe$/i, '');
      if (!source) return { intent: 'Copy source application required', operations: [], confidence: 0.98, explanation: `Name the application containing the selection, for example “copy selected text in Chrome and paste it in ${destination}”. JARVIS will not copy from an unknown foreground window.`, uncertainty: 'No explicit source process was supplied for clipboard copy.' };
      return {
        intent: 'Copy the selection from one application and paste it into another',
        operations: [
          { operation: 'desktop:copy_selection', parameters: { expectProcess: source }, justification: 'User explicitly named the source application for copying its current selection' },
          { operation: 'app:launch', parameters: { appId: destination.toLowerCase() }, justification: 'Bring the named paste destination to the foreground' },
          { operation: 'desktop:paste_clipboard', parameters: { expectProcess: destination }, justification: 'User explicitly named the clipboard paste destination' },
        ],
        confidence: 0.88,
        explanation: 'Will copy only from the named source, open or focus the destination, and paste only if its process matches — each step after approval.',
      };
    }
    // Pronouns refer to the clipboard, never to literal text to paste.
    const pasteClipboard = requestText.match(/\bpaste\s+(?:the\s+)?(?:clipboard|it|this|that|copied\s+text|the\s+copied\s+text|the\s+selection)\s+(?:in|into)\s+([A-Za-z0-9._-]{1,64})\s*$/i);
    if (pasteClipboard) {
      return { intent: 'Paste clipboard into the named application', operations: [{ operation: 'desktop:paste_clipboard', parameters: { expectProcess: pasteClipboard[1].replace(/\.exe$/i, '') }, justification: 'User explicitly named the clipboard paste destination' }], confidence: 0.9, explanation: 'Will paste only if the foreground process matches the named destination application.' };
    }
    const pasteMatch = requestText.match(/\bpaste\s+(?:the following\s+)?[“"]?(.+?)[”"]?\s+in\s+([A-Za-z0-9._-]{1,64})\s*$/i);
    if (pasteMatch && pasteMatch[1].trim()) {
      return { intent: 'Paste explicit text in the named application', operations: [{ operation: 'desktop:paste_text', parameters: { text: pasteMatch[1].trim(), expectProcess: pasteMatch[2].replace(/\.exe$/i, '') }, justification: 'User supplied text and explicitly named the destination process' }], confidence: 0.9, explanation: 'Will paste the supplied text only if the foreground process matches the named application, after approval.' };
    }
    if (/\bpaste\b/i.test(requestText)) {
      return { intent: 'Paste destination required', operations: [], confidence: 0.98, explanation: 'Name the destination application, for example “paste this in Notepad”. JARVIS will not paste into an unknown foreground window.', uncertainty: 'No explicit destination process was supplied for paste.' };
    }
    const copySelection = requestText.match(/\bcopy\s+(?:this|the\s+selected\s+text|selected\s+text)\s+in\s+([A-Za-z0-9._-]{1,64})\s*$/i);
    if (copySelection) {
      const expectProcess = copySelection[1].replace(/\.exe$/i, '');
      return { intent: 'Copy selected text from the named application', operations: [{ operation: 'desktop:copy_selection', parameters: { expectProcess }, justification: 'User explicitly named the source application for copying its current selection' }], confidence: 0.9, explanation: 'Will copy only if the foreground process matches the named source application; clipboard contents may be sensitive.' };
    }
    if (/\bcopy\b/i.test(requestText)) {
      return { intent: 'Copy source application required', operations: [], confidence: 0.98, explanation: 'Name the application containing the selection, for example “copy selected text in Chrome”.', uncertainty: 'No explicit source process was supplied for clipboard copy.' };
    }

    // 2. Application launch requests.
    // Require an explicit launch verb: merely asking about an application must
    // never cause a state-changing app:launch operation.
    const launchIntent = /^\s*(?:(?:(?:hey|hello|hi|ok|okay)\s+)?jarvis\b[,.!:]?\s*)?(?:please\s+)?(?:open|launch|start|run|bring\s+up)\s+(?:the\s+)?(.+?)\s*$/i.exec(requestText);
    const launchTarget = launchIntent?.[1]?.trim()
      .replace(/[.!?,;:]+$/g, '')
      .replace(/\s+(?:please|for me)$/i, '')
      .trim() ?? '';
    if (launchTarget && /^(?:notepad|note\s*pad)$/i.test(launchTarget)) {
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

    if (launchTarget && /^(?:calc|calculator)$/i.test(launchTarget)) {
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

    const builtInLaunchAliases: Array<{ names: RegExp; appId: string; displayName: string }> = [
      { names: /^(?:paint|microsoft paint)$/i, appId: 'mspaint', displayName: 'Paint' },
      { names: /^(?:file explorer|windows explorer|explorer)$/i, appId: 'explorer', displayName: 'File Explorer' },
      { names: /^(?:task manager|windows task manager)$/i, appId: 'taskmgr', displayName: 'Task Manager' },
      { names: /^(?:command prompt|cmd|cmd prompt)$/i, appId: 'cmd', displayName: 'Command Prompt' },
      { names: /^(?:powershell|windows powershell)$/i, appId: 'powershell', displayName: 'PowerShell' },
      { names: /^(?:chrome|google chrome)$/i, appId: 'Google Chrome', displayName: 'Google Chrome' },
      { names: /^(?:edge|microsoft edge)$/i, appId: 'Microsoft Edge', displayName: 'Microsoft Edge' },
    ];
    const builtInAlias = builtInLaunchAliases.find((entry) => entry.names.test(launchTarget));
    if (builtInAlias) {
      return {
        intent: 'Launch ' + builtInAlias.displayName + ' application',
        operations: [{
          operation: 'app:launch',
          parameters: { appId: builtInAlias.appId },
          justification: 'User requested launching ' + builtInAlias.displayName,
        }],
        confidence: 0.93,
        explanation: 'Interpreted as launching ' + builtInAlias.displayName + ' through the Windows application launcher.',
      };
    }

    const genericOpen = /^[A-Za-z0-9][A-Za-z0-9 ._+()\-]{0,79}$/.test(launchTarget);
    if (genericOpen && launchTarget) {
      const appName = launchTarget;
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
