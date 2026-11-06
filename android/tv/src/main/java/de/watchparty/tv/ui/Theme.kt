package de.watchparty.tv.ui

import android.graphics.Bitmap
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.delay

object C {
    val bg = Color(0xFF0B0B0F)
    val surface = Color(0xFF15151C)
    val surface2 = Color(0xFF1E1E28)
    val line = Color(0xFF2A2A35)
    val text = Color(0xFFFFFFFF)
    val muted = Color(0xFF9A9AA8)
    val accent = Color(0xFFF2B544)
    val accentInk = Color(0xFF1A1408)
    val danger = Color(0xFFFF6B6B)
    val ok = Color(0xFF4ADE80)
    val twitch = Color(0xFF9146FF)
    val youtube = Color(0xFFFF0033)
}

/** Text ohne Material: schlicht und schnell */
@Composable
fun T(
    text: String, modifier: Modifier = Modifier, size: TextUnit = 16.sp, color: Color = C.text,
    weight: FontWeight = FontWeight.Normal, maxLines: Int = Int.MAX_VALUE, align: TextAlign = TextAlign.Start,
) {
    BasicText(text, modifier, style = TextStyle(color = color, fontSize = size, fontWeight = weight, textAlign = align, lineHeight = size * 1.3f),
        maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

/**
 * Fokussierbares Element: heller Rahmen + leicht größer, wenn die Fernbedienung darauf steht.
 * OK/Enter löst onClick aus (macht Compose für clickable von selbst).
 */
@Composable
fun Focusable(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    shape: RoundedCornerShape = RoundedCornerShape(10.dp),
    focusedScale: Float = 1.05f,
    requester: FocusRequester? = null,
    onFocus: (() -> Unit)? = null,
    enabled: Boolean = true,
    background: Color = Color.Transparent,
    focusedBackground: Color = background,
    content: @Composable (focused: Boolean) -> Unit,
) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val scale by animateFloatAsState(if (focused) focusedScale else 1f, tween(120), label = "scale")
    val onFocusNow by rememberUpdatedState(onFocus)
    LaunchedEffect(focused) { if (focused) onFocusNow?.invoke() }
    Box(
        modifier
            .then(if (requester != null) Modifier.focusRequester(requester) else Modifier)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(shape)
            .background(if (focused) focusedBackground else background)
            .border(if (focused) 3.dp else 0.dp, if (focused) C.text else Color.Transparent, shape)
            .clickable(interactionSource = src, indication = null, enabled = enabled, onClick = onClick),
    ) { content(focused) }
}

/** Knopf: gelb = Hauptaktion, sonst dunkel; fokussiert immer weiß hinterlegt (gut lesbar auf dem Sofa) */
@Composable
fun Btn(
    text: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = false,
    requester: FocusRequester? = null, enabled: Boolean = true, small: Boolean = false, onFocus: (() -> Unit)? = null,
) {
    Focusable(onClick, modifier, RoundedCornerShape(if (small) 8.dp else 12.dp), 1.06f, requester, onFocus, enabled,
        background = if (primary) C.accent else C.surface2, focusedBackground = C.text) { f ->
        Box(Modifier.padding(horizontal = if (small) 14.dp else 22.dp, vertical = if (small) 7.dp else 11.dp), contentAlignment = Alignment.Center) {
            T(text, size = if (small) 14.sp else 17.sp, weight = FontWeight.SemiBold, maxLines = 1,
                color = when { f -> C.bg; primary -> C.accentInk; !enabled -> C.muted; else -> C.text })
        }
    }
}

@Composable
fun ButtonRow(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically, content = content)
}

/**
 * Textfeld für die Fernbedienung: Beim Drüberfahren passiert nichts (keine Tastatur, keine
 * gefangenen Pfeiltasten). Erst OK öffnet die Bildschirmtastatur; „Fertig“ oder Zurück schließt sie.
 */
@Composable
fun TvField(
    value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier,
    password: Boolean = false, url: Boolean = false, requester: FocusRequester? = null, onSubmit: () -> Unit = {},
) {
    var editing by remember { mutableStateOf(false) }
    var wasEditing by remember { mutableStateOf(false) }
    var hadFocus by remember { mutableStateOf(false) } // pro Eingabe: erst schließen, nachdem das Feld wirklich Fokus hatte
    val inner = remember { FocusRequester() }
    val own = remember { FocusRequester() }
    val outer = requester ?: own
    val keyboard = LocalSoftwareKeyboardController.current
    val shown = if (password) "•".repeat(value.length) else value
    LaunchedEffect(editing) {
        if (editing) {
            wasEditing = true
            hadFocus = false
            delay(40)
            runCatching { inner.requestFocus() }
            keyboard?.show()
        } else if (wasEditing) {
            delay(40)
            runCatching { outer.requestFocus() }
        }
    }
    Box(modifier) {
        if (!editing) {
            Focusable({ editing = true }, Modifier.fillMaxWidth(), RoundedCornerShape(12.dp), 1.02f, outer, background = C.surface2, focusedBackground = C.surface2) { f ->
                Box(Modifier.fillMaxWidth().border(3.dp, if (f) C.accent else C.line, RoundedCornerShape(12.dp)).padding(horizontal = 18.dp, vertical = 14.dp)) {
                    if (value.isEmpty()) T(placeholder, color = C.muted, size = 19.sp, maxLines = 1) else T(shown, size = 19.sp, maxLines = 1)
                }
            }
        } else {
            BasicTextField(
                value = value, onValueChange = onChange, singleLine = true,
                textStyle = TextStyle(color = C.text, fontSize = 19.sp),
                cursorBrush = SolidColor(C.accent),
                visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(
                    keyboardType = when { password -> KeyboardType.Password; url -> KeyboardType.Uri; else -> KeyboardType.Text },
                    imeAction = ImeAction.Done, autoCorrectEnabled = false,
                ),
                keyboardActions = KeyboardActions(onDone = { editing = false; keyboard?.hide(); onSubmit() }),
                modifier = Modifier.fillMaxWidth().focusRequester(inner)
                    .onFocusChanged { if (it.isFocused) hadFocus = true else if (editing && hadFocus) editing = false },
                decorationBox = { innerField ->
                    Box(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.surface2)
                            .border(3.dp, C.accent, RoundedCornerShape(12.dp)).padding(horizontal = 18.dp, vertical = 14.dp),
                    ) {
                        if (value.isEmpty()) T(placeholder, color = C.muted, size = 19.sp, maxLines = 1)
                        innerField()
                    }
                },
            )
        }
    }
}

/** Fortschrittsbalken (z. B. „Weiterschauen“) */
@Composable
fun ProgressLine(fraction: Float, modifier: Modifier = Modifier, height: Dp = 4.dp, color: Color = C.accent) {
    Box(modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(height)).background(Color(0x55FFFFFF))) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(height).background(color))
    }
}

/** Abdunkeln von unten bzw. links für Text auf Bildern */
val bottomShade = Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000), Color(0xF2000000)))
val leftShade = Brush.horizontalGradient(listOf(Color(0xF20B0B0F), Color(0xB30B0B0F), Color.Transparent))
val topShade = Brush.verticalGradient(listOf(Color(0xCC000000), Color.Transparent))

/**
 * TV-Scrollen: Die fokussierte Kachel bleibt an einer festen Stelle (wie bei Netflix),
 * statt am Rand „anzustoßen“. Gilt für alle Listen darunter.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PivotScroll(fraction: Float = 0.12f, content: @Composable () -> Unit) {
    val spec = remember(fraction) {
        object : BringIntoViewSpec {
            override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
                val target = containerSize * fraction
                // Element größer als der Platz: vorne ausrichten
                if (size >= containerSize) return offset
                return offset - target
            }
        }
    }
    CompositionLocalProvider(LocalBringIntoViewSpec provides spec, content = content)
}

/** QR-Code als Bild */
@Composable
fun Qr(text: String, modifier: Modifier = Modifier, sizeDp: Dp = 220.dp) {
    val bmp = remember(text) {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 512, 512, mapOf(EncodeHintType.MARGIN to 1))
        val b = Bitmap.createBitmap(m.width, m.height, Bitmap.Config.RGB_565)
        for (x in 0 until m.width) for (y in 0 until m.height) b.setPixel(x, y, if (m.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
        b.asImageBitmap()
    }
    Image(bmp, "QR-Code", modifier.size(sizeDp).clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Fit)
}

/** Fokus nach dem Aufbau setzen (requestFocus wirft, solange das Element noch nicht da ist) */
@Composable
fun AutoFocus(requester: FocusRequester, key: Any? = Unit, delayMs: Long = 80) {
    LaunchedEffect(key) {
        // bis zu ~3 s probieren: Inhalte (z. B. Details) kommen erst aus dem Netz
        repeat(36) {
            delay(delayMs)
            if (runCatching { requester.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }
}

fun fmtTime(sec: Double): String {
    if (sec.isNaN() || sec < 0) return "0:00"
    val s = sec.toLong()
    val h = s / 3600; val m = (s % 3600) / 60; val r = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, r) else "%d:%02d".format(m, r)
}

fun fmtRuntime(sec: Double?): String? {
    if (sec == null || sec <= 0) return null
    val m = (sec / 60).toInt()
    return if (m >= 60) "${m / 60} Std. ${m % 60} Min." else "$m Min."
}
