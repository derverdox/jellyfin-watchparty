package de.watchparty.tv.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import de.watchparty.tv.data.Api

/** Was gerade geladen werden soll */
sealed class ExoSource {
    abstract val key: String

    /** Jellyfin: Originaldatei (direct) oder Transcode (HLS). subs = Text-Untertitel als WebVTT vom Relay */
    data class Jellyfin(
        override val key: String, val url: String, val hls: Boolean, val startSec: Double,
        val subs: List<SubTrack>, val audioOrdinal: Int?, val subIndex: Int?,
    ) : ExoSource()

    /** Twitch-Restream vom Relay: Zeitachse = Zeitstempel (#EXT-X-PROGRAM-DATE-TIME) */
    data class Twitch(override val key: String, val url: String) : ExoSource()
}

data class SubTrack(val index: Int, val url: String, val lang: String, val label: String)

/**
 * ExoPlayer für Jellyfin-Dateien und den Twitch-Restream.
 * Bei Twitch ist die Raum-Position ein Zeitstempel: windowStartTimeMs (aus der Playlist) + Position im Fenster.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class ExoAdapter(ctx: Context, api: Api, private val onError: (PlaybackException, ExoSource?) -> Unit) : MediaAdapter {
    private val dataSource = OkHttpDataSource.Factory(api.http)
    val player: ExoPlayer = ExoPlayer.Builder(ctx)
        .setMediaSourceFactory(DefaultMediaSourceFactory(ctx).setDataSourceFactory(dataSource))
        .setLoadControl(
            DefaultLoadControl.Builder()
                // Fire TV hat wenig RAM: moderater Puffer, schneller Start
                .setBufferDurationsMs(15_000, 50_000, 1_500, 2_500)
                .setBackBuffer(30_000, true)
                .build(),
        )
        .setSeekBackIncrementMs(10_000)
        .setSeekForwardIncrementMs(10_000)
        .build()

    var source: ExoSource? = null; private set
    private val window = Timeline.Window()
    private var pendingTracks = false

    init {
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) { onError(error, source) }
            override fun onTracksChanged(tracks: Tracks) { if (pendingTracks) applyTracks() }
        })
    }

    fun load(src: ExoSource, playWhenReady: Boolean) {
        if (src.key == source?.key) return
        source = src
        when (src) {
            is ExoSource.Jellyfin -> {
                val b = MediaItem.Builder().setUri(Uri.parse(src.url))
                if (src.hls) b.setMimeType(MimeTypes.APPLICATION_M3U8)
                b.setSubtitleConfigurations(src.subs.map {
                    MediaItem.SubtitleConfiguration.Builder(Uri.parse(it.url))
                        .setMimeType(MimeTypes.TEXT_VTT).setLanguage(it.lang.ifEmpty { null }).setLabel(it.label)
                        .setId("wp-sub-${it.index}").setSelectionFlags(0).build()
                })
                player.setMediaItem(b.build(), (src.startSec * 1000).toLong().coerceAtLeast(0))
                pendingTracks = true
            }
            is ExoSource.Twitch -> {
                val item = MediaItem.Builder().setUri(Uri.parse(src.url)).setMimeType(MimeTypes.APPLICATION_M3U8)
                    // Keine automatische Live-Geschwindigkeit: die Geschwindigkeit regelt der Raum-Sync
                    .setLiveConfiguration(MediaItem.LiveConfiguration.Builder().setMinPlaybackSpeed(1f).setMaxPlaybackSpeed(1f).build())
                    .build()
                player.setMediaItem(item)
                pendingTracks = false
            }
        }
        player.playWhenReady = playWhenReady
        player.prepare()
    }

    /** Nach Fehlern (z. B. aus dem Live-Fenster gefallen) neu laden */
    fun reload() {
        val s = source ?: return
        source = null
        load(s, player.playWhenReady)
    }

    fun stop() {
        source = null
        player.stop()
        player.clearMediaItems()
    }

    /* ---------------- Spuren ---------------- */

    private fun applyTracks() {
        val src = source as? ExoSource.Jellyfin ?: return
        val groups = player.currentTracks.groups
        if (groups.isEmpty()) return
        pendingTracks = false
        var p = player.trackSelectionParameters.buildUpon()
        // Ton: k-te Tonspur der Datei (Jellyfin zählt in derselben Reihenfolge)
        val audio = groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        val ord = src.audioOrdinal
        if (src.url.contains("/direct") && ord != null && ord in audio.indices) {
            p = p.setOverrideForType(TrackSelectionOverride(audio[ord].mediaTrackGroup, 0))
        }
        // Untertitel: nur unsere WebVTT-Spur oder ganz aus
        val text = groups.filter { it.type == C.TRACK_TYPE_TEXT }
        val want = src.subIndex
        val g = if (want == null) null else text.firstOrNull { grp -> (0 until grp.length).any { grp.getTrackFormat(it).id?.contains("wp-sub-$want") == true } }
        p = if (g != null) {
            p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0))
        } else {
            p.clearOverridesOfType(C.TRACK_TYPE_TEXT).setTrackTypeDisabled(C.TRACK_TYPE_TEXT, want == null)
        }
        player.trackSelectionParameters = p.build()
    }

    /* ---------------- MediaAdapter ---------------- */

    private val isLive get() = source is ExoSource.Twitch

    /** Fensterbeginn als Unix-Millisekunden (nur Twitch) */
    private fun windowStartMs(): Long {
        val tl = player.currentTimeline
        if (tl.isEmpty) return C.TIME_UNSET
        tl.getWindow(player.currentMediaItemIndex, window)
        return window.windowStartTimeMs
    }

    /** Live-Fenster als Unix-Sekunden: Anfang und Ende (= neuestes Segment) */
    fun liveWindow(): Pair<Double, Double>? {
        val start = windowStartMs()
        if (start == C.TIME_UNSET) return null
        val dur = window.durationMs
        if (dur == C.TIME_UNSET) return null
        return start / 1000.0 to (start + dur) / 1000.0
    }

    override val ready: Boolean
        get() = source != null && player.playbackState != Player.STATE_IDLE && !player.currentTimeline.isEmpty &&
            (!isLive || windowStartMs() != C.TIME_UNSET)

    override fun position(): Double {
        val pos = player.currentPosition / 1000.0
        if (!isLive) return pos
        val start = windowStartMs()
        return if (start == C.TIME_UNSET) Double.NaN else start / 1000.0 + pos
    }

    override fun seekTo(p: Double) {
        if (isLive) {
            val start = windowStartMs()
            if (start == C.TIME_UNSET) return
            player.seekTo(((p * 1000).toLong() - start).coerceAtLeast(0))
        } else player.seekTo((p * 1000).toLong().coerceAtLeast(0))
    }

    override val paused get() = !player.playWhenReady
    override fun play() { player.playWhenReady = true }
    override fun pause() { player.playWhenReady = false }
    override val buffering get() = player.playbackState == Player.STATE_BUFFERING
    override val ended get() = player.playbackState == Player.STATE_ENDED
    override fun duration(): Double = if (isLive) 0.0 else player.duration.takeIf { it != C.TIME_UNSET }?.div(1000.0) ?: 0.0
    override val fineSpeed = true
    override fun setSpeed(s: Float) { player.setPlaybackSpeed(s) }

    fun bufferedPosition(): Double {
        val b = player.bufferedPosition / 1000.0
        if (!isLive) return b
        val start = windowStartMs()
        return if (start == C.TIME_UNSET) Double.NaN else start / 1000.0 + b
    }

    override fun release() { player.release() }
}
