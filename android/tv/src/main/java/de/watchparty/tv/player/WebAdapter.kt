package de.watchparty.tv.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/** Was im eingebetteten Player läuft */
sealed class WebSource {
    abstract val key: String
    data class YouTube(val id: String, val start: Double) : WebSource() { override val key get() = "yt|$id" }
    data class TwitchVod(val video: String, val start: Double) : WebSource() { override val key get() = "twv|$video" }
    data class TwitchClip(val clip: String) : WebSource() { override val key get() = "twc|$clip" }
}

/**
 * YouTube (IFrame-API) und Twitch-Videos/Clips im eingebetteten Player einer WebView.
 * Die Seite meldet alle 200 ms Zeit und Zustand über eine JS-Brücke; dazwischen wird hochgerechnet.
 * Bedient wird nur über unsere Steuerung – die WebView selbst bekommt keinen Fokus.
 */
@SuppressLint("SetJavaScriptEnabled")
class WebAdapter(ctx: Context, private val origin: String, private val onError: (String) -> Unit) : MediaAdapter {
    private val main = Handler(Looper.getMainLooper())
    val view: WebView = WebView(ctx).apply {
        setBackgroundColor(Color.BLACK)
        isFocusable = false
        isFocusableInTouchMode = false
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        webChromeClient = WebChromeClient()
        webViewClient = WebViewClient()
    }

    var source: WebSource? = null; private set
    @Volatile private var t = Double.NaN
    @Volatile private var tAt = 0L
    @Volatile private var state = -1      // YouTube-Zustände: -1 neu, 0 Ende, 1 läuft, 2 Pause, 3 lädt, 5 bereit
    @Volatile private var dur = 0.0
    @Volatile private var isReady = false
    private var rate = 1f

    init {
        view.addJavascriptInterface(object {
            @JavascriptInterface fun tick(time: Double, st: Int, d: Double) {
                t = time; tAt = SystemClock.elapsedRealtime(); state = st; if (d > 0) dur = d
            }
            @JavascriptInterface fun ready() { isReady = true }
            @JavascriptInterface fun error(msg: String) { main.post { onError(msg) } }
        }, "WP")
    }

    fun load(src: WebSource) {
        if (src.key == source?.key) return
        source = src
        isReady = false; t = Double.NaN; state = -1; dur = 0.0; rate = 1f
        view.loadDataWithBaseURL("$origin/", html(src), "text/html", "utf-8", null)
    }

    fun stop() {
        source = null
        isReady = false
        view.loadUrl("about:blank")
    }

    private fun js(code: String) { main.post { view.evaluateJavascript("try{$code}catch(e){}", null) } }

    private fun html(src: WebSource): String {
        val host = try { java.net.URI(origin).host } catch (_: Exception) { "localhost" }
        val head = """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p,iframe{position:absolute;inset:0;width:100%;height:100%;border:0}</style></head><body><div id="p"></div>"""
        return when (src) {
            is WebSource.YouTube -> head + """
<script src="https://www.youtube.com/iframe_api"></script>
<script>
var p;
function onYouTubeIframeAPIReady(){
  p=new YT.Player('p',{videoId:${JSONObject.quote(src.id)},host:'https://www.youtube.com',
    playerVars:{autoplay:0,controls:0,disablekb:1,fs:0,rel:0,playsinline:1,iv_load_policy:3,modestbranding:1,start:${src.start.toInt()},origin:${JSONObject.quote(origin)}},
    events:{onReady:function(){WP.ready();},onError:function(e){WP.error('YouTube-Fehler '+e.data);}}});
  setInterval(function(){try{WP.tick(p.getCurrentTime()||0,p.getPlayerState(),p.getDuration()||0);}catch(e){}},200);
}
window.wp={play:function(){p.playVideo()},pause:function(){p.pauseVideo()},seek:function(s){p.seekTo(s,true)},rate:function(r){p.setPlaybackRate(r)}};
</script></body></html>"""
            is WebSource.TwitchVod -> head + """
<script src="https://player.twitch.tv/js/embed/v1.js"></script>
<script>
var p=new Twitch.Player('p',{video:${JSONObject.quote("v" + src.video)},parent:[${JSONObject.quote(host)}],autoplay:false,controls:false,width:'100%',height:'100%',time:${JSONObject.quote("${src.start.toInt()}s")}});
var st=-1;
p.addEventListener(Twitch.Player.READY,function(){WP.ready();st=2;});
p.addEventListener(Twitch.Player.PLAY,function(){st=1;});
p.addEventListener(Twitch.Player.PAUSE,function(){st=2;});
p.addEventListener(Twitch.Player.ENDED,function(){st=0;});
setInterval(function(){try{WP.tick(p.getCurrentTime()||0,p.isPaused()?(st==0?0:2):st,p.getDuration()||0);}catch(e){}},200);
window.wp={play:function(){p.play()},pause:function(){p.pause()},seek:function(s){p.seek(s)},rate:function(r){}};
</script></body></html>"""
            is WebSource.TwitchClip -> head + """
<iframe src="https://clips.twitch.tv/embed?clip=${java.net.URLEncoder.encode(src.clip, "UTF-8")}&parent=${java.net.URLEncoder.encode(host, "UTF-8")}&autoplay=true" allow="autoplay; fullscreen"></iframe>
<script>WP.ready();setInterval(function(){WP.tick(0,1,0);},1000);window.wp={play:function(){},pause:function(){},seek:function(){},rate:function(){}};</script>
</body></html>"""
        }
    }

    /* ---------------- MediaAdapter ---------------- */

    override val ready get() = source != null && isReady && !t.isNaN()

    override fun position(): Double {
        if (t.isNaN()) return Double.NaN
        // zwischen zwei Meldungen hochrechnen
        return if (state == 1) t + (SystemClock.elapsedRealtime() - tAt) / 1000.0 * rate else t
    }

    override fun seekTo(p: Double) {
        if (!seekable) return
        t = p; tAt = SystemClock.elapsedRealtime()
        js("wp.seek(${"%.3f".format(java.util.Locale.ROOT, p.coerceAtLeast(0.0))})")
    }

    override val paused get() = state != 1 && state != 3
    override fun play() { if (state != 1 && state != 3) js("wp.play()") }
    override fun pause() { if (state == 1 || state == 3) js("wp.pause()") }
    override val buffering get() = state == 3 || state == -1
    override val ended get() = state == 0
    override fun duration() = dur
    override val fineSpeed = false
    override val seekable get() = source !is WebSource.TwitchClip
    override fun setSpeed(s: Float) {
        if (s == rate) return
        rate = s
        js("wp.rate($s)")
    }

    override fun release() {
        stop()
        view.destroy()
    }
}
