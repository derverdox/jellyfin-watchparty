package de.watchparty.tv.data

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** Alles, was die Oberfläche über den Raum wissen muss */
data class RoomState(
    val code: String? = null,
    val connected: Boolean = false,
    val connecting: Boolean = false,
    val youSid: String? = null,
    val youName: String? = null,
    val info: RoomInfo? = null,
    val members: List<Member> = emptyList(),
    val chat: List<ChatMsg> = emptyList(),
    val queue: List<QueueEntry> = emptyList(),
    val poll: Poll? = null,
    val ratePrompt: Pair<String, String>? = null, // itemId, Titel
    val reactions: List<String> = listOf("😂", "😮", "❤️", "👍", "🔥", "😱", "👏", "💀"),
    val agentOnline: Boolean = true,
    val advancing: QueueEntry? = null,
    val recs: RoomRecs? = null,   // Empfehlungen am Filmende
) {
    val isHost get() = info != null && youSid != null && info.host == youSid
}

sealed class RoomEvent {
    data class Toast(val text: String, val bad: Boolean = false) : RoomEvent()
    data class React(val emoji: String, val from: String) : RoomEvent()
    data class Chat(val msg: ChatMsg) : RoomEvent()
    data class PlaybackChanged(val by: String?, val action: String?) : RoomEvent()
    data object Kicked : RoomEvent()
    data class NoAccess(val title: String) : RoomEvent()
    data class RoundEnd(val title: String, val avg: Double?, val count: Int) : RoomEvent()
}

/**
 * Verbindung zum Raum über denselben WebSocket wie Browser und Desktop-Client.
 * Hält die Serverzeit-Abweichung (für den Sync) und baut die Verbindung bei Abbrüchen neu auf.
 */
class RoomClient(private val api: Api) {
    private val main = Handler(Looper.getMainLooper())
    private val _state = MutableStateFlow(RoomState())
    val state = _state.asStateFlow()
    private val _playback = MutableStateFlow<Playback?>(null)
    val playback = _playback.asStateFlow()
    private val _events = MutableSharedFlow<RoomEvent>(extraBufferCapacity = 64)
    val events = _events.asSharedFlow()

    @Volatile var offsetMs = 0L; private set
    @Volatile var bestRtt = Long.MAX_VALUE; private set
    private val samples = ArrayDeque<Pair<Long, Double>>() // rtt, offset
    private var ws: WebSocket? = null
    private var gen = 0
    private var retry = 0
    private var leaving = false
    /** Wird nach „welcome“ einmal ausgeführt (z. B. Titel starten, nachdem der eigene Raum offen ist) */
    var onWelcome: ((RoomClient) -> Unit)? = null

    fun serverNow(): Long = System.currentTimeMillis() + offsetMs

    /** Erwartete Position des Raums jetzt (Sekunden bzw. bei Twitch Zeitstempel) */
    fun expectedPos(pb: Playback? = _playback.value): Double {
        if (pb == null) return 0.0
        var p = if (pb.playing) pb.position + (serverNow() - pb.updatedAt) / 1000.0 else pb.position
        val rt = pb.item?.runtime
        if (pb.item?.live != true && rt != null && rt > 0) p = p.coerceAtMost(rt)
        return if (pb.item?.live == true) p else p.coerceAtLeast(0.0)
    }

    fun join(code: String) {
        leave()
        leaving = false
        retry = 0
        _state.value = RoomState(code = code.uppercase(), connecting = true)
        _playback.value = null
        connect()
    }

    fun leave() {
        leaving = true
        gen++
        main.removeCallbacksAndMessages(null)
        ws?.close(1000, null)
        ws = null
        _state.value = RoomState()
        _playback.value = null
    }

    val inRoom get() = _state.value.code != null

    private fun connect() {
        val code = _state.value.code ?: return
        val myGen = ++gen
        val url = api.base.replaceFirst(Regex("^http"), "ws") + "/ws?room=" + Api.enc(code)
        val req = Request.Builder().url(url).header("Cookie", api.cookieHeader).build()
        ws = api.http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (myGen != gen) return
                retry = 0
                _state.value = _state.value.copy(connected = true, connecting = false)
                schedulePing(myGen)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (myGen != gen) return
                val msg = try { JSONObject(text) } catch (_: Exception) { return }
                main.post { if (myGen == gen) handle(msg) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { onDrop(myGen, code, null) }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { onDrop(myGen, 0, response?.code) }
        })
    }

    private fun onDrop(myGen: Int, closeCode: Int, httpCode: Int?) {
        main.post {
            if (myGen != gen || leaving) return@post
            _state.value = _state.value.copy(connected = false, connecting = true)
            when {
                closeCode == 4001 -> { _events.tryEmit(RoomEvent.Kicked); leave(); return@post }
                httpCode == 404 -> { _events.tryEmit(RoomEvent.Toast("Diesen Raum gibt es nicht mehr.", true)); _events.tryEmit(RoomEvent.Kicked); leave(); return@post }
                httpCode == 401 -> { _events.tryEmit(RoomEvent.Toast("Bitte neu anmelden.", true)); _events.tryEmit(RoomEvent.Kicked); leave(); return@post }
            }
            retry++
            val delay = (1000L shl retry.coerceAtMost(4)).coerceAtMost(15000L)
            main.postDelayed({ if (myGen == gen && !leaving) connect() }, delay)
        }
    }

    private fun schedulePing(myGen: Int) {
        main.postDelayed({
            if (myGen != gen) return@postDelayed
            send(JSONObject().put("t", "ping").put("c", System.currentTimeMillis()))
            schedulePing(myGen)
        }, if (samples.size < 4) 1000L else 5000L)
    }

    fun send(msg: JSONObject): Boolean = ws?.send(msg.toString()) ?: false
    fun send(t: String, vararg kv: Pair<String, Any?>): Boolean {
        val o = JSONObject().put("t", t)
        for ((k, v) in kv) o.put(k, v ?: JSONObject.NULL)
        return send(o)
    }

    /* ---------------- eingehende Nachrichten ---------------- */

    private fun setPlayback(j: JSONObject?) {
        val pb = Playback.from(j) ?: return
        val old = _playback.value
        if (old != null && pb.seq < old.seq && pb.item?.id == old.item?.id) return
        _playback.value = pb
    }

    private fun handle(m: JSONObject) {
        val s = _state.value
        when (m.optString("t")) {
            "welcome" -> {
                val you = m.optJSONObject("you")
                offsetMs = m.optLong("serverNow", System.currentTimeMillis()) - System.currentTimeMillis()
                _state.value = s.copy(
                    connected = true, connecting = false,
                    youSid = you?.str("sid"), youName = you?.str("name"),
                    info = RoomInfo.from(m.optJSONObject("room")),
                    members = m.optJSONArray("members").map { Member.from(it) },
                    chat = m.optJSONArray("chat").map { ChatMsg.from(it) }.takeLast(100),
                    queue = m.optJSONArray("queue").map { QueueEntry.from(it) },
                    poll = Poll.from(m.optJSONObject("poll")),
                    reactions = m.optJSONArray("reactions").strings().ifEmpty { s.reactions },
                    agentOnline = m.optBoolean("agentOnline", true),
                    recs = RoomRecs.from(m.optJSONObject("recs")),
                )
                setPlayback(m.optJSONObject("playback"))
                onWelcome?.let { cb -> onWelcome = null; cb(this) }
            }
            "pong" -> {
                val now = System.currentTimeMillis()
                val rtt = now - m.optLong("c")
                if (rtt in 0..10000) {
                    samples.addLast(rtt to (m.optLong("s") + rtt / 2.0 - now))
                    if (samples.size > 12) samples.removeFirst()
                    // Offset aus den Messungen mit der kürzesten Laufzeit (genauer)
                    val best = samples.sortedBy { it.first }.take(3)
                    offsetMs = best.map { it.second }.average().toLong()
                    bestRtt = best.first().first
                }
            }
            "playback" -> {
                if (m.str("action") == "load" && s.recs != null) _state.value = s.copy(recs = null)
                setPlayback(m.optJSONObject("playback"))
                _events.tryEmit(RoomEvent.PlaybackChanged(m.str("by"), m.str("action")))
            }
            "members" -> _state.value = s.copy(members = m.optJSONArray("members").map { Member.from(it) })
            "room" -> _state.value = s.copy(info = RoomInfo.from(m.optJSONObject("room")) ?: s.info,
                members = if (m.has("members")) m.optJSONArray("members").map { Member.from(it) } else s.members)
            "chat" -> m.optJSONObject("msg")?.let {
                val c = ChatMsg.from(it)
                _state.value = s.copy(chat = (s.chat + c).takeLast(100))
                _events.tryEmit(RoomEvent.Chat(c))
            }
            "react" -> _events.tryEmit(RoomEvent.React(m.optString("emoji"), m.optString("from")))
            "error" -> _events.tryEmit(RoomEvent.Toast(m.optString("text"), true))
            "announce" -> _events.tryEmit(RoomEvent.Toast("📣 ${m.optString("from")}: ${m.optString("text")}"))
            "agent" -> _state.value = s.copy(agentOnline = m.bool("online"))
            "noaccess" -> _events.tryEmit(RoomEvent.NoAccess(m.optJSONObject("item")?.optString("title") ?: ""))
            "kicked" -> { _events.tryEmit(RoomEvent.Toast(m.str("text") ?: "Du wurdest aus dem Raum entfernt.", true)); _events.tryEmit(RoomEvent.Kicked); leave() }
            "queue" -> _state.value = s.copy(queue = m.optJSONArray("queue").map { QueueEntry.from(it) }, advancing = null)
            "poll" -> {
                _state.value = s.copy(poll = Poll.from(m.optJSONObject("poll")))
                m.optJSONObject("winner")?.let { _events.tryEmit(RoomEvent.Toast("🏆 ${it.optString("title")}")) }
            }
            "rate-prompt" -> m.optJSONObject("item")?.let { _state.value = s.copy(ratePrompt = it.optString("id") to it.optString("title")) }
            "round-end" -> {
                _state.value = s.copy(ratePrompt = null)
                val it = m.optJSONObject("item")
                _events.tryEmit(RoomEvent.RoundEnd(it?.optString("title") ?: "", m.num("avg"), m.optInt("count")))
            }
            "advancing" -> _state.value = s.copy(advancing = m.optJSONObject("next")?.let { QueueEntry.from(it) })
            "recs" -> _state.value = s.copy(recs = RoomRecs.from(m.optJSONObject("recs")))
            "load-url" -> when (m.optString("state")) {
                "loading" -> _events.tryEmit(RoomEvent.Toast("Stream wird verbunden …"))
            }
        }
    }

    fun clearRatePrompt() { _state.value = _state.value.copy(ratePrompt = null) }

    /** Eigene Aktion sofort anwenden (fühlt sich direkter an), der Server bestätigt gleich */
    fun applyLocal(action: String, position: Double?) {
        val pb = _playback.value ?: return
        if (action == "live") return
        val pos = position ?: expectedPos(pb)
        _playback.value = pb.copy(
            position = pos, updatedAt = serverNow(),
            playing = when (action) { "play" -> true; "pause" -> false; else -> pb.playing },
        )
    }

    /* ---------------- Rechte ---------------- */

    fun canControl(me: Me?): Boolean {
        val s = _state.value
        if (s.isHost) return true
        return (s.info?.allowAllControl ?: false) && (me?.can("control") ?: false)
    }

    fun canLoad(me: Me?): Boolean = canControl(me) && (_state.value.isHost || (me?.can("load") ?: false))
}
