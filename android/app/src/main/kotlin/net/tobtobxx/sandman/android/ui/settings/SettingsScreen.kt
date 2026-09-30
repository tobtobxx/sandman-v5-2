package net.tobtobxx.sandman.android.ui.settings

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import net.tobtobxx.sandman.android.data.ServerSettings
import net.tobtobxx.sandman.android.push.Notifications

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
) {
    val loaded by viewModel.loaded.collectAsStateWithLifecycle()
    val status by viewModel.status.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        // Wait for the stored values so the fields start with them.
        val initial = loaded ?: return@Scaffold
        var baseUrl by rememberSaveable { mutableStateOf(initial.baseUrl) }
        var token by rememberSaveable { mutableStateOf(initial.token) }
        Column(
            Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = { Text("Server address") },
                placeholder = { Text("http://sandman.example.ts.net:8700") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("API token (api.token in config.jsonc)") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(onClick = { viewModel.save(ServerSettings(baseUrl, token)) }) { Text("Save and test") }
            status?.let { Text(it) }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            NotificationsSection(viewModel)
        }
    }
}

/** Push over UnifiedPush: on/off, which distributor, a test button. */
@Composable
private fun NotificationsSection(viewModel: SettingsViewModel) {
    val push by viewModel.push.collectAsStateWithLifecycle()
    val message by viewModel.pushMessage.collectAsStateWithLifecycle()
    val activity = LocalActivity.current
    val context = LocalContext.current
    var denied by rememberSaveable { mutableStateOf(false) }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            denied = !granted
            if (granted && activity != null) viewModel.enablePush(activity)
        }

    Text("Notifications", style = MaterialTheme.typography.titleMedium)
    Text(
        "Questions and reminders reach you when the app is closed, through a UnifiedPush distributor app " +
            "such as ntfy.",
        style = MaterialTheme.typography.bodyMedium,
    )
    if (push.enabled) {
        val via = viewModel.distributorName()?.let { " · via $it" }.orEmpty()
        Text((push.status ?: "On") + via)
        if (!Notifications.canNotify(context)) Text("Notifications for Sandman are off in the system settings.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = viewModel::testPush) { Text("Send a test") }
            OutlinedButton(onClick = viewModel::disablePush) { Text("Turn off") }
        }
    } else {
        push.status?.let { Text(it) }
        Button(onClick = {
            val needsAsk =
                Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                    PackageManager.PERMISSION_GRANTED
            if (needsAsk) {
                permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else if (activity != null) {
                viewModel.enablePush(activity)
            }
        }) { Text("Turn on") }
        if (denied) Text("Allow notifications for Sandman to turn them on.")
    }
    message?.let { Text(it) }
}
