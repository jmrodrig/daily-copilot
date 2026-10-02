package com.bespoke.copilot

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.bespoke.copilot.ui.theme.CopilotColors
import com.bespoke.copilot.ui.theme.CopilotTheme
import kotlinx.coroutines.launch

private val PROJECTS = listOf("C7801", "R5301", "P5002", "Inbox")
private val PRIORITIES = listOf("Low", "Normal", "High")

private fun projectColor(project: String): Color = when (project) {
    "C7801" -> CopilotColors.ProjectC7801
    "R5301" -> CopilotColors.ProjectR5301
    "P5002" -> CopilotColors.ProjectP5002
    else -> CopilotColors.ProjectNeutral
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CopilotTheme {
                CaptureScreen()
            }
        }
    }
}

@Composable
fun CaptureScreen() {
    var content by rememberSaveable { mutableStateOf("") }
    var project by rememberSaveable { mutableStateOf("Inbox") }
    var priority by rememberSaveable { mutableStateOf("Normal") }
    var saving by remember { mutableStateOf(false) }
    var lastSaveFailed by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    fun save() {
        saving = true
        scope.launch {
            val result = NetworkClient.saveCapture(content, project, priority)
            saving = false
            lastSaveFailed = result.isFailure
            result
                .onSuccess { path ->
                    content = ""
                    snackbarHostState.showSnackbar("Saved to $path")
                }
                .onFailure { error ->
                    snackbarHostState.showSnackbar("Save failed: ${error.message ?: "unknown error"}")
                }
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = {
            SnackbarHost(snackbarHostState) { data ->
                Snackbar(
                    snackbarData = data,
                    containerColor = CopilotColors.SurfaceRaised,
                    contentColor = if (lastSaveFailed) MaterialTheme.colorScheme.error else CopilotColors.TextPrimary,
                )
            }
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "Daily Co-Pilot Capture",
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onBackground,
            )

            OutlinedTextField(
                value = content,
                onValueChange = { content = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                placeholder = { Text("Quick note…", color = CopilotColors.TextMuted) },
                enabled = !saving,
            )

            Label("Project")
            ChoiceRow(
                options = PROJECTS,
                selected = project,
                onSelect = { project = it },
                enabled = !saving,
                selectedColor = projectColor(project),
            )

            Label("Priority")
            ChoiceRow(
                options = PRIORITIES,
                selected = priority,
                onSelect = { priority = it },
                enabled = !saving,
                selectedColor = CopilotColors.Accent,
            )

            Button(
                onClick = { save() },
                enabled = content.isNotBlank() && !saving,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
            ) {
                if (saving) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = CopilotColors.TextMuted,
                    )
                } else {
                    Text("Save")
                }
            }

            Text(
                text = "v${BuildConfig.VERSION_NAME} · ${BuildConfig.BACKEND_URL}",
                style = MaterialTheme.typography.bodySmall,
                color = CopilotColors.TextMuted,
            )
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = CopilotColors.TextSecondary,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChoiceRow(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    enabled: Boolean,
    selectedColor: Color,
) {
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        options.forEachIndexed { index, option ->
            SegmentedButton(
                selected = option == selected,
                onClick = { onSelect(option) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                enabled = enabled,
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = selectedColor.copy(alpha = 0.2f),
                    activeContentColor = selectedColor,
                    activeBorderColor = CopilotColors.BorderLight,
                    inactiveContainerColor = CopilotColors.SurfacePanel,
                    inactiveContentColor = CopilotColors.TextSecondary,
                    inactiveBorderColor = CopilotColors.Border,
                ),
                label = { Text(option) },
            )
        }
    }
}

@Preview
@Composable
private fun CaptureScreenPreview() {
    CopilotTheme {
        CaptureScreen()
    }
}
