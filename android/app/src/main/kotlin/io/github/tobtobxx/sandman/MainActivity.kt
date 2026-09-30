package io.github.tobtobxx.sandman

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import io.github.tobtobxx.sandman.ui.SandmanNavHost
import io.github.tobtobxx.sandman.ui.SandmanTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as SandmanApp).container
        setContent {
            SandmanTheme {
                SandmanNavHost(container)
            }
        }
    }
}
