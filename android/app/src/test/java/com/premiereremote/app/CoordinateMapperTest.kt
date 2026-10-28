package com.premiereremote.app

import com.premiereremote.app.input.CoordinateMapper
import com.premiereremote.app.input.ViewState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Same cases as shared/test/mapping.test.js so both implementations stay identical. */
class CoordinateMapperTest {
    private val eps = 1e-4f

    @Test fun letterboxPortrait() {
        val r = CoordinateMapper.fitRect(1080f, 2340f, 1280f, 720f)!!
        assertEquals(1080f, r.w, eps)
        assertEquals(607.5f, r.h, eps)
        assertEquals((2340f - 607.5f) / 2f, r.y, eps)
    }

    @Test fun centreAndCorners() {
        val v = ViewState(1080f, 2340f, 1280f, 720f)
        val c = CoordinateMapper.viewToNormalized(540f, 1170f, v)!!
        assertEquals(0.5f, c.x, eps); assertEquals(0.5f, c.y, eps)
        val top = (2340f - 607.5f) / 2f
        val br = CoordinateMapper.viewToNormalized(1080f, top + 607.5f, v)!!
        assertEquals(1f, br.x, eps); assertEquals(1f, br.y, eps)
    }

    @Test fun letterboxTapsAreIgnored() {
        val v = ViewState(1080f, 2340f, 1280f, 720f)
        assertNull(CoordinateMapper.viewToNormalized(540f, 10f, v))
    }

    @Test fun zoomAndPan() {
        val v = ViewState(1600f, 900f, 1280f, 720f, scale = 2f, panX = -1600f, panY = -900f)
        val p = CoordinateMapper.viewToNormalized(0f, 0f, v)!!
        assertEquals(0.5f, p.x, eps); assertEquals(0.5f, p.y, eps)
    }

    @Test fun rotationInvariance() {
        val pr = CoordinateMapper.fitRect(1080f, 2340f, 1920f, 1080f)!!
        val lr = CoordinateMapper.fitRect(2340f, 1080f, 1920f, 1080f)!!
        val a = CoordinateMapper.viewToNormalized(pr.x + pr.w * 0.25f, pr.y + pr.h * 0.75f, ViewState(1080f, 2340f, 1920f, 1080f))
        val b = CoordinateMapper.viewToNormalized(lr.x + lr.w * 0.25f, lr.y + lr.h * 0.75f, ViewState(2340f, 1080f, 1920f, 1080f))
        assertNotNull(a); assertNotNull(b)
        assertEquals(a!!.x, b!!.x, eps); assertEquals(a.y, b.y, eps)
    }

    @Test fun clampPan() {
        val c = CoordinateMapper.clampPan(ViewState(1600f, 900f, 1280f, 720f, scale = 2f, panX = 500f, panY = -5000f))
        assertEquals(0f, c.panX, eps)
        assertEquals(-900f, c.panY, eps)
        assertEquals(8f, CoordinateMapper.clampPan(ViewState(1600f, 900f, 1280f, 720f, scale = 50f)).scale, eps)
    }
}
