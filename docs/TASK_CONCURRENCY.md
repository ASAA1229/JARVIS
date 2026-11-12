# JARVIS Task Concurrency & Deadlock Safety

**Status:** Initial execution-coordination layer implemented in source; build and tests intentionally not run in this increment.  
**Branch:** `new`

## Goals

Allow independent JARVIS tasks to make progress concurrently without allowing conflicting host actions to race, starving lower-priority work, exhausting the host, or bypassing task policy and approval.

## Current execution model

- Planning and policy evaluation remain per task. Every state-changing operation still passes through the existing policy gateway and its exact task/device/parameter-bound approval.
- Planner/provider work has a separate bounded admission pool (2 globally, 1 per device, 100 waiting). A task cancelled while waiting for planning is removed before the provider call; if an uninterruptible provider call is already active, its eventual result is discarded before policy or execution.
- A task cancelled or timed out while waiting for adapter capacity is marked terminal without recovery reconciliation because no adapter callback started. Once adapter dispatch has started, interruption remains uncertain and requires reconciliation.
- Adapter execution is admitted by `TaskCoordinator`.
- Global active adapter work is bounded to 4 operations; active work per device is bounded to 2.
- The queue is bounded to 200 waiting operations and defaults to a 30-second admission timeout.
- Interactive work has a higher initial priority than scheduled work. Priority aging increases a waiting task's effective priority over time to reduce starvation.
- A task identifier cannot be queued or active twice at once.
- A waiting task can be cancelled through its AbortSignal. It is rejected before its adapter callback starts.
- Adapter errors and cancellation always release the concurrency slot and every acquired resource lock.
- Scheduler ticks now advance and durably persist each due job's at-most-once state before dispatching independent jobs concurrently. The core coordinator still applies the actual execution limits.

## Resource isolation

Resource keys are derived from operation semantics:

| Resource | Lock scope | Purpose |
|---|---|---|
| Desktop/app control | Per host | Prevent two devices/tasks from racing focus, typing, clicking, or launching on the same physical desktop |
| Personal memory store | Shared process store | Prevent concurrent mutations from overwriting one another |
| Plugin/workflow registry | Shared registry | Serialize registry changes |
| Workspace/file operations | Shared workspace | Conservatively serialize file/repository operations until canonical path identity is proven |

A task declares its complete resource set before execution. The coordinator normalizes and sorts all keys and grants the entire set atomically. It never grants a partial set and then waits for another lock. This removes the hold-and-wait condition required for circular-wait deadlocks. Locks are always released in a `finally` path.

## Computer-science methods used

- **Bounded admission control / bulkhead:** global and per-device limits isolate resource consumption.
- **Priority queue with aging:** responsive interactive work without indefinite starvation of background tasks.
- **Atomic multi-resource locking:** all-or-nothing lock acquisition in a canonical order; avoids lock-order cycles.
- **DAG validation:** workflow templates already use Kahn's topological-sort algorithm to reject dependency cycles.
- **At-most-once scheduling:** scheduler persists the next-run state before dispatch, preventing a restart from blindly replaying a due job.
- **Cooperative cancellation and deadlines:** waiting work can be removed before it starts; executing adapters receive an AbortSignal and the existing execution timeout.
- **Fail-safe recovery:** interrupted tasks remain recovery-required; uncertain state-changing operations are never automatically replayed.

## Important limits

- The coordinator is process-local. It is correct for the current single-host Node service; it is not a distributed lock manager for multiple JARVIS server replicas. A multi-process deployment must add a transactional shared queue/lease store before horizontal scaling.
- JavaScript async I/O concurrency is not the same as CPU parallelism. Do not create a worker thread for every request. A separate bounded worker-thread pool should be introduced only for measured CPU-bound workloads (for example, local inference preprocessing or expensive media analysis), with message schemas, cancellation, memory limits and shutdown semantics.
- Current multi-step task execution remains dependency-ordered and sequential within one task. Independent tasks can overlap. Parallel branches inside one workflow require explicit dependency metadata, policy/approval per branch, deterministic join semantics, and partial-side-effect recovery before enabling them.
- Resource locks are conservative operation-level isolation, not proof that every third-party application is thread-safe. New adapters must declare their shared resources and must not acquire locks outside the coordinator.
- The coordinator prevents deadlocks caused by its own resource-lock protocol; it does not claim to detect arbitrary deadlocks inside an operating system, third-party application, native adapter, or external service.

## Next implementation stages

1. Add execution metrics and owner-visible queue status without exposing sensitive parameters.
2. Add task dependency graph contracts and bounded DAG execution for explicitly independent, read-only branches first.
3. Add cancellation propagation for queued and running scheduled work, plus graceful shutdown/drain.
4. Add worker-thread isolation only for measured CPU-bound tasks.
5. Add durable multi-process queue/leases only if JARVIS is deployed with more than one core process.
6. Build, then run concurrency stress, race, cancellation, starvation, crash/recovery and real desktop/device acceptance tests in the user's chosen test phase.

## Acceptance gates

- Global and per-device limits are never exceeded.
- Conflicting resources never overlap; unrelated resources can progress concurrently.
- Opposite requested lock order cannot deadlock.
- Cancelled/timed-out queued work never invokes its adapter.
- Duplicate task admission is rejected.
- Failure/cancellation always releases slots and locks.
- Interactive priority works while aging prevents indefinite starvation.
- Scheduler dispatches independent due jobs concurrently but never runs one job twice in overlapping ticks.
- No task bypasses policy, approvals, audit, durable checkpoints or outcome verification.
- Process restart never automatically replays an uncertain side effect.
