package com.premiereremote.app.protocol

import java.security.MessageDigest
import java.util.Base64

/** Mirrors shared/src/protocol.js and shared/src/auth.js. Keep the two in sync. */
object Protocol {
    const val AUTH_CONTEXT = "PREMIERE-REMOTE-AUTH-V1"

    object Sig {
        const val HELLO = "hello"
        const val WELCOME = "welcome"
        const val ERROR = "error"
        const val PING = "ping"
        const val SESSION_REQUEST = "session.request"
        const val SESSION_CREATED = "session.created"
        const val SESSION_ACCEPT = "session.accept"
        const val SESSION_REJECT = "session.reject"
        const val SESSION_END = "session.end"
        const val SIGNAL = "signal"
        const val HOST_STATUS = "host.status"
    }

    object Ctl {
        const val AUTH_CHALLENGE = "auth.challenge"
        const val AUTH_RESPONSE = "auth.response"
        const val AUTH_OK = "auth.ok"
        const val AUTH_FAIL = "auth.fail"
        const val CMD = "cmd"
        const val ACK = "ack"
        const val CMD_QUERY = "cmd.query"
        const val CMD_STATUS = "cmd.status"
        const val POINTER = "ptr"
        const val KEY = "key"
        const val TEXT = "text"
        const val STATUS = "status"
        const val CAPTURE_SET = "capture.set"
        const val QUALITY_SET = "quality.set"
        const val PING = "ping"
        const val PONG = "pong"
        const val NOTICE = "notice"
        const val EPOCH = "epoch"
        const val BYE = "bye"
    }

    /** Commands that change the project. They are never re-sent automatically after a reconnect. */
    val DESTRUCTIVE = setOf(
        "setIn", "setOut", "addMarker", "addEdit", "deleteSelection", "rippleDeleteSelection",
        "trimPrevToPlayhead", "trimNextToPlayhead", "undo", "redo",
    )

    fun transcript(
        role: String, hostId: String, deviceId: String, sessionId: String,
        hostNonce: String, deviceNonce: String, hostFingerprint: String, deviceFingerprint: String,
    ): String {
        val fields = listOf(role, hostId, deviceId, sessionId, hostNonce, deviceNonce, hostFingerprint, deviceFingerprint)
        require(fields.all { it.isNotEmpty() && !it.contains('|') }) { "invalid transcript field" }
        return (listOf(AUTH_CONTEXT) + fields).joinToString("|")
    }

    private val FP = Regex("^a=fingerprint:sha-256 ([0-9A-Fa-f:]{95})\\s*$", RegexOption.MULTILINE)

    fun extractFingerprint(sdp: String): String? = FP.find(sdp)?.groupValues?.get(1)?.uppercase()

    /** Short key ID shown on both phone and PC during pairing, e.g. "3FA2-91C0". */
    fun keyHash(spkiBase64: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(Base64.getDecoder().decode(spkiBase64))
        val hex = d.joinToString("") { "%02X".format(it) }
        return "${hex.substring(0, 4)}-${hex.substring(4, 8)}"
    }

    fun normalizeCode(input: String): String? {
        val digits = input.replace(" ", "").replace("-", "")
        return if (Regex("^\\d{8}$").matches(digits)) digits else null
    }
}
