package de.watchparty.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.SharedPreferences
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast

/**
 * Watchparty für Fire TV / Android TV.
 *
 * Lädt die Watchparty-Website in einer Vollbild-WebView. Die Seite erkennt die App am
 * User-Agent („WatchpartyTV“) und schaltet in den TV-Modus (Steuerung per Fernbedienung, tv.js).
 * Zurück-, Menü- und Medientasten fängt die App ab und reicht sie an die Seite weiter.
 */
class MainActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private var web: WebView? = null
    private var root: FrameLayout? = null
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var server: String? = null
    private var lastBack = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("watchparty", MODE_PRIVATE)
        val saved = prefs.getString(KEY_SERVER, null)
        if (saved.isNullOrBlank()) showSetup(null) else showWeb(saved)
    }

    /* ---------------- Einrichtung ---------------- */

    private fun showSetup(error: String?) {
        destroyWeb()
        setContentView(R.layout.setup)
        val field = findViewById<EditText>(R.id.server)
        val err = findViewById<TextView>(R.id.setup_error)
        val connect = findViewById<Button>(R.id.connect)
        field.setText(prefs.getString(KEY_SERVER, "")?.removePrefix("https://") ?: "")
        if (error != null) { err.text = error; err.visibility = View.VISIBLE }

        val go = {
            val url = normalize(field.text.toString())
            if (url == null) {
                err.text = getString(R.string.setup_invalid)
                err.visibility = View.VISIBLE
            } else {
                prefs.edit().putString(KEY_SERVER, url).apply()
                showWeb(url)
            }
        }
        connect.setOnClickListener { go() }
        field.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) { go(); true } else false
        }
        (if (field.text.isNullOrEmpty()) field else connect).requestFocus()
    }

    private fun showError(detail: String) {
        destroyWeb()
        setContentView(R.layout.error)
        findViewById<TextView>(R.id.error_detail).text = "${server ?: ""}\n$detail"
        val retry = findViewById<Button>(R.id.retry)
        retry.setOnClickListener { server?.let { showWeb(it) } ?: showSetup(null) }
        findViewById<Button>(R.id.change).setOnClickListener { showSetup(null) }
        retry.requestFocus()
    }

    /* ---------------- WebView ---------------- */

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb(url: String) {
        destroyWeb()
        server = url
        val host = Uri.parse(url).host

        val wv = WebView(this)
        wv.setBackgroundColor(Color.BLACK)
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true
        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            userAgentString = "$userAgentString WatchpartyTV/${BuildConfigCompat.versionName(this@MainActivity)}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        wv.addJavascriptInterface(Bridge(), "WatchpartyTV")

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == host) return false
                Toast.makeText(this@MainActivity, R.string.external_blocked, Toast.LENGTH_SHORT).show()
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                val msg = error.description?.toString() ?: "Fehler ${error.errorCode}"
                // Nicht mitten im Callback der WebView zerstören
                window.decorView.post { if (web === view) showError(msg) }
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            // Echtes Vollbild (falls die Seite es anfordert)
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return }
                fullscreenView = view
                fullscreenCallback = callback
                root?.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                web?.visibility = View.GONE
            }

            override fun onHideCustomView() { leaveFullscreen() }

            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
        }

        val frame = FrameLayout(this)
        frame.setBackgroundColor(Color.BLACK)
        frame.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(frame)
        root = frame
        web = wv
        wv.loadUrl(url)
        wv.requestFocus()
    }

    private fun leaveFullscreen() {
        val v = fullscreenView ?: return
        root?.removeView(v)
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        web?.visibility = View.VISIBLE
        web?.requestFocus()
    }

    private fun destroyWeb() {
        leaveFullscreen()
        web?.let {
            it.stopLoading()
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        web = null
        root = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /* ---------------- Tasten ---------------- */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val wv = web ?: return super.dispatchKeyEvent(event)
        val js = when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_HEADSETHOOK -> "window.wpTv&&wpTv.media('playpause')"
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_NEXT -> "window.wpTv&&wpTv.media('ff')"
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "window.wpTv&&wpTv.media('rew')"
            KeyEvent.KEYCODE_MENU -> "window.wpTv&&wpTv.menu()"
            KeyEvent.KEYCODE_BACK -> {
                if (event.action == KeyEvent.ACTION_UP) onBackKey(wv)
                return true
            }
            else -> return super.dispatchKeyEvent(event)
        }
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) wv.evaluateJavascript(js, null)
        return true
    }

    private fun onBackKey(wv: WebView) {
        if (fullscreenView != null) { leaveFullscreen(); return }
        wv.evaluateJavascript("(window.wpTv&&window.wpTv.back())?1:0") { result ->
            when {
                result == "1" -> Unit
                wv.canGoBack() -> wv.goBack()
                System.currentTimeMillis() - lastBack < 2000 -> finish()
                else -> {
                    lastBack = System.currentTimeMillis()
                    Toast.makeText(this, R.string.exit_again, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    /* ---------------- Lebenszyklus ---------------- */

    override fun onPause() {
        super.onPause()
        web?.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
    }

    override fun onDestroy() {
        destroyWeb()
        super.onDestroy()
    }

    /* ---------------- Brücke für tv.js ---------------- */

    inner class Bridge {
        /** Bildschirmschoner aus, solange ein Video läuft. */
        @JavascriptInterface
        fun keepAwake(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        @JavascriptInterface
        fun changeServer() { runOnUiThread { showSetup(null) } }

        @JavascriptInterface
        fun version(): String = BuildConfigCompat.versionName(this@MainActivity)
    }

    companion object {
        private const val KEY_SERVER = "server"

        /** „example.com“, „https://example.com/“ oder „192.168.1.5:8097“ → Basis-URL, sonst null. */
        fun normalize(input: String): String? {
            var s = input.trim().trimEnd('/')
            if (s.isEmpty() || s.contains(' ')) return null
            if (!s.startsWith("http://", true) && !s.startsWith("https://", true)) {
                // Lokale Adressen ohne TLS, alles andere über HTTPS
                val local = Regex("^(localhost|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)").containsMatchIn(s)
                s = (if (local) "http://" else "https://") + s
            }
            val uri = Uri.parse(s)
            val host = uri.host ?: return null
            if (!host.contains('.') && host != "localhost") return null
            val port = if (uri.port > 0) ":${uri.port}" else ""
            return "${uri.scheme!!.lowercase()}://${host.lowercase()}$port"
        }
    }
}

/** Versionsname ohne BuildConfig (die ist bei neueren AGP-Versionen standardmäßig aus). */
object BuildConfigCompat {
    fun versionName(a: Activity): String = try {
        a.packageManager.getPackageInfo(a.packageName, 0).versionName ?: "1"
    } catch (e: Exception) { "1" }
}
