package de.watchparty.tv.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import de.watchparty.tv.AppState
import de.watchparty.tv.HomeTab
import de.watchparty.tv.Screen
import de.watchparty.tv.ScreenMemory
import de.watchparty.tv.data.Friend
import de.watchparty.tv.data.MediaItem
import de.watchparty.tv.data.items
import de.watchparty.tv.data.map
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay

/** Startseite mit Navigation links (wie bei Netflix/Prime auf dem Fernseher) */
@Composable
fun HomeScreen(app: AppState) {
    val mem = Screen.Home.memory
    val roomState by app.room.state.collectAsState()
    val tabFocus = remember { HomeTab.entries.associateWith { FocusRequester() } }
    AutoFocus(tabFocus.getValue(app.homeTab), key = "home")

    Row(Modifier.fillMaxSize().background(C.bg)) {
        // Navigation
        Column(
            Modifier.width(230.dp).fillMaxHeight().background(C.surface).padding(horizontal = 16.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(Modifier.padding(start = 8.dp, bottom = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                T("▶", Modifier.clip(RoundedCornerShape(8.dp)).background(C.accent).padding(horizontal = 9.dp, vertical = 2.dp), size = 18.sp, color = C.accentInk, weight = FontWeight.Bold)
                Spacer(Modifier.width(10.dp))
                T("Watchparty", size = 21.sp, weight = FontWeight.Bold)
            }
            if (roomState.code != null) {
                Focusable({ app.openRoom() }, Modifier.fillMaxWidth(), background = C.accent, focusedBackground = C.text) { f ->
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        T("▶ Zurück zum Raum", size = 15.sp, weight = FontWeight.Bold, color = if (f) C.bg else C.accentInk)
                        T(roomState.code ?: "", size = 13.sp, color = if (f) C.bg else C.accentInk)
                    }
                }
                Spacer(Modifier.height(10.dp))
            }
            for (tab in HomeTab.entries) {
                val sel = app.homeTab == tab
                Focusable({ app.homeTab = tab }, Modifier.fillMaxWidth(), requester = tabFocus.getValue(tab), focusedScale = 1.03f,
                    background = if (sel) C.surface2 else Color.Transparent, focusedBackground = C.text) { f ->
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                        T(tab.icon, Modifier.width(28.dp), size = 18.sp, color = if (f) C.bg else if (sel) C.accent else C.muted)
                        T(tab.label, size = 17.sp, weight = if (sel) FontWeight.Bold else FontWeight.Normal, color = if (f) C.bg else if (sel) C.text else C.muted, maxLines = 1)
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            app.me?.let { T(it.name, Modifier.padding(start = 10.dp), size = 14.sp, color = C.muted) }
        }
        // Inhalt
        Box(Modifier.weight(1f).fillMaxHeight()) {
            when (app.homeTab) {
                HomeTab.START -> StartTab(app, mem)
                HomeTab.SEARCH -> SearchTab(app)
                HomeTab.LIBRARY -> LibrariesTab(app)
                HomeTab.EXT -> ExtTab(app)
                HomeTab.FRIENDS -> FriendsTab(app)
                HomeTab.SETTINGS -> SettingsTab(app)
            }
        }
    }
}

/* ---------------- Start ---------------- */

private data class StartData(
    val friends: List<Friend> = emptyList(),
    val history: List<MediaItem> = emptyList(),
    val watchlist: List<MediaItem> = emptyList(),
    val latest: List<Pair<MediaItem, List<MediaItem>>> = emptyList(),
    val top: List<MediaItem> = emptyList(),
    val loaded: Boolean = false,
    val error: String? = null,
)

private var startCache = StartData()

@Composable
private fun StartTab(app: AppState, mem: ScreenMemory) {
    var data by remember { mutableStateOf(startCache) }
    var hero by remember { mutableStateOf<MediaItem?>(null) }
    LaunchedEffect(Unit) {
        // Startseite: alles parallel laden, Fehler einzelner Reihen ignorieren
        try {
            data = coroutineScope {
                val friends = async { runCatching { app.api.activity().optJSONArray("friends").map { Friend.from(it) } }.getOrDefault(emptyList()) }
                val hist = async { runCatching { app.api.history().filter { it.progress < 92 } }.getOrDefault(emptyList()) }
                val wl = async { runCatching { app.api.watchlist() }.getOrDefault(emptyList()) }
                val top = async { runCatching { app.api.topRated() }.getOrDefault(emptyList()) }
                val libs = runCatching { app.api.libraries() }.getOrDefault(emptyList())
                val latest = libs.map { l -> async { l to runCatching { app.api.latest(l.id, l.collectionType) }.getOrDefault(emptyList()) } }
                StartData(friends.await(), hist.await(), wl.await(), latest.map { it.await() }.filter { it.second.isNotEmpty() }, top.await(), true,
                    if (libs.isEmpty()) "Der Heimserver ist gerade nicht erreichbar – YouTube, Twitch und Räume gehen trotzdem." else null)
            }
            startCache = data
        } catch (e: Exception) { data = data.copy(loaded = true, error = e.message) }
    }
    // Gerade fokussiertes Element oben groß zeigen
    val h = hero ?: data.history.firstOrNull() ?: data.latest.firstOrNull()?.second?.firstOrNull()
    Box(Modifier.fillMaxSize()) {
        Hero(app, h)
        PivotScroll(0.08f) {
            LazyColumn(state = mem.list, contentPadding = PaddingValues(start = 36.dp, end = 24.dp, top = 250.dp, bottom = 40.dp)) {
                if (data.error != null) item("err") { T(data.error!!, Modifier.padding(bottom = 16.dp), color = C.muted) }
                if (!data.loaded && data.history.isEmpty()) item("load") { T("Lädt …", color = C.muted) }
                val watching = data.friends.filter { it.roomCode != null && it.item != null }
                item("friends") {
                    CardRow("Läuft gerade bei Freunden", watching, mem.row("friends"), { it.username }) { f ->
                        val fi = f.item
                        val ext = fi?.optJSONObject("ext")
                        val img = when {
                            fi == null -> null
                            ext != null && ext.optString("kind") == "youtube" -> "https://i.ytimg.com/vi/${ext.optString("id")}/mqdefault.jpg"
                            ext != null -> null
                            else -> app.api.img(fi.optString("seriesId").takeIf { s -> s.isNotEmpty() && s != "null" } ?: fi.optString("id"), 480, "Backdrop")
                        }
                        WideCard(f.itemTitle ?: "", "${f.name} · ${if (f.state == "watching") "schaut gerade" else "pausiert"}", img,
                            { f.roomCode?.let { app.joinRoom(it) } }, badge = if (ext?.optBoolean("live") == true) "● LIVE" else "Mitschauen",
                            badgeColor = if (ext != null) C.twitch else C.accent, requester = mem.requester("f:${f.username}"),
                            onFocus = { mem.focusKey = "f:${f.username}" })
                    }
                }
                item("history") {
                    CardRow("Weiterschauen", data.history, mem.row("history"), { it.id }) { it2 ->
                        WideCard(it2.name, it2.subtitle ?: fmtRuntime(it2.runtime?.minus(it2.pos)), app.api.img(if (it2.isEpisode) it2.id else it2.backdropId, 480, if (it2.isEpisode) "Primary" else "Backdrop"),
                            { app.play(it2.id, it2.pos) }, progress = it2.progress, requester = mem.requester("h:${it2.id}"),
                            onFocus = { hero = it2; mem.focusKey = "h:${it2.id}" })
                    }
                }
                item("watchlist") {
                    CardRow("Meine Liste", data.watchlist, mem.row("watchlist"), { it.id }) { it2 ->
                        PosterCard(it2, { app.go(Screen.Details(it2.id, it2)) }, requester = mem.requester("w:${it2.id}"), onFocus = { hero = it2; mem.focusKey = "w:${it2.id}" })
                    }
                }
                items(data.latest, key = { "lib:" + it.first.id }) { (lib, list) ->
                    CardRow("Neu in ${lib.name}", list, mem.row("lib:${lib.id}"), { it.id }) { it2 ->
                        PosterCard(it2, { openItem(app, it2) }, requester = mem.requester("l:${lib.id}:${it2.id}"), onFocus = { hero = it2; mem.focusKey = "l:${lib.id}:${it2.id}" })
                    }
                }
                item("top") {
                    CardRow("★ Top bei euch", data.top, mem.row("top"), { it.id }) { it2 ->
                        PosterCard(it2, { openItem(app, it2) }, requester = mem.requester("t:${it2.id}"), onFocus = { hero = it2; mem.focusKey = "t:${it2.id}" })
                    }
                }
            }
        }
    }
    // Zurück auf die Startseite: zuletzt fokussierte Kachel wieder fokussieren
    LaunchedEffect(data.loaded) {
        val k = mem.focusKey ?: return@LaunchedEffect
        delay(120)
        runCatching { mem.requester(k).requestFocus() }
    }
}

fun openItem(app: AppState, it: MediaItem) {
    when {
        it.isFolder && !it.isSeries -> app.go(Screen.Folder(it))
        else -> app.go(Screen.Details(it.id, it))
    }
}

/** Großes Bild oben mit Titel und Beschreibung des fokussierten Titels */
@Composable
private fun Hero(app: AppState, it: MediaItem?) {
    Box(Modifier.fillMaxWidth().height(330.dp)) {
        if (it != null) {
            Img(app.api.img(it.backdropId, 1280, if (it.hasBackdrop || it.isEpisode) "Backdrop" else "Primary"), Modifier.fillMaxSize(), widthPx = 1280)
            Box(Modifier.fillMaxSize().background(leftShade))
            Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color.Transparent, C.bg))))
            Column(Modifier.padding(start = 40.dp, top = 34.dp, end = 300.dp)) {
                T(if (it.isEpisode) (it.seriesName ?: it.name) else it.name, size = 30.sp, weight = FontWeight.Bold, maxLines = 1)
                val meta = listOfNotNull(if (it.isEpisode) it.episodeLabel else null, it.year?.toString(), fmtRuntime(it.runtime), it.rating?.let { r -> "★ ${"%.1f".format(r)}" }, it.officialRating)
                T(meta.joinToString("  ·  "), Modifier.padding(top = 6.dp), size = 15.sp, color = C.muted, maxLines = 1)
                if (it.overview.isNotBlank()) T(it.overview, Modifier.padding(top = 10.dp), size = 15.sp, color = Color(0xDDFFFFFF), maxLines = 3)
            }
        }
    }
}

/* ---------------- Bibliotheken ---------------- */

@Composable
private fun LibrariesTab(app: AppState) {
    var libs by remember { mutableStateOf<List<MediaItem>?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { try { libs = app.api.libraries() } catch (e: Exception) { err = e.message } }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 36.dp, end = 30.dp)) {
        T("Bibliothek", size = 30.sp, weight = FontWeight.Bold)
        Spacer(Modifier.height(20.dp))
        err?.let { T(it, color = C.danger) }
        val list = libs
        if (list == null && err == null) T("Lädt …", color = C.muted)
        if (list != null) {
            LazyVerticalGrid(GridCells.Fixed(3), state = Screen.Home.memory.grid, horizontalArrangement = Arrangement.spacedBy(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp),
                contentPadding = PaddingValues(6.dp)) {
                items(list, key = { it.id }) { lib ->
                    WideCard(lib.name, when (lib.collectionType) { "movies" -> "Filme"; "tvshows" -> "Serien"; else -> "Ordner" }, app.api.img(lib.id, 640),
                        { app.go(Screen.Folder(lib)) }, width = 300.dp)
                }
            }
        }
    }
}

/* ---------------- Suche ---------------- */

@Composable
private fun SearchTab(app: AppState) {
    var q by remember { mutableStateOf("") }
    var res by remember { mutableStateOf<Triple<List<MediaItem>, List<MediaItem>, List<MediaItem>>?>(null) }
    var busy by remember { mutableStateOf(false) }
    val field = remember { FocusRequester() }
    val mem = remember { ScreenMemory() }
    AutoFocus(field)
    LaunchedEffect(q) {
        if (q.trim().length < 2) { res = null; return@LaunchedEffect }
        delay(450) // erst suchen, wenn man kurz nicht tippt
        busy = true
        try {
            val j = app.api.search(q.trim())
            res = Triple(items(j.optJSONArray("movies")), items(j.optJSONArray("series")), items(j.optJSONArray("episodes")))
        } catch (e: Exception) { app.toast(e.message ?: "Suche geht nicht", true) } finally { busy = false }
    }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 36.dp, end = 30.dp)) {
        T("Suchen", size = 30.sp, weight = FontWeight.Bold)
        Spacer(Modifier.height(16.dp))
        TvField(q, { q = it }, "Filme, Serien, Folgen … (auch mit Jahr)", Modifier.width(620.dp), requester = field)
        Spacer(Modifier.height(18.dp))
        val r = res
        if (busy && r == null) T("Sucht …", color = C.muted)
        if (r != null && r.first.isEmpty() && r.second.isEmpty() && r.third.isEmpty()) T("Nichts gefunden.", color = C.muted)
        if (r != null) PivotScroll(0.08f) {
            LazyColumn(state = mem.list) {
                item("m") { CardRow("Filme", r.first, mem.row("m"), { it.id }) { PosterCard(it, { openItem(app, it) }) } }
                item("s") { CardRow("Serien", r.second, mem.row("s"), { it.id }) { PosterCard(it, { openItem(app, it) }) } }
                item("e") {
                    CardRow("Folgen", r.third, mem.row("e"), { it.id }) {
                        WideCard(it.seriesName ?: it.name, it.episodeLabel, app.api.img(it.id, 480), { app.go(Screen.Details(it.id, it)) })
                    }
                }
            }
        }
    }
}

/* ---------------- YouTube & Twitch ---------------- */

@Composable
private fun ExtTab(app: AppState) {
    var link by remember { mutableStateOf("") }
    var friends by remember { mutableStateOf<List<Friend>>(emptyList()) }
    val field = remember { FocusRequester() }
    AutoFocus(field)
    LaunchedEffect(Unit) {
        friends = runCatching { app.api.activity().optJSONArray("friends").map { Friend.from(it) }.filter { it.item?.has("ext") == true && it.roomCode != null } }.getOrDefault(emptyList())
    }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 36.dp, end = 30.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        T("YouTube & Twitch", size = 30.sp, weight = FontWeight.Bold)
        T("Twitch live holt der Server einmal und gibt allen exakt dasselbe Bild – aufs Bild genau synchron. Für Twitch reicht der Kanalname.", size = 16.sp, color = C.muted)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TvField(link, { link = it }, "Twitch-Kanal oder YouTube-/Twitch-Link", Modifier.width(560.dp), url = true, requester = field, onSubmit = { app.playLink(link) })
            Spacer(Modifier.width(14.dp))
            Btn("▶ Zusammen schauen", { app.playLink(link) }, primary = true, enabled = link.isNotBlank())
        }
        val recent = app.prefs.recentLinks
        if (recent.isNotEmpty()) {
            T("Zuletzt", size = 19.sp, weight = FontWeight.Bold)
            androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(6.dp)) {
                items(recent) { u -> Btn(linkLabel(u), { app.playLink(u) }, small = true) }
            }
        }
        if (friends.isNotEmpty()) {
            T("Gerade bei Freunden", size = 19.sp, weight = FontWeight.Bold)
            androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(6.dp)) {
                items(friends) { f -> WideCard(f.itemTitle ?: "", f.name, null, { f.roomCode?.let { app.joinRoom(it) } }, badge = "Mitschauen", badgeColor = C.twitch) }
            }
        }
    }
}

private fun linkLabel(u: String): String {
    Regex("(?:v=|youtu\\.be/|shorts/|live/)([\\w-]{11})").find(u)?.let { return "YouTube · ${it.groupValues[1]}" }
    Regex("twitch\\.tv/(videos/\\d+|\\w+)", RegexOption.IGNORE_CASE).find(u)?.let { return "Twitch · ${it.groupValues[1].replace("videos/", "Video ")}" }
    return u.take(40)
}

/* ---------------- Freunde & Räume ---------------- */

@Composable
private fun FriendsTab(app: AppState) {
    var friends by remember { mutableStateOf<List<Friend>?>(null) }
    var code by remember { mutableStateOf("") }
    val first = remember { FocusRequester() }
    AutoFocus(first)
    LaunchedEffect(Unit) {
        while (true) {
            friends = runCatching { app.api.activity().optJSONArray("friends").map { Friend.from(it) } }.getOrDefault(friends ?: emptyList())
            delay(10_000)
        }
    }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 36.dp, end = 30.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        T("Freunde & Räume", size = 30.sp, weight = FontWeight.Bold)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TvField(code, { code = it.uppercase().take(12) }, "Raum-Code", Modifier.width(260.dp), requester = first, onSubmit = { app.joinRoom(code) })
            Spacer(Modifier.width(14.dp))
            Btn("Beitreten", { app.joinRoom(code) }, primary = true, enabled = code.length >= 4)
            Spacer(Modifier.width(14.dp))
            if (app.me?.can("createRoom") == true) Btn("Neuen Raum erstellen", { app.newRoom() })
        }
        val list = friends
        if (list == null) T("Lädt …", color = C.muted)
        else if (list.isEmpty()) T("Gerade ist sonst niemand online.", color = C.muted)
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 6.dp, horizontal = 6.dp)) {
            items(list, key = { it.username }) { f ->
                Focusable({ f.roomCode?.let { app.joinRoom(it) } ?: app.toast("${f.name} ist in keinem Raum.") }, Modifier.width(720.dp),
                    background = C.surface, focusedBackground = C.surface2, focusedScale = 1.02f) {
                    Row(Modifier.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        val dot = when (f.state) { "watching" -> C.ok; "paused", "room" -> C.accent; else -> C.muted }
                        Box(Modifier.width(12.dp).height(12.dp).clip(RoundedCornerShape(6.dp)).background(dot))
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            T(f.name, size = 18.sp, weight = FontWeight.SemiBold)
                            T(when (f.state) {
                                "watching" -> "schaut ${f.itemTitle ?: ""}"; "paused" -> "pausiert bei ${f.itemTitle ?: ""}"
                                "room" -> "im Raum, noch nichts ausgewählt"; "private" -> "in einem privaten Raum"; else -> "online"
                            }, size = 14.sp, color = C.muted, maxLines = 1)
                        }
                        if (f.roomCode != null) T("Beitreten ›", size = 15.sp, color = C.accent, weight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

/* ---------------- Einstellungen ---------------- */

@Composable
private fun SettingsTab(app: AppState) {
    val p = app.prefs
    var quality by remember { mutableStateOf(p.quality) }
    var sub by remember { mutableStateOf(p.subLang) }
    var audio by remember { mutableStateOf(p.audioLang) }
    var chat by remember { mutableStateOf(p.chatOverlay) }
    val first = remember { FocusRequester() }
    AutoFocus(first)
    val qualities = listOf("direct" to "Original (empfohlen)", "20000000" to "Full HD · 20 Mbit/s", "10000000" to "Full HD · 10 Mbit/s", "6000000" to "HD · 6 Mbit/s", "3000000" to "SD · 3 Mbit/s")
    val langs = listOf("off" to "Aus", "deu" to "Deutsch", "ger" to "Deutsch (ger)", "eng" to "Englisch")
    val audios = listOf("" to "Wie in der Datei", "deu" to "Deutsch", "ger" to "Deutsch (ger)", "eng" to "Englisch", "jpn" to "Japanisch")
    fun <V> next(list: List<Pair<V, String>>, cur: V): V = list[(list.indexOfFirst { it.first == cur } + 1).mod(list.size)].first
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 36.dp, end = 30.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        T("Einstellungen", size = 30.sp, weight = FontWeight.Bold)
        Setting("Qualität", qualities.firstOrNull { it.first == quality }?.second ?: quality, first) { quality = next(qualities, quality); p.quality = quality }
        Setting("Tonspur", audios.firstOrNull { it.first == audio }?.second ?: audio) { audio = next(audios, audio); p.audioLang = audio }
        Setting("Untertitel", langs.firstOrNull { it.first == sub }?.second ?: sub) { sub = next(langs, sub); p.subLang = sub }
        Setting("Chat im Bild", if (chat) "An" else "Aus") { chat = !chat; p.chatOverlay = chat }
        Spacer(Modifier.height(8.dp))
        T("Angemeldet als ${app.me?.name ?: "?"} auf ${app.api.base.removePrefix("https://")}", color = C.muted, size = 15.sp)
        ButtonRow {
            Btn("Abmelden", { app.logout() })
            Btn("Server ändern", { app.leaveRoom(); app.replace(Screen.Setup) })
        }
        T("Watchparty TV ${app.version}", color = C.muted, size = 13.sp)
    }
}

@Composable
private fun Setting(label: String, value: String, requester: FocusRequester? = null, onClick: () -> Unit) {
    Focusable(onClick, Modifier.width(620.dp), requester = requester, background = C.surface, focusedBackground = C.surface2, focusedScale = 1.02f) {
        Row(Modifier.padding(horizontal = 20.dp, vertical = 15.dp), verticalAlignment = Alignment.CenterVertically) {
            T(label, Modifier.weight(1f), size = 18.sp)
            T("$value  ›", size = 17.sp, color = C.accent, weight = FontWeight.SemiBold)
        }
    }
}
