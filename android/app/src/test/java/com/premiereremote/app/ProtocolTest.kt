package com.premiereremote.app

import com.premiereremote.app.protocol.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Vectors produced by shared/src/auth.js and companion/src/main/host-core.js keyHash(). */
class ProtocolTest {
    @Test fun transcriptMatchesNodeImplementation() {
        assertEquals(
            "PREMIERE-REMOTE-AUTH-V1|device|h_1|d_1|s-1|hn|dn|AA|BB",
            Protocol.transcript("device", "h_1", "d_1", "s-1", "hn", "dn", "AA", "BB"),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun transcriptRejectsSeparator() {
        Protocol.transcript("device", "h|1", "d_1", "s-1", "hn", "dn", "AA", "BB")
    }

    @Test fun keyHashMatchesHost() {
        val spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw=="
        assertEquals("0131-DDA9", Protocol.keyHash(spki))
    }

    @Test fun fingerprintExtraction() {
        val fp = (0 until 32).joinToString(":") { "%02x".format(it) }
        val sdp = "v=0\r\na=fingerprint:sha-256 $fp\r\na=setup:active\r\n"
        assertEquals(fp.uppercase(), Protocol.extractFingerprint(sdp))
        assertNull(Protocol.extractFingerprint("v=0\r\n"))
    }

    @Test fun codeNormalisationKeepsLeadingZeros() {
        assertEquals("00012345", Protocol.normalizeCode("0001 2345"))
        assertEquals("00012345", Protocol.normalizeCode("0001-2345"))
        assertNull(Protocol.normalizeCode("12345"))
    }
}
