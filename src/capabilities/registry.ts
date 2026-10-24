/**
 * Capability catalogue for the personalized, cross-device JARVIS assistant.
 *
 * This catalogue is descriptive metadata only. It does not grant permission,
 * bypass PolicyGateway, or claim that a planned adapter is implemented.
 */
export type JarvisPlatform = 'windows' | 'android' | 'ios' | 'web' | 'all';
export type CapabilityStatus = 'implemented' | 'partial' | 'planned' | 'restricted';
export type CapabilityRisk = 'read-only' | 'low' | 'medium' | 'high' | 'critical' | 'blocked';

export interface CapabilityDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly platforms: readonly JarvisPlatform[];
  readonly status: CapabilityStatus;
  readonly risk: CapabilityRisk;
  readonly requiresApproval: boolean;
  readonly requiresDeviceAgent: boolean;
  readonly notes: string;
}

const CAPABILITIES: readonly CapabilityDescriptor[] = [
  {
    id: 'conversation.voice-input',
    name: 'Voice input',
    description: 'Capture speech and turn a finalized transcript into a user request.',
    platforms: ['web', 'windows'],
    status: 'partial',
    risk: 'low',
    requiresApproval: false,
    requiresDeviceAgent: false,
    notes: 'Current HUD uses browser speech recognition; local-only recognition is not guaranteed.',
  },
  {
    id: 'conversation.spoken-output',
    name: 'Spoken responses',
    description: 'Speak assistant responses through configured local or browser speech output.',
    platforms: ['web', 'windows'],
    status: 'partial',
    risk: 'low',
    requiresApproval: false,
    requiresDeviceAgent: false,
    notes: 'Local Piper requires a configured executable and model; browser speech is a fallback.',
  },
  {
    id: 'desktop.system-info',
    name: 'Windows system information',
    description: 'Read allowlisted OS, memory, battery and disk information.',
    platforms: ['windows'],
    status: 'implemented',
    risk: 'read-only',
    requiresApproval: false,
    requiresDeviceAgent: true,
    notes: 'Only the existing allowlisted read operations are covered.',
  },
  {
    id: 'desktop.app-launch',
    name: 'Launch selected Windows applications',
    description: 'Launch applications supported by the current bounded app adapter.',
    platforms: ['windows'],
    status: 'partial',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'This is not yet universal application UI control.',
  },
  {
    id: 'desktop.ui-automation',
    name: 'Cross-application desktop interaction',
    description: 'Use accessibility/UI Automation to interact with permitted windows and controls.',
    platforms: ['windows'],
    status: 'partial',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Foreground UI Automation inspection, exact-name InvokePattern and non-sensitive ValuePattern are available; universal coverage and full outcome verification remain incomplete.',
  },
  {
    id: 'desktop.text-and-clipboard',
    name: 'Text entry, copy and paste',
    description: 'Use explicit selection/context and approved clipboard or keyboard operations.',
    platforms: ['windows'],
    status: 'partial',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Explicit text paste and selected-text copy are implemented for Windows; destination-content verification and richer selection context remain incomplete.',
  },
  {
    id: 'desktop.zoom-gesture',
    name: 'Application-aware zoom and gestures',
    description: 'Map an explicit gesture or spoken instruction to supported app zoom controls.',
    platforms: ['windows'],
    status: 'partial',
    risk: 'low',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Explicit zoom shortcuts are implemented for the foreground Windows app; actual zoom state is not yet visually verified.',
  },
  {
    id: 'files.scoped-operations',
    name: 'Scoped file operations',
    description: 'Create, read, edit and organize files only within explicitly authorized locations.',
    platforms: ['windows'],
    status: 'planned',
    risk: 'high',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Deletion requires quarantine/recovery; scripts require review; no unrestricted filesystem access.',
  },
  {
    id: 'stores.official-discovery',
    name: 'Official app-store discovery',
    description: 'Find apps in the official store for the selected target operating system.',
    platforms: ['windows', 'android', 'ios'],
    status: 'partial',
    risk: 'read-only',
    requiresApproval: false,
    requiresDeviceAgent: false,
    notes: 'Show app identity, publisher, store and target device before any install request.',
  },
  {
    id: 'stores.install',
    name: 'Approval-led app installation',
    description: 'Install a verified app through a supported official-store workflow after approval.',
    platforms: ['windows', 'android', 'ios'],
    status: 'planned',
    risk: 'high',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Must not silently sideload; some platforms require user/OS confirmation.',
  },
  {
    id: 'android.app-control',
    name: 'Android app control',
    description: 'Launch and interact with apps through explicitly granted Android capabilities.',
    platforms: ['android'],
    status: 'planned',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Requires a native companion, per-device identity and explicit Android permissions.',
  },
  {
    id: 'device.find-and-ring',
    name: 'Find or ring an enrolled device',
    description: 'Request an allowed sound/location action through supported device services.',
    platforms: ['windows', 'android', 'ios'],
    status: 'planned',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Depends on reachability, device settings and platform-approved find-device services.',
  },
  {
    id: 'ios.supported-integrations',
    name: 'iOS-supported app integrations',
    description: 'Use supported shortcuts, intents and system integrations on enrolled Apple devices.',
    platforms: ['ios'],
    status: 'planned',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'Unrestricted background control of arbitrary iOS apps is not available to third-party apps.',
  },
  {
    id: 'memory.personal-context',
    name: 'Owner-controlled personal memory',
    description: 'Store and retrieve explicitly permitted preferences, project context and routines.',
    platforms: ['all'],
    status: 'partial',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: false,
    notes: 'Requires categories, local-first storage, retention, review and verified deletion controls.',
  },
  {
    id: 'workflow.multi-step',
    name: 'Multi-step task orchestration',
    description: 'Plan, checkpoint, execute, verify and recover across permitted capabilities.',
    platforms: ['all'],
    status: 'partial',
    risk: 'medium',
    requiresApproval: true,
    requiresDeviceAgent: false,
    notes: 'Current planner supports only a small deterministic allowlist; no general executor authority.',
  },
  {
    id: 'developer.workflows',
    name: 'Developer workflows',
    description: 'Assist with repositories, tests and builds through approved workspace and command allowlists.',
    platforms: ['windows'],
    status: 'planned',
    risk: 'high',
    requiresApproval: true,
    requiresDeviceAgent: true,
    notes: 'No arbitrary shell, scripts or administrator elevation.',
  },
  {
    id: 'security.financial-app-automation',
    name: 'Financial and payment app automation',
    description: 'General-purpose interaction with payment apps, credentials or transactions.',
    platforms: ['all'],
    status: 'restricted',
    risk: 'blocked',
    requiresApproval: false,
    requiresDeviceAgent: false,
    notes: 'Explicitly excluded by owner policy, including PhonePe, Paytm and Google Pay.',
  },
  {
    id: 'security.voice-only-unlock',
    name: 'Unlock a device using voice alone',
    description: 'Use a voice match as the sole mechanism to unlock a phone or authorize sensitive actions.',
    platforms: ['android', 'ios'],
    status: 'restricted',
    risk: 'blocked',
    requiresApproval: false,
    requiresDeviceAgent: false,
    notes: 'Voice recognition is spoofable and is not a substitute for OS-supported strong authentication.',
  },
] as const;

export function listCapabilities(): readonly CapabilityDescriptor[] {
  return CAPABILITIES;
}

export function getCapability(id: string): CapabilityDescriptor | undefined {
  return CAPABILITIES.find((capability) => capability.id === id);
}

export function listCapabilitiesForPlatform(platform: Exclude<JarvisPlatform, 'all'>): readonly CapabilityDescriptor[] {
  return CAPABILITIES.filter(
    (capability) => capability.platforms.includes(platform) || capability.platforms.includes('all'),
  );
}

export function listCapabilitiesByStatus(status: CapabilityStatus): readonly CapabilityDescriptor[] {
  return CAPABILITIES.filter((capability) => capability.status === status);
}
