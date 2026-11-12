# JARVIS Task Concurrency & Deadlock Safety

**Status:** Bounded task coordination and a branch-aware DAG execution coordinator are implemented in source. Core workflow-route integration, build and tests remain pending.  
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
- A task identifier cannot be queued or active twice at once. Nested admission from a coordinated worker is rejected through async execution-context tracking, preventing reentrant lock-order deadlocks.
- A waiting task can be cancelled through its AbortSignal. It is rejected before its adapter callback starts.
- Adapter errors and cancellation always release the concurrency slot and every acquired resource lock.
- Scheduler ticks now advance and durably persist each due job's at-most-once state before dispatching independent jobs concurrently, with a separate four-job dispatch ceiling. The core planner and execution coordinators still apply the stricter actual work limits.

## Task lifecycle visibility

The core health snapshot now includes opaque task IDs for active and queued work, queue wait duration, effective priority, and whether a queued item is blocked by a held resource or its device concurrency limit. It also reports separate planner queue state. It deliberately omits resource names, request text, operation parameters and device identifiers so private window titles, paths and user data are not leaked through diagnostics.

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
- **Reentrancy guard:** async execution-context tracking rejects nested admission from a worker already holding coordinated resources.
- **DAG validation:** workflow templates already use Kahn's topological-sort algorithm to reject dependency cycles.
- **At-most-once scheduling:** scheduler persists the next-run state before dispatch, preventing a restart from blindly replaying a due job.
- **Cooperative cancellation and deadlines:** waiting work can be removed before it starts; executing adapters receive an AbortSignal and the existing execution timeout.
- **Fail-safe recovery:** interrupted tasks remain recovery-required; uncertain state-changing operations are never automatically replayed.

## Important limits

- The coordinator is process-local. It is correct for the current single-host Node service; it is not a distributed lock manager for multiple JARVIS server replicas. A multi-process deployment must add a transactional shared queue/lease store before horizontal scaling.
- JavaScript async I/O concurrency is not the same as CPU parallelism. Do not create a worker thread for every request. A separate bounded worker-thread pool should be introduced only for measured CPU-bound workloads (for example, local inference preprocessing or expensive media analysis), with message schemas, cancellation, memory limits and shutdown semantics.
- The existing workflow:run service path still expands into the legacy sequential task lifecycle. A new WorkflowBranchExecutor implements bounded concurrent DAG-node execution, branch-scoped approval references, durable checkpoint callbacks, resource conflict exclusion, dependency-aware joins, partial outcomes and explicit no-effect recovery. It is not yet wired into the service route; do not claim live workflow templates execute concurrently until that integration is complete.
- Resource locks are conservative operation-level isolation, not proof that every third-party application is thread-safe. New adapters must declare their shared resources and must not acquire locks outside the coordinator.
- The coordinator prevents deadlocks caused by its own resource-lock protocol; it does not claim to detect arbitrary deadlocks inside an operating system, third-party application, native adapter, or external service.

## Workflow branch execution and recovery

workflowExecutionBatches remains the deterministic DAG-wave planning primitive. The new src/workflows/workflowExecution.ts adds an execution coordinator with the following source-level behavior:

- Runs dependency-ready branches concurrently up to a validated limit (1–8; default 4).
- Acquires each branch's complete resource-key set before dispatch; conflicting branches serialize while unrelated branches may overlap.
- Persists the run and each running transition before invoking the injected executor. Checkpoint writes are serialized and promises are kept outside the serializable checkpoint model.
- Keeps branch status, attempt count, dependency IDs, outcome, approval reference and bounded message independently.
- An approval-required branch enters awaiting_approval; unrelated branches continue. Descendants remain pending until every prerequisite is completed.
- Resume requires the same run ID and exact workflow graph. A saved approval reference is not itself authorization: the caller must supply the matching reference only after the normal JARVIS approval endpoint confirms it. The executor callback must still revalidate/consume the exact task/device/operation/parameter-bound approval through the policy gateway.
- A branch found running after process restart becomes uncertain; it is never automatically retried. Only an owner-reviewed reconciledNoEffectSteps entry can return that branch to pending. Effect-observed and still-unknown outcomes remain non-replayable.
- Verified failure, partial, uncertain, blocked or cancelled branches block descendants; unrelated branches continue and the run reports partial/uncertain rather than false success.
- Checkpoint failure before dispatch prevents the executor callback. Failure after dispatch is treated as uncertain because an external effect may have occurred.
- This module is an orchestration primitive, not a policy adapter. Its callback must be integrated with JarvisCoreService task records, approval lifecycle, audit, encrypted TaskJournal, resource derivation and outcome verifier before live workflow templates use it.

## Next implementation stages

1. Integrate branch records into the encrypted task journal and owner task timeline; expose parent/child task relationships and per-branch approvals.
2. Wire WorkflowBranchExecutor into workflow:run through the existing policy gateway, task-scoped approvals, audit and independent outcome verifier. Keep the legacy sequential route until this is complete.
3. Add graceful shutdown/drain and cancellation propagation across branch workers.
4. Add validated owner/runtime concurrency settings and owner-visible lifecycle controls.
5. Add worker-thread isolation only for measured CPU-bound tasks; add durable multi-process queue/leases only if JARVIS runs more than one core process.
6. Build, then run concurrency stress, race, approval, cancellation, starvation, crash/recovery and real desktop/device acceptance tests in the user's chosen test phase.

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
- Workflow approval references are branch-scoped and are not accepted as authority without policy-gateway revalidation.
- A failed/uncertain dependency blocks descendants while independent branches may complete.
- Process restart never automatically replays an uncertain side effect; retry requires explicit no-effect reconciliation.
