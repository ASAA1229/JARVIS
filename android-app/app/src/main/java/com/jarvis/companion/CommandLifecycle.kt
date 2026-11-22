package com.jarvis.companion

/**
 * The single command lifecycle shared with the core, event bus and HUD
 * (src/core/commandLifecycle.ts): queued -> running -> completed | failed | cancelled | timed_out.
 * The server sends `lifecycle` on tasks and events; the fallback below only covers older servers.
 */
object CommandLifecycle {
    const val QUEUED = "queued"
    const val RUNNING = "running"
    const val COMPLETED = "completed"
    const val FAILED = "failed"
    const val CANCELLED = "cancelled"
    const val TIMED_OUT = "timed_out"

    fun fromTaskState(state: String): String = when (state) {
        "CREATED", "AWAITING_APPROVAL", "APPROVED" -> QUEUED
        "EXECUTING" -> RUNNING
        "COMPLETED", "PARTIAL" -> COMPLETED
        "REJECTED", "CANCELLED" -> CANCELLED
        "EXPIRED" -> TIMED_OUT
        else -> FAILED
    }

    /** Uncertain outcome (the action may have partly happened): only the owner can settle it. Mirrors needsOwnerReview() in the core. */
    fun needsOwnerReview(state: String): Boolean = state == "AWAITING_RECOVERY" || state == "INTERRUPTED"

    fun isInFlight(lifecycle: String): Boolean = lifecycle == QUEUED || lifecycle == RUNNING
}
