package com.bespoke.copilot

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** One entry on the Morning List (`GET /api/triage`, see TriageItem in backend/schemas.py). */
data class TriageItem(
    val id: String,
    val kind: String,
    val rank: Int,
    val title: String,
    val project: String?,
    val priority: String,
    val status: String?,
    val assignee: String?,
    val startDate: LocalDate?,
    val dueDate: LocalDate?,
) {
    val isTask: Boolean get() = kind == "gantt_task"

    /** "task:12" -> 12; null for capture notes. */
    val taskId: Int? get() = if (isTask) id.removePrefix("task:").toIntOrNull() else null
}

/** The next unfinished milestone from `GET /api/gantt`. */
data class Milestone(val name: String, val project: String, val date: LocalDate)

/** Minimal client for the Daily Co-Pilot backend at [BuildConfig.BACKEND_URL]. */
object NetworkClient {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun url(path: String) = "${BuildConfig.BACKEND_URL}$path"

    private fun execute(request: Request): String =
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Server returned ${response.code}")
            }
            response.body?.string().orEmpty()
        }

    private fun get(path: String): String = execute(Request.Builder().url(url(path)).get().build())

    private fun post(path: String, body: JSONObject): String =
        execute(Request.Builder().url(url(path)).post(body.toString().toRequestBody(JSON)).build())

    /** `optString` turns JSON null into "null", so read nullable strings by hand. */
    private fun JSONObject.stringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else getString(key)

    private fun JSONObject.dateOrNull(key: String): LocalDate? =
        stringOrNull(key)?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }

    /**
     * POSTs a capture to `/api/capture` off the main thread.
     * Returns the saved note's path relative to the backend's notes directory.
     */
    suspend fun saveCapture(content: String, project: String, priority: String, source: String?): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val body = JSONObject()
                    .put("content", content)
                    .put("project", project)
                    .put("priority", priority)
                if (source != null) body.put("source", source)
                JSONObject(post("/api/capture", body)).getString("path")
            }
        }

    /** The Morning List, most urgent first. */
    suspend fun triage(): Result<List<TriageItem>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val items = JSONArray(get("/api/triage"))
                (0 until items.length()).map { i ->
                    val o = items.getJSONObject(i)
                    TriageItem(
                        id = o.getString("id"),
                        kind = o.getString("kind"),
                        rank = o.getInt("rank"),
                        title = o.getString("title"),
                        project = o.stringOrNull("project"),
                        priority = o.optString("priority", "normal"),
                        status = o.stringOrNull("status"),
                        assignee = o.stringOrNull("assignee"),
                        startDate = o.dateOrNull("start_date"),
                        dueDate = o.dateOrNull("due_date"),
                    )
                }
            }
        }

    /** The earliest unfinished milestone on or after [today], if any. */
    suspend fun nextMilestone(today: LocalDate): Result<Milestone?> =
        withContext(Dispatchers.IO) {
            runCatching {
                val projects = JSONObject(get("/api/gantt")).getJSONArray("projects")
                val milestones = mutableListOf<Milestone>()
                for (p in 0 until projects.length()) {
                    val project = projects.getJSONObject(p)
                    val tasks = project.getJSONArray("tasks")
                    for (t in 0 until tasks.length()) {
                        val task = tasks.getJSONObject(t)
                        if (!task.optBoolean("is_milestone") || task.optString("status") == "done") continue
                        val date = task.dateOrNull("end_date") ?: task.dateOrNull("start_date") ?: continue
                        if (date.isBefore(today)) continue
                        milestones += Milestone(task.getString("name"), project.getString("code"), date)
                    }
                }
                milestones.minByOrNull { it.date }
            }
        }

    /** Marks the tasks done (`POST /api/checkin`); returns how many were completed. */
    suspend fun checkIn(completedTaskIds: List<Int>): Result<Int> =
        withContext(Dispatchers.IO) {
            runCatching {
                val body = JSONObject().put("completed_task_ids", JSONArray(completedTaskIds))
                JSONObject(post("/api/checkin", body)).getJSONArray("completed_task_ids").length()
            }
        }
}
