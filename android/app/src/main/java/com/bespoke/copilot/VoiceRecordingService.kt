package com.bespoke.copilot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.TimeUnit

/** The app's one voice recording, as the UI sees it (see [VoiceRecordingService.state]). */
data class ListenState(
    val phase: Phase = Phase.IDLE,
    val project: String = "Inbox",
    /** Time recorded before the current stretch, i.e. banked by pauses. */
    val bankedMillis: Long = 0,
    /** [SystemClock.elapsedRealtime] when the current stretch began; null unless recording. */
    val resumedAt: Long? = null,
) {
    enum class Phase { IDLE, RECORDING, PAUSED, UPLOADING }

    val isCapturing: Boolean get() = phase == Phase.RECORDING || phase == Phase.PAUSED

    fun elapsedMillis(now: Long = SystemClock.elapsedRealtime()): Long =
        bankedMillis + (resumedAt?.let { now - it } ?: 0)
}

/** How a recording ended, once it's been uploaded and transcribed (or failed to be). */
sealed interface ListenEvent {
    data class Saved(val notePath: String) : ListenEvent
    data class Failed(val message: String) : ListenEvent
}

/** "03:12", or "1:03:12" past the hour. */
fun formatDuration(millis: Long): String {
    val total = millis / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) String.format(Locale.UK, "%d:%02d:%02d", h, m, s) else String.format(Locale.UK, "%02d:%02d", m, s)
}

/**
 * Records the microphone in a foreground service, so a voice note keeps recording with the screen locked or the app
 * in the background. A persistent notification (`Daily Copilot: Listening...`) shows the running time with Pause /
 * Resume and Stop actions. On stop, the recording is uploaded to `/api/voice/transcribe`, which transcribes it into
 * a listen block in a note; the local file is deleted once the backend has it.
 *
 * Ported from First Mate's `RecordingService` (mic only: the phone has no Teams loopback to capture).
 */
class VoiceRecordingService : Service() {

    companion object {
        private const val TAG = "Copilot_VoiceService"
        private const val CHANNEL_ID = "copilot_voice_listening"
        private const val RESULT_CHANNEL_ID = "copilot_voice_results"
        private const val NOTIFICATION_ID = 1301
        private const val RESULT_NOTIFICATION_ID = 1302

        private const val ACTION_START = "com.bespoke.copilot.voice.START"
        private const val ACTION_PAUSE = "com.bespoke.copilot.voice.PAUSE"
        private const val ACTION_RESUME = "com.bespoke.copilot.voice.RESUME"
        private const val ACTION_STOP = "com.bespoke.copilot.voice.STOP"
        private const val EXTRA_PROJECT = "project"
        private const val EXTRA_NOTE_PATH = "note_path"

        // A safety net: the lock is released on stop, but never outlives a forgotten recording by much.
        private val WAKE_LOCK_TIMEOUT_MS = TimeUnit.HOURS.toMillis(6)

        private val _state = MutableStateFlow(ListenState())
        val state: StateFlow<ListenState> = _state.asStateFlow()

        private val _events = MutableSharedFlow<ListenEvent>(extraBufferCapacity = 4)
        val events: SharedFlow<ListenEvent> = _events.asSharedFlow()

        /**
         * Starts recording a voice note for [project] (or appended to [notePath]). Needs RECORD_AUDIO granted, and
         * must be called while the app is in the foreground (Android 14 won't start a microphone service otherwise).
         */
        fun start(context: Context, project: String, notePath: String? = null) {
            val intent = intent(context, ACTION_START).putExtra(EXTRA_PROJECT, project)
            if (notePath != null) intent.putExtra(EXTRA_NOTE_PATH, notePath)
            ContextCompat.startForegroundService(context, intent)
        }

        fun pause(context: Context) {
            context.startService(intent(context, ACTION_PAUSE))
        }

        fun resume(context: Context) {
            context.startService(intent(context, ACTION_RESUME))
        }

        fun stop(context: Context) {
            context.startService(intent(context, ACTION_STOP))
        }

        private fun intent(context: Context, action: String) =
            Intent(context, VoiceRecordingService::class.java).setAction(action)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var recorder: MediaRecorder? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioFile: File? = null
    private var notePath: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRecording(
                intent.getStringExtra(EXTRA_PROJECT) ?: "Inbox",
                intent.getStringExtra(EXTRA_NOTE_PATH),
            )
            ACTION_PAUSE -> pauseRecording()
            ACTION_RESUME -> resumeRecording()
            ACTION_STOP -> stopRecording()
            else -> if (_state.value.phase == ListenState.Phase.IDLE) stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // Only reached mid-recording if the system tears the service down: finalise what was recorded, on disk.
        if (_state.value.isCapturing) runCatching { recorder?.stop() }
        releaseRecorder()
        releaseWakeLock()
        scope.cancel()
        _state.value = ListenState()
        super.onDestroy()
    }

    private fun startRecording(project: String, notePath: String?) {
        val current = _state.value
        if (current.phase != ListenState.Phase.IDLE) {
            // Already foreground (recording or uploading), which satisfies startForegroundService.
            if (current.phase == ListenState.Phase.UPLOADING) {
                _events.tryEmit(ListenEvent.Failed("The last voice note is still being transcribed: wait for it to finish."))
            }
            return
        }

        val starting = ListenState(ListenState.Phase.RECORDING, project, 0, SystemClock.elapsedRealtime())
        try {
            // Android 14: go foreground, with the microphone type, before touching the mic.
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(starting),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
            )
        } catch (e: Exception) {
            // Missing RECORD_AUDIO, or started from the background.
            Log.e(TAG, "Couldn't start the foreground service", e)
            fail("Couldn't start listening: ${e.message ?: "permission denied"}")
            return
        }

        val file = newRecordingFile()
        try {
            recorder = newRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(1)
                setAudioSamplingRate(44100)
                setAudioEncodingBitRate(96000)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            audioFile = file
            this.notePath = notePath
            acquireWakeLock()
            _state.value = starting.copy(resumedAt = SystemClock.elapsedRealtime())
            updateNotification()
            Log.i(TAG, "Listening -> ${file.name}")
        } catch (e: Exception) {
            Log.e(TAG, "Couldn't start the recorder", e)
            releaseRecorder()
            file.delete()
            fail("Couldn't start listening: the microphone is busy (a call?)")
        }
    }

    private fun pauseRecording() {
        val current = _state.value
        if (current.phase != ListenState.Phase.RECORDING) return
        try {
            recorder?.pause()
            _state.value = current.copy(
                phase = ListenState.Phase.PAUSED,
                bankedMillis = current.elapsedMillis(),
                resumedAt = null,
            )
            updateNotification()
        } catch (e: Exception) {
            Log.e(TAG, "Pause failed", e)
        }
    }

    private fun resumeRecording() {
        val current = _state.value
        if (current.phase != ListenState.Phase.PAUSED) return
        try {
            recorder?.resume()
            _state.value = current.copy(phase = ListenState.Phase.RECORDING, resumedAt = SystemClock.elapsedRealtime())
            updateNotification()
        } catch (e: Exception) {
            Log.e(TAG, "Resume failed", e)
        }
    }

    private fun stopRecording() {
        val current = _state.value
        if (!current.isCapturing) {
            if (current.phase == ListenState.Phase.IDLE) stopSelf()
            return
        }

        val file = audioFile
        val stopped = try {
            recorder?.stop()
            true
        } catch (e: RuntimeException) {
            // MediaRecorder throws if it never got any audio (stopped straight away, or the mic was blocked).
            Log.e(TAG, "Stop failed", e)
            false
        }
        releaseRecorder()
        releaseWakeLock()
        if (!stopped) file?.delete()

        if (!stopped || file == null || !file.exists()) {
            fail("Nothing was recorded.")
            return
        }

        _state.value = current.copy(
            phase = ListenState.Phase.UPLOADING,
            bankedMillis = current.elapsedMillis(),
            resumedAt = null,
        )
        updateNotification()

        val appendTo = notePath
        scope.launch {
            NetworkClient.transcribeVoice(file, current.project, appendTo)
                .onSuccess { path ->
                    file.delete()
                    finish(ListenEvent.Saved(path), "Voice note saved", path)
                }
                .onFailure { error ->
                    Log.e(TAG, "Upload failed; the recording is kept at ${file.absolutePath}", error)
                    finish(
                        ListenEvent.Failed("Transcription failed: ${error.message ?: "unknown error"}"),
                        "Voice note not transcribed",
                        "${error.message ?: "Upload failed"}. The recording is kept on the phone (${file.name}).",
                    )
                }
        }
    }

    /** Ends the session: reports [event], posts a dismissible result notification and stops the service. */
    private fun finish(event: ListenEvent, title: String, text: String) {
        _events.tryEmit(event)
        notify(
            RESULT_NOTIFICATION_ID,
            NotificationCompat.Builder(this, RESULT_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openAppIntent())
                .setAutoCancel(true)
                .build(),
        )
        shutDown()
    }

    private fun fail(message: String) {
        _events.tryEmit(ListenEvent.Failed(message))
        shutDown()
    }

    private fun shutDown() {
        _state.value = ListenState()
        audioFile = null
        notePath = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    @Suppress("DEPRECATION")
    private fun newRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else MediaRecorder()

    private fun newRecordingFile(): File {
        val dir = File(filesDir, "voice").apply { mkdirs() }
        val stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss", Locale.UK))
        return File(dir, "voice_$stamp.m4a")
    }

    private fun releaseRecorder() {
        recorder?.release()
        recorder = null
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(PowerManager::class.java) ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Copilot:VoiceRecording").apply {
            setReferenceCounted(false)
            acquire(WAKE_LOCK_TIMEOUT_MS)
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    // --- Notifications ---------------------------------------------------------------------------------------

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Listening", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Shown while a voice note is recording"
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(RESULT_CHANNEL_ID, "Voice notes", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "When a voice note has been transcribed, or couldn't be"
            },
        )
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun actionIntent(action: String, requestCode: Int): PendingIntent = PendingIntent.getService(
        this,
        requestCode,
        intent(this, action),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildNotification(state: ListenState): Notification {
        val where = if (state.project == "Inbox") "the inbox" else state.project
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

        when (state.phase) {
            ListenState.Phase.RECORDING -> builder
                .setContentTitle("Daily Copilot: Listening...")
                .setContentText("Recording a voice note for $where")
                // The system ticks the chronometer, so the notification needn't be reposted every second.
                .setUsesChronometer(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis() - state.elapsedMillis())
                .addAction(android.R.drawable.ic_media_pause, "Pause", actionIntent(ACTION_PAUSE, 1))
                .addAction(android.R.drawable.ic_menu_save, "Stop Recording", actionIntent(ACTION_STOP, 2))
            ListenState.Phase.PAUSED -> builder
                .setContentTitle("Daily Copilot: Paused")
                .setContentText("${formatDuration(state.elapsedMillis())} recorded for $where")
                .setShowWhen(false)
                .addAction(android.R.drawable.ic_media_play, "Resume", actionIntent(ACTION_RESUME, 3))
                .addAction(android.R.drawable.ic_menu_save, "Stop Recording", actionIntent(ACTION_STOP, 2))
            ListenState.Phase.UPLOADING, ListenState.Phase.IDLE -> builder
                .setContentTitle("Daily Copilot: Transcribing...")
                .setContentText("${formatDuration(state.elapsedMillis())} voice note for $where")
                .setShowWhen(false)
                .setProgress(0, 0, true)
        }
        return builder.build()
    }

    private fun updateNotification() = notify(NOTIFICATION_ID, buildNotification(_state.value))

    // Without POST_NOTIFICATIONS (Android 13+) the system drops these silently; the foreground service still runs.
    private fun notify(id: Int, notification: Notification) {
        getSystemService(NotificationManager::class.java)?.notify(id, notification)
    }
}
