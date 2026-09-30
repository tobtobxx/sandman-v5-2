package net.tobtobxx.sandman.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import net.tobtobxx.sandman.android.ui.SandmanNavHost
import net.tobtobxx.sandman.android.ui.SandmanTheme

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
