package com.jarvis.companion

import android.app.Activity
import android.app.AlertDialog
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.text.DateFormat
import java.util.Date

/**
 * Owner panels on the phone. Every button calls a signed laptop endpoint; the laptop
 * policy gateway decides what this phone may do (device-management phones see more).
 * Nothing here grants authority locally, and approvals stay single-use and laptop-side.
 */
class OwnerPanels(
    private val activity: Activity,
    private val session: CompanionSession,
    private val client: () -> JarvisApiClient,
    private val run: (label: String, action: () -> String) -> Unit,
) {
    private lateinit var approvalsList: LinearLayout
    private lateinit var tasksList: LinearLayout
    private lateinit var devicesList: LinearLayout
    private lateinit var memoryList: LinearLayout
    private lateinit var candidatesList: LinearLayout
    private lateinit var syncList: LinearLayout
    private lateinit var memoryCategory: EditText
    private lateinit var memoryText: EditText
    private lateinit var commandText: EditText

    fun attach(root: LinearLayout) {
        header(root, "APPROVALS & TASKS")
        button(root, "Refresh approvals") { loadApprovals() }
        approvalsList = list(root)
        button(root, "Refresh task status") { loadTasks() }
        tasksList = list(root)

        header(root, "DEVICES")
        button(root, "List enrolled devices") { loadDevices() }
        devicesList = list(root)

        header(root, "MEMORY")
        button(root, "Review long-term memory") { loadMemories() }
        memoryList = list(root)
        button(root, "Review learning suggestions") { loadCandidates() }
        candidatesList = list(root)

        header(root, "OFFLINE SYNC")
        memoryCategory = field(root, "Memory category (preference, project, routine, general)", "general")
        memoryText = field(root, "Memory to add (queued offline, needs owner approval on sync)", "")
        button(root, "Queue memory for sync") {
            run("Queued") {
                syncClient().queueMemoryCreate(memoryCategory.text.toString().trim(), memoryText.text.toString())
                activity.runOnUiThread { memoryText.setText("") }
                "Queued. ${syncClient().pendingCount()} change(s) waiting for the next sync."
            }
        }
        commandText = field(root, "Command to hold for the laptop (never auto-run)", "")
        button(root, "Queue command for owner review") {
            run("Queued") {
                syncClient().queueCommand(commandText.text.toString())
                activity.runOnUiThread { commandText.setText("") }
                "Queued. The laptop holds it until you explicitly run it."
            }
        }
        button(root, "Sync now") { syncNow() }
        button(root, "Review conflicts & held commands") { loadSyncOverview() }
        syncList = list(root)

        header(root, "LAN PEER PAIRING")
        val pairingCode = field(root, "6-digit pairing code from the laptop HUD", "")
        button(root, "Confirm pairing") {
            run("Pairing") {
                session.guard { client().confirmPeerPairing(pairingCode.text.toString()) }
                    .also { activity.runOnUiThread { pairingCode.setText("") } }
            }
        }
        button(root, "Peer status") { run("Checking") { session.guard { client().peerStatus() } } }

        header(root, "NOTIFICATIONS")
        button(root, if (session.notificationsEnabled) "Approval alerts: ON (tap to turn off)" else "Approval alerts: OFF (tap to turn on)") {
            session.notificationsEnabled = !session.notificationsEnabled
            if (session.notificationsEnabled) ApprovalPollWorker.schedule(activity) else ApprovalPollWorker.cancel(activity)
            (it as Button).text = if (session.notificationsEnabled) "Approval alerts: ON (tap to turn off)" else "Approval alerts: OFF (tap to turn on)"
        }
    }

    private fun syncClient() = SyncClient(client(), session.syncQueueFile, session.keys)

    // ---- approvals and tasks ----

    private fun loadApprovals(): Unit = run("Loading approvals") {
        val pending = session.guard { client().pendingApprovals() }
        activity.runOnUiThread {
            approvalsList.removeAllViews()
            if (pending.isEmpty()) approvalsList.addView(text("No actions are waiting for approval."))
            for (item in pending) {
                approvalsList.addView(text("${item.operation}\n\"${item.requestText}\""))
                val actionRow: LinearLayout = newActionRow(approvalsList)
                rowButton(actionRow, "Approve") { confirm("Approve this exact action?\n\n${item.requestText}") { decide(item, true) } }
                rowButton(actionRow, "Reject") { decide(item, false) }
            }
        }
        "${pending.size} approval(s) waiting."
    }

    private fun decide(item: PendingApproval, approve: Boolean): Unit = run(if (approve) "Approving" else "Rejecting") {
        val message = session.guard { client().resolveApproval(item.approvalId, approve) }
        activity.runOnUiThread { loadApprovals() }
        message
    }

    private fun loadTasks() = run("Loading tasks") {
        val tasks = session.guard { client().listTasks() }
        activity.runOnUiThread {
            tasksList.removeAllViews()
            if (tasks.isEmpty()) tasksList.addView(text("No recent tasks."))
            for (task in tasks.take(20)) {
                tasksList.addView(text("${task.lifecycle} (${task.state}) - ${task.operation.ifBlank { "planning" }} (${time(task.updatedAt)})"))
                if (CommandLifecycle.isInFlight(task.lifecycle)) {
                    val actionRow: LinearLayout = newActionRow(tasksList)
                    rowButton(actionRow, if (task.lifecycle == CommandLifecycle.RUNNING) "Stop" else "Cancel") {
                        run("Cancelling") { session.guard { client().cancelTask(task.id) } }
                    }
                }
            }
        }
        "${tasks.size} recent task(s)."
    }

    // ---- devices ----

    private fun loadDevices() = run("Loading devices") {
        val devices = session.guard { client().listDevices() }
        activity.runOnUiThread {
            devicesList.removeAllViews()
            for (device in devices) {
                val mine = if (device.id == session.keys.deviceId()) " (this phone)" else ""
                devicesList.addView(text("${device.name}$mine - ${device.platform} - ${device.status}" +
                    if (device.sessionActive) " - online" else ""))
            }
            if (devices.isEmpty()) devicesList.addView(text("No devices returned."))
        }
        "${devices.size} device(s). Revoke lost devices from the laptop HUD or owner recovery."
    }

    // ---- memory ----

    private fun loadMemories() = run("Loading memory") {
        val memories = session.guard { client().listMemories() }
        activity.runOnUiThread {
            memoryList.removeAllViews()
            if (memories.isEmpty()) memoryList.addView(text("No long-term memories."))
            for (memory in memories) {
                memoryList.addView(text("[${memory.category}] ${memory.content}"))
                val actionRow: LinearLayout = newActionRow(memoryList)
                rowButton(actionRow, "Forget") {
                    confirm("Ask JARVIS to forget this memory? You will approve the deletion.") {
                        run("Requesting deletion") {
                            val reply = session.guard { client().requestMemoryDelete(memory.id) }
                            "${reply.state}: ${reply.message}"
                        }
                    }
                }
            }
        }
        "${memories.size} memory record(s)."
    }

    private fun loadCandidates() = run("Loading suggestions") {
        val candidates = session.guard { client().learningCandidates() }
        activity.runOnUiThread {
            candidatesList.removeAllViews()
            if (candidates.isEmpty()) candidatesList.addView(text("No learning suggestions are waiting."))
            for (candidate in candidates) {
                candidatesList.addView(text("[${candidate.category}, from ${candidate.source}] ${candidate.content}"))
                val actionRow: LinearLayout = newActionRow(candidatesList)
                rowButton(actionRow, "Remember") { run("Saving") { session.guard { client().decideCandidate(candidate.id, true) } } }
                rowButton(actionRow, "Discard") { run("Discarding") { session.guard { client().decideCandidate(candidate.id, false) } } }
            }
        }
        "${candidates.size} suggestion(s)."
    }

    // ---- sync ----

    private fun syncNow() = run("Syncing") {
        val report = session.guard { syncClient().syncNow() }
        val outcomes = report.outcomes.entries.joinToString(", ") { "${it.value} ${it.key.replace('_', ' ')}" }.ifBlank { "nothing to push" }
        "Pushed ${report.pushed}: $outcomes. ${report.changedMemories} memory change(s) pulled. " +
            "${report.conflicts.size} conflict(s) need review. ${syncClient().pendingCount()} still queued."
    }

    private fun loadSyncOverview() = run("Loading sync review") {
        val overview = session.guard { client().syncOverview() }
        val conflicts = overview.optJSONArray("conflicts")
        val commands = overview.optJSONArray("commands")
        activity.runOnUiThread {
            syncList.removeAllViews()
            if ((conflicts?.length() ?: 0) == 0 && (commands?.length() ?: 0) == 0) {
                syncList.addView(text("No open conflicts or held commands."))
            }
            for (i in 0 until (conflicts?.length() ?: 0)) {
                val c = conflicts!!.getJSONObject(i)
                val id = c.optString("id")
                syncList.addView(text("Conflict (${c.optString("kind").replace('_', ' ')})\nLaptop: ${c.optString("hubContent").ifBlank { "(deleted)" }}\nPhone: ${c.optString("deviceContent").ifBlank { "(delete)" }}"))
                val actionRow: LinearLayout = newActionRow(syncList)
                rowButton(actionRow, "Keep laptop") { run("Resolving") { session.guard { client().resolveConflict(id, "keep_hub") } } }
                rowButton(actionRow, "Keep phone") { run("Resolving") { session.guard { client().resolveConflict(id, "keep_device") } } }
                rowButton(actionRow, "Merge") { mergeDialog(id, c.optString("hubContent"), c.optString("deviceContent")) }
            }
            for (i in 0 until (commands?.length() ?: 0)) {
                val cmd = commands!!.getJSONObject(i)
                val id = cmd.optString("id")
                syncList.addView(text("Held command: \"${cmd.optString("text")}\" (expires ${time(cmd.optLong("expiresAt"))})"))
                val actionRow: LinearLayout = newActionRow(syncList)
                rowButton(actionRow, "Run") {
                    confirm("Run this held command now? It still goes through normal policy and approval.\n\n${cmd.optString("text")}") {
                        run("Submitting") { session.guard { client().decideHeldCommand(id, true) } }
                    }
                }
                rowButton(actionRow, "Discard") { run("Discarding") { session.guard { client().decideHeldCommand(id, false) } } }
            }
        }
        "${conflicts?.length() ?: 0} conflict(s), ${commands?.length() ?: 0} held command(s)."
    }

    private fun mergeDialog(conflictId: String, hub: String, device: String) {
        val input = EditText(activity).apply { setText(listOf(hub, device).filter { it.isNotBlank() }.joinToString("\n")) }
        AlertDialog.Builder(activity)
            .setTitle("Merged memory text")
            .setView(input)
            .setPositiveButton("Submit") { _, _ ->
                run("Resolving") { session.guard { client().resolveConflict(conflictId, "merge", input.text.toString()) } }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---- small view helpers ----

    private fun confirm(message: String, onYes: () -> Unit) {
        AlertDialog.Builder(activity).setMessage(message)
            .setPositiveButton("Yes") { _, _ -> onYes() }
            .setNegativeButton("No", null).show()
    }

    private fun time(millis: Long): String =
        if (millis <= 0) "unknown time" else DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(millis))

    private fun params() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { bottomMargin = 10 }

    private fun header(root: LinearLayout, label: String) {
        root.addView(TextView(activity).apply { text = label; textSize = 18f }, params())
    }

    private fun text(value: String) = TextView(activity).apply { text = value; textSize = 14f }

    private fun list(root: LinearLayout) = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }.also { root.addView(it, params()) }

    private fun newActionRow(parent: LinearLayout) = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }.also { parent.addView(it, params()) }

    private fun rowButton(row: LinearLayout, label: String, onClick: () -> Unit) {
        row.addView(Button(activity).apply { text = label; setOnClickListener { onClick() } },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun button(root: LinearLayout, label: String, onClick: (android.view.View) -> Unit) {
        root.addView(Button(activity).apply { text = label; setOnClickListener(onClick) }, params())
    }

    private fun field(root: LinearLayout, hintText: String, value: String): EditText =
        EditText(activity).apply { hint = hintText; setText(value); textSize = 15f }.also { root.addView(it, params()) }
}
