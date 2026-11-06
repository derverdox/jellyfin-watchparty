package de.watchparty.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import android.app.UiModeManager
import android.content.SharedPreferences
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
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
 * Watchparty für Fire TV / Android TV, Handy und Tablet (eine App für alles).
 *
 * Lädt die Watchparty-Website in einer WebView. Die Seite erkennt die App am User-Agent:
 *  - „WatchpartyTV“ auf Fernsehern → TV-Modus (Steuerung per Fernbedienung, tv.js)
 *  - „WatchpartyApp“ auf Handy/Tablet → normale Touch-Oberfläche, Zurück-Taste schließt Fenster
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
    private var isTv = false
    private var pendingCamera: PermissionRequest? = null
    private var videoPlaying = false
    private var videoAspect = Rational(16, 9)
    private var pipReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isTv = detectTv()
        if (isTv) {
            window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            window.statusBarColor = Color.parseColor("#0B0B0F")
            window.navigationBarColor = Color.parseColor("#0B0B0F")
        }
        prefs = getSharedPreferences("watchparty", MODE_PRIVATE)
        setupInsets()
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
            val marker = if (isTv) "WatchpartyTV" else "WatchpartyApp"
            userAgentString = "$userAgentString $marker/${BuildConfigCompat.versionName(this@MainActivity)}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        // YouTube/Twitch-Player sind eingebettet: deren Anmeldung (Premium/Turbo = keine Werbung) braucht ihre Cookies
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)
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
                if (!isTv) {
                    // Handy/Tablet: Video im Querformat, ohne Status- und Navigationsleiste
                    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    hideSystemBars(true)
                }
                refreshInsets()
            }

            override fun onHideCustomView() { leaveFullscreen() }

            // Kamera nur für die eigene Seite (QR-Code scannen), alles andere ablehnen
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val own = request.origin?.host == host
                    val camera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    when {
                        !own || !camera -> request.deny()
                        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED ->
                            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                        else -> {
                            pendingCamera?.deny()
                            pendingCamera = request
                            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
                        }
                    }
                }
            }
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
        if (!isTv) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            hideSystemBars(false)
        }
        refreshInsets()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars(on: Boolean) {
        window.decorView.systemUiVisibility = if (on) {
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        } else View.SYSTEM_UI_FLAG_VISIBLE
    }

    private fun detectTv(): Boolean {
        val ui = getSystemService(UI_MODE_SERVICE) as? UiModeManager
        return ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature("amazon.hardware.fire_tv") ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
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

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        val req = pendingCamera ?: return
        pendingCamera = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        else req.deny()
    }

    /* ---------------- Ränder: Statusleiste, Navigationsleiste, Tastatur ---------------- */

    /**
     * Ab Android 15 zeichnen Apps immer randlos, auch unter Status- und Navigationsleiste.
     * Darum hier selbst Abstand lassen (inkl. Tastatur, damit das Chatfeld sichtbar bleibt).
     * Im Video-Vollbild und im kleinen Fenster: kein Abstand.
     */
    private fun setupInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return // ältere Android-Versionen machen das selbst
        val content = findViewById<View>(android.R.id.content)
        content.setOnApplyWindowInsetsListener { v, insets ->
            if (isTv || fullscreenView != null || inPip()) v.setPadding(0, 0, 0, 0)
            else {
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(i.left, i.top, i.right, i.bottom)
            }
            insets
        }
        content.requestApplyInsets()
    }

    private fun refreshInsets() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) findViewById<View>(android.R.id.content)?.requestApplyInsets()
    }

    /* ---------------- Bild im Bild (Handy/Tablet) ---------------- */

    private fun pipSupported() = !isTv && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun pipParams(): PictureInPictureParams {
        val b = PictureInPictureParams.Builder().setAspectRatio(videoAspect)
        // Play/Pause im kleinen Fenster (gilt wie überall für den ganzen Raum)
        val intent = Intent(ACTION_PIP).setPackage(packageName)
        val pi = PendingIntent.getBroadcast(this, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val icon = Icon.createWithResource(this, if (videoPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play)
        val label = if (videoPlaying) "Pause" else "Play"
        b.setActions(listOf(RemoteAction(icon, label, label, pi)))
        // Android 12+: beim Wechsel in eine andere App von selbst ins kleine Fenster
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(videoPlaying).setSeamlessResizeEnabled(true)
        return b.build()
    }

    private fun updatePip() {
        if (!pipSupported()) return
        try { setPictureInPictureParams(pipParams()) } catch (_: Exception) { /* egal */ }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Vor Android 12 muss die App selbst ins kleine Fenster wechseln
        if (pipSupported() && videoPlaying && web != null && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            try { enterPictureInPictureMode(pipParams()) } catch (_: Exception) { /* egal */ }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        web?.evaluateJavascript("window.wpTv&&wpTv.pip&&wpTv.pip(${isInPictureInPictureMode})", null)
        refreshInsets()
        if (isInPictureInPictureMode && pipReceiver == null) {
            val r = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    web?.evaluateJavascript("window.wpTv&&wpTv.media('playpause')", null)
                }
            }
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(r, IntentFilter(ACTION_PIP), Context.RECEIVER_NOT_EXPORTED)
            else registerReceiver(r, IntentFilter(ACTION_PIP))
            pipReceiver = r
        } else if (!isInPictureInPictureMode) {
            pipReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) { } }
            pipReceiver = null
        }
    }

    private fun inPip() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode

    /* ---------------- Lebenszyklus ---------------- */

    override fun onPause() {
        super.onPause()
        // Im kleinen Fenster läuft das Video weiter
        if (!inPip()) web?.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onStop() {
        super.onStop()
        // Kleines Fenster weggewischt oder App wirklich im Hintergrund → lokal anhalten (die anderen schauen weiter)
        web?.onPause()
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
    }

    override fun onDestroy() {
        pipReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) { } }
        pipReceiver = null
        destroyWeb()
        super.onDestroy()
    }

    /* ---------------- Brücke für tv.js ---------------- */

    inner class Bridge {
        /** Bildschirmschoner aus, solange ein Video läuft. */
        @JavascriptInterface
        fun keepAwake(on: Boolean) {
            runOnUiThread {
                videoPlaying = on
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                updatePip()
            }
        }

        /** Seitenverhältnis des Videos fürs kleine Fenster. */
        @JavascriptInterface
        fun videoAspect(w: Int, h: Int) {
            if (w <= 0 || h <= 0) return
            // Android erlaubt nur 1:2,39 bis 2,39:1
            val r = (w.toDouble() / h).coerceIn(0.42, 2.39)
            runOnUiThread { videoAspect = Rational((r * 1000).toInt(), 1000); updatePip() }
        }

        @JavascriptInterface
        fun changeServer() { runOnUiThread { showSetup(null) } }

        @JavascriptInterface
        fun version(): String = BuildConfigCompat.versionName(this@MainActivity)
    }

    companion object {
        private const val KEY_SERVER = "server"
        private const val REQ_CAMERA = 42
        private const val ACTION_PIP = "de.watchparty.app.PIP_PLAYPAUSE"

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
