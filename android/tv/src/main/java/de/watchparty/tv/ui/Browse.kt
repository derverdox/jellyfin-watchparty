package de.watchparty.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import de.watchparty.tv.Screen
import de.watchparty.tv.data.MediaItem
import de.watchparty.tv.data.items
import de.watchparty.tv.data.map
import de.watchparty.tv.data.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/* ---------------- Ordner / Bibliothek als Raster ---------------- */

private val SORTS = listOf("name" to "A–Z", "added" to "Neu hinzugefügt", "year" to "Neueste", "rating" to "Beste Bewertung")

@Composable
fun FolderScreen(app: AppState, screen: Screen.Folder) {
    val folder = screen.item
    val mem = screen.memory
    var sort by remember { mutableStateOf(if (folder.type == "Season") "index" else "name") }
    var list by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var total by remember { mutableStateOf(-1) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val first = remember { FocusRequester() }
    // Bibliothek auf oberster Ebene: Filme/Serien direkt (statt Ordnerstruktur)
    val ct = folder.collectionType?.takeIf { it == "movies" || it == "tvshows" }

    fun loadMore(reset: Boolean = false) {
        if (loading) return
        if (!reset && total >= 0 && list.size >= total) return
        loading = true
        val start = if (reset) 0 else list.size
        scope.launch {
            try {
                val (page, t) = app.api.children(folder.id, ct, sort, start, 60)
                list = if (reset) page else list + page
                total = t
            } catch (e: Exception) { app.toast(e.message ?: "Fehler", true) } finally { loading = false }
        }
    }
    LaunchedEffect(sort) { loadMore(reset = true) }
    LaunchedEffect(list.isNotEmpty()) {
        if (list.isEmpty()) return@LaunchedEffect
        val k = mem.focusKey
        delay(100)
        runCatching { if (k != null) mem.requester(k).requestFocus() else first.requestFocus() }
    }

    Column(Modifier.fillMaxSize().background(C.bg).padding(start = 48.dp, top = 30.dp, end = 40.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            T(folder.name, Modifier.weight(1f), size = 30.sp, weight = FontWeight.Bold, maxLines = 1)
            if (total >= 0) T("$total Titel", size = 15.sp, color = C.muted)
        }
        Spacer(Modifier.height(12.dp))
        if (folder.type != "Season") ButtonRow {
            for ((k, label) in SORTS) Btn(label, { if (sort != k) { mem.focusKey = null; sort = k } }, primary = sort == k, small = true)
        }
        Spacer(Modifier.height(14.dp))
        if (list.isEmpty() && loading) T("Lädt …", color = C.muted)
        if (list.isEmpty() && !loading && total == 0) T("Hier ist nichts.", color = C.muted)
        PivotScroll(0.15f) {
            LazyVerticalGrid(GridCells.Fixed(6), state = mem.grid, horizontalArrangement = Arrangement.spacedBy(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
                contentPadding = PaddingValues(8.dp)) {
                itemsIndexed(list, key = { _, it -> it.id }) { i, it ->
                    if (i >= list.size - 12) LaunchedEffect(list.size) { loadMore() } // nachladen, bevor das Ende sichtbar wird
                    PosterCard(it, {
                        if (it.isFolder && !it.isSeries) app.go(Screen.Folder(it)) else app.go(Screen.Details(it.id, it))
                    }, width = 140.dp, requester = if (i == 0 && mem.focusKey == null) first else mem.requester(it.id), onFocus = { mem.focusKey = it.id })
                }
            }
        }
    }
}

/* ---------------- Details (Film, Serie, Folge) ---------------- */

private class Show(val seasons: List<Pair<String, List<MediaItem>>>, val next: JSONObject?, val watchedCount: Int, val total: Int)

@Composable
fun DetailsScreen(app: AppState, screen: Screen.Details) {
    val mem = screen.memory
    var d by remember { mutableStateOf<MediaItem?>(screen.preview) }
    var raw by remember { mutableStateOf<JSONObject?>(null) }
    var show by remember { mutableStateOf<Show?>(null) }
    var season by remember { mutableStateOf(0) }
    var inList by remember { mutableStateOf(false) }
    var watched by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    val playBtn = remember { FocusRequester() }
    AutoFocus(playBtn, key = screen.id)

    LaunchedEffect(screen.id, reload) {
        try {
            val j = app.api.details(screen.id)
            raw = j; d = MediaItem.from(j)
            inList = j.optBoolean("inWatchlist"); watched = j.optBoolean("watched")
            if (j.optString("type") == "Series") {
                val s = app.api.show(screen.id, app.room.state.value.code)
                val seasons = s.optJSONArray("seasons").map { it.optString("name") to items(it.optJSONArray("episodes")) }
                show = Show(seasons, s.optJSONObject("next"), s.optInt("watchedCount"), s.optInt("total"))
                // Staffel der nächsten Folge vorauswählen
                val nextId = s.optJSONObject("next")?.str("id")
                if (nextId != null) seasons.indexOfFirst { (_, eps) -> eps.any { it.id == nextId } }.takeIf { it >= 0 }?.let { season = it }
            }
        } catch (e: Exception) { app.toast(e.message ?: "Fehler", true) }
    }

    val it = d
    Box(Modifier.fillMaxSize().background(C.bg)) {
        if (it != null) {
            Img(app.api.img(it.backdropId, 1280, "Backdrop"), Modifier.fillMaxSize(), widthPx = 1280)
            Box(Modifier.fillMaxSize().background(leftShade))
            Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color.Transparent, Color(0xE60B0B0F)))))
        }
        PivotScroll(0.2f) {
            LazyColumn(state = mem.list, contentPadding = PaddingValues(start = 56.dp, top = 48.dp, end = 48.dp, bottom = 40.dp)) {
                item("head") {
                    Column(Modifier.width(640.dp)) {
                        if (it == null) { T("Lädt …", color = C.muted); return@Column }
                        T(if (it.isEpisode) (it.seriesName ?: "") else it.name, size = 38.sp, weight = FontWeight.Bold, maxLines = 2)
                        if (it.isEpisode) T(it.episodeLabel, Modifier.padding(top = 4.dp), size = 20.sp, weight = FontWeight.SemiBold)
                        val genres = raw?.optJSONArray("genres")?.let { a -> (0 until a.length()).map { i -> a.optString(i) } } ?: emptyList()
                        val ours = raw?.optJSONObject("ours")
                        val meta = listOfNotNull(it.year?.toString(), fmtRuntime(it.runtime), it.officialRating, it.rating?.let { r -> "★ ${"%.1f".format(r)}" },
                            ours?.takeIf { o -> o.optInt("count") > 0 }?.let { o -> "Bei euch ★ ${"%.1f".format(o.optDouble("avg"))}" },
                            show?.let { s -> "${s.watchedCount}/${s.total} gesehen" }, genres.take(3).joinToString(", ").ifEmpty { null })
                        T(meta.joinToString("  ·  "), Modifier.padding(top = 10.dp), size = 16.sp, color = C.muted)
                        if (it.overview.isNotBlank()) T(it.overview, Modifier.padding(top = 16.dp), size = 17.sp, color = Color(0xE6FFFFFF), maxLines = 6)
                        Spacer(Modifier.height(24.dp))
                        val resume = raw?.optDouble("resume", 0.0) ?: 0.0
                        ButtonRow {
                            val sh = show
                            when {
                                sh != null -> {
                                    val n = sh.next
                                    Btn(if (n != null) "▶ ${if ((n.optDouble("progress", 0.0)) > 2) "Weiter" else "Abspielen"}: ${n.optString("label")}" else "▶ Abspielen",
                                        { (n?.str("id") ?: sh.seasons.firstOrNull()?.second?.firstOrNull()?.id)?.let { id -> app.play(id) } }, primary = true, requester = playBtn)
                                }
                                it.playable && resume > 30 -> {
                                    Btn("▶ Fortsetzen ab ${fmtTime(resume)}", { app.play(it.id, resume) }, primary = true, requester = playBtn)
                                    Btn("Von vorn", { app.play(it.id, 0.0) })
                                }
                                it.playable -> Btn("▶ Abspielen", { app.play(it.id, 0.0) }, primary = true, requester = playBtn)
                            }
                            Btn(if (inList) "✓ Auf meiner Liste" else "+ Meine Liste", {
                                scope.launch { runCatching { inList = app.api.toggleWatchlist(it.id, !inList).optBoolean("on") } }
                            })
                            if (it.playable) Btn(if (watched) "✓ Gesehen" else "Als gesehen markieren", {
                                scope.launch { runCatching { app.api.setWatched(listOf(it.id), !watched); watched = !watched } }
                            })
                            if (it.isEpisode && it.seriesId != null) Btn("Zur Serie", { app.go(Screen.Details(it.seriesId, null)) })
                            if (app.inRoom && app.me?.can("suggest") == true && !app.room.canLoad(app.me)) Btn("💡 Vorschlagen", {
                                app.room.send("suggest", "itemId" to it.id); app.toast("Im Chat vorgeschlagen")
                            })
                            if (app.inRoom && it.playable) Btn("+ Warteschlange", { app.room.send("queue-add", "itemId" to it.id); app.toast("Eingereiht") })
                        }
                    }
                }
                val sh = show
                if (sh != null && sh.seasons.isNotEmpty()) {
                    item("seasons") {
                        LazyRow(Modifier.padding(top = 30.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(6.dp)) {
                            itemsIndexed(sh.seasons) { i, (name, eps) ->
                                val w = eps.count { e -> e.watched }
                                Btn("$name  $w/${eps.size}", { season = i }, primary = season == i, small = true, onFocus = { season = i })
                            }
                        }
                    }
                    item("episodes") {
                        val eps = sh.seasons.getOrNull(season)?.second ?: emptyList()
                        LazyRow(state = mem.row("s$season"), horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(6.dp)) {
                            items(eps, key = { e -> e.id }) { e ->
                                EpisodeCard(app, e)
                            }
                        }
                    }
                    item("markall") {
                        val eps = sh.seasons.getOrNull(season)?.second ?: emptyList()
                        ButtonRow(Modifier.padding(top = 16.dp)) {
                            Btn("Staffel als gesehen markieren", { scope.launch { runCatching { app.api.setWatched(eps.map { e -> e.id }, true); reload++ } } }, small = true)
                            if (app.inRoom) Btn("Staffel einreihen", {
                                app.room.send(JSONObject().put("t", "queue-add").put("itemIds", org.json.JSONArray(eps.map { e -> e.id }))); app.toast("${eps.size} Folgen eingereiht")
                            }, small = true)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EpisodeCard(app: AppState, e: MediaItem) {
    Column(Modifier.width(300.dp)) {
        Focusable({ app.play(e.id, if (e.progress in 2.0..92.0) (e.runtime ?: 0.0) * e.progress / 100 else 0.0) }, Modifier.fillMaxWidth().aspectRatio(16f / 9f),
            RoundedCornerShape(10.dp), 1.06f, background = C.surface2) {
            Box(Modifier.fillMaxSize()) {
                Img(app.api.img(e.id, 480), Modifier.fillMaxSize(), widthPx = 480)
                if (e.progress > 1) ProgressLine((e.progress / 100).toFloat(), Modifier.align(Alignment.BottomCenter).padding(8.dp))
                if (e.watched) T("✓ gesehen", Modifier.align(Alignment.TopEnd).padding(8.dp).clip(RoundedCornerShape(6.dp)).background(C.accent).padding(horizontal = 7.dp, vertical = 2.dp),
                    size = 12.sp, color = C.accentInk, weight = FontWeight.Bold)
                if (e.roomWatched.isNotEmpty()) T("👁 ${e.roomWatched.joinToString(", ")}", Modifier.align(Alignment.TopStart).padding(8.dp).clip(RoundedCornerShape(6.dp)).background(Color(0xCC000000)).padding(horizontal = 7.dp, vertical = 2.dp),
                    size = 12.sp, maxLines = 1)
            }
        }
        Spacer(Modifier.height(6.dp))
        T("${e.index ?: "?"}. ${e.name}", size = 15.sp, weight = FontWeight.SemiBold, maxLines = 1)
        T(listOfNotNull(fmtRuntime(e.runtime), e.overview.takeIf { it.isNotBlank() }).joinToString(" · "), size = 13.sp, color = C.muted, maxLines = 2)
    }
}
