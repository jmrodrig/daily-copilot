package com.bespoke.copilot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bespoke.copilot.BuildConfig
import com.bespoke.copilot.NetworkClient
import com.bespoke.copilot.ui.theme.CopilotColors
import kotlinx.coroutines.launch

private data class Choice(val label: String, val value: String)

private val SOURCES = listOf(
    Choice("Verbal", "verbal"),
    Choice("Meeting", "meeting"),
    Choice("Email", "email"),
    Choice("Other", "other"),
)

// "Not sure" saves to the Inbox for sorting later.
private val PROJECTS = listOf(
    Choice("C7801", "C7801"),
    Choice("R5301", "R5301"),
    Choice("P5002", "P5002"),
    Choice("Not sure", "Inbox"),
)

// Labels from the mockup mapped onto the backend's priorities.
private val PRIORITIES = listOf(
    Choice("Urgent", "urgent"),
    Choice("This week", "normal"),
    Choice("Park it", "low"),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CaptureScreen(showMessage: (String, Boolean) -> Unit) {
    var content by rememberSaveable { mutableStateOf("") }
    var source by rememberSaveable { mutableStateOf(SOURCES.first().value) }
    var project by rememberSaveable { mutableStateOf("Inbox") }
    var priority by rememberSaveable { mutableStateOf("normal") }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun save() {
        saving = true
        scope.launch {
            val result = NetworkClient.saveCapture(content, project, priority, source)
            saving = false
            result
                .onSuccess { path ->
                    content = ""
                    showMessage("Saved to $path", false)
                }
                .onFailure { error -> showMessage("Save failed: ${error.message ?: "unknown error"}", true) }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        ScreenHeader(title = "Capture", subtitle = "Drop it here. Sort it later.")

        OutlinedTextField(
            value = content,
            onValueChange = { content = it },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 170.dp),
            placeholder = { Text("What came up?", color = CopilotColors.TextMuted, fontSize = 17.sp) },
            textStyle = TextStyle(fontSize = 17.sp, color = CopilotColors.TextPrimary),
            enabled = !saving,
            shape = RoundedCornerShape(14.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = CopilotColors.SurfaceRaised,
                unfocusedContainerColor = CopilotColors.SurfaceRaised,
                disabledContainerColor = CopilotColors.SurfaceRaised,
                focusedBorderColor = CopilotColors.Accent.copy(alpha = 0.7f),
                unfocusedBorderColor = CopilotColors.BorderLight,
                disabledBorderColor = CopilotColors.Border,
                cursorColor = CopilotColors.Accent,
            ),
        )

        ChoiceGroup("Source", SOURCES, source, !saving) { source = it }
        ChoiceGroup("Project", PROJECTS, project, !saving) { project = it }
        ChoiceGroup("Priority", PRIORITIES, priority, !saving) { priority = it }

        PrimaryButton(
            text = if (project == "Inbox") "Save to inbox" else "Save to $project",
            enabled = content.isNotBlank(),
            busy = saving,
            onClick = { save() },
        )

        Text(
            text = "v${BuildConfig.VERSION_NAME} · ${BuildConfig.BACKEND_URL}",
            fontSize = 12.sp,
            color = CopilotColors.TextMuted,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChoiceGroup(
    label: String,
    options: List<Choice>,
    selected: String,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel(label)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            options.forEach { option ->
                Pill(option.label, selected = option.value == selected, enabled = enabled) { onSelect(option.value) }
            }
        }
    }
}
