package com.premiereremote.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/**
 * Jog wheel: rotating clockwise steps forward. Frames are accumulated and flushed every 80 ms as a
 * single stepFrames command, so a fast spin never floods the PC with stale per-frame events.
 */
@Composable
fun JogWheel(size: Dp, precision: Boolean, enabled: Boolean, onFrames: (Int) -> Unit) {
    val state = remember { object { var lastAngle: Float? = null; var accDeg = 0f; var pending = 0 } }
    var angle by remember { mutableFloatStateOf(0f) }
    val degPerFrame = if (precision) 30f else 8f

    LaunchedEffect(Unit) {
        while (true) {
            delay(80)
            val n = state.pending
            if (n != 0) {
                state.pending = 0
                onFrames(n.coerceIn(-600, 600))
            }
        }
    }

    Canvas(
        Modifier
            .size(size)
            .pointerInput(enabled, precision) {
                if (!enabled) return@pointerInput
                detectDragGestures(
                    onDragStart = { state.lastAngle = null },
                    onDragEnd = { state.lastAngle = null },
                ) { change, _ ->
                    val c = Offset(this.size.width / 2f, this.size.height / 2f)
                    val p = change.position - c
                    val a = (atan2(p.y, p.x) * 180f / PI.toFloat())
                    val last = state.lastAngle
                    if (last != null) {
                        var d = a - last
                        if (d > 180) d -= 360
                        if (d < -180) d += 360
                        angle += d
                        state.accDeg += d
                        val frames = (state.accDeg / degPerFrame).toInt()
                        if (frames != 0) {
                            state.pending += frames
                            state.accDeg -= frames * degPerFrame
                        }
                    }
                    state.lastAngle = a
                    change.consume()
                }
            },
    ) {
        val r = this.size.minDimension / 2f
        drawCircle(Color(0xFF2A2A30), r)
        drawCircle(if (precision) Color(0xFFFFB547) else Color(0xFF8B80FF), r - 6f, style = Stroke(width = 6f))
        for (i in 0 until 24) {
            val t = (angle + i * 15f) * PI.toFloat() / 180f
            drawLine(
                Color(0xFF6B6B70),
                Offset(center.x + cos(t) * (r - 30f), center.y + sin(t) * (r - 30f)),
                Offset(center.x + cos(t) * (r - 14f), center.y + sin(t) * (r - 14f)),
                strokeWidth = 3f,
            )
        }
        drawCircle(Color(0xFF444450), r * 0.28f)
    }
}
