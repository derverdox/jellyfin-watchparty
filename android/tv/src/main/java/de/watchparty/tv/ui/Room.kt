package de.watchparty.tv.ui

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import de.watchparty.tv.AppState
import de.watchparty.tv.HomeTab
import de.watchparty.tv.data.ChatMsg
import de.watchparty.tv.data.RoomEvent
import de.watchparty.tv.player.PlayerSurface
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Panel { CHAT, PEOPLE, QUEUE, TRACKS, QUALITY }

private data class Floating(val id: Long, val emoji: String, val from: String)

@androidx.annotation.OptIn(UnstableApi::class)
@Composable
fun RoomScreen(app: AppState) {
    val rs by app.room.state.collectAsState()
    val pb by app.room.playback.collectAsState()
    val ui by app.player.ui.collectAsState()
    val item = pb?.item
    val canControl = app.room.canControl(app.me)
    val scope = rememberCoroutineScope()

    var controls by remember { mutableStateOf(false) }
    var panel by remember { mutableStateOf<Panel?>(null) }
    var exit by remember { mutableStateOf(false) }
    var seekTarget by remember { mutableStateOf<Double?>(null) }
    var idle by remember { mutableStateOf(0) }
    var dismissedPoll by remember { mutableStateOf<String?>(null) }
    val floats = remember { mutableStateListOf<Floating>() }
    val overlayChat = remember { mutableStateListOf<ChatMsg>() }
    val catcher = remember { FocusRequester() }
    val playBtn = remember { FocusRequester() }
    val pollOpen = rs.poll != null && dismissedPoll != rs.poll?.id
    val dialogOpen = pollOpen || rs.ratePrompt != null

    // Abspielen nur, solange dieser Bildschirm offen ist (beim Stöbern bleibt man im Raum, das Video ruht)
    DisposableEffect(Unit) {
        app.player.start()
        onDispose { app.player.stop() }
    }

    // Ereignisse aus dem Raum
    LaunchedEffect(Unit) {
        app.room.events.collect { e ->
            when (e) {
                is RoomEvent.React -> {
                    val f = Floating(System.nanoTime(), e.emoji, e.from)
                    floats.add(f)
                    scope.launch { delay(3200); floats.remove(f) }
                }
                is RoomEvent.Chat -> if (app.prefs.chatOverlay && panel != Panel.CHAT) {
                    overlayChat.add(e.msg)
                    if (overlayChat.size > 4) overlayChat.removeAt(0)
                    scope.launch { delay(9000); overlayChat.remove(e.msg) }
                }
                is RoomEvent.PlaybackChanged -> {
                    val by = e.by
                    if (by != null && by != rs.youName) {
                        val what = when (e.action) { "play" -> "▶ Play"; "pause" -> "❚❚ Pause"; "seek" -> "⇄ Gesprungen"; "live" -> "● Live"; else -> null }
                        if (what != null) app.toast("$what · $by")
                    }
                }
                is RoomEvent.NoAccess -> app.toast("🔒 Kein Zugriff auf „${e.title}“", true)
                is RoomEvent.RoundEnd -> if (e.count > 0) app.toast("⭐ Eure Runde zu „${e.title}“: ${"%.1f".format(e.avg ?: 0.0)}/10")
                else -> Unit
            }
        }
    }

    // Leiste nach 5 s ohne Taste ausblenden (nicht bei Pause und nicht, solange gespult wird)
    LaunchedEffect(controls, idle, pb?.playing) {
        if (!controls || pb?.playing != true) return@LaunchedEffect
        delay(5000)
        controls = false
    }
    // Spulen ohne Leiste: nach kurzer Pause ausführen
    LaunchedEffect(seekTarget) {
        val t = seekTarget ?: return@LaunchedEffect
        delay(900)
        app.control("seek", t)
        seekTarget = null
    }
    // Fokus dorthin, wo er hingehört
    LaunchedEffect(controls, panel, exit, item?.id, dialogOpen) {
        delay(60)
        runCatching {
            when {
                exit || panel != null || dialogOpen -> Unit
                controls -> playBtn.requestFocus()
                item != null -> catcher.requestFocus()
            }
        }
    }

    fun togglePlay() {
        if (item == null) return
        app.control(if (pb?.playing == true) "pause" else "play", app.player.localPos())
    }
    fun seekBy(d: Double) {
        if (item == null || !canControl) { if (!canControl) app.toast("🔒 Gerade steuert nur der Host.", true); return }
        seekTarget = (seekTarget ?: app.player.localPos()) + d
    }
    fun skipSegment() {
        val seg = ui.segment ?: return
        if (seg.type == "outro") item?.nextEpisodeId?.let { app.room.send("load", "itemId" to it) }
        else app.control("seek", seg.end)
    }

    BackHandler(true) {
        when {
            exit -> exit = false
            pollOpen -> dismissedPoll = rs.poll?.id
            rs.ratePrompt != null -> app.room.clearRatePrompt()
            panel != null -> panel = null
            seekTarget != null -> seekTarget = null
            controls -> controls = false
            else -> exit = true
        }
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black)
            .onPreviewKeyEvent { if (it.type == KeyEventType.KeyDown) idle++; false },
    ) {
        /* ---------- Video ---------- */
        when (ui.surface) {
            PlayerSurface.EXO -> AndroidView(
                factory = { ctx -> PlayerView(ctx).apply {
                    useController = false
                    isFocusable = false
                    keepScreenOn = true
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    player = app.player.exo.player
                } },
                update = { v -> if (v.player !== app.player.exo.player) v.player = app.player.exo.player },
                modifier = Modifier.fillMaxSize(),
            )
            PlayerSurface.WEB -> AndroidView(
                factory = { ctx -> FrameLayout(ctx).apply {
                    keepScreenOn = true
                    val w = app.player.web.view
                    (w.parent as? ViewGroup)?.removeView(w)
                    addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                } },
                modifier = Modifier.fillMaxSize(),
            )
            PlayerSurface.NONE -> Unit
        }

        // Unsichtbarer Tastenfänger, solange keine Leiste offen ist
        if (item != null && !controls && panel == null && !exit && !dialogOpen) {
            Box(Modifier.fillMaxSize().focusRequester(catcher).focusable().onKeyEvent { ev -> hiddenKeys(ev, ::togglePlay, ::seekBy, ::skipSegment,
                hasSegment = ui.segment != null, seeking = seekTarget != null,
                commitSeek = { seekTarget?.let { t -> app.control("seek", t) }; seekTarget = null },
                showControls = { controls = true }, openChat = { panel = Panel.CHAT }) })
        }

        /* ---------- Nichts ausgewählt: Raum-Lobby ---------- */
        if (item == null) RoomLobby(app, rs.code ?: "", rs.connected) { p -> panel = p }

        /* ---------- Hinweise im Bild ---------- */
        if (item != null && (ui.loading || ui.error != null) && !controls) {
            Box(Modifier.align(Alignment.Center).clip(RoundedCornerShape(14.dp)).background(Color(0xB3000000)).padding(horizontal = 24.dp, vertical = 14.dp)) {
                T(ui.error ?: "Lädt …", size = 18.sp, color = if (ui.error != null) C.danger else C.text)
            }
        }
        if (!rs.connected && rs.code != null) {
            T("Verbindung zum Raum unterbrochen – verbinde neu …", Modifier.align(Alignment.TopCenter).padding(top = 24.dp).clip(RoundedCornerShape(10.dp)).background(C.danger).padding(horizontal = 16.dp, vertical = 8.dp),
                size = 15.sp, color = Color.Black, weight = FontWeight.SemiBold)
        }
        // Spulen-Vorschau ohne Leiste
        seekTarget?.let { t ->
            val disp = if (ui.live) "−${fmtTime((ui.liveStart + ui.dur - t).coerceAtLeast(0.0))}" else fmtTime(t)
            val d = t - app.player.localPos()
            Column(Modifier.align(Alignment.Center).clip(RoundedCornerShape(16.dp)).background(Color(0xCC000000)).padding(horizontal = 34.dp, vertical = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                T("${if (d >= 0) "⏩ +" else "⏪ −"}${fmtTime(kotlin.math.abs(d))}", size = 30.sp, weight = FontWeight.Bold)
                T(disp, size = 18.sp, color = C.muted)
                T("OK: jetzt springen · Zurück: abbrechen", size = 13.sp, color = C.muted)
            }
        }
        // Intro überspringen (ohne Leiste mit OK)
        val seg = ui.segment
        if (seg != null && !controls && panel == null && canControl) {
            val label = when (seg.type) { "intro" -> "Intro überspringen"; "recap" -> "Rückblick überspringen"; "preview" -> "Vorschau überspringen"; else -> if (item?.nextEpisodeId != null) "Nächste Folge" else "Abspann überspringen" }
            T("$label  ·  OK", Modifier.align(Alignment.BottomEnd).padding(end = 48.dp, bottom = 48.dp).clip(RoundedCornerShape(10.dp)).background(C.text).padding(horizontal = 20.dp, vertical = 12.dp),
                size = 17.sp, color = C.bg, weight = FontWeight.Bold)
        }
        // Chat im Bild
        if (panel == null && overlayChat.isNotEmpty()) {
            Column(Modifier.align(Alignment.BottomStart).padding(start = 40.dp, bottom = if (controls) 190.dp else 40.dp).width(520.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (m in overlayChat) ChatLine(m, overlay = true)
            }
        }
        // Reaktionen
        Column(Modifier.align(Alignment.BottomEnd).padding(end = 60.dp, bottom = 150.dp), horizontalAlignment = Alignment.End) {
            for (f in floats) Row(verticalAlignment = Alignment.CenterVertically) {
                T(f.from, size = 13.sp, color = C.muted); Spacer(Modifier.width(6.dp)); T(f.emoji, size = 40.sp)
            }
        }

        /* ---------- Steuerleiste ---------- */
        AnimatedVisibility(controls && item != null && panel == null && !exit, Modifier.align(Alignment.BottomCenter), enter = fadeIn(), exit = fadeOut()) {
            Controls(app, ui, canControl, playBtn, ::togglePlay, ::skipSegment, onPanel = { panel = it }, onReact = { e -> app.room.send("react", "emoji" to e) })
        }
        if (controls && item != null && panel == null) {
            Column(Modifier.align(Alignment.TopStart).fillMaxWidth().background(topShade).padding(start = 48.dp, top = 30.dp, end = 48.dp, bottom = 60.dp)) {
                T(item.title, size = 26.sp, weight = FontWeight.Bold, maxLines = 1)
                item.subtitle?.let { T(it, size = 16.sp, color = C.muted, maxLines = 1) }
                T("Raum ${rs.code} · ${rs.members.size} ${if (rs.members.size == 1) "Person" else "Leute"}${if (!canControl) " · 🔒 Host steuert" else ""}", size = 14.sp, color = C.muted)
            }
        }

        /* ---------- Seitenleiste ---------- */
        panel?.let { p -> SidePanel(app, p, ui, Modifier.align(Alignment.CenterEnd)) { panel = it } }

        /* ---------- Abstimmung, Bewertung, Weiter ---------- */
        val poll = rs.poll
        if (poll != null && pollOpen && !exit) PollDialog(app, poll) { dismissedPoll = poll.id }
        rs.ratePrompt?.let { (id, title) -> if (!exit) RateDialog(app, id, title) }
        rs.advancing?.let { n ->
            T("⏭ Gleich: ${n.title}", Modifier.align(Alignment.TopEnd).padding(top = 30.dp, end = 40.dp).clip(RoundedCornerShape(10.dp)).background(C.surface2).padding(horizontal = 16.dp, vertical = 10.dp), size = 16.sp)
        }

        if (exit) ExitDialog(app) { exit = false }
    }
}

/** Tasten, wenn keine Leiste offen ist (wie bei Netflix auf dem Fernseher) */
private fun hiddenKeys(
    ev: KeyEvent, toggle: () -> Unit, seekBy: (Double) -> Unit, skip: () -> Unit,
    hasSegment: Boolean, seeking: Boolean, commitSeek: () -> Unit, showControls: () -> Unit, openChat: () -> Unit,
): Boolean {
    if (ev.type != KeyEventType.KeyDown) return false
    val repeat = ev.nativeKeyEvent.repeatCount
    return when (ev.key) {
        Key.DirectionLeft -> { seekBy(if (repeat > 2) -30.0 else -10.0); true }
        Key.DirectionRight -> { seekBy(if (repeat > 2) 30.0 else 10.0); true }
        Key.MediaRewind -> { seekBy(-30.0); true }
        Key.MediaFastForward -> { seekBy(30.0); true }
        Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> {
            when { seeking -> commitSeek(); hasSegment -> skip(); else -> { toggle(); showControls() } }
            true
        }
        Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause, Key.Spacebar -> { toggle(); true }
        Key.DirectionDown -> { showControls(); true }
        Key.DirectionUp, Key.Menu -> { openChat(); true }
        else -> false
    }
}

/* ---------------- Steuerleiste ---------------- */

@Composable
private fun Controls(
    app: AppState, ui: de.watchparty.tv.player.PlayerUi, canControl: Boolean, playBtn: FocusRequester,
    toggle: () -> Unit, skip: () -> Unit, onPanel: (Panel) -> Unit, onReact: (String) -> Unit,
) {
    val pb by app.room.playback.collectAsState()
    val rs by app.room.state.collectAsState()
    val item = pb?.item ?: return
    Column(Modifier.fillMaxWidth().background(bottomShade).padding(start = 48.dp, end = 48.dp, top = 70.dp, bottom = 30.dp)) {
        SeekBar(app, ui, canControl)
        Spacer(Modifier.height(16.dp))
        ButtonRow {
            Btn(if (pb?.playing == true) "❚❚  Pause" else "▶  Play", toggle, primary = true, requester = playBtn, enabled = canControl)
            Btn("↺ 10", { app.control("seek", app.player.localPos() - 10) }, enabled = canControl)
            Btn("↻ 10", { app.control("seek", app.player.localPos() + 10) }, enabled = canControl)
            if (ui.live) Btn(if (ui.liveBehind <= 3 && pb?.playing == true) "● LIVE" else "● Zu live", { app.control("live") }, enabled = canControl)
            ui.segment?.let { Btn(if (it.type == "outro") "Abspann ⏭" else "Überspringen ⏭", skip, enabled = canControl) }
            if (item.nextEpisodeId != null && app.room.canLoad(app.me) && ui.dur > 0 && ui.pos > ui.dur - 300) {
                Btn("Nächste Folge ⏭", { app.room.send("load", "itemId" to item.nextEpisodeId) })
            }
            Spacer(Modifier.weight(1f))
            if (ui.audio.size > 1 || ui.subs.isNotEmpty()) Btn("Ton & Untertitel", { onPanel(Panel.TRACKS) }, small = true)
            if (ui.qualities.size > 1) Btn("Qualität", { onPanel(Panel.QUALITY) }, small = true)
            Btn("💬 Chat", { onPanel(Panel.CHAT) }, small = true)
            Btn("👥 ${rs.members.size}", { onPanel(Panel.PEOPLE) }, small = true)
            if (rs.queue.isNotEmpty()) Btn("Liste ${rs.queue.size}", { onPanel(Panel.QUEUE) }, small = true)
        }
        Spacer(Modifier.height(12.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(rs.reactions) { e -> Btn(e, { onReact(e) }, small = true) }
        }
    }
}

/** Zeitleiste: fokussieren, dann mit ◀/▶ eine Stelle wählen und OK drücken */
@Composable
private fun SeekBar(app: AppState, ui: de.watchparty.tv.player.PlayerUi, canControl: Boolean) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    var scrub by remember { mutableStateOf<Double?>(null) }
    LaunchedEffect(focused) { if (!focused) scrub = null }
    val dur = ui.dur.coerceAtLeast(0.0)
    val pos = scrub ?: ui.pos
    val frac = if (dur > 0) (pos / dur).toFloat().coerceIn(0f, 1f) else 0f
    val buf = if (dur > 0) (ui.buffered / dur).toFloat().coerceIn(0f, 1f) else 0f
    Column {
        Box(
            Modifier.fillMaxWidth().height(28.dp)
                .onKeyEvent { ev ->
                    if (ev.type != KeyEventType.KeyDown || !canControl || dur <= 0) return@onKeyEvent false
                    val step = if (ev.nativeKeyEvent.repeatCount > 3) dur / 50 else 10.0
                    when (ev.key) {
                        Key.DirectionLeft -> { scrub = ((scrub ?: ui.pos) - step).coerceIn(0.0, dur); true }
                        Key.DirectionRight -> { scrub = ((scrub ?: ui.pos) + step).coerceIn(0.0, dur); true }
                        Key.DirectionCenter, Key.Enter -> {
                            scrub?.let { s -> app.control("seek", if (ui.live) ui.liveStart + s else s) }
                            scrub = null; true
                        }
                        else -> false
                    }
                }
                .focusable(enabled = canControl, interactionSource = src),
            contentAlignment = Alignment.CenterStart,
        ) {
            val h = if (focused) 10.dp else 6.dp
            Box(Modifier.fillMaxWidth().height(h).clip(RoundedCornerShape(h)).background(Color(0x40FFFFFF))) {
                Box(Modifier.fillMaxWidth(buf).height(h).background(Color(0x40FFFFFF)))
                Box(Modifier.fillMaxWidth(frac).height(h).background(if (ui.live) C.twitch else C.accent))
            }
            if (focused) Box(Modifier.fillMaxWidth(frac).padding(end = 0.dp), contentAlignment = Alignment.CenterEnd) {
                Box(Modifier.size(20.dp).offset(x = 10.dp).clip(RoundedCornerShape(10.dp)).background(C.text))
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            if (ui.live) {
                val behind = if (scrub != null) (dur - pos) else ui.liveBehind
                T(if (behind > 3) "−${fmtTime(behind)}" else "● live", size = 15.sp, color = if (behind > 3) C.muted else C.danger, weight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                T("DVR ${fmtTime(dur)}", size = 15.sp, color = C.muted)
            } else {
                T(fmtTime(pos), size = 15.sp, color = if (scrub != null) C.accent else C.text)
                Spacer(Modifier.weight(1f))
                T(if (focused && scrub != null) "OK: hierhin springen" else if (kotlin.math.abs(ui.drift) > 1) "${"%.1f".format(ui.drift)} s versetzt" else "", size = 13.sp, color = C.muted)
                Spacer(Modifier.weight(1f))
                T(fmtTime(dur), size = 15.sp, color = C.muted)
            }
        }
    }
}

/* ---------------- Raum-Lobby (nichts ausgewählt) ---------------- */

@Composable
private fun RoomLobby(app: AppState, code: String, connected: Boolean, onPanel: (Panel) -> Unit) {
    val rs by app.room.state.collectAsState()
    val first = remember { FocusRequester() }
    AutoFocus(first, key = code)
    Row(Modifier.fillMaxSize().background(C.bg).padding(56.dp), horizontalArrangement = Arrangement.spacedBy(48.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            T("Raum", size = 18.sp, color = C.muted)
            T("${code.take(3)} ${code.drop(3)}", size = 54.sp, weight = FontWeight.Bold)
            T(if (connected) "Was schauen wir? Such einen Film aus – alle im Raum sehen es sofort." else "Verbinde …", size = 18.sp, color = C.muted)
            Spacer(Modifier.height(8.dp))
            ButtonRow {
                Btn("Bibliothek", { app.homeTab = HomeTab.START; app.back() }, primary = true, requester = first, enabled = app.room.canLoad(app.me))
                Btn("YouTube & Twitch", { app.homeTab = HomeTab.EXT; app.back() }, enabled = app.room.canLoad(app.me))
                Btn("💬 Chat", { onPanel(Panel.CHAT) })
                Btn("Raum verlassen", { app.leaveRoom() })
            }
            if (!app.room.canLoad(app.me)) T("Der Host sucht gleich etwas aus.", color = C.muted)
            Spacer(Modifier.height(12.dp))
            T("Andere kommen dazu über ${app.api.base.removePrefix("https://")}/r/$code", size = 15.sp, color = C.muted)
        }
        Column(Modifier.width(320.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            T("Im Raum", size = 18.sp, weight = FontWeight.Bold)
            for (m in rs.members) Row(verticalAlignment = Alignment.CenterVertically) {
                T(if (m.isHost) "★" else "•", Modifier.width(22.dp), color = C.accent)
                T(m.name, size = 17.sp)
                if (m.kind == "tv") T("  📺", size = 14.sp)
            }
            Spacer(Modifier.height(12.dp))
            Qr("${app.api.base}/r/$code", sizeDp = 150.dp)
            T("Mit dem Handy scannen zum Mitmachen", size = 13.sp, color = C.muted)
        }
    }
}

/* ---------------- Seitenleiste: Chat, Leute, Liste, Spuren, Qualität ---------------- */

@Composable
private fun SidePanel(app: AppState, p: Panel, ui: de.watchparty.tv.player.PlayerUi, modifier: Modifier, set: (Panel?) -> Unit) {
    val rs by app.room.state.collectAsState()
    val first = remember { FocusRequester() }
    AutoFocus(first, key = p)
    Column(modifier.width(420.dp).fillMaxHeight().background(Color(0xF2121218)).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (p == Panel.CHAT || p == Panel.PEOPLE || p == Panel.QUEUE) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((pp, label) in listOf(Panel.CHAT to "Chat", Panel.PEOPLE to "Leute", Panel.QUEUE to "Liste")) {
                Btn(label, { set(pp) }, small = true, primary = p == pp, requester = if (pp == p) first else null)
            }
        }
        when (p) {
            Panel.CHAT -> ChatPanel(app)
            Panel.PEOPLE -> {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(rs.members, key = { it.id }) { m ->
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.surface).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                T((if (m.isHost) "★ " else "") + m.name + (if (m.kind == "tv") "  📺" else if (m.kind == "desktop") "  🖥" else ""), size = 16.sp, weight = FontWeight.SemiBold)
                                T(when (m.state) { "playing" -> "▶ schaut" + (if (kotlin.math.abs(m.drift) > 1) " · ${"%.0f".format(kotlin.math.abs(m.drift))} s versetzt" else " · synchron"); "paused" -> "❚❚ pausiert"
                                    "buffering" -> "⏳ lädt …"; "error" -> "✖ Fehler"; "blocked" -> "⚠ muss klicken"; else -> "bereit" }, size = 13.sp, color = C.muted)
                            }
                        }
                    }
                    if (rs.isHost) item("host") {
                        Btn(if (rs.info?.allowAllControl == true) "Alle dürfen steuern ✓" else "Nur ich steuere", {
                            app.room.send("settings", "allowAllControl" to !(rs.info?.allowAllControl ?: true))
                        }, small = true)
                    }
                }
            }
            Panel.QUEUE -> {
                if (rs.queue.isEmpty()) T("Die Warteschlange ist leer. In den Details „+ Warteschlange“ wählen.", color = C.muted, size = 15.sp)
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexed(rs.queue) { i, q ->
                        Focusable({ if (app.room.canLoad(app.me)) { app.room.send("queue-play", "index" to i); set(null) } else app.toast("Nur wer auswählen darf.", true) },
                            Modifier.fillMaxWidth(), background = C.surface, focusedBackground = C.surface2, focusedScale = 1.02f) {
                            Column(Modifier.padding(12.dp)) {
                                T("${i + 1}. ${q.title}", size = 16.sp, weight = FontWeight.SemiBold, maxLines = 1)
                                T(listOfNotNull(q.subtitle, q.by?.let { "von $it" }, "OK: jetzt abspielen").joinToString(" · "), size = 13.sp, color = C.muted, maxLines = 1)
                            }
                        }
                    }
                }
            }
            Panel.TRACKS -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item("ah") { T("Tonspur", size = 17.sp, weight = FontWeight.Bold) }
                itemsIndexed(ui.audio, key = { _, a -> "a${a.index}" }) { i, a -> Btn((if (a.index == ui.audioIndex) "✓ " else "") + a.label, { app.player.setAudio(a.index); set(null) }, small = true, requester = if (i == 0) first else null) }
                item("sh") { T("Untertitel", Modifier.padding(top = 10.dp), size = 17.sp, weight = FontWeight.Bold) }
                item("off") { Btn((if (ui.subIndex == null) "✓ " else "") + "Aus", { app.player.setSub(null); set(null) }, small = true, requester = if (ui.audio.isEmpty()) first else null) }
                items(ui.subs, key = { "s${it.index}" }) { s -> Btn((if (s.index == ui.subIndex) "✓ " else "") + s.label + (if (s.isText) "" else " (eingebrannt)"), { app.player.setSub(s.index); set(null) }, small = true) }
            }
            Panel.QUALITY -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item("h") { T("Qualität (nur für dich)", size = 17.sp, weight = FontWeight.Bold) }
                itemsIndexed(ui.qualities, key = { _, q -> q.id }) { i, q -> Btn((if (q.id == ui.quality) "✓ " else "") + q.label, { app.player.setQuality(q.id); set(null) }, small = true, requester = if (i == 0) first else null) }
            }
        }
    }
}

@Composable
private fun ChatPanel(app: AppState) {
    val rs by app.room.state.collectAsState()
    var text by remember { mutableStateOf("") }
    val list = rememberLazyListState()
    LaunchedEffect(rs.chat.size) { if (rs.chat.isNotEmpty()) list.scrollToItem(rs.chat.size - 1) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LazyColumn(Modifier.height(330.dp), state = list, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(rs.chat, key = { it.id }) { m -> ChatLine(m, overlay = false) }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(rs.reactions) { e -> Btn(e, { app.room.send("react", "emoji" to e) }, small = true) }
        }
        if (app.me?.can("chat") != false) {
            TvField(text, { text = it.take(500) }, "Nachricht …", onSubmit = {
                if (text.isNotBlank()) { app.room.send("chat", "text" to text.trim()); text = "" }
            })
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(listOf("😂😂😂", "Pause bitte!", "Weiter geht's", "Gleich wieder da", "Wie geil")) { q -> Btn(q, { app.room.send("chat", "text" to q) }, small = true) }
            }
        }
    }
}

@Composable
private fun ChatLine(m: ChatMsg, overlay: Boolean) {
    val bg = if (overlay) Color(0xB3000000) else Color.Transparent
    Row(Modifier.clip(RoundedCornerShape(8.dp)).background(bg).padding(horizontal = if (overlay) 12.dp else 0.dp, vertical = if (overlay) 6.dp else 0.dp)) {
        if (m.kind == "system") T(m.text, size = 14.sp, color = C.muted)
        else {
            T((m.from ?: "?") + "  ", size = 15.sp, weight = FontWeight.Bold, color = nameColor(m.from ?: ""))
            T(if (m.kind == "suggest") "💡 ${m.text}" else m.text, size = 15.sp)
        }
    }
}

private fun nameColor(name: String): Color {
    var h = 0
    for (ch in name) h = (h * 31 + ch.code) % 360
    return Color.hsl(h.toFloat(), 0.75f, 0.68f)
}

/* ---------------- Dialoge ---------------- */

@Composable
private fun Dialog(title: String, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color(0x99000000)), contentAlignment = Alignment.Center) {
        Column(Modifier.width(620.dp).clip(RoundedCornerShape(18.dp)).background(C.surface).border(1.dp, C.line, RoundedCornerShape(18.dp)).padding(30.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            T(title, size = 24.sp, weight = FontWeight.Bold)
            content()
        }
    }
}

@Composable
private fun ExitDialog(app: AppState, close: () -> Unit) {
    val first = remember { FocusRequester() }
    AutoFocus(first)
    Dialog("Was möchtest du?") {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Btn("▶ Weiterschauen", close, primary = true, requester = first, modifier = Modifier.fillMaxWidth())
            Btn("Zur Startseite (Raum bleibt offen)", { close(); app.homeTab = HomeTab.START; app.back() }, modifier = Modifier.fillMaxWidth())
            Btn("Raum verlassen", { close(); app.leaveRoom() }, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun PollDialog(app: AppState, poll: de.watchparty.tv.data.Poll, dismiss: () -> Unit) {
    val first = remember { FocusRequester() }
    AutoFocus(first, key = poll.id)
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(poll.id) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val left = ((poll.ends - app.room.serverNow()) / 1000).coerceAtLeast(0)
    val mine = app.me?.username?.lowercase()
    Dialog("🗳 Was schauen wir?  ·  noch ${left}s") {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            poll.options.forEachIndexed { i, o ->
                val voted = mine != null && mine in o.voters
                Btn("${if (voted) "✓ " else ""}${o.title}${o.subtitle?.let { " · $it" } ?: ""}   (${o.votes})", { app.room.send("poll-vote", "itemId" to o.id) },
                    primary = voted, requester = if (i == 0) first else null, modifier = Modifier.fillMaxWidth())
            }
            Btn("Später", dismiss, small = true)
        }
    }
    if (now < 0) Unit // nur für die Neuberechnung
}

@Composable
private fun RateDialog(app: AppState, itemId: String, title: String) {
    val first = remember { FocusRequester() }
    AutoFocus(first, key = itemId)
    val scope = rememberCoroutineScope()
    Dialog("⭐ Wie fandest du „$title“?") {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(4.dp)) {
            items((1..10).toList()) { n ->
                Btn("$n", { scope.launch { runCatching { app.api.rate(itemId, n) }; app.toast("Danke! $n/10"); app.room.clearRatePrompt() } },
                    primary = n >= 8, requester = if (n == 7) first else null)
            }
        }
        Btn("Überspringen", { app.room.clearRatePrompt() }, small = true)
    }
}
