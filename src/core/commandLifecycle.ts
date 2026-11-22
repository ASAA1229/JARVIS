/**
 * Single command lifecycle vocabulary (D2.1, D2.9).
 *
 * Core tasks (TaskState), the Android command queue and the event bus each keep their own
 * detailed states, but every client-facing surface (event bus, /api/tasks, HUD, Android client
 * models) also carries this one coarse lifecycle so progress and terminal outcomes mean the
 * same thing everywhere:
 *
 *   queued -> running -> completed | failed | cancelled | timed_out
 *
 * A command is never left "running" forever: the core enforces execution and planning deadlines
 * and the Android queue expires claimed work, and both report `timed_out`.
 */
import { TaskState } from './types.js';

export const COMMAND_LIFECYCLE_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out'] as const;
export type CommandLifecycleState = (typeof COMMAND_LIFECYCLE_STATES)[number];

const TERMINAL: ReadonlySet<CommandLifecycleState> = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

export function isTerminalLifecycle(state: CommandLifecycleState): boolean {
  return TERMINAL.has(state);
}

export function isCommandLifecycleState(value: unknown): value is CommandLifecycleState {
  return typeof value === 'string' && (COMMAND_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * Map a core task state. Approval waits are queued work (nothing has run). An expired approval
 * is a timeout. Interrupted or recovery-pending work is reported as failed: it is no longer
 * running and its side effects need owner reconciliation, never an automatic retry.
 */
export function lifecycleFromTaskState(state: TaskState | string): CommandLifecycleState {
  switch (state) {
    case TaskState.CREATED:
    case TaskState.AWAITING_APPROVAL:
    case TaskState.APPROVED:
      return 'queued';
    case TaskState.EXECUTING:
      return 'running';
    case TaskState.COMPLETED:
    case TaskState.PARTIAL:
      return 'completed';
    case TaskState.REJECTED:
    case TaskState.CANCELLED:
      return 'cancelled';
    case TaskState.EXPIRED:
      return 'timed_out';
    case TaskState.FAILED:
    case TaskState.INTERRUPTED:
    case TaskState.AWAITING_RECOVERY:
    default:
      return 'failed';
  }
}

/** Map an Android inventory-command queue state. */
export function lifecycleFromAndroidState(state: string): CommandLifecycleState {
  switch (state) {
    case 'PENDING': return 'queued';
    case 'CLAIMED': return 'running';
    case 'COMPLETED': return 'completed';
    case 'EXPIRED': return 'timed_out';
    case 'CANCELLED': return 'cancelled';
    default: return 'failed';
  }
}
