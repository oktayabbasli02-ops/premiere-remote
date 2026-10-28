package com.premiereremote.app.ui

import android.content.Context
import android.graphics.SurfaceTexture
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.TextureView
import android.view.ViewConfiguration
import android.widget.FrameLayout
import com.premiereremote.app.input.CoordinateMapper
import com.premiereremote.app.input.NPoint
import com.premiereremote.app.input.ViewState
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.util.concurrent.CountDownLatch
import kotlin.math.abs
import kotlin.math.hypot

/** TextureView-backed WebRTC renderer (TextureView, unlike SurfaceView, can be scaled/translated for zoom). */
class RemoteVideoView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener, VideoSink {
    private val renderer = EglRenderer("remote")
    @Volatile private var frameW = 0
    @Volatile private var frameH = 0
    var onFrameSize: ((Int, Int) -> Unit)? = null

    fun init(eglContext: EglBase.Context) {
        renderer.init(eglContext, EglBase.CONFIG_PLAIN, GlRectDrawer())
        surfaceTextureListener = this
    }

    override fun onFrame(frame: VideoFrame) {
        val w = frame.rotatedWidth
        val h = frame.rotatedHeight
        if (w != frameW || h != frameH) {
            frameW = w
            frameH = h
            post { onFrameSize?.invoke(w, h) }
        }
        renderer.onFrame(frame)
    }

    override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) = renderer.createEglSurface(st)
    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {}
    override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
        val latch = CountDownLatch(1)
        renderer.releaseEglSurface { latch.countDown() }
        latch.await()
        return true
    }

    fun release() = renderer.release()
}

interface RemoteInput {
    fun move(p: NPoint)
    fun rel(dx: Float, dy: Float)
    fun pointer(kind: String, p: NPoint?, button: String = "left", dy: Int = 0)
}

/**
 * Container that letterboxes the stream, applies pinch-zoom/pan, and turns touches into remote input.
 *
 * Touch mode (direct):   tap = click at finger · hold = right-click · drag = mouse drag ·
 *                        two fingers = zoom/pan the view (local only)
 * Trackpad mode:         move = relative cursor · tap = click · two-finger tap = right-click ·
 *                        two-finger drag = scroll · hold then move = drag · pinch = zoom view
 */
class RemoteSurface(context: Context) : FrameLayout(context) {
    val video = RemoteVideoView(context)
    var input: RemoteInput? = null
    var trackpad = false
    var enabled2 = true // control permission; false = view-only (gestures only zoom/pan)

    private var frameW = 16f
    private var frameH = 9f
    private var view = ViewState(1f, 1f, 16f, 9f)
    private val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()

    init {
        clipChildren = true
        setBackgroundColor(0xFF000000.toInt())
        addView(video, LayoutParams(1, 1))
        video.onFrameSize = { w, h ->
            frameW = w.toFloat()
            frameH = h.toFloat()
            relayout()
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        relayout() // rotation: normalized coordinates are unaffected; only the fit rect changes
    }

    private fun relayout() {
        if (width == 0 || height == 0) return
        view = CoordinateMapper.clampPan(view.copy(viewW = width.toFloat(), viewH = height.toFloat(), frameW = frameW, frameH = frameH))
        val base = CoordinateMapper.fitRect(width.toFloat(), height.toFloat(), frameW, frameH) ?: return
        val lp = video.layoutParams as LayoutParams
        lp.width = base.w.toInt()
        lp.height = base.h.toInt()
        lp.leftMargin = base.x.toInt()
        lp.topMargin = base.y.toInt()
        video.layoutParams = lp
        applyTransform()
    }

    /** screen = (base + local) * scale + pan  <=> pivot at the container origin, then translate. */
    private fun applyTransform() {
        val base = CoordinateMapper.fitRect(view.viewW, view.viewH, view.frameW, view.frameH) ?: return
        video.pivotX = -base.x
        video.pivotY = -base.y
        video.scaleX = view.scale
        video.scaleY = view.scale
        video.translationX = view.panX
        video.translationY = view.panY
    }

    fun resetZoom() {
        view = CoordinateMapper.clampPan(view.copy(scale = 1f, panX = 0f, panY = 0f))
        applyTransform()
    }

    private fun map(x: Float, y: Float): NPoint? = CoordinateMapper.viewToNormalized(x, y, view)

    // ------------------------------------------------------------------ gestures
    private var multi = false
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var downAt = 0L
    private var dragging = false
    private var longFired = false
    private var twoFingerMoved = false
    private var twoStartX = 0f
    private var twoStartY = 0f
    private var lastTapUp = 0L
    private var scrollAccum = 0f

    private val longPress = Runnable {
        if (multi || dragging) return@Runnable
        longFired = true
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        if (!enabled2) return@Runnable
        if (trackpad) {
            // trackpad: hold arms a drag that starts at the current remote cursor
            dragging = true
            input?.pointer("down", null)
        } else {
            input?.pointer("click", map(downX, downY) ?: return@Runnable, "right")
        }
    }

    private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean {
            val newScale = (view.scale * d.scaleFactor).coerceIn(1f, 8f)
            val f = newScale / view.scale
            // zoom about the focal point
            view = CoordinateMapper.clampPan(
                view.copy(scale = newScale, panX = d.focusX - (d.focusX - view.panX) * f, panY = d.focusY - (d.focusY - view.panY) * f),
            )
            twoFingerMoved = true
            applyTransform()
            return true
        }
    })

    override fun onTouchEvent(e: MotionEvent): Boolean {
        scaler.onTouchEvent(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                multi = false; dragging = false; longFired = false; twoFingerMoved = false
                downX = e.x; downY = e.y; lastX = e.x; lastY = e.y
                downAt = SystemClock.uptimeMillis()
                postDelayed(longPress, if (trackpad) 350L else 550L)
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                removeCallbacks(longPress)
                if (dragging && enabled2) input?.pointer("up", if (trackpad) null else map(lastX, lastY))
                dragging = false
                multi = true
                twoStartX = avgX(e); twoStartY = avgY(e)
                lastX = twoStartX; lastY = twoStartY
            }
            MotionEvent.ACTION_MOVE -> {
                if (multi && e.pointerCount >= 2) {
                    val ax = avgX(e); val ay = avgY(e)
                    val dx = ax - lastX; val dy = ay - lastY
                    lastX = ax; lastY = ay
                    if (hypot(ax - twoStartX, ay - twoStartY) > slop) twoFingerMoved = true
                    if (trackpad && !scaler.isInProgress && enabled2) {
                        scrollAccum += dy
                        if (abs(scrollAccum) > 24f) {
                            // natural scrolling: fingers up = content up = wheel down
                            input?.pointer("scroll", null, dy = (scrollAccum * -5).toInt())
                            scrollAccum = 0f
                        }
                    } else if (!scaler.isInProgress) {
                        view = CoordinateMapper.clampPan(view.copy(panX = view.panX + dx, panY = view.panY + dy))
                        applyTransform()
                    }
                    return true
                }
                if (multi) return true
                val moved = hypot(e.x - downX, e.y - downY) > slop
                if (moved && !longFired) removeCallbacks(longPress)
                if (!enabled2) return true
                if (trackpad) {
                    if (moved || dragging) {
                        input?.rel((e.x - lastX) / width * accel(e.x - lastX, e.y - lastY), (e.y - lastY) / height * accel(e.x - lastX, e.y - lastY))
                    }
                } else if (!longFired) {
                    if (moved && !dragging) {
                        dragging = true
                        map(downX, downY)?.let { input?.pointer("down", it) }
                    }
                    if (dragging) map(e.x, e.y)?.let { input?.move(it) }
                }
                lastX = e.x; lastY = e.y
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (trackpad && !twoFingerMoved && enabled2 && e.pointerCount == 2 && SystemClock.uptimeMillis() - downAt < 350) {
                    input?.pointer("click", null, "right")
                    twoFingerMoved = true // only once
                }
            }
            MotionEvent.ACTION_UP -> {
                removeCallbacks(longPress)
                if (!enabled2) return true
                if (multi) { multi = false; return true }
                if (dragging) {
                    input?.pointer("up", if (trackpad) null else map(e.x, e.y))
                    dragging = false
                } else if (!longFired && hypot(e.x - downX, e.y - downY) <= slop) {
                    val now = SystemClock.uptimeMillis()
                    // two quick taps arrive as two clicks; Windows turns them into a double-click
                    if (trackpad) input?.pointer("click", null) else map(e.x, e.y)?.let { input?.pointer("click", it) }
                    lastTapUp = now
                }
            }
            MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(longPress)
                if (dragging && enabled2) input?.pointer("up", if (trackpad) null else map(lastX, lastY))
                dragging = false
            }
        }
        return true
    }

    private fun accel(dx: Float, dy: Float): Float {
        val speed = hypot(dx, dy)
        return when {
            speed < 3 -> 0.6f // precision
            speed < 12 -> 1.2f
            else -> 2.2f
        } / view.scale
    }

    private fun avgX(e: MotionEvent) = (0 until e.pointerCount).map { e.getX(it) }.average().toFloat()
    private fun avgY(e: MotionEvent) = (0 until e.pointerCount).map { e.getY(it) }.average().toFloat()
}
