/**
 * Provider-independent desktop platform adapter contract (JARVIS-GAP-019/020).
 *
 * Windows is the only implemented platform. macOS and Linux get explicit
 * fail-closed adapters: every operation returns a VERIFIED_FAILURE naming the
 * missing native integration, so a request on an unsupported OS can never appear
 * to succeed. Native adapters (macOS Accessibility/TCC, Linux portals/AT-SPI) are
 * NOT implemented and require physical-device acceptance when they are.
 */
import { VerificationOutcome, type ExecutionResult } from '../core/types.js';

export type DesktopPlatform = 'windows' | 'macos' | 'linux';
export type PlatformOperation = 'app:launch' | 'desktop:list_windows' | 'desktop:focus_window' | 'system:get_info';

export interface PlatformAdapterInfo {
  platform: DesktopPlatform;
  implemented: boolean;
  /** Operations this adapter can actually execute. Empty for unsupported platforms. */
  supportedOperations: readonly PlatformOperation[];
  /** What native work remains before this platform can be accepted. */
  blockers: readonly string[];
}

export interface DesktopPlatformAdapter {
  describe(): PlatformAdapterInfo;
  execute(operation: PlatformOperation, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult>;
}

export function unsupportedPlatformResult(platform: DesktopPlatform, operation: string): ExecutionResult {
  return {
    success: false,
    outcome: VerificationOutcome.VERIFIED_FAILURE,
    error: `The ${platform} desktop adapter is not implemented; "${operation}" was not attempted.`,
    evidence: { platform, operation, implemented: false, attempted: false },
  };
}

/** Fail-closed adapter used for platforms without a native integration. */
export class UnsupportedPlatformAdapter implements DesktopPlatformAdapter {
  constructor(private readonly platform: Exclude<DesktopPlatform, 'windows'>) {}

  describe(): PlatformAdapterInfo {
    return {
      platform: this.platform,
      implemented: false,
      supportedOperations: [],
      blockers: this.platform === 'macos'
        ? ['Native Accessibility/TCC permission-aware adapter', 'Physical macOS acceptance testing']
        : ['XDG portal / AT-SPI accessibility integration', 'Distribution-specific physical acceptance testing'],
    };
  }

  async execute(operation: PlatformOperation): Promise<ExecutionResult> {
    return unsupportedPlatformResult(this.platform, operation);
  }
}

/** Wraps an injected Windows executor so the platform contract is uniform and testable. */
export class WindowsPlatformAdapter implements DesktopPlatformAdapter {
  constructor(private readonly executor: (operation: PlatformOperation, parameters: Record<string, unknown>, signal?: AbortSignal) => Promise<ExecutionResult>) {}

  describe(): PlatformAdapterInfo {
    return { platform: 'windows', implemented: true, supportedOperations: ['app:launch', 'desktop:list_windows', 'desktop:focus_window', 'system:get_info'], blockers: [] };
  }

  execute(operation: PlatformOperation, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult> {
    if (!this.describe().supportedOperations.includes(operation)) return Promise.resolve(unsupportedPlatformResult('windows', String(operation)));
    return this.executor(operation, parameters, signal);
  }
}

export function platformFromNode(nodePlatform: string): DesktopPlatform | undefined {
  return nodePlatform === 'win32' ? 'windows' : nodePlatform === 'darwin' ? 'macos' : nodePlatform === 'linux' ? 'linux' : undefined;
}

export function selectPlatformAdapter(
  nodePlatform: string,
  windowsExecutor: ConstructorParameters<typeof WindowsPlatformAdapter>[0],
): DesktopPlatformAdapter {
  const platform = platformFromNode(nodePlatform);
  if (platform === 'windows') return new WindowsPlatformAdapter(windowsExecutor);
  if (platform === 'macos' || platform === 'linux') return new UnsupportedPlatformAdapter(platform);
  throw new Error(`Unsupported host platform: ${nodePlatform}.`);
}
