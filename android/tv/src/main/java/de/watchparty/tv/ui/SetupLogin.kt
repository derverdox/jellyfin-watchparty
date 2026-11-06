package de.watchparty.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import de.watchparty.tv.AppState
import de.watchparty.tv.Screen
import de.watchparty.tv.data.Api
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
private fun Brand() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.clip(RoundedCornerShape(12.dp)).background(C.accent).padding(horizontal = 14.dp, vertical = 6.dp)) {
            T("▶", size = 24.sp, color = C.accentInk, weight = FontWeight.Bold)
        }
        Spacer(Modifier.width(14.dp))
        T("Watchparty", size = 34.sp, weight = FontWeight.Bold)
    }
}

/** Erster Start: Adresse des eigenen Servers */
@Composable
fun SetupScreen(app: AppState) {
    var server by remember { mutableStateOf(app.prefs.server.removePrefix("https://")) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val field = remember { FocusRequester() }
    AutoFocus(field)

    fun connect() {
        if (busy) return
        val url = try { Api.normalizeServer(server) } catch (e: Exception) { error = e.message; return }
        busy = true; error = null
        scope.launch {
            val old = app.prefs.server
            app.prefs.server = url
            try {
                // Erreichbar? (/healthz braucht keine Anmeldung)
                app.api.get("/healthz")
                if (old != url) app.prefs.sid = null
                app.boot()
            } catch (e: Exception) {
                app.prefs.server = old
                error = "Unter $url antwortet keine Watchparty (${e.message})."
            } finally { busy = false }
        }
    }

    Box(Modifier.fillMaxSize().background(C.bg), contentAlignment = Alignment.Center) {
        Column(Modifier.width(560.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Brand()
            T("Gib die Adresse eures Watchparty-Servers ein – dieselbe wie im Browser.", size = 18.sp, color = C.muted)
            TvField(server, { server = it }, "z. B. watchparty.example.com", url = true, requester = field, onSubmit = ::connect)
            if (error != null) T(error!!, color = C.danger, size = 16.sp)
            ButtonRow { Btn(if (busy) "Verbinde …" else "Verbinden", ::connect, primary = true, enabled = !busy) }
        }
    }
}

/**
 * Anmelden: QR-Code mit dem Handy scannen (dort ist man schon angemeldet) – kein Tippen mit der Fernbedienung.
 * Benutzername/Passwort geht als Ausweg auch.
 */
@Composable
fun LoginScreen(app: AppState) {
    var code by remember { mutableStateOf<String?>(null) }
    var qr by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf("QR-Code wird erstellt …") }
    var withPassword by remember { mutableStateOf(false) }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var round by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    val first = remember { FocusRequester() }
    AutoFocus(first, withPassword)

    // QR-Code holen und alle 2 s fragen, ob das Handy bestätigt hat
    LaunchedEffect(round) {
        try {
            val r = app.api.pairStart()
            val token = r.getString("token")
            code = r.getString("code")
            qr = app.api.base + r.getString("path")
            status = "Warte auf dein Handy …"
            val until = System.currentTimeMillis() + r.optLong("expiresIn", 300) * 1000
            while (System.currentTimeMillis() < until) {
                delay(2000)
                val p = try { app.api.pairPoll(token) } catch (_: Exception) { continue }
                when (p.optString("state")) {
                    "ok" -> { app.loggedIn(p.getJSONObject("me")); return@LaunchedEffect }
                    "approved" -> status = "Bestätigt – melde an …"
                    "denied" -> { status = "Abgelehnt. Neuer Code …"; delay(1500); round++; return@LaunchedEffect }
                    "expired" -> { round++; return@LaunchedEffect }
                }
            }
            round++
        } catch (e: Exception) {
            status = "QR-Anmeldung geht gerade nicht: ${e.message}"
        }
    }

    fun login() {
        error = null
        scope.launch {
            try { app.loggedIn(app.api.login(user.trim(), pass)) } catch (e: Exception) { error = e.message }
        }
    }

    Box(Modifier.fillMaxSize().background(C.bg), contentAlignment = Alignment.Center) {
        Row(horizontalArrangement = Arrangement.spacedBy(64.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.width(420.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Brand()
                T(app.api.base.removePrefix("https://"), color = C.muted, size = 15.sp)
                Spacer(Modifier.height(8.dp))
                if (!withPassword) {
                    T("Mit dem Handy anmelden", size = 24.sp, weight = FontWeight.Bold)
                    T("1. Am Handy die Watchparty öffnen (angemeldet)\n2. „📷 Gerät anmelden“ und den Code scannen\n   – oder den Code dort eintippen", size = 17.sp, color = C.muted)
                    ButtonRow {
                        Btn("Mit Passwort anmelden", { withPassword = true }, requester = first)
                        Btn("Server ändern", { app.replace(Screen.Setup) })
                    }
                } else {
                    T("Anmelden", size = 24.sp, weight = FontWeight.Bold)
                    TvField(user, { user = it }, "Benutzername", requester = first)
                    TvField(pass, { pass = it }, "Passwort", password = true, onSubmit = ::login)
                    if (error != null) T(error!!, color = C.danger)
                    ButtonRow {
                        Btn("Anmelden", ::login, primary = true)
                        Btn("Zurück zum QR-Code", { withPassword = false })
                    }
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                val q = qr
                if (q != null) Qr(q, sizeDp = 260.dp) else Box(Modifier.width(260.dp).height(260.dp).clip(RoundedCornerShape(12.dp)).background(C.surface2))
                code?.let { T("${it.take(4)} ${it.drop(4)}", size = 34.sp, weight = FontWeight.Bold) }
                T(status, size = 15.sp, color = C.muted)
            }
        }
    }
}
