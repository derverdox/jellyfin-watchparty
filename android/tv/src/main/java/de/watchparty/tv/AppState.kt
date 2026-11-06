package de.watchparty.tv

import android.content.Context
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import de.watchparty.tv.data.Api
import de.watchparty.tv.data.ApiException
import de.watchparty.tv.data.MediaItem
import de.watchparty.tv.data.Me
import de.watchparty.tv.data.Prefs
import de.watchparty.tv.data.RoomClient
import de.watchparty.tv.player.PlayerController
import de.watchparty.tv.update.UpdateInfo
import de.watchparty.tv.update.Updater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Merkt sich pro Bildschirm Scroll-Stand und zuletzt fokussiertes Element (für „Zurück“) */
class ScreenMemory {
    val list = LazyListState()
    val grid = LazyGridState()
    private val rows = HashMap<String, LazyListState>()
    private val requesters = HashMap<String, FocusRequester>()
    var focusKey: String? = null
    fun row(key: String) = rows.getOrPut(key) { LazyListState() }
    fun requester(key: String) = requesters.getOrPut(key) { FocusRequester() }
}

enum class HomeTab(val label: String, val icon: String) {
    START("Start", "⌂"), SEARCH("Suchen", "⌕"), LIBRARY("Bibliothek", "▤"), EXT("YouTube & Twitch", "▶"), FRIENDS("Freunde & Räume", "☺"), SETTINGS("Einstellungen", "⚙")
}

sealed class Screen {
    val memory = ScreenMemory()
    data object Setup : Screen()
    data object Login : Screen()
    data object Home : Screen()
    data class Folder(val item: MediaItem) : Screen()
    data class Details(val id: String, val preview: MediaItem?) : Screen()
    data object Room : Screen()
}

class AppState(ctx: Context) {
    val prefs = Prefs(ctx)
    val version: String = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "2" } catch (_: Exception) { "2" }
    val api = Api(prefs, version)
    val room = RoomClient(api)
    val player = PlayerController(ctx, api, prefs, room)
    val updater = Updater(ctx, api)
    /** Hinweis-Dialog „Update verfügbar“ (einmal pro Version) */
    var updatePrompt by mutableStateOf<UpdateInfo?>(null)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    var me by mutableStateOf<Me?>(null)
    var homeTab by mutableStateOf(HomeTab.START)
    var toast by mutableStateOf<Pair<String, Boolean>?>(null)
    val stack = mutableStateListOf<Screen>()
    val top: Screen? get() = stack.lastOrNull()

    private var toastSeq = 0

    fun toast(text: String, bad: Boolean = false) {
        toast = text to bad
        val my = ++toastSeq
        scope.launch { delay(if (bad) 5000 else 3200); if (toastSeq == my) toast = null }
    }

    fun go(s: Screen) { stack.add(s) }
    fun replace(s: Screen) { stack.clear(); stack.add(s) }
    fun back(): Boolean { if (stack.size <= 1) return false; stack.removeAt(stack.lastIndex); return true }

    /** Beim Start: Server gesetzt? Angemeldet? */
    fun boot() {
        if (prefs.server.isBlank()) { replace(Screen.Setup); return }
        if (prefs.sid == null) { replace(Screen.Login); checkUpdate(); return }
        scope.launch {
            try {
                me = Me.from(api.me())
                replace(Screen.Home)
                checkUpdate()
            } catch (e: ApiException) {
                if (e.status == 401) { prefs.sid = null; replace(Screen.Login) }
                else { replace(Screen.Home); toast(e.message ?: "Server nicht erreichbar", true) }
            }
        }
    }

    fun loggedIn(meJson: JSONObject) {
        me = Me.from(meJson)
        replace(Screen.Home)
        checkUpdate()
    }

    /** Beim Start still nach Updates schauen; neue Version einmal mit Dialog anbieten */
    fun checkUpdate(manual: Boolean = false) {
        scope.launch {
            val info = updater.check()
            if (info == null) { if (manual) toast(if (updater.state.value is de.watchparty.tv.update.UpdateState.Failed) "Update-Prüfung fehlgeschlagen" else "Du hast die neueste Version."); return@launch }
            if (manual || prefs.skippedUpdate != info.versionCode) updatePrompt = info
        }
    }

    fun installUpdate(info: UpdateInfo) {
        updatePrompt = null
        scope.launch { updater.install(info) }
    }

    fun skipUpdate(info: UpdateInfo) {
        prefs.skippedUpdate = info.versionCode
        updatePrompt = null
    }

    fun logout() {
        scope.launch {
            leaveRoom()
            try { api.logout() } catch (_: Exception) { }
            me = null
            replace(Screen.Login)
        }
    }

    /* ---------------- Raum ---------------- */

    val inRoom get() = room.inRoom

    fun openRoom() {
        player.start()
        if (top !is Screen.Room) {
            // Raum liegt immer direkt über der Startseite
            while (stack.size > 1 && stack.last() !is Screen.Home) stack.removeAt(stack.lastIndex)
            go(Screen.Room)
        }
    }

    fun joinRoom(code: String) {
        val c = code.trim().uppercase().filter { it.isLetterOrDigit() }
        if (c.length < 4) { toast("Der Code ist zu kurz.", true); return }
        if (room.state.value.code == c) { openRoom(); return }
        room.join(c)
        openRoom()
    }

    fun leaveRoom() {
        room.leave()
        player.stop()
        if (top is Screen.Room) back()
    }

    /** Titel abspielen: im aktuellen Raum (wenn man darf), sonst im eigenen Raum zum Alleine-Schauen */
    fun play(itemId: String, position: Double = 0.0) {
        if (room.inRoom) {
            if (!room.canLoad(me)) { toast("Hier steuert gerade jemand anderes – schlag es lieber vor.", true); room.send("suggest", "itemId" to itemId); return }
            room.send("load", "itemId" to itemId, "position" to position, "play" to (room.state.value.members.size <= 1))
            openRoom()
            return
        }
        scope.launch {
            try {
                val code = api.soloRoom()
                room.onWelcome = { r -> r.send("load", "itemId" to itemId, "position" to position, "play" to true) }
                room.join(code)
                openRoom()
            } catch (e: Exception) { toast(e.message ?: "Fehler", true) }
        }
    }

    /** YouTube-/Twitch-Link (oder nur ein Twitch-Kanalname) für den Raum */
    fun playLink(input: String) {
        var url = input.trim()
        if (url.isEmpty()) return
        if (!url.contains('.') && !url.contains('/') && Regex("^[A-Za-z0-9_]{2,25}$").matches(url)) url = "https://www.twitch.tv/$url"
        prefs.rememberLink(url)
        if (room.inRoom) {
            if (!room.canLoad(me)) { toast("Hier steuert gerade jemand anderes.", true); return }
            room.send("load-ext", "url" to url)
            openRoom()
            return
        }
        scope.launch {
            try {
                val code = api.soloRoom()
                room.onWelcome = { r -> r.send("load-ext", "url" to url) }
                room.join(code)
                openRoom()
            } catch (e: Exception) { toast(e.message ?: "Fehler", true) }
        }
    }

    fun newRoom() {
        scope.launch {
            try { joinRoom(api.newRoom()) } catch (e: Exception) { toast(e.message ?: "Fehler", true) }
        }
    }

    /** Eigene Steuerung (Play/Pause/Springen/Live) an den Raum */
    fun control(action: String, position: Double? = null) {
        if (!room.canControl(me)) { toast("🔒 Gerade steuert nur der Host.", true); return }
        room.applyLocal(action, position)
        room.send("control", "action" to action, "position" to position)
        player.syncNow()
    }
}
