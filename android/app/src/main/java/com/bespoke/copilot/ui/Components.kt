package com.bespoke.copilot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bespoke.copilot.ui.theme.CopilotColors
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

// Shared pieces of the Android screens in docs/mockups (Capture, Morning, Evening).

val CardShape = RoundedCornerShape(14.dp)

fun projectColor(project: String?): Color = when (project?.uppercase()) {
    "C7801" -> CopilotColors.ProjectC7801
    "R5301" -> CopilotColors.ProjectR5301
    "P5002" -> CopilotColors.ProjectP5002
    else -> CopilotColors.ProjectNeutral
}

/** "WED 30 SEP" */
fun dayLabel(date: LocalDate = LocalDate.now()): String =
    date.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK)).uppercase(Locale.UK)

/** "30 Sep" */
fun shortDate(date: LocalDate): String = date.format(DateTimeFormatter.ofPattern("d MMM", Locale.UK))

/** The mono date line, big title and muted subtitle at the top of each screen. */
@Composable
fun ScreenHeader(title: String, subtitle: String, eyebrow: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (eyebrow != null) {
            Text(
                eyebrow,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                letterSpacing = 1.sp,
                color = CopilotColors.TextMuted,
            )
        }
        Text(title, fontSize = 28.sp, fontWeight = FontWeight.SemiBold, color = CopilotColors.TextPrimary)
        Text(subtitle, fontSize = 15.sp, color = CopilotColors.TextMuted)
    }
}

/** Small caps label above a group of pills, e.g. "SOURCE". */
@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(Locale.UK),
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.2.sp,
        color = CopilotColors.TextMuted,
    )
}

/** A rounded single-choice pill: amber outline and tint when selected. */
@Composable
fun Pill(text: String, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(percent = 50)
    Box(
        modifier = Modifier
            .heightIn(min = 44.dp)
            .clip(shape)
            .background(if (selected) CopilotColors.Accent.copy(alpha = 0.16f) else CopilotColors.SurfacePanel)
            .border(1.dp, if (selected) CopilotColors.Accent else CopilotColors.BorderStrong, shape)
            .clickable(enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            fontSize = 15.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) CopilotColors.AccentSoft else CopilotColors.TextSecondary,
        )
    }
}

/** Outlined chip with a coloured dot, e.g. the project of a task. */
@Composable
fun DotChip(text: String, color: Color) {
    Row(
        modifier = Modifier
            .border(1.dp, CopilotColors.BorderLight, RoundedCornerShape(percent = 50))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Text(text, fontSize = 13.sp, color = CopilotColors.TextSecondary)
    }
}

/** A raised card with the panel border. */
@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .then(modifier)
            .background(CopilotColors.SurfaceRaised)
            .border(1.dp, CopilotColors.Border, CardShape),
    ) {
        content()
    }
}

/** The full-width amber button at the bottom of Capture and Check-in. */
@Composable
fun PrimaryButton(text: String, enabled: Boolean, busy: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = CopilotColors.Accent,
            contentColor = CopilotColors.OnAccent,
            disabledContainerColor = CopilotColors.Accent.copy(alpha = 0.35f),
            disabledContentColor = CopilotColors.OnAccent.copy(alpha = 0.7f),
        ),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = CopilotColors.OnAccent)
        } else {
            Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Muted message with an optional retry link, for empty and error states. */
@Composable
fun Notice(text: String, actionLabel: String? = null, onAction: () -> Unit = {}) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text, fontSize = 15.sp, color = CopilotColors.TextMuted)
        if (actionLabel != null) {
            Text(
                actionLabel,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = CopilotColors.Accent,
                modifier = Modifier.clickable(role = Role.Button, onClick = onAction),
            )
        }
    }
}
