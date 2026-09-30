package net.tobtobxx.sandman.android.ui

import androidx.compose.runtime.Composable
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlinx.serialization.Serializable
import net.tobtobxx.sandman.android.AppContainer
import net.tobtobxx.sandman.android.ui.home.HomeScreen
import net.tobtobxx.sandman.android.ui.home.HomeViewModel
import net.tobtobxx.sandman.android.ui.settings.SettingsScreen
import net.tobtobxx.sandman.android.ui.settings.SettingsViewModel

@Serializable
object HomeRoute

@Serializable
object SettingsRoute

@Composable
fun SandmanNavHost(container: AppContainer) {
    val nav = rememberNavController()
    NavHost(nav, startDestination = HomeRoute) {
        composable<HomeRoute> {
            HomeScreen(
                viewModel { HomeViewModel(container) },
                onOpenSettings = { nav.navigate(SettingsRoute) },
            )
        }
        composable<SettingsRoute> {
            SettingsScreen(
                viewModel { SettingsViewModel(container) },
                onBack = { nav.popBackStack() },
            )
        }
    }
}
