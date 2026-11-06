package de.watchparty.tv

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.ImageLoader
import de.watchparty.tv.data.RoomEvent
import de.watchparty.tv.ui.C
import de.watchparty.tv.ui.DetailsScreen
import de.watchparty.tv.ui.FolderScreen
import de.watchparty.tv.ui.HomeScreen
import de.watchparty.tv.ui.LocalApi
import de.watchparty.tv.ui.LocalImages
import de.watchparty.tv.ui.LoginScreen
import de.watchparty.tv.ui.RoomScreen
import de.watchparty.tv.ui.SetupScreen
import de.watchparty.tv.ui.T

class MainActivity : ComponentActivity() {
    private lateinit var app: AppState
    private var lastBack = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = AppState(applicationContext)
        val images = ImageLoader.Builder(this).okHttpClient(app.api.http).crossfade(true).respectCacheHeaders(false).build()
        app.boot()

        setContent {
            CompositionLocalProvider(LocalApi provides app.api, LocalImages provides images) {
                val top = app.top
                val roomState by app.room.state.collectAsState()

                // Raum verloren (rausgeworfen, gelöscht) → zurück zur Startseite
                LaunchedEffect(Unit) {
                    app.room.events.collect { e ->
                        when (e) {
                            is RoomEvent.Toast -> app.toast(e.text, e.bad)
                            is RoomEvent.Kicked -> { app.player.stop(); if (app.top is Screen.Room) app.back() }
                            else -> Unit
                        }
                    }
                }
                // Bildschirm an lassen, solange man im Raum ist
                LaunchedEffect(top, roomState.code) {
                    if (top is Screen.Room) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }

                Box(Modifier.fillMaxSize().background(C.bg)) {
                    when (top) {
                        null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { T("Watchparty", size = 40.sp, weight = FontWeight.Bold) }
                        is Screen.Setup -> SetupScreen(app)
                        is Screen.Login -> LoginScreen(app)
                        is Screen.Home -> HomeScreen(app)
                        is Screen.Folder -> FolderScreen(app, top)
                        is Screen.Details -> DetailsScreen(app, top)
                        is Screen.Room -> RoomScreen(app)
                    }
                    // Zurück: eine Ebene hoch; auf der Startseite zweimal drücken zum Beenden
                    BackHandler(top !is Screen.Room) {
                        if (!app.back()) {
                            val now = System.currentTimeMillis()
                            if (now - lastBack < 2500) finish() else { lastBack = now; app.toast("Nochmal „Zurück“ zum Beenden") }
                        }
                    }
                    app.toast?.let { (text, bad) ->
                        T(text, Modifier.align(Alignment.TopCenter).padding(top = 28.dp).clip(RoundedCornerShape(12.dp))
                            .background(if (bad) C.danger else Color(0xF21E1E28)).padding(horizontal = 22.dp, vertical = 12.dp),
                            size = 17.sp, color = if (bad) Color.Black else C.text, weight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (::app.isInitialized && app.top is Screen.Room) app.player.start()
    }

    override fun onStop() {
        super.onStop()
        // Im Hintergrund (Home-Taste): Wiedergabe anhalten, Raum bleibt offen
        if (::app.isInitialized) app.player.stop()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::app.isInitialized) { app.room.leave(); app.player.release() }
    }
}
