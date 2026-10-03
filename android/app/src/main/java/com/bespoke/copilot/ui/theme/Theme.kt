package com.bespoke.copilot.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Mirrors shared/design-tokens.json
object CopilotColors {
    val Background = Color(0xFF0C1216)
    val SurfaceRaised = Color(0xFF131B21)
    val SurfacePanel = Color(0xFF0F171C)
    val SurfaceActive = Color(0xFF1A252D)
    val Border = Color(0xFF25323B)
    val BorderLight = Color(0xFF2F3E48)
    val BorderStrong = Color(0xFF34434D)
    val TextPrimary = Color(0xFFE8EEF1)
    val TextSecondary = Color(0xFFC5D0D6)
    val TextMuted = Color(0xFF97A5AE)
    val OnAccent = Color(0xFF10161A)
    val Accent = Color(0xFFF2B544)
    val AccentSoft = Color(0xFFF6C96A)
    val ProjectC7801 = Color(0xFF6CB6EA)
    val ProjectR5301 = Color(0xFFB7A3F2)
    val ProjectP5002 = Color(0xFF56C8A8)
    val ProjectNeutral = Color(0xFF6B7A84)
}

private val DarkColors = darkColorScheme(
    primary = CopilotColors.Accent,
    onPrimary = CopilotColors.OnAccent,
    background = CopilotColors.Background,
    onBackground = CopilotColors.TextPrimary,
    surface = CopilotColors.SurfaceRaised,
    onSurface = CopilotColors.TextPrimary,
    surfaceVariant = CopilotColors.SurfacePanel,
    onSurfaceVariant = CopilotColors.TextSecondary,
    outline = CopilotColors.Border,
    outlineVariant = CopilotColors.BorderLight,
)

// Dark-first: the app always uses the dark scheme regardless of system setting.
@Composable
fun CopilotTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, content = content)
}
