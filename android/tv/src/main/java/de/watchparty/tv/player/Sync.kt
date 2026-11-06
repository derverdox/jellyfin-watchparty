package de.watchparty.tv.player

import android.os.SystemClock
import kotlin.math.abs

/** Einheitliche Steuerung für ExoPlayer und den eingebetteten YouTube/Twitch-Player. */
interface MediaAdapter {
    /** Bereit zum Steuern (Datei geladen, Zeitachse bekannt) */
    val ready: Boolean
    /** Eigene Position auf der Zeitachse des Raums (bei Twitch: Unix-Sekunden), NaN = unbekannt */
    fun position(): Double
    fun seekTo(p: Double)
    val paused: Boolean
    fun play()
    fun pause()
    val buffering: Boolean
    val ended: Boolean
    /** Länge in Sekunden (0 = unbekannt/live) */
    fun duration(): Double
    /** Feine Geschwindigkeit möglich (ExoPlayer) oder nur Stufen (YouTube) */
    val fineSpeed: Boolean
    fun setSpeed(s: Float)
    /** Darf springen? (Clips z. B. nicht) */
    val seekable: Boolean get() = true
    fun release()
}

/**
 * Hält den Player auf der gemeinsamen Zeit – dieselbe Logik wie im Browser und im Desktop-Client:
 * kleine Abweichungen weich über die Geschwindigkeit, große durch einen Sprung.
 */
class SyncEngine {
    private var correcting = false
    private var lastHardSeek = 0L
    private var speed = 1f
    var lastDrift = 0.0; private set
    var blocked = false

    fun reset() { correcting = false; lastHardSeek = 0L; speed = 1f; lastDrift = 0.0 }

    private fun setSpeed(a: MediaAdapter, s: Float) {
        if (abs(s - speed) < 0.004f) return
        speed = s
        a.setSpeed(s)
    }

    fun tick(a: MediaAdapter, playing: Boolean, expected: Double, force: Boolean = false) {
        if (!a.ready) return
        val cur = a.position()
        if (cur.isNaN()) return
        val diff = expected - cur // > 0: ich hänge hinterher
        lastDrift = diff
        val ad = abs(diff)

        if (!playing) {
            if (!a.paused) a.pause()
            setSpeed(a, 1f)
            correcting = false
            if (a.seekable && ad > 0.15) a.seekTo(expected)
            return
        }
        val dur = a.duration()
        if (a.ended && dur > 0 && expected >= dur - 1) return
        if (a.paused && !blocked) a.play()
        if (a.buffering) return

        val now = SystemClock.elapsedRealtime()
        if (a.seekable && ad > 1.5 && (force || now - lastHardSeek > 3500 || ad > 10)) {
            lastHardSeek = now
            setSpeed(a, 1f)
            correcting = false
            a.seekTo(expected + if (diff > 0) 0.3 else 0.0)
            return
        }
        if (a.fineSpeed) {
            if (ad > 0.2) correcting = true
            if (correcting && ad < 0.04) correcting = false
            // Verstärkung 0,4: ein Player, der dauerhaft 5 % zu langsam läuft, bleibt unter ~0,15 s
            setSpeed(a, if (correcting) 1f + (diff * 0.4).coerceIn(-0.06, 0.06).toFloat() else 1f)
        } else {
            // YouTube: nur feste Stufen (0,75 / 1,25)
            if (ad > 0.15) correcting = true
            if (correcting && ad < 0.05) correcting = false
            setSpeed(a, if (!correcting) 1f else if (diff > 0) 1.25f else 0.75f)
        }
    }
}
