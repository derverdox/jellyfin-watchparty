package de.watchparty.tv.update

import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import de.watchparty.tv.data.Api
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Neueste Version laut CI (android-latest/watchparty-tv.json) */
data class UpdateInfo(val versionCode: Long, val versionName: String, val sha256: String?, val size: Long)

sealed class UpdateState {
    data object Idle : UpdateState()
    data object Checking : UpdateState()
    data object Latest : UpdateState()
    data class Available(val info: UpdateInfo) : UpdateState()
    data class Downloading(val info: UpdateInfo, val percent: Int) : UpdateState()
    data class Installing(val info: UpdateInfo) : UpdateState()
    data class Failed(val message: String, val info: UpdateInfo? = null) : UpdateState()
}

/**
 * Updates der TV-App: Das CI legt neben watchparty-tv.apk eine kleine JSON mit Build-Nummer und
 * Prüfsumme ab. Das Relay leitet /tv.json und /tv.apk dorthin weiter. Die App lädt das APK,
 * prüft es und übergibt es dem Android-Paketinstaller (der fragt einmal nach).
 */
class Updater(private val ctx: Context, private val api: Api) {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state = _state.asStateFlow()

    val currentCode: Long = try {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong()
    } catch (_: Exception) { 0L }

    init { instance = this }

    /** Gibt es etwas Neueres? (still, Fehler landen nur im Zustand) */
    suspend fun check(): UpdateInfo? {
        val s = _state.value
        if (s is UpdateState.Downloading || s is UpdateState.Installing) return null
        _state.value = UpdateState.Checking
        return try {
            val j = withContext(Dispatchers.IO) {
                api.http.newCall(Request.Builder().url("${api.base}/tv.json").build()).execute().use { r ->
                    if (!r.isSuccessful) throw IllegalStateException("Update-Info nicht erreichbar (${r.code})")
                    JSONObject(r.body?.string() ?: "{}")
                }
            }
            val info = UpdateInfo(j.optLong("versionCode"), j.optString("versionName"), j.optString("sha256").takeIf { it.length == 64 }, j.optLong("size"))
            if (info.versionCode > currentCode) { _state.value = UpdateState.Available(info); info } else { _state.value = UpdateState.Latest; null }
        } catch (e: Exception) {
            _state.value = UpdateState.Failed(e.message ?: "Update-Prüfung fehlgeschlagen")
            null
        }
    }

    /** Laden, prüfen, installieren */
    suspend fun install(info: UpdateInfo) {
        // Android 8+: Die App muss Apps installieren dürfen (einmal in den Einstellungen erlauben)
        if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) {
            _state.value = UpdateState.Failed("Erlaube „Watchparty TV“ einmal, Apps zu installieren – gleich öffnen sich die Einstellungen. Danach nochmal „Update installieren“.", info)
            try {
                ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: ActivityNotFoundException) {
                _state.value = UpdateState.Failed("Auf dem Fire TV: Einstellungen → Mein Fire TV → Entwickleroptionen → Apps unbekannter Herkunft → „Watchparty TV“ an. Danach nochmal versuchen.", info)
            }
            return
        }
        try {
            val file = download(info)
            _state.value = UpdateState.Installing(info)
            withContext(Dispatchers.IO) { commit(file) }
        } catch (e: Exception) {
            _state.value = UpdateState.Failed(e.message ?: "Update fehlgeschlagen", info)
        }
    }

    private suspend fun download(info: UpdateInfo): File = withContext(Dispatchers.IO) {
        val dir = File(ctx.cacheDir, "update").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "watchparty-tv-${info.versionCode}.apk")
        val md = MessageDigest.getInstance("SHA-256")
        api.http.newCall(Request.Builder().url("${api.base}/tv.apk").build()).execute().use { r ->
            if (!r.isSuccessful) throw IllegalStateException("Download fehlgeschlagen (${r.code})")
            val body = r.body ?: throw IllegalStateException("Leerer Download")
            val total = body.contentLength().takeIf { it > 0 } ?: info.size
            var done = 0L
            var lastPct = -1
            body.byteStream().use { input ->
                file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        done += n
                        val pct = if (total > 0) ((done * 100) / total).toInt() else 0
                        if (pct != lastPct) { lastPct = pct; _state.value = UpdateState.Downloading(info, pct) }
                    }
                }
            }
        }
        val hex = md.digest().joinToString("") { "%02x".format(it) }
        if (info.sha256 != null && hex != info.sha256) {
            file.delete()
            throw IllegalStateException("Prüfsumme stimmt nicht – das neue APK wird gerade erst hochgeladen. In ein paar Minuten nochmal.")
        }
        file
    }

    private fun commit(file: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            file.inputStream().use { input ->
                s.openWrite("watchparty-tv.apk", 0, file.length()).use { out ->
                    input.copyTo(out)
                    s.fsync(out)
                }
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pending = PendingIntent.getBroadcast(ctx, id, Intent(ctx, InstallReceiver::class.java), flags)
            s.commit(pending.intentSender)
        }
    }

    internal fun onResult(status: Int, message: String?) {
        val info = (_state.value as? UpdateState.Installing)?.info
        _state.value = when (status) {
            PackageInstaller.STATUS_SUCCESS -> UpdateState.Latest // die App wird gleich neu gestartet
            PackageInstaller.STATUS_FAILURE_ABORTED -> UpdateState.Failed("Installation abgebrochen.", info)
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                UpdateState.Failed("Das Update passt nicht zur installierten App (anderer Signierschlüssel). Einmal deinstallieren und über /tv neu installieren – danach klappen Updates.", info)
            PackageInstaller.STATUS_FAILURE_STORAGE -> UpdateState.Failed("Zu wenig Speicher für das Update.", info)
            else -> UpdateState.Failed("Installation fehlgeschlagen${message?.let { ": $it" } ?: ""}", info)
        }
    }

    companion object {
        @Volatile internal var instance: Updater? = null
    }
}

/** Rückmeldung des Paketinstallers: Bestätigungsdialog zeigen bzw. Ergebnis melden */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try { context.startActivity(confirm) } catch (_: Exception) { Updater.instance?.onResult(PackageInstaller.STATUS_FAILURE, "Installer ließ sich nicht öffnen") }
            }
            return
        }
        Updater.instance?.onResult(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
    }
}
