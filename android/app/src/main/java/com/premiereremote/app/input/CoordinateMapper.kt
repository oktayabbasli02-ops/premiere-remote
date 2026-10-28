package com.premiereremote.app.input

import kotlin.math.max
import kotlin.math.min

/**
 * Same math as shared/src/mapping.js (the tested reference).
 * Display transform: screen = base * scale + pan, applied about the container origin.
 */
data class ViewState(
    val viewW: Float, val viewH: Float,
    val frameW: Float, val frameH: Float,
    val scale: Float = 1f, val panX: Float = 0f, val panY: Float = 0f,
)

data class RectF4(val x: Float, val y: Float, val w: Float, val h: Float)
data class NPoint(val x: Float, val y: Float)

object CoordinateMapper {
    fun fitRect(viewW: Float, viewH: Float, frameW: Float, frameH: Float): RectF4? {
        if (viewW <= 0 || viewH <= 0 || frameW <= 0 || frameH <= 0) return null
        val s = min(viewW / frameW, viewH / frameH)
        val w = frameW * s
        val h = frameH * s
        return RectF4((viewW - w) / 2f, (viewH - h) / 2f, w, h)
    }

    /** Touch point in container coordinates -> normalized frame coordinates, or null in the letterbox. */
    fun viewToNormalized(px: Float, py: Float, v: ViewState): NPoint? {
        val base = fitRect(v.viewW, v.viewH, v.frameW, v.frameH) ?: return null
        val qx = (px - v.panX) / v.scale
        val qy = (py - v.panY) / v.scale
        val nx = (qx - base.x) / base.w
        val ny = (qy - base.y) / base.h
        if (nx < 0f || nx > 1f || ny < 0f || ny > 1f) return null
        return NPoint(nx, ny)
    }

    fun clampPan(v: ViewState): ViewState {
        val scale = max(1f, min(v.scale, 8f))
        val base = fitRect(v.viewW, v.viewH, v.frameW, v.frameH) ?: return v.copy(scale = scale, panX = 0f, panY = 0f)
        fun axis(pan: Float, viewLen: Float, start: Float, len: Float): Float {
            val cs = start * scale
            val cl = len * scale
            if (cl <= viewLen) return (viewLen - cl) / 2f - cs
            val lo = viewLen - (cs + cl)
            val hi = -cs
            return min(hi, max(lo, pan))
        }
        return v.copy(scale = scale, panX = axis(v.panX, v.viewW, base.x, base.w) + 0f, panY = axis(v.panY, v.viewH, base.y, base.h) + 0f)
    }
}
