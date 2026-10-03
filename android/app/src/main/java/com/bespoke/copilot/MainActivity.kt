package com.bespoke.copilot

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bespoke.copilot.ui.CaptureScreen
import com.bespoke.copilot.ui.CheckInScreen
import com.bespoke.copilot.ui.TodayScreen
import com.bespoke.copilot.ui.theme.CopilotColors
import com.bespoke.copilot.ui.theme.CopilotTheme
import kotlinx.coroutines.launch

private enum class Tab(val label: String, val icon: ImageVector) {
    CAPTURE("Capture", Icons.Outlined.Edit),
    TODAY("Today", Icons.AutoMirrored.Outlined.List),
    CHECK_IN("Check-in", Icons.Outlined.CheckCircle),
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CopilotTheme {
                CopilotApp()
            }
        }
    }
}

@Composable
fun CopilotApp() {
    var tab by rememberSaveable { mutableStateOf(Tab.CAPTURE) }
    var lastMessageIsError by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    val showMessage: (String, Boolean) -> Unit = { message, isError ->
        lastMessageIsError = isError
        scope.launch { snackbarHostState.showSnackbar(message) }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = {
            SnackbarHost(snackbarHostState) { data ->
                Snackbar(
                    snackbarData = data,
                    containerColor = CopilotColors.SurfaceActive,
                    contentColor = if (lastMessageIsError) MaterialTheme.colorScheme.error else CopilotColors.TextPrimary,
                )
            }
        },
        bottomBar = { BottomBar(selected = tab, onSelect = { tab = it }) },
    ) { innerPadding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            when (tab) {
                Tab.CAPTURE -> CaptureScreen(showMessage)
                Tab.TODAY -> TodayScreen()
                Tab.CHECK_IN -> CheckInScreen(showMessage)
            }
        }
    }
}

@Composable
private fun BottomBar(selected: Tab, onSelect: (Tab) -> Unit) {
    Column(Modifier.background(CopilotColors.Background)) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(CopilotColors.Border),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            Tab.entries.forEach { tab ->
                val active = tab == selected
                val color = if (active) CopilotColors.Accent else CopilotColors.TextMuted
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(role = Role.Tab) { onSelect(tab) }
                        .padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(tab.icon, contentDescription = null, tint = color, modifier = Modifier.size(24.dp))
                    Text(
                        tab.label,
                        fontSize = 13.sp,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                        color = color,
                    )
                }
            }
        }
    }
}

@Preview
@Composable
private fun CopilotAppPreview() {
    CopilotTheme {
        CopilotApp()
    }
}
