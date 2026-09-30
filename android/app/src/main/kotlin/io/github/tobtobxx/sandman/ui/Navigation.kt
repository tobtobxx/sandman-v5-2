package io.github.tobtobxx.sandman.ui

import androidx.compose.runtime.Composable
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import io.github.tobtobxx.sandman.AppContainer
import io.github.tobtobxx.sandman.ui.home.HomeScreen
import io.github.tobtobxx.sandman.ui.home.HomeViewModel
import io.github.tobtobxx.sandman.ui.settings.SettingsScreen
import io.github.tobtobxx.sandman.ui.settings.SettingsViewModel
import kotlinx.serialization.Serializable

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
