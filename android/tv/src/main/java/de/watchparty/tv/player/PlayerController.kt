package de.watchparty.tv.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.PlaybackException
import de.watchparty.tv.data.Api
import de.watchparty.tv.data.PlayInfo
import de.watchparty.tv.data.Playback
import de.watchparty.tv.data.Prefs
import de.watchparty.tv.data.Quality
import de.watchparty.tv.data.RoomClient
import de.watchparty.tv.data.RoomItem
import de.watchparty.tv.data.Segment
import de.watchparty.tv.data.Track
import de.watchparty.tv.data.map
import de.watchparty.tv.data.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.random.Random

enum class PlayerSurface { NONE, EXO, WEB }

/** Zustand für die Player-Oberfläche */
data class PlayerUi(
    val surface: PlayerSurface = PlayerSurface.NONE,
    val loading: Boolean = false,
    val live: Boolean = false,
    /** Anzeige: bei Filmen Sekunden, bei Twitch Sekunden ab Fensteranfang */
    val pos: Double = 0.0,
    val dur: Double = 0.0,
    val buffered: Double = 0.0,
    val liveBehind: Double = 0.0,
    val liveStart: Double = 0.0,
    val qualities: List<Quality> = emptyList(),
    val quality: String? = null,
    val audio: List<Track> = emptyList(),
    val audioIndex: Int? = null,
    val subs: List<Track> = emptyList(),
    val subIndex: Int? = null,
    val segment: Segment? = null,
    val error: String? = null,
    val drift: Double = 0.0,
)

/**
 * Verbindet den Raum mit dem Player: lädt, was im Raum läuft, hält es synchron und meldet den eigenen Zustand.
 * Läuft komplett auf dem Main-Thread (ExoPlayer verlangt das).
 */
class PlayerController(private val ctx: Context, private val api: Api, private val prefs: Prefs, private val room: RoomClient) {
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var exoA: ExoAdapter? = null
    private var webA: WebAdapter? = null
    val exo: ExoAdapter get() = exoA ?: ExoAdapter(ctx, api, ::onExoError).also { exoA = it }
    val web: WebAdapter get() = webA ?: WebAdapter(ctx, api.base, ::onWebError).also { webA = it }
    private val sync = SyncEngine()
    private var active: MediaAdapter? = null
    private var loadedId: String? = null
    private var info: PlayInfo? = null
    private var twitch: JSONObject? = null
    private var directFailed = false
    private var lastStatus = 0L
    private var lastUi = 0L
    private var running = false

    private val _ui = MutableStateFlow(PlayerUi())
    val ui = _ui.asStateFlow()

    private val ticker = object : Runnable {
        override fun run() {
            if (!running) return
            tick()
            main.postDelayed(this, 250)
        }
    }

    fun start() {
        if (running) return
        running = true
        main.post(ticker)
    }

    /** Raum verlassen / App im Hintergrund */
    fun stop() {
        running = false
        main.removeCallbacks(ticker)
        unload()
        lastPb = null // beim nächsten start() neu laden
    }

    fun release() {
        stop()
        exoA?.release(); exoA = null
        webA?.release(); webA = null
    }

    private fun unload() {
        exoA?.stop()
        webA?.stop()
        active = null
        loadedId = null
        info = null
        twitch = null
        sync.reset()
        _ui.value = PlayerUi()
    }

    /* ---------------- Laden ---------------- */

    private fun onPlayback(pb: Playback?) {
        val item = pb?.item
        if (item == null) { if (loadedId != null) unload(); return }
        if (item.id == loadedId) return
        unload()
        loadedId = item.id
        directFailed = false
        _ui.value = PlayerUi(loading = true)
        when {
            item.ext != null -> loadExt(item, pb)
            item.source == "youtube" -> loadWeb(WebSource.YouTube(item.videoId ?: item.id.removePrefix("yt:"), room.expectedPos(pb)))
            item.source == "twitch" -> loadTwitch(item)
            else -> loadJellyfin(item.id)
        }
    }

    private fun loadExt(item: RoomItem, pb: Playback?) {
        val e = item.ext ?: return
        val src = when {
            e.optString("kind") == "youtube" -> WebSource.YouTube(e.optString("id"), room.expectedPos(pb))
            e.str("video") != null -> WebSource.TwitchVod(e.optString("video"), room.expectedPos(pb))
            e.str("clip") != null -> WebSource.TwitchClip(e.optString("clip"))
            else -> { _ui.value = PlayerUi(error = "Dieser Stream läuft hier nicht."); return }
        }
        loadWeb(src)
    }

    private fun loadWeb(src: WebSource) {
        active = web
        web.load(src)
        _ui.value = _ui.value.copy(surface = PlayerSurface.WEB, loading = true, qualities = emptyList(), audio = emptyList(), subs = emptyList())
    }

    private fun loadTwitch(item: RoomItem) {
        val id = item.id
        scope.launch {
            try {
                val t = api.twitch(item.channel ?: id.removePrefix("twitch:"))
                if (loadedId != id) return@launch
                twitch = t
                val variants = t.optJSONArray("variants").map { Quality(it.optString("id"), it.optString("name")) }
                val pref = prefs.twitchQuality
                val q = variants.firstOrNull { it.id == pref }?.id ?: t.str("defaultId")?.takeIf { d -> variants.any { it.id == d } } ?: variants.firstOrNull()?.id
                    ?: throw IllegalStateException("Twitch liefert keine Qualitäten")
                startTwitch(item.channel ?: "", q, variants)
            } catch (e: Exception) {
                if (loadedId == id) _ui.value = PlayerUi(error = "Twitch: ${e.message}")
            }
        }
    }

    private fun startTwitch(channel: String, variant: String, variants: List<Quality>) {
        active = exo
        exo.load(ExoSource.Twitch("tw|$channel|$variant", "${api.base}/live/twitch/${Api.enc(channel)}/${Api.enc(variant)}.m3u8"), room.playback.value?.playing ?: true)
        _ui.value = _ui.value.copy(surface = PlayerSurface.EXO, live = true, qualities = variants, quality = variant, loading = true)
    }

    private fun loadJellyfin(id: String) {
        scope.launch {
            try {
                val pi = PlayInfo.from(api.item(id))
                if (loadedId != id) return@launch
                info = pi
                val audio = pickAudio(pi)
                val sub = pickSub(pi)
                val q = pickQuality(pi)
                _ui.value = _ui.value.copy(surface = PlayerSurface.EXO, live = false, qualities = qualityList(pi), quality = q,
                    audio = pi.audio, audioIndex = audio, subs = pi.subs, subIndex = sub)
                openJellyfin(pi, q, audio, sub, room.expectedPos())
            } catch (e: Exception) {
                if (loadedId == id) _ui.value = PlayerUi(error = "Konnte das Video nicht laden: ${e.message}")
            }
        }
    }

    private fun qualityList(pi: PlayInfo) = pi.qualities.filter { it.id != "direct" || (pi.allowDirect && !directFailed) }

    private fun pickQuality(pi: PlayInfo): String {
        val list = qualityList(pi)
        val want = prefs.quality
        if (list.any { it.id == want }) return want
        // ExoPlayer spielt fast alles direkt: Original, wenn erlaubt
        list.firstOrNull { it.id == "direct" }?.let { return it.id }
        val lower = list.filter { it.id != "direct" && (it.id.toLongOrNull() ?: 0) <= (want.toLongOrNull() ?: Long.MAX_VALUE) }
        return (lower.firstOrNull() ?: list.firstOrNull { it.id != "direct" } ?: list.firstOrNull())?.id ?: "10000000"
    }

    private fun pickAudio(pi: PlayInfo): Int? {
        val al = prefs.audioLang
        return (pi.audio.firstOrNull { al.isNotEmpty() && it.lang == al } ?: pi.audio.firstOrNull { it.index == pi.defaultAudioIndex } ?: pi.audio.firstOrNull())?.index
    }

    private fun pickSub(pi: PlayInfo): Int? {
        val sl = prefs.subLang
        if (sl.isEmpty() || sl == "off") return null
        val c = pi.subs.filter { it.lang == sl }
        return (c.firstOrNull { !it.isForced && it.isText } ?: c.firstOrNull { !it.isForced } ?: c.firstOrNull())?.index
    }

    private fun openJellyfin(pi: PlayInfo, q: String, audio: Int?, sub: Int?, start: Double) {
        val direct = q == "direct"
        val subTrack = pi.subs.firstOrNull { it.index == sub }
        val burn = subTrack != null && !subTrack.isText
        // Bild-Untertitel (PGS …) gehen nur eingebrannt → Transcode
        val useDirect = direct && !burn
        val textSubs = pi.subs.filter { it.isText }.map { SubTrack(it.index, "${api.base}/subs/${pi.id}/${pi.mediaSourceId}/${it.index}.vtt", it.lang, it.label) }
        val src = if (useDirect) {
            ExoSource.Jellyfin("${pi.id}|direct|$audio|$sub", "${api.base}/stream/${pi.id}/direct?ms=${pi.mediaSourceId}", false, start,
                textSubs, pi.audio.indexOfFirst { it.index == audio }.takeIf { it >= 0 }, if (burn) null else sub)
        } else {
            val br = if (direct) (pi.qualities.firstOrNull { it.id != "direct" }?.id ?: "10000000") else q
            val ps = (1..16).joinToString("") { "%02x".format(Random.nextInt(256)) }
            val qs = StringBuilder("ms=${pi.mediaSourceId}&ps=$ps&br=$br")
            if (audio != null) qs.append("&audio=$audio")
            if (burn) qs.append("&sub=$sub")
            ExoSource.Jellyfin("${pi.id}|$br|$audio|${if (burn) "b$sub" else ""}|$sub", "${api.base}/stream/${pi.id}/master.m3u8?$qs", true, start,
                textSubs, null, if (burn) null else sub)
        }
        active = exo
        exo.load(src, room.playback.value?.playing ?: false)
        sync.reset()
    }

    /* ---------------- Einstellungen im Player ---------------- */

    fun setQuality(id: String) {
        val pos = active?.position() ?: room.expectedPos()
        if (_ui.value.live) {
            prefs.twitchQuality = id
            val t = twitch ?: return
            val item = room.playback.value?.item ?: return
            startTwitch(item.channel ?: "", id, t.optJSONArray("variants").map { Quality(it.optString("id"), it.optString("name")) })
            return
        }
        val pi = info ?: return
        prefs.quality = id
        _ui.value = _ui.value.copy(quality = id)
        openJellyfin(pi, id, _ui.value.audioIndex, _ui.value.subIndex, if (pos.isNaN()) room.expectedPos() else pos)
    }

    fun setAudio(index: Int) {
        val pi = info ?: return
        pi.audio.firstOrNull { it.index == index }?.let { prefs.audioLang = it.lang }
        _ui.value = _ui.value.copy(audioIndex = index)
        openJellyfin(pi, _ui.value.quality ?: "direct", index, _ui.value.subIndex, active?.position()?.takeIf { !it.isNaN() } ?: room.expectedPos())
    }

    fun setSub(index: Int?) {
        val pi = info ?: return
        prefs.subLang = pi.subs.firstOrNull { it.index == index }?.lang ?: "off"
        _ui.value = _ui.value.copy(subIndex = index)
        openJellyfin(pi, _ui.value.quality ?: "direct", _ui.value.audioIndex, index, active?.position()?.takeIf { !it.isNaN() } ?: room.expectedPos())
    }

    /* ---------------- Fehler ---------------- */

    private fun onExoError(e: PlaybackException, src: ExoSource?) {
        val pi = info
        when {
            src is ExoSource.Twitch -> {
                // z. B. aus dem Live-Fenster gefallen: neu laden, der Sync springt wieder an die Raum-Position
                main.postDelayed({ if (exoA?.source == null || exoA?.source == src) exo.reload() }, 1500)
            }
            src is ExoSource.Jellyfin && !src.hls && pi != null -> {
                // Originaldatei kann das Gerät nicht → Transcode
                directFailed = true
                val q = pi.qualities.firstOrNull { it.id != "direct" }?.id ?: "10000000"
                _ui.value = _ui.value.copy(qualities = qualityList(pi), quality = q, error = null)
                openJellyfin(pi, q, _ui.value.audioIndex, _ui.value.subIndex, room.expectedPos())
            }
            else -> _ui.value = _ui.value.copy(error = "Wiedergabefehler: ${e.errorCodeName}", loading = false)
        }
    }

    private fun onWebError(msg: String) { _ui.value = _ui.value.copy(error = msg, loading = false) }

    /* ---------------- Takt ---------------- */

    private var lastPb: Playback? = null

    private fun tick() {
        val pb = room.playback.value
        if (pb !== lastPb) { lastPb = pb; onPlayback(pb) }
        val a = active
        if (pb != null && pb.item != null && a != null) sync.tick(a, pb.playing, room.expectedPos(pb))
        val now = SystemClock.elapsedRealtime()
        if (now - lastUi >= 400) { lastUi = now; pushUi(pb, a) }
        if (now - lastStatus >= 2000 && room.inRoom) { lastStatus = now; report(pb, a) }
    }

    /** Sofort nachziehen (nach eigener Aktion) */
    fun syncNow() {
        val pb = room.playback.value ?: return
        val a = active ?: return
        sync.tick(a, pb.playing, room.expectedPos(pb), force = true)
    }

    private fun pushUi(pb: Playback?, a: MediaAdapter?) {
        val u = _ui.value
        val item = pb?.item ?: return
        if (a == null) return
        val cur = a.position().takeIf { !it.isNaN() } ?: room.expectedPos(pb)
        val loading = !a.ready || a.buffering
        if (u.live && a is ExoAdapter) {
            val w = a.liveWindow()
            val delay = twitch?.optDouble("delay", 4.0) ?: 4.0
            if (w != null) {
                val buf = a.bufferedPosition().takeIf { !it.isNaN() } ?: cur
                _ui.value = u.copy(loading = loading, pos = cur - w.first, dur = w.second - w.first, liveStart = w.first,
                    liveBehind = (w.second - delay - cur).coerceAtLeast(0.0), buffered = buf - w.first, drift = sync.lastDrift)
            } else _ui.value = u.copy(loading = true)
            return
        }
        val dur = item.runtime ?: a.duration()
        val seg = info?.segments?.firstOrNull { cur >= it.start - 0.5 && cur < it.end - 1.5 && it.type in setOf("intro", "recap", "preview", "outro") }
        val buf = (a as? ExoAdapter)?.bufferedPosition() ?: cur
        _ui.value = u.copy(loading = loading, pos = cur, dur = dur, buffered = buf, segment = seg, drift = sync.lastDrift,
            error = if (a.ready) null else u.error)
    }

    private fun report(pb: Playback?, a: MediaAdapter?) {
        val item = pb?.item
        if (pb == null || item == null || a == null) { room.send("status", "pos" to 0, "state" to "idle"); return }
        val cur = a.position()
        val state = when {
            _ui.value.error != null -> "error"
            !a.ready || a.buffering -> if (pb.playing) "buffering" else "paused"
            a.paused -> "paused"
            else -> "playing"
        }
        val o = JSONObject().put("t", "status").put("pos", if (cur.isNaN()) room.expectedPos(pb) else cur).put("state", state)
            .put("drift", if (cur.isNaN()) 0.0 else room.expectedPos(pb) - cur)
        if (item.source == "youtube" && a.duration() > 1) o.put("dur", a.duration())
        room.send(o)
    }

    /** Aktuelle eigene Position auf der Raum-Zeitachse */
    fun localPos(): Double = active?.position()?.takeIf { !it.isNaN() } ?: room.expectedPos()
}
