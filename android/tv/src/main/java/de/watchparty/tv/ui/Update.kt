package de.watchparty.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.activity.compose.BackHandler
import de.watchparty.tv.AppState
import de.watchparty.tv.update.UpdateInfo
import de.watchparty.tv.update.UpdateState

/** „Neue Version verfügbar“ – Installieren oder später */
@Composable
fun UpdateDialog(app: AppState, info: UpdateInfo) {
    val first = remember { FocusRequester() }
    AutoFocus(first, key = info.versionCode)
    BackHandler { app.updatePrompt = null }
    Box(Modifier.fillMaxSize().background(Color(0x99000000)), contentAlignment = Alignment.Center) {
        Column(Modifier.trapFocus().width(600.dp).clip(RoundedCornerShape(18.dp)).background(C.surface).border(1.dp, C.line, RoundedCornerShape(18.dp)).padding(30.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            T("⟳ Neue Version verfügbar", size = 24.sp, weight = FontWeight.Bold)
            T("Watchparty TV ${info.versionName} ist da (du hast ${app.version}). Das Update dauert etwa eine Minute; Android fragt einmal, ob es installieren darf.", size = 16.sp, color = C.muted)
            ButtonRow {
                Btn("Jetzt installieren", { app.installUpdate(info) }, primary = true, requester = first)
                Btn("Später", { app.updatePrompt = null })
                Btn("Diese Version überspringen", { app.skipUpdate(info) })
            }
        }
    }
}

/** Kleiner Hinweis unten rechts, solange geladen/installiert wird oder etwas schiefging */
@Composable
fun UpdateProgress(app: AppState, modifier: Modifier) {
    val st by app.updater.state.collectAsState()
    val text = when (val s = st) {
        is UpdateState.Downloading -> "⟳ Update ${s.info.versionName} lädt … ${s.percent} %"
        is UpdateState.Installing -> "⟳ Update ${s.info.versionName} wird installiert …"
        is UpdateState.Failed -> if (s.info != null) "⚠ ${s.message}" else null
        else -> null
    } ?: return
    val bad = st is UpdateState.Failed
    T(text, modifier.padding(28.dp).width(520.dp).clip(RoundedCornerShape(12.dp)).background(if (bad) C.danger else Color(0xF21E1E28)).padding(horizontal = 18.dp, vertical = 12.dp),
        size = 15.sp, color = if (bad) Color.Black else C.text, weight = FontWeight.SemiBold)
}
