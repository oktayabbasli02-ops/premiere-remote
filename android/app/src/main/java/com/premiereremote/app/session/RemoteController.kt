package com.premiereremote.app.session

import com.premiereremote.app.data.CredentialStore
import com.premiereremote.app.data.PairedHost
import com.premiereremote.app.net.SignalingClient
import com.premiereremote.app.protocol.Protocol
import com.premiereremote.app.protocol.Protocol.Ctl
import com.premiereremote.app.protocol.Protocol.Sig
import com.premiereremote.app.rtc.RtcClient
import com.premiereremote.app.rtc.StreamStats
import com.premiereremote.app.rtc.iceServersFrom
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.PeerConnection
import org.webrtc.VideoSink
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

enum class Phase { CONNECTING, HOST_OFFLINE, WAITING_APPROVAL, CONNECTING_MEDIA, AUTHENTICATING, LIVE, RECONNECTING, REJECTED, REVOKED, SECURITY_ERROR, ENDED }

data class Capability(val action: String, val impl: String, val destructive: Boolean, val verified: Boolean, val shortcut: String?)

data class PendingCommand(val id: String, val action: String, val label: String, val sentAt: Long, val state: String = "sent")

data class AckInfo(val action: String, val status: String, val verified: Boolean, val message: String, val at: Long = System.currentTimeMillis())

data class HostView(
    val premiereRunning: Boolean = false,
    val minimized: Boolean = false,
    val modal: Boolean = false,
    val locked: Boolean = false,
    val foregroundTitle: String = "",
    val foregroundIsPremiere: Boolean = true,
    val projectName: String? = null,
    val sequenceName: String? = null,
    val sequenceGuid: String? = null,
    val positionSeconds: Double? = null,
    val fps: Double? = null,
    val captureMode: String? = null,
    val captureW: Int? = null,
    val captureH: Int? = null,
    val quality: String? = null,
    val autoQuality: Boolean = false,
    val pluginConnected: Boolean = false,
    val hostEncoder: String? = null,
    val hostBitrate: Int? = null,
)

data class UiState(
    val phase: Phase = Phase.CONNECTING,
    val message: String = "",
    val canControl: Boolean = false,
    val capabilities: List<Capability> = emptyList(),
    val host: HostView = HostView(),
    val stats: StreamStats = StreamStats(),
    val appRttMs: Int? = null,
    val pending: List<PendingCommand> = emptyList(),
    val lastAck: AckInfo? = null,
    val notices: List<String> = emptyList(),
)

/**
 * One phone <-> one PC connection with automatic, *safe* reconnection:
 *  - every reconnect is a brand-new WebRTC session with a new input epoch, so stale pointer/scrub
 *    events from the old connection are discarded by the host;
 *  - unacknowledged commands are never re-sent; the phone asks the host (cmd.query) what happened.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RemoteController(
    private val store: CredentialStore,
    val host: PairedHost,
    private val videoSink: VideoSink,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui

    private var signaling: SignalingClient? = null
    private var rtc: RtcClient? = null
    private var sessionId: String? = null
    private var fingerprints: Pair<String, String>? = null // host, device
    private var deviceNonce: String? = null
    private var hostNonce: String? = null
    private var epoch: String = UUID.randomUUID().toString()
    private var pointerSeq = 0
    private val pending = LinkedHashMap<String, PendingCommand>()
    private val pings = HashMap<String, Long>()
    private var userStopped = false
    private var backoffMs = 1000L
    private var failedSince: Long? = null
    private var timers: Job? = null

    // ------------------------------------------------------------------ lifecycle
    fun start() = scope.launch {
        userStopped = false
        connectSignaling()
    }

    fun stop() = scope.launch {
        userStopped = true
        sendControl(JSONObject().put("t", Ctl.BYE))
        sessionId?.let { signaling?.send(JSONObject().put("t", Sig.SESSION_END).put("sessionId", it)) }
        teardownSession()
        signaling?.close()
        signaling = null
        setPhase(Phase.ENDED, "Disconnected.")
        scope.cancel()
    }

    private fun setPhase(p: Phase, msg: String = "") = _ui.update { it.copy(phase = p, message = msg) }

    private fun connectSignaling() {
        val token = store.token(host.hostId)
        if (token == null) {
            setPhase(Phase.REVOKED, "Credentials for this PC are missing. Pair again.")
            return
        }
        setPhase(if (_ui.value.phase == Phase.LIVE) Phase.RECONNECTING else Phase.CONNECTING, "Connecting to server…")
        val client = SignalingClient(host.serverUrl, host.deviceId, token, object : SignalingClient.Listener {
            override fun onOpen() {}
            override fun onMessage(msg: JSONObject) { scope.launch { onSignal(msg) } }
            override fun onClosed(code: Int, reason: String) { scope.launch { onSignalingClosed(code) } }
        })
        signaling = client
        client.connect()
    }

    private fun onSignalingClosed(code: Int) {
        teardownSession()
        signaling = null
        if (userStopped) return
        if (code == 4003 || code == 4001) {
            setPhase(Phase.REVOKED, "This phone's access was revoked on the PC (or the server forgot it). Pair again.")
            return
        }
        setPhase(Phase.RECONNECTING, "Connection lost. Reconnecting…")
        scope.launch {
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(15_000)
            if (!userStopped && signaling == null) connectSignaling()
        }
    }

    /** Called by the activity when Android reports a new default network (Wi-Fi <-> mobile data). */
    fun onNetworkChanged() = scope.launch {
        if (userStopped) return@launch
        backoffMs = 500
        if (signaling == null) connectSignaling()
    }

    // ------------------------------------------------------------------ signaling
    private fun onSignal(m: JSONObject) {
        when (m.optString("t")) {
            Sig.WELCOME -> {
                backoffMs = 1000
                if (m.optBoolean("hostOnline")) requestSession()
                else setPhase(Phase.HOST_OFFLINE, "The PC is offline or remote access is off. Waiting…")
            }
            Sig.HOST_STATUS -> {
                if (m.optBoolean("online") && sessionId == null) requestSession()
                if (!m.optBoolean("online")) { teardownSession(); setPhase(Phase.HOST_OFFLINE, "The PC went offline. Waiting…") }
            }
            Sig.SESSION_CREATED -> {
                sessionId = m.getString("sessionId")
                setPhase(Phase.WAITING_APPROVAL, "Waiting for the PC to accept (approve on the PC if this phone is not trusted for unattended access)…")
            }
            Sig.SESSION_ACCEPT -> if (m.optString("sessionId") == sessionId) startRtc(m.optJSONArray("iceServers"))
            Sig.SESSION_REJECT -> {
                val reason = m.optString("reason")
                teardownSession()
                when (reason) {
                    "host_offline" -> setPhase(Phase.HOST_OFFLINE, "The PC is offline. Waiting…")
                    "busy" -> setPhase(Phase.REJECTED, "Another phone is connected to this PC.")
                    "unauthorized" -> setPhase(Phase.REVOKED, "This phone is no longer trusted by the PC. Pair again.")
                    else -> setPhase(Phase.REJECTED, "The PC declined the connection.")
                }
            }
            Sig.SESSION_END -> if (m.optString("sessionId") == sessionId) {
                val reason = m.optString("reason")
                teardownSession()
                if (reason == "revoked") setPhase(Phase.REVOKED, "Access revoked on the PC.")
                else if (!userStopped) {
                    setPhase(Phase.RECONNECTING, "Session ended ($reason). Reconnecting…")
                    scope.launch { delay(1500); if (sessionId == null && !userStopped) requestSession() }
                }
            }
            Sig.SIGNAL -> if (m.optString("sessionId") == sessionId) m.optJSONObject("data")?.let { rtc?.onRemoteSignal(it) }
            Sig.ERROR -> if (m.optString("code") == "unauthorized") {
                setPhase(
                    Phase.REVOKED,
                    if (m.optString("reason") == "revoked") "This phone's access was revoked on the PC. Pair again to reconnect."
                    else "Server rejected this phone. Pair again.",
                )
            }
        }
    }

    private fun requestSession() {
        if (sessionId != null) return
        signaling?.send(JSONObject().put("t", Sig.SESSION_REQUEST).put("clientRef", UUID.randomUUID().toString()))
    }

    private fun startRtc(ice: JSONArray?) {
        setPhase(Phase.CONNECTING_MEDIA, "Connecting media (direct or via TURN)…")
        fingerprints = null
        val sid = sessionId ?: return
        rtc = RtcClient(iceServersFrom(ice), videoSink, object : RtcClient.Events {
            override fun onLocalSignal(data: JSONObject) {
                scope.launch { signaling?.send(JSONObject().put("t", Sig.SIGNAL).put("sessionId", sid).put("data", data)) }
            }
            override fun onAnswerReady(localSdp: String, remoteSdp: String) {
                scope.launch {
                    if (fingerprints != null) return@launch // ICE restart: identity unchanged
                    val h = Protocol.extractFingerprint(remoteSdp)
                    val d = Protocol.extractFingerprint(localSdp)
                    if (h == null || d == null) securityError("Missing DTLS fingerprint") else fingerprints = h to d
                }
            }
            override fun onChannelOpen(label: String) {}
            override fun onChannelMessage(label: String, text: String) {
                scope.launch { runCatching { JSONObject(text) }.getOrNull()?.let { onControl(it) } }
            }
            override fun onConnectionState(state: PeerConnection.PeerConnectionState) { scope.launch { onPcState(state) } }
            override fun onError(message: String) { scope.launch { notice("WebRTC: $message") } }
        })
        startTimers()
    }

    private fun onPcState(state: PeerConnection.PeerConnectionState) {
        when (state) {
            PeerConnection.PeerConnectionState.CONNECTED -> {
                failedSince = null
                if (_ui.value.phase == Phase.RECONNECTING) setPhase(Phase.LIVE, "")
            }
            PeerConnection.PeerConnectionState.DISCONNECTED, PeerConnection.PeerConnectionState.FAILED -> {
                if (failedSince == null) failedSince = System.currentTimeMillis()
                if (_ui.value.phase == Phase.LIVE) setPhase(Phase.RECONNECTING, "Network interrupted. Waiting for the PC to restart ICE…")
            }
            else -> Unit
        }
    }

    private fun teardownSession() {
        timers?.cancel()
        timers = null
        rtc?.close()
        rtc = null
        sessionId = null
        fingerprints = null
        hostNonce = null
        deviceNonce = null
        failedSince = null
        // pending commands stay: they are queried (never re-sent) after the next successful auth
    }

    private fun securityError(msg: String) {
        sessionId?.let { signaling?.send(JSONObject().put("t", Sig.SESSION_END).put("sessionId", it).put("reason", "security")) }
        teardownSession()
        userStopped = true
        signaling?.close()
        setPhase(Phase.SECURITY_ERROR, "Security check failed: $msg. Not reconnecting. If this persists, revoke and pair again.")
    }

    // ------------------------------------------------------------------ data channel protocol
    private fun onControl(m: JSONObject) {
        when (m.optString("t")) {
            Ctl.AUTH_CHALLENGE -> onChallenge(m)
            Ctl.AUTH_OK -> onAuthOk(m)
            Ctl.AUTH_FAIL -> securityError("the PC rejected this phone's signature")
            Ctl.ACK -> onAck(m)
            Ctl.CMD_STATUS -> onCmdStatus(m)
            Ctl.STATUS -> onStatus(m)
            Ctl.NOTICE -> notice(m.optString("message"))
            Ctl.PING -> sendControl(JSONObject().put("t", Ctl.PONG).put("id", m.optString("id")).put("hostTs", m.optLong("hostTs")).put("ts", System.currentTimeMillis()))
            Ctl.PONG -> pings.remove(m.optString("id"))?.let { sent -> _ui.update { it.copy(appRttMs = (System.currentTimeMillis() - sent).toInt()) } }
        }
    }

    private fun onChallenge(m: JSONObject) {
        val fp = fingerprints ?: return securityError("challenge before DTLS fingerprints were known")
        val sid = sessionId ?: return
        if (m.optString("sessionId") != sid || m.optString("hostId") != host.hostId) return securityError("challenge for a different session/host")
        val hn = m.optString("hostNonce")
        val dn = randomNonce()
        hostNonce = hn
        deviceNonce = dn
        val t = Protocol.transcript("device", host.hostId, host.deviceId, sid, hn, dn, fp.first, fp.second)
        sendControl(JSONObject().put("t", Ctl.AUTH_RESPONSE).put("deviceNonce", dn).put("sig", store.sign(t)))
        setPhase(Phase.AUTHENTICATING, "Verifying the PC's identity…")
    }

    private fun onAuthOk(m: JSONObject) {
        val fp = fingerprints ?: return
        val sid = sessionId ?: return
        val t = Protocol.transcript("host", host.hostId, host.deviceId, sid, hostNonce ?: return, deviceNonce ?: return, fp.first, fp.second)
        if (!store.verifyHost(host.hostPublicKey, t, m.optString("sig"))) return securityError("the PC's identity key does not match the one pinned at pairing")
        val caps = m.optJSONArray("capabilities") ?: JSONArray()
        val list = (0 until caps.length()).map { i ->
            val c = caps.getJSONObject(i)
            Capability(c.getString("action"), c.getString("impl"), c.optBoolean("destructive"), c.optBoolean("verified"), c.optString("shortcut").ifEmpty { null })
        }
        epoch = UUID.randomUUID().toString()
        pointerSeq = 0
        sendControl(JSONObject().put("t", Ctl.EPOCH).put("epoch", epoch))
        _ui.update { it.copy(canControl = m.optJSONObject("permissions")?.optBoolean("control") == true, capabilities = list) }
        setPhase(Phase.LIVE, "")
        backoffMs = 1000
        if (pending.isNotEmpty()) {
            sendControl(JSONObject().put("t", Ctl.CMD_QUERY).put("ids", JSONArray(pending.keys.toList())))
        }
    }

    private fun onAck(m: JSONObject) {
        val id = m.optString("id")
        val p = pending[id] ?: return
        val status = m.optString("status")
        if (status == "in_progress") return
        pending.remove(id)
        val err = m.optJSONObject("error")
        val verified = m.optBoolean("verified")
        val msg = when (status) {
            "ok" -> if (verified) "${p.label}: done" else "${p.label}: sent" + (m.optString("note").takeIf { it.isNotEmpty() }?.let { " — $it" } ?: " (cannot be verified)")
            "unsupported" -> "${p.label}: not supported (${err?.optString("message")})"
            "forbidden" -> "${p.label}: this phone is view-only"
            else -> "${p.label} failed: ${err?.optString("message") ?: status}"
        }
        _ui.update { it.copy(pending = pending.values.toList(), lastAck = AckInfo(p.action, status, verified, msg)) }
    }

    private fun onCmdStatus(m: JSONObject) {
        val arr = m.optJSONArray("results") ?: return
        for (i in 0 until arr.length()) {
            val r = arr.getJSONObject(i)
            val id = r.optString("id")
            val p = pending[id] ?: continue
            when (r.optString("state")) {
                "done" -> {
                    val res = r.optJSONObject("result") ?: JSONObject()
                    onAck(res.put("id", id))
                }
                "unknown" -> {
                    pending.remove(id)
                    _ui.update { it.copy(lastAck = AckInfo(p.action, "lost", false, "${p.label} never reached the PC and was NOT re-sent. Check the timeline, then repeat it if needed.")) }
                }
                "inflight" -> Unit // ack will arrive on this connection
            }
        }
        _ui.update { it.copy(pending = pending.values.toList()) }
    }

    private fun onStatus(m: JSONObject) {
        val pr = m.optJSONObject("premiere") ?: JSONObject()
        val proj = pr.optJSONObject("project")
        val seq = proj?.optJSONObject("sequence")
        val cap = m.optJSONObject("capture")
        val stream = m.optJSONObject("stream")
        val fg = pr.optJSONObject("foreground")
        _ui.update {
            it.copy(
                host = HostView(
                    premiereRunning = pr.optBoolean("running"),
                    minimized = pr.optBoolean("minimized"),
                    modal = pr.optBoolean("modal"),
                    locked = pr.optBoolean("locked"),
                    foregroundTitle = fg?.optString("title").orEmpty(),
                    foregroundIsPremiere = fg?.optBoolean("isPremiere", true) ?: true,
                    projectName = proj?.optJSONObject("project")?.optString("name"),
                    sequenceName = seq?.optString("name"),
                    sequenceGuid = seq?.optString("guid"),
                    positionSeconds = seq?.optJSONObject("position")?.optDouble("seconds"),
                    fps = seq?.optDouble("fps"),
                    captureMode = cap?.optString("mode"),
                    captureW = cap?.optInt("width"),
                    captureH = cap?.optInt("height"),
                    quality = m.optString("quality"),
                    autoQuality = m.optBoolean("auto"),
                    pluginConnected = m.optBoolean("plugin"),
                    hostEncoder = stream?.optString("encoder"),
                    hostBitrate = stream?.optInt("videoBitrate"),
                ),
            )
        }
    }

    /** Transient host notices: de-duplicated and auto-expiring so they never pile up over the video. */
    private fun notice(text: String) {
        if (text.isEmpty()) return
        _ui.update { it.copy(notices = (it.notices.filter { n -> n != text } + text).takeLast(3)) }
        scope.launch {
            delay(8000)
            _ui.update { it.copy(notices = it.notices.filter { n -> n != text }) }
        }
    }

    fun dismissNotices() = _ui.update { it.copy(notices = emptyList()) }

    private fun startTimers() {
        timers?.cancel()
        timers = scope.launch {
            while (isActive) {
                delay(2000)
                rtc?.stats { s -> scope.launch { _ui.update { it.copy(stats = s) } } }
                if (_ui.value.phase == Phase.LIVE) {
                    val id = UUID.randomUUID().toString()
                    pings[id] = System.currentTimeMillis()
                    if (pings.size > 10) pings.remove(pings.keys.first())
                    sendControl(JSONObject().put("t", Ctl.PING).put("id", id).put("ts", System.currentTimeMillis()))
                }
                if (pending.isNotEmpty() && _ui.value.phase == Phase.LIVE) {
                    // commands stuck in "inflight" for long are re-queried, never re-sent
                    val stale = pending.values.filter { System.currentTimeMillis() - it.sentAt > 8000 }.map { it.id }
                    if (stale.isNotEmpty()) sendControl(JSONObject().put("t", Ctl.CMD_QUERY).put("ids", JSONArray(stale)))
                }
                val since = failedSince
                if (since != null && System.currentTimeMillis() - since > 12_000) {
                    // the PC did not manage an ICE restart: start a fresh session (new epoch)
                    sessionId?.let { signaling?.send(JSONObject().put("t", Sig.SESSION_END).put("sessionId", it).put("reason", "media_failed")) }
                    teardownSession()
                    setPhase(Phase.RECONNECTING, "Re-establishing the stream…")
                    requestSession()
                }
            }
        }
    }

    private fun sendControl(m: JSONObject): Boolean = rtc?.send("control", m) ?: false

    private fun randomNonce(): String {
        val b = ByteArray(24)
        SecureRandom().nextBytes(b)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    }

    // ------------------------------------------------------------------ public actions (any thread)
    fun command(action: String, label: String, args: JSONObject = JSONObject()) = scope.launch {
        if (_ui.value.phase != Phase.LIVE) {
            _ui.update { it.copy(lastAck = AckInfo(action, "offline", false, "$label not sent: not connected.")) }
            return@launch
        }
        val id = UUID.randomUUID().toString()
        val msg = JSONObject().put("t", Ctl.CMD).put("id", id).put("action", action).put("args", args)
        val guid = _ui.value.host.sequenceGuid
        if (action in Protocol.DESTRUCTIVE && !guid.isNullOrEmpty()) msg.put("expect", JSONObject().put("sequenceGuid", guid))
        if (sendControl(msg)) {
            pending[id] = PendingCommand(id, action, label, System.currentTimeMillis())
            _ui.update { it.copy(pending = pending.values.toList()) }
        } else {
            _ui.update { it.copy(lastAck = AckInfo(action, "offline", false, "$label not sent: channel not open.")) }
        }
    }

    fun pointerMove(nx: Float, ny: Float) = scope.launch {
        rtc?.send("pointer", JSONObject().put("t", "move").put("x", nx.toDouble()).put("y", ny.toDouble()).put("seq", ++pointerSeq).put("ts", System.currentTimeMillis()).put("epoch", epoch))
    }

    fun pointerRel(dx: Float, dy: Float) = scope.launch {
        rtc?.send("pointer", JSONObject().put("t", "rel").put("dx", dx.toDouble()).put("dy", dy.toDouble()).put("seq", ++pointerSeq).put("ts", System.currentTimeMillis()).put("epoch", epoch))
    }

    /** kind: down | up | click | dblclick | scroll. nx/ny null = at the current remote cursor. */
    fun pointer(kind: String, nx: Float?, ny: Float?, button: String = "left", dy: Int = 0, dx: Int = 0) = scope.launch {
        val m = JSONObject().put("t", Ctl.POINTER).put("kind", kind).put("button", button).put("epoch", epoch)
        if (nx != null && ny != null) m.put("x", nx.toDouble()).put("y", ny.toDouble())
        if (kind == "scroll") m.put("dy", dy).put("dx", dx)
        sendControl(m)
    }

    fun key(combo: String) = scope.launch {
        val id = UUID.randomUUID().toString()
        if (sendControl(JSONObject().put("t", Ctl.KEY).put("id", id).put("combo", combo))) {
            pending[id] = PendingCommand(id, "key", combo, System.currentTimeMillis())
        }
    }

    fun text(s: String) = scope.launch {
        if (s.isEmpty()) return@launch
        val id = UUID.randomUUID().toString()
        if (sendControl(JSONObject().put("t", Ctl.TEXT).put("id", id).put("text", s.take(500)))) {
            pending[id] = PendingCommand(id, "text", "Typing", System.currentTimeMillis())
        }
    }

    fun setCapture(mode: String) = scope.launch { sendControl(JSONObject().put("t", Ctl.CAPTURE_SET).put("mode", mode)) }
    fun setQuality(profile: String) = scope.launch { sendControl(JSONObject().put("t", Ctl.QUALITY_SET).put("profile", profile)) }
}
