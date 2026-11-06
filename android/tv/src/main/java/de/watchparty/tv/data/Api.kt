package de.watchparty.tv.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Gespeicherte Einstellungen: Server, Sitzung, Vorlieben. */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("watchparty_tv", Context.MODE_PRIVATE)

    var server: String
        get() = sp.getString("server", "") ?: ""
        set(v) { sp.edit().putString("server", v).apply() }
    var sid: String?
        get() = sp.getString("sid", null)
        set(v) { sp.edit().putString("sid", v).apply() }
    var quality: String
        get() = sp.getString("quality", "direct") ?: "direct"
        set(v) { sp.edit().putString("quality", v).apply() }
    var twitchQuality: String
        get() = sp.getString("twitchQuality", "") ?: ""
        set(v) { sp.edit().putString("twitchQuality", v).apply() }
    var audioLang: String
        get() = sp.getString("audioLang", "") ?: ""
        set(v) { sp.edit().putString("audioLang", v).apply() }
    var subLang: String
        get() = sp.getString("subLang", "off") ?: "off"
        set(v) { sp.edit().putString("subLang", v).apply() }
    var chatOverlay: Boolean
        get() = sp.getBoolean("chatOverlay", true)
        set(v) { sp.edit().putBoolean("chatOverlay", v).apply() }
    var skippedUpdate: Long
        get() = sp.getLong("skippedUpdate", 0L)
        set(v) { sp.edit().putLong("skippedUpdate", v).apply() }
    var recentLinks: List<String>
        get() = (sp.getString("recentLinks", "") ?: "").split('\n').filter { it.isNotBlank() }
        set(v) { sp.edit().putString("recentLinks", v.take(12).joinToString("\n")).apply() }

    fun rememberLink(url: String) { recentLinks = listOf(url) + recentLinks.filter { it != url } }
}

class ApiException(val status: Int, message: String) : Exception(message)

/**
 * HTTP-Zugriff auf das Relay. Das Sitzungs-Cookie (wp_sid) hängt automatisch an jeder Anfrage,
 * auch an Bildern (Coil) und Videos (ExoPlayer) – alle nutzen denselben OkHttpClient.
 */
class Api(private val prefs: Prefs, version: String) {
    val userAgent = "Mozilla/5.0 (Linux; Android ${android.os.Build.VERSION.RELEASE}; ${android.os.Build.MODEL}) WatchpartyTV/$version (native)"

    val base: String get() = prefs.server.trimEnd('/')

    private val cookies = Interceptor { chain ->
        val req = chain.request()
        val b = req.newBuilder().header("User-Agent", userAgent)
        val sid = prefs.sid
        if (sid != null && req.url.host == hostOf(base)) b.header("Cookie", "wp_sid=$sid")
        val res = chain.proceed(b.build())
        for (c in res.headers("Set-Cookie")) {
            val m = Regex("^wp_sid=([^;]*)").find(c) ?: continue
            prefs.sid = m.groupValues[1].ifEmpty { null }
        }
        res
    }

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .addInterceptor(cookies)
        .build()

    val cookieHeader: String get() = prefs.sid?.let { "wp_sid=$it" } ?: ""

    suspend fun get(path: String): JSONObject = call(Request.Builder().url(base + path).get().build())

    suspend fun post(path: String, body: JSONObject = JSONObject()): JSONObject =
        call(Request.Builder().url(base + path).post(body.toString().toRequestBody(JSON)).build())

    private suspend fun call(req: Request): JSONObject = withContext(Dispatchers.IO) {
        val res = try { http.newCall(req).execute() } catch (e: Exception) {
            throw ApiException(0, "Server nicht erreichbar (${e.message ?: e.javaClass.simpleName})")
        }
        res.use {
            val text = it.body?.string() ?: ""
            val json = try { if (text.isBlank()) JSONObject() else JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (!it.isSuccessful) throw ApiException(it.code, json.optString("error").ifEmpty { "Fehler ${it.code}" })
            json
        }
    }

    fun img(id: String, w: Int = 320, type: String = "Primary") = "$base/img/$id?w=$w&type=$type"

    /* ---------------- Endpunkte ---------------- */

    suspend fun me() = get("/api/me")
    suspend fun login(user: String, pass: String) = post("/api/login", JSONObject().put("username", user).put("password", pass))
    suspend fun logout() { try { post("/api/logout") } finally { prefs.sid = null } }
    suspend fun pairStart() = post("/api/pair/start")
    suspend fun pairPoll(token: String) = post("/api/pair/poll", JSONObject().put("token", token))
    suspend fun libraries(): List<MediaItem> = items(get("/api/libraries").optJSONArray("items"))
    suspend fun children(parentId: String, collectionType: String?, sort: String = "name", start: Int = 0, limit: Int = 60): Pair<List<MediaItem>, Int> {
        val q = "parentId=$parentId&start=$start&limit=$limit&sort=$sort" + (collectionType?.let { "&collectionType=$it" } ?: "")
        val j = get("/api/items?$q")
        return items(j.optJSONArray("items")) to j.optInt("total")
    }
    suspend fun latest(libId: String, collectionType: String?) = children(libId, collectionType, "added", 0, 24).first
    suspend fun history(): List<MediaItem> = items(get("/api/history").optJSONArray("items"))
    suspend fun watchlist(): List<MediaItem> = items(get("/api/watchlist").optJSONArray("items"))
    suspend fun topRated(): List<MediaItem> = items(get("/api/top-rated").optJSONArray("items"))
    suspend fun search(q: String): JSONObject = get("/api/search?q=${enc(q)}")
    suspend fun details(id: String) = get("/api/details/$id")
    suspend fun show(id: String, room: String?) = get("/api/show/$id" + (room?.let { "?room=$it" } ?: ""))
    suspend fun item(id: String) = get("/api/item/$id")
    suspend fun activity() = get("/api/activity")
    suspend fun soloRoom(): String = post("/api/rooms", JSONObject().put("solo", true)).getString("code")
    suspend fun newRoom(): String = post("/api/rooms").getString("code")
    suspend fun roomExists(code: String) = get("/api/rooms/${enc(code)}")
    suspend fun toggleWatchlist(id: String, on: Boolean) = post("/api/watchlist", JSONObject().put("itemId", id).put("on", on))
    suspend fun setWatched(ids: List<String>, on: Boolean) = post("/api/watched", JSONObject().put("ids", JSONArray(ids)).put("on", on))
    suspend fun rate(id: String, score: Int?) = post("/api/rate", JSONObject().put("itemId", id).put("score", score ?: JSONObject.NULL))
    suspend fun twitch(login: String) = get("/api/twitch/${enc(login)}")

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
        fun hostOf(url: String): String = try { java.net.URI(url).host ?: "" } catch (_: Exception) { "" }

        /** „watchparty.example.com“ → „https://watchparty.example.com“ */
        fun normalizeServer(input: String): String {
            var s = input.trim().trimEnd('/')
            if (s.isEmpty()) throw IllegalArgumentException("Bitte die Adresse des Servers eingeben")
            if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s = "https://$s"
            val u = java.net.URI(s)
            if (u.host.isNullOrBlank()) throw IllegalArgumentException("Das ist keine gültige Adresse")
            return "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
        }
    }
}
