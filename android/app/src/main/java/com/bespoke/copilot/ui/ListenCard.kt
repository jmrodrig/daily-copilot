package com.bespoke.copilot.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.bespoke.copilot.ListenState
import com.bespoke.copilot.VoiceRecordingService
import com.bespoke.copilot.formatDuration
import com.bespoke.copilot.ui.theme.CopilotColors
import kotlinx.coroutines.delay

private val RecordingRed = Color(0xFFE5484D)

private fun Context.isGranted(permission: String) =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

/**
 * Start / pause / stop a voice note, recorded by [VoiceRecordingService] (which keeps going, with its persistent
 * notification, when the app is closed). The recording is transcribed into a voice note in [project]'s inbox.
 */
@Composable
fun ListenCard(project: String, showMessage: (String, Boolean) -> Unit) {
    val context = LocalContext.current
    val state by VoiceRecordingService.state.collectAsState()
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }

    val recording = state.phase == ListenState.Phase.RECORDING
    LaunchedEffect(recording) {
        while (recording) {
            now = SystemClock.elapsedRealtime()
            delay(500)
        }
    }

    // The notification permission is asked for alongside, but only the microphone is required.
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (context.isGranted(Manifest.permission.RECORD_AUDIO)) {
            VoiceRecordingService.start(context, project)
        } else {
            showMessage("Voice notes need the microphone permission", true)
        }
    }

    fun startListening() {
        val missing = buildList {
            if (!context.isGranted(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !context.isGranted(Manifest.permission.POST_NOTIFICATIONS)
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (missing.isEmpty()) VoiceRecordingService.start(context, project) else permissions.launch(missing.toTypedArray())
    }

    val target = if (project == "Inbox") "the inbox" else project
    val activeTarget = if (state.project == "Inbox") "the inbox" else state.project

    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (state.isCapturing) {
                    Box(
                        Modifier
                            .size(10.dp)
                            .background(if (recording) RecordingRed else CopilotColors.TextMuted, CircleShape),
                    )
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        when (state.phase) {
                            ListenState.Phase.IDLE -> "Voice note"
                            ListenState.Phase.RECORDING -> "Listening"
                            ListenState.Phase.PAUSED -> "Paused"
                            ListenState.Phase.UPLOADING -> "Transcribing..."
                        },
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = CopilotColors.TextPrimary,
                    )
                    Text(
                        when (state.phase) {
                            ListenState.Phase.IDLE -> "Record a meeting or a thought; it's transcribed into $target."
                            ListenState.Phase.UPLOADING -> "Saving to $activeTarget. You can leave the app."
                            else -> "Keeps recording with the screen locked. Saving to $activeTarget."
                        },
                        fontSize = 14.sp,
                        color = CopilotColors.TextMuted,
                    )
                }
                if (state.phase != ListenState.Phase.IDLE) {
                    Text(
                        formatDuration(state.elapsedMillis(now)),
                        fontSize = 18.sp,
                        fontFamily = FontFamily.Monospace,
                        color = if (recording) CopilotColors.TextPrimary else CopilotColors.TextMuted,
                    )
                }
            }

            when (state.phase) {
                ListenState.Phase.IDLE -> PrimaryButton("Start listening", enabled = true, busy = false) { startListening() }
                ListenState.Phase.UPLOADING -> PrimaryButton("Transcribing", enabled = false, busy = true) {}
                ListenState.Phase.RECORDING, ListenState.Phase.PAUSED -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.weight(1f)) {
                        SecondaryButton(if (recording) "Pause" else "Resume") {
                            if (recording) VoiceRecordingService.pause(context) else VoiceRecordingService.resume(context)
                        }
                    }
                    Box(Modifier.weight(1f)) {
                        PrimaryButton("Stop", enabled = true, busy = false) { VoiceRecordingService.stop(context) }
                    }
                }
            }
        }
    }
}

@Composable
private fun SecondaryButton(text: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, CopilotColors.BorderStrong),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = CopilotColors.TextPrimary),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp),
    ) {
        Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}
