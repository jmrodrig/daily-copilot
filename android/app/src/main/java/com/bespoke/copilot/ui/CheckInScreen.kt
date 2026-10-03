package com.bespoke.copilot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bespoke.copilot.NetworkClient
import com.bespoke.copilot.TriageItem
import com.bespoke.copilot.ui.theme.CopilotColors
import kotlinx.coroutines.launch

private sealed interface CheckInState {
    data object Loading : CheckInState
    data class Loaded(val tasks: List<TriageItem>) : CheckInState
    data class Failed(val message: String) : CheckInState
}

/** Gantt tasks claimed and started today, as on the desktop's Evening check-in. */
private fun myActiveTasks(items: List<TriageItem>): List<TriageItem> =
    items.filter { it.isTask && it.assignee == ME && it.status != "todo" }

@Composable
fun CheckInScreen(showMessage: (String, Boolean) -> Unit) {
    var state by remember { mutableStateOf<CheckInState>(CheckInState.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    var done by remember { mutableStateOf(setOf<String>()) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(reload) {
        state = CheckInState.Loading
        done = emptySet()
        state = NetworkClient.triage().fold(
            onSuccess = { CheckInState.Loaded(myActiveTasks(it)) },
            onFailure = { CheckInState.Failed(it.message ?: "unknown error") },
        )
    }

    fun finish(tasks: List<TriageItem>) {
        saving = true
        scope.launch {
            val ids = tasks.filter { it.id in done }.mapNotNull { it.taskId }
            val result = NetworkClient.checkIn(ids)
            saving = false
            result
                .onSuccess { count ->
                    showMessage("Day closed out: $count task${if (count == 1) "" else "s"} done", false)
                    reload++
                }
                .onFailure { error -> showMessage("Check-in failed: ${error.message ?: "unknown error"}", true) }
        }
    }

    val tasks = (state as? CheckInState.Loaded)?.tasks.orEmpty()

    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                ScreenHeader(
                    title = "Evening check-in",
                    subtitle = "Tick what got done. The rest carries into tomorrow's ranking.",
                    eyebrow = dayLabel(),
                )
            }
            when (val s = state) {
                CheckInState.Loading -> item { Notice("Loading…") }
                is CheckInState.Failed -> item {
                    Notice("Could not load your tasks (${s.message}).", actionLabel = "Try again") { reload++ }
                }
                is CheckInState.Loaded -> {
                    if (s.tasks.isEmpty()) {
                        item {
                            Notice("No tasks in progress. Claim tasks from All tasks on the desktop to see them here.")
                        }
                    } else {
                        item {
                            Text(
                                buildAnnotatedString {
                                    withStyle(SpanStyle(color = CopilotColors.Accent)) { append("${done.size}") }
                                    append(" of ${s.tasks.size} done")
                                },
                                fontSize = 15.sp,
                                color = CopilotColors.TextSecondary,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        }
                    }
                    items(s.tasks, key = { it.id }) { task ->
                        TaskRow(task, checked = task.id in done, enabled = !saving) {
                            done = if (task.id in done) done - task.id else done + task.id
                        }
                    }
                }
            }
        }
        if (tasks.isNotEmpty()) {
            Box(Modifier.padding(horizontal = 20.dp, vertical = 16.dp)) {
                PrimaryButton("Finish check-in", enabled = done.isNotEmpty(), busy = saving) { finish(tasks) }
            }
        }
    }
}

@Composable
private fun TaskRow(task: TriageItem, checked: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    val boxShape = RoundedCornerShape(7.dp)
    Card(Modifier.clickable(enabled = enabled, role = Role.Checkbox, onClick = onToggle)) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(26.dp)
                    .background(if (checked) CopilotColors.Accent else CopilotColors.SurfaceRaised, boxShape)
                    .border(2.dp, if (checked) CopilotColors.Accent else CopilotColors.TextMuted.copy(alpha = 0.6f), boxShape),
                contentAlignment = Alignment.Center,
            ) {
                if (checked) {
                    Icon(Icons.Filled.Check, contentDescription = null, tint = CopilotColors.OnAccent, modifier = Modifier.size(18.dp))
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    task.title,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (checked) CopilotColors.TextMuted else CopilotColors.TextPrimary,
                    textDecoration = if (checked) TextDecoration.LineThrough else null,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(8.dp).background(projectColor(task.project), CircleShape))
                    Text(task.project ?: "Inbox", fontSize = 14.sp, color = CopilotColors.TextMuted)
                }
            }
        }
    }
}
