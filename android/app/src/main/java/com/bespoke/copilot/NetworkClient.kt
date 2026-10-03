package com.bespoke.copilot

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Minimal client for the Daily Co-Pilot backend at [BuildConfig.BACKEND_URL]. */
object NetworkClient {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /**
     * POSTs a capture to `/api/capture` off the main thread.
     * Returns the saved note's path relative to the backend's notes directory.
     */
    suspend fun saveCapture(content: String, project: String, priority: String): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val body = JSONObject()
                    .put("content", content)
                    .put("project", project)
                    .put("priority", priority)
                    .toString()
                    .toRequestBody(JSON)
                val request = Request.Builder()
                    .url("${BuildConfig.BACKEND_URL}/api/capture")
                    .post(body)
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw IOException("Server returned ${response.code}")
                    }
                    JSONObject(response.body?.string().orEmpty()).getString("path")
                }
            }
        }
}
