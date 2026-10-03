package com.bespoke.copilot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bespoke.copilot.Milestone
import com.bespoke.copilot.NetworkClient
import com.bespoke.copilot.TriageItem
import com.bespoke.copilot.ui.theme.CopilotColors
import java.time.LocalDate

/** The person using the app; matches `ME` on the desktop. Tasks claimed by others are hidden. */
const val ME = "Jose"

// Morning List ranks (see TriageRank in backend/schemas.py).
private const val RANK_OVERDUE = 1
private const val RANK_TODAY = 2
private const val RANK_UPCOMING = 5
private const val RANK_CAPTURE_LOW = 6

private sealed interface TodayState {
    data object Loading : TodayState
    data class Loaded(val items: List<TriageItem>, val milestone: Milestone?) : TodayState
    data class Failed(val message: String) : TodayState
}

/** What needs doing today, ranked: overdue and due tasks first, then captured notes to sort. */
private fun todaysItems(items: List<TriageItem>): List<TriageItem> = items.filter { item ->
    item.rank != RANK_UPCOMING && item.rank != RANK_CAPTURE_LOW && (item.assignee == null || item.assignee == ME)
}

private fun subtitle(item: TriageItem, today: LocalDate): String {
    if (!item.isTask) {
        return if (item.priority == "high" || item.priority == "urgent") "Captured note · high priority" else "Captured note · to sort"
    }
    val parts = mutableListOf<String>()
    when (item.rank) {
        RANK_OVERDUE -> parts += item.dueDate?.let { "Overdue since ${shortDate(it)}" } ?: "Overdue"
        RANK_TODAY -> parts += when (val due = item.dueDate) {
            null -> "In progress on the Gantt"
            today -> "Due today"
            else -> "Due ${shortDate(due)}"
        }
    }
    if (item.status == "blocked") parts += "blocked"
    if (item.assignee == ME) parts += "claimed by you"
    return parts.joinToString(" · ")
}

@Composable
fun TodayScreen() {
    var state by remember { mutableStateOf<TodayState>(TodayState.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    val today = remember { LocalDate.now() }

    LaunchedEffect(reload) {
        state = TodayState.Loading
        val triage = NetworkClient.triage()
        // The milestone banner is a nice-to-have; the list still shows if the Gantt fails.
        val milestone = NetworkClient.nextMilestone(today).getOrNull()
        state = triage.fold(
            onSuccess = { TodayState.Loaded(todaysItems(it), milestone) },
            onFailure = { TodayState.Failed(it.message ?: "unknown error") },
        )
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Box(Modifier.padding(bottom = 12.dp)) {
                ScreenHeader(title = "Today", subtitle = "Ranked from your plan", eyebrow = dayLabel(today))
            }
        }
        when (val s = state) {
            TodayState.Loading -> item { Notice("Loading…") }
            is TodayState.Failed -> item {
                Notice("Could not load the list (${s.message}).", actionLabel = "Try again") { reload++ }
            }
            is TodayState.Loaded -> {
                s.milestone?.let { m -> item { MilestoneBanner(m) } }
                if (s.items.isEmpty()) {
                    item { Notice("Nothing due today and no notes to sort.", actionLabel = "Refresh") { reload++ } }
                }
                itemsIndexed(s.items, key = { _, item -> item.id }) { index, item ->
                    RankedCard(index + 1, item, subtitle(item, today))
                }
            }
        }
    }
}

@Composable
private fun MilestoneBanner(milestone: Milestone) {
    Card {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(Modifier.size(12.dp).rotate(45f).background(CopilotColors.Accent))
            Text(
                "Next milestone: ${milestone.name} · ${milestone.project} · ${shortDate(milestone.date)}",
                fontSize = 15.sp,
                color = CopilotColors.TextPrimary,
            )
        }
    }
}

@Composable
private fun RankedCard(number: Int, item: TriageItem, subtitle: String) {
    val first = number == 1
    Card {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .background(if (first) CopilotColors.Accent else CopilotColors.SurfaceRaised, CircleShape)
                    .border(1.dp, if (first) CopilotColors.Accent else CopilotColors.TextMuted, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "$number",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (first) CopilotColors.OnAccent else CopilotColors.TextSecondary,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = CopilotColors.TextPrimary)
                if (subtitle.isNotEmpty()) Text(subtitle, fontSize = 14.sp, color = CopilotColors.TextMuted)
                Box(Modifier.padding(top = 8.dp)) {
                    DotChip(item.project ?: "Inbox", projectColor(item.project))
                }
            }
        }
    }
}
