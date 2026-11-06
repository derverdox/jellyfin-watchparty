package de.watchparty.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.request.ImageRequest
import de.watchparty.tv.data.Api
import de.watchparty.tv.data.MediaItem

val LocalImages = compositionLocalOf<ImageLoader> { error("ImageLoader fehlt") }
val LocalApi = compositionLocalOf<Api> { error("Api fehlt") }

/** Bild vom Relay (mit Sitzung) oder von außen (YouTube/Twitch) */
@Composable
fun Img(url: String?, modifier: Modifier = Modifier, scale: ContentScale = ContentScale.Crop, widthPx: Int = 0) {
    if (url == null) return
    val ctx = LocalContext.current
    val req = ImageRequest.Builder(ctx).data(url).crossfade(150).apply { if (widthPx > 0) size(widthPx, (widthPx * 1.5).toInt()) }.build()
    AsyncImage(model = req, contentDescription = null, imageLoader = LocalImages.current, modifier = modifier, contentScale = scale)
}

/** Hochformat-Kachel (Film/Serie) */
@Composable
fun PosterCard(item: MediaItem, onClick: () -> Unit, width: Dp = 132.dp, requester: FocusRequester? = null, onFocus: (() -> Unit)? = null) {
    val api = LocalApi.current
    Column(Modifier.width(width)) {
        Focusable(onClick, Modifier.fillMaxWidth().aspectRatio(2f / 3f), RoundedCornerShape(10.dp), 1.08f, requester, onFocus, background = C.surface2) {
            Box(Modifier.fillMaxSize()) {
                T(item.name, Modifier.align(Alignment.Center).padding(8.dp), size = 13.sp, color = C.muted, maxLines = 3)
                if (item.hasImage || item.isEpisode) Img(api.img(item.posterId, 300), Modifier.fillMaxSize(), widthPx = 300)
                if (item.progress > 1) ProgressLine((item.progress / 100).toFloat(), Modifier.align(Alignment.BottomCenter).padding(6.dp))
                if (item.watched) T("✓", Modifier.align(Alignment.TopEnd).padding(6.dp).clip(RoundedCornerShape(99.dp)).background(C.accent).padding(horizontal = 7.dp, vertical = 1.dp),
                    size = 13.sp, color = C.accentInk, weight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.height(6.dp))
        T(item.name, size = 13.sp, color = C.muted, maxLines = 1)
    }
}

/** Breite Kachel (Folgen, Weiterschauen, Freunde) */
@Composable
fun WideCard(
    title: String, subtitle: String?, image: String?, onClick: () -> Unit, width: Dp = 260.dp, progress: Double = 0.0,
    badge: String? = null, badgeColor: Color = C.accent, requester: FocusRequester? = null, onFocus: (() -> Unit)? = null,
) {
    Column(Modifier.width(width)) {
        Focusable(onClick, Modifier.fillMaxWidth().aspectRatio(16f / 9f), RoundedCornerShape(10.dp), 1.06f, requester, onFocus, background = C.surface2) {
            Box(Modifier.fillMaxSize()) {
                T(title, Modifier.align(Alignment.Center).padding(10.dp), size = 14.sp, color = C.muted, maxLines = 2)
                Img(image, Modifier.fillMaxSize(), widthPx = 480)
                if (progress > 1) ProgressLine((progress / 100).toFloat(), Modifier.align(Alignment.BottomCenter).padding(8.dp))
                if (badge != null) T(badge, Modifier.align(Alignment.TopStart).padding(8.dp).clip(RoundedCornerShape(6.dp)).background(badgeColor).padding(horizontal = 7.dp, vertical = 2.dp),
                    size = 12.sp, weight = FontWeight.Bold, color = if (badgeColor == C.accent) C.accentInk else Color.White)
            }
        }
        Spacer(Modifier.height(6.dp))
        T(title, size = 14.sp, weight = FontWeight.SemiBold, maxLines = 1)
        if (!subtitle.isNullOrBlank()) T(subtitle, size = 12.sp, color = C.muted, maxLines = 1)
    }
}

/** Eine Reihe mit Überschrift */
@Composable
fun <E> CardRow(
    title: String, list: List<E>, state: LazyListState, key: (E) -> String,
    content: @Composable (E) -> Unit,
) {
    if (list.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(bottom = 18.dp)) {
        T(title, Modifier.padding(start = 4.dp, bottom = 10.dp), size = 19.sp, weight = FontWeight.Bold)
        LazyRow(state = state, contentPadding = PaddingValues(horizontal = 6.dp, vertical = 8.dp), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(16.dp)) {
            items(list, key = key) { content(it) }
        }
    }
}
