package de.watchparty.tv.data

import org.json.JSONArray
import org.json.JSONObject

/* JSON-Helfer: org.json liefert für fehlende Werte "" und für null den Text "null" – das wollen wir nicht. */
fun JSONObject.str(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).takeIf { it.isNotEmpty() }
fun JSONObject.num(k: String): Double? = if (!has(k) || isNull(k)) null else optDouble(k).takeIf { !it.isNaN() }
fun JSONObject.int(k: String): Int? = num(k)?.toInt()
fun JSONObject.bool(k: String): Boolean = optBoolean(k, false)
inline fun <T> JSONArray?.map(f: (JSONObject) -> T): List<T> {
    if (this == null) return emptyList()
    val out = ArrayList<T>(length())
    for (i in 0 until length()) optJSONObject(i)?.let { out.add(f(it)) }
    return out
}
fun JSONArray?.strings(): List<String> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optString(it).takeIf { s -> s.isNotEmpty() } }
}

/** Ein Titel aus der Bibliothek (Film, Serie, Folge, Ordner …) – wie mapItem() im Relay. */
data class MediaItem(
    val id: String,
    val name: String,
    val type: String,
    val collectionType: String? = null,
    val year: Int? = null,
    val seriesName: String? = null,
    val index: Int? = null,
    val parentIndex: Int? = null,
    val runtime: Double? = null,
    val hasImage: Boolean = true,
    val hasBackdrop: Boolean = false,
    val isFolder: Boolean = false,
    val playable: Boolean = false,
    val overview: String = "",
    val rating: Double? = null,
    val seriesId: String? = null,
    val officialRating: String? = null,
    val progress: Double = 0.0,   // Prozent (Verlauf)
    val pos: Double = 0.0,        // Sekunden (Verlauf)
    val subtitle: String? = null, // Verlauf: „S01E02 · Titel“
    val watched: Boolean = false,
    val roomWatched: List<String> = emptyList(),
    val availableQualities: List<String> = emptyList(),
) {
    val isSeries get() = type == "Series"
    val isEpisode get() = type == "Episode"
    /** Folge: „S1E3 · Name“, sonst der Name */
    val episodeLabel get() = if (isEpisode) "S${parentIndex ?: "?"}E${index ?: "?"} · $name" else name
    /** Für Kacheln: Serie zeigt das Serien-Poster */
    val posterId get() = if (isEpisode && seriesId != null) seriesId else id
    val backdropId get() = if (isEpisode && seriesId != null) seriesId else id

    companion object {
        fun from(j: JSONObject) = MediaItem(
            id = j.optString("id"),
            name = j.str("name") ?: j.str("title") ?: "",
            type = j.str("type") ?: "",
            collectionType = j.str("collectionType"),
            year = j.int("year"),
            seriesName = j.str("seriesName"),
            index = j.int("index"),
            parentIndex = j.int("parentIndex"),
            runtime = j.num("runtime"),
            hasImage = if (j.has("hasImage")) j.bool("hasImage") else true,
            hasBackdrop = j.bool("hasBackdrop"),
            isFolder = j.bool("isFolder"),
            playable = if (j.has("playable")) j.bool("playable") else j.str("type") in setOf("Movie", "Episode", "Video"),
            overview = j.str("overview") ?: "",
            rating = j.num("rating"),
            seriesId = j.str("seriesId"),
            officialRating = j.str("officialRating"),
            progress = j.num("progress") ?: 0.0,
            pos = j.num("pos") ?: 0.0,
            subtitle = j.str("subtitle"),
            watched = j.bool("watched") || j.bool("played"),
            roomWatched = j.optJSONArray("roomWatched").strings(),
            availableQualities = j.optJSONArray("availableQualities").strings(),
        )
    }
}

fun items(a: JSONArray?): List<MediaItem> = a.map { MediaItem.from(it) }

/** Was im Raum läuft (playback.item) */
data class RoomItem(
    val id: String,
    val title: String,
    val subtitle: String?,
    val type: String?,
    val runtime: Double?,
    val nextEpisodeId: String?,
    val seriesId: String?,
    val source: String?,     // "twitch" (Restream) | "youtube"
    val live: Boolean,
    val channel: String?,
    val videoId: String?,
    val thumb: String?,
    val ext: JSONObject?,    // eingebetteter Player (Twitch-VOD/Clip): { kind, video, clip, start }
    val mediaSourceId: String? = null,
) {
    val isJellyfin get() = source == null && ext == null

    companion object {
        fun from(j: JSONObject?): RoomItem? {
            if (j == null) return null
            return RoomItem(
                id = j.optString("id"), title = j.str("title") ?: "", subtitle = j.str("subtitle"), type = j.str("type"),
                runtime = j.num("runtime"), nextEpisodeId = j.str("nextEpisodeId"), seriesId = j.str("seriesId"),
                source = j.str("source"), live = j.bool("live"), channel = j.str("channel"), videoId = j.str("videoId"),
                thumb = j.str("thumb"), ext = j.optJSONObject("ext"), mediaSourceId = j.str("mediaSourceId"),
            )
        }
    }
}

/** Gemeinsamer Abspielzustand des Raums */
data class Playback(val item: RoomItem?, val playing: Boolean, val position: Double, val updatedAt: Long, val seq: Int) {
    companion object {
        fun from(j: JSONObject?): Playback? {
            if (j == null) return null
            return Playback(RoomItem.from(j.optJSONObject("item")), j.bool("playing"), j.optDouble("position", 0.0), j.optLong("updatedAt"), j.optInt("seq"))
        }
    }
}

data class Member(val id: String, val name: String, val isHost: Boolean, val state: String, val drift: Double, val kind: String?) {
    companion object {
        fun from(j: JSONObject): Member {
            val st = j.optJSONObject("status") ?: JSONObject()
            return Member(j.optString("id"), j.optString("name"), j.bool("isHost"), st.optString("state", "idle"), st.optDouble("drift", 0.0), j.str("kind"))
        }
    }
}

data class ChatMsg(val id: String, val ts: Long, val kind: String, val from: String?, val text: String, val itemId: String?) {
    companion object {
        fun from(j: JSONObject) = ChatMsg(j.optString("id"), j.optLong("ts"), j.optString("kind", "user"), j.str("from"), j.optString("text"), j.str("itemId"))
    }
}

/** Eine Empfehlung am Filmende (vom Relay, schon für alle im Raum freigegeben) */
data class Rec(
    val id: String, val name: String, val type: String, val year: Int?, val rating: Double?, val runtime: Double?,
    val hasImage: Boolean, val reasons: List<String>, val seenBy: List<String>,
) {
    val isSeries get() = type == "Series"
    /** Für die Detailseite (gleiche Felder wie in der Bibliothek) */
    fun toMediaItem() = MediaItem(id = id, name = name, type = type, year = year, rating = rating, runtime = runtime, hasImage = hasImage,
        isFolder = isSeries, playable = !isSeries)

    companion object {
        fun from(j: JSONObject) = Rec(
            j.optString("id"), j.str("name") ?: "", j.str("type") ?: "Movie", j.int("year"), j.num("rating"), j.num("runtime"),
            if (j.has("hasImage")) j.bool("hasImage") else true, j.optJSONArray("reasons").strings(), j.optJSONArray("seenBy").strings(),
        )
    }
}

/** „Das könnte euch auch gefallen“ nach einem Film */
data class RoomRecs(val itemId: String, val title: String, val items: List<Rec>) {
    companion object {
        fun from(j: JSONObject?): RoomRecs? {
            if (j == null) return null
            val item = j.optJSONObject("item") ?: return null
            val items = j.optJSONArray("items").map { Rec.from(it) }
            if (items.isEmpty()) return null
            return RoomRecs(item.optString("id"), item.optString("title"), items)
        }
    }
}

data class QueueEntry(val id: String, val title: String, val subtitle: String?, val type: String?, val by: String?) {
    companion object {
        fun from(j: JSONObject) = QueueEntry(j.optString("id"), j.optString("title"), j.str("subtitle"), j.str("type"), j.str("by"))
    }
}

data class PollOption(val id: String, val title: String, val subtitle: String?, val votes: Int, val voters: List<String>)
data class Poll(val id: String, val by: String?, val ends: Long, val options: List<PollOption>) {
    companion object {
        fun from(j: JSONObject?): Poll? {
            if (j == null) return null
            return Poll(j.optString("id"), j.str("by"), j.optLong("ends"), j.optJSONArray("options").map {
                PollOption(it.optString("id"), it.optString("title"), it.str("subtitle"), it.optInt("votes"), it.optJSONArray("voters").strings())
            })
        }
    }
}

data class RoomInfo(val code: String, val host: String, val allowAllControl: Boolean, val isPrivate: Boolean, val solo: Boolean) {
    companion object {
        fun from(j: JSONObject?) = j?.let { RoomInfo(it.optString("code"), it.optString("host"), it.optBoolean("allowAllControl", true), it.bool("private"), it.bool("solo")) }
    }
}

/** Eigenes Konto (/api/me) */
data class Me(val name: String, val username: String, val admin: Boolean, val perms: Set<String>, val agentOnline: Boolean, val server: String?, val motd: String) {
    fun can(p: String) = admin || p in perms

    companion object {
        fun from(j: JSONObject): Me {
            val p = j.optJSONObject("perms") ?: JSONObject()
            val perms = p.keys().asSequence().filter { p.optBoolean(it) }.toSet()
            return Me(j.optString("name"), j.optString("username"), j.bool("admin"), perms, j.bool("agentOnline"), j.str("server"), j.optString("motd"))
        }
    }
}

/** Ein Freund aus /api/activity */
data class Friend(val name: String, val username: String, val state: String, val item: JSONObject?, val roomCode: String?, val roomMembers: Int, val kind: String?) {
    val itemTitle get() = item?.let { (it.str("title") ?: "") + (it.str("subtitle")?.let { s -> " · $s" } ?: "") }

    companion object {
        fun from(j: JSONObject): Friend {
            val r = j.optJSONObject("room")
            return Friend(j.optString("name"), j.optString("username"), j.optString("state"), j.optJSONObject("item")?.takeIf { !it.bool("hidden") }, r?.str("code"), r?.optInt("members") ?: 0, j.str("kind"))
        }
    }
}

/** Details zum Abspielen (/api/item/:id) */
data class Track(val index: Int, val label: String, val lang: String, val isText: Boolean, val isForced: Boolean)
data class Quality(val id: String, val label: String)
data class Segment(val type: String, val start: Double, val end: Double)
data class PlayInfo(
    val id: String, val title: String, val subtitle: String?, val mediaSourceId: String,
    val audio: List<Track>, val subs: List<Track>, val defaultAudioIndex: Int?, val qualities: List<Quality>,
    val allowDirect: Boolean, val maxBitrate: Long, val resume: Double, val segments: List<Segment>, val runtime: Double?,
    val autoQuality: String = "10000000", val autoTranscodeQuality: String = "10000000",
    val bitrate: Long = 0, val autoMaxBitrate: Long = 10000000,
) {
    companion object {
        fun from(j: JSONObject) = PlayInfo(
            id = j.optString("id"), title = j.optString("title"), subtitle = j.str("subtitle"), mediaSourceId = j.optString("mediaSourceId"),
            audio = j.optJSONArray("audio").map { Track(it.optInt("index"), it.optString("label"), it.optString("lang"), false, false) },
            subs = j.optJSONArray("subs").map { Track(it.optInt("index"), it.optString("label"), it.optString("lang"), it.bool("isText"), it.bool("isForced")) },
            defaultAudioIndex = j.int("defaultAudioIndex"),
            qualities = j.optJSONArray("qualities").map { Quality(it.optString("id"), it.optString("label")) },
            allowDirect = j.bool("allowDirect"), maxBitrate = j.optLong("maxBitrate", 40_000_000L), resume = j.optDouble("resume", 0.0),
            segments = j.optJSONArray("segments").map { Segment(it.optString("type"), it.optDouble("start"), it.optDouble("end")) },
            runtime = j.num("runtime"),
            autoQuality = j.str("autoQuality") ?: "10000000",
            autoTranscodeQuality = j.str("autoTranscodeQuality") ?: "10000000",
            bitrate = j.optLong("bitrate", 0), autoMaxBitrate = j.optLong("autoMaxBitrate", 10000000),
        )
    }
}
