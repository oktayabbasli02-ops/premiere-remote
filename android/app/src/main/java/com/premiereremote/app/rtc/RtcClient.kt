package com.premiereremote.app.rtc

import android.content.Context
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer

/** Snapshot of receive-side WebRTC stats for the on-screen diagnostics. */
data class StreamStats(
    val rttMs: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
    val fps: Double? = null,
    val bitrateKbps: Int? = null,
    val packetsLost: Long? = null,
    val jitterMs: Double? = null,
    val codec: String? = null,
    val decoder: String? = null,
    val relayed: Boolean? = null,
    val candidates: String? = null,
)

/** Factory + EGL context shared by all sessions (created once per process). */
object Rtc {
    lateinit var egl: EglBase
    lateinit var factory: PeerConnectionFactory

    fun init(context: Context) {
        if (::factory.isInitialized) return
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
        egl = EglBase.create()
        factory = PeerConnectionFactory.builder()
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setAudioDeviceModule(JavaAudioDeviceModule.builder(context.applicationContext).createAudioDeviceModule())
            .createPeerConnectionFactory()
    }
}

/**
 * Answerer side of one session. The PC is the offerer (it owns the media). All callbacks arrive on
 * WebRTC's signaling thread; RemoteController marshals to its own scope.
 */
class RtcClient(
    iceServers: List<PeerConnection.IceServer>,
    private val sink: VideoSink,
    private val events: Events,
) {
    interface Events {
        fun onLocalSignal(data: JSONObject)
        fun onAnswerReady(localSdp: String, remoteSdp: String)
        fun onChannelOpen(label: String)
        fun onChannelMessage(label: String, text: String)
        fun onConnectionState(state: PeerConnection.PeerConnectionState)
        fun onError(message: String)
    }

    private val channels = mutableMapOf<String, DataChannel>()
    private var lastBytes: Pair<Long, Double>? = null
    private val pc: PeerConnection

    init {
        val cfg = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        pc = Rtc.factory.createPeerConnection(cfg, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                events.onLocalSignal(
                    JSONObject().put("type", "candidate").put(
                        "candidate",
                        JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex),
                    ),
                )
            }
            override fun onDataChannel(dc: DataChannel) = attach(dc)
            override fun onTrack(transceiver: RtpTransceiver) {
                (transceiver.receiver.track() as? VideoTrack)?.addSink(sink)
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = events.onConnectionState(newState)
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
        }) ?: throw IllegalStateException("could not create PeerConnection")
    }

    private fun attach(dc: DataChannel) {
        val label = dc.label()
        channels[label] = dc
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                if (dc.state() == DataChannel.State.OPEN) events.onChannelOpen(label)
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                events.onChannelMessage(label, String(bytes, Charsets.UTF_8))
            }
        })
        if (dc.state() == DataChannel.State.OPEN) events.onChannelOpen(label)
    }

    fun send(label: String, msg: JSONObject): Boolean {
        val dc = channels[label] ?: return false
        if (dc.state() != DataChannel.State.OPEN) return false
        // never queue up stale pointer data: drop moves if the channel is backed up
        if (label == "pointer" && dc.bufferedAmount() > 16_384) return false
        return dc.send(DataChannel.Buffer(ByteBuffer.wrap(msg.toString().toByteArray(Charsets.UTF_8)), false))
    }

    /** Handles the PC's offer (initial or ICE-restart) and remote candidates. */
    fun onRemoteSignal(data: JSONObject) {
        when (data.optString("type")) {
            "offer" -> {
                val offerSdp = data.getString("sdp")
                pc.setRemoteDescription(object : SimpleSdp() {
                    override fun onSetSuccess() = createAnswer(offerSdp)
                    override fun onSetFailure(error: String?) = events.onError("setRemoteDescription: $error")
                }, SessionDescription(SessionDescription.Type.OFFER, offerSdp))
            }
            "candidate" -> {
                val c = data.optJSONObject("candidate") ?: return
                if (c.optString("candidate").isEmpty()) return
                pc.addIceCandidate(IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.getString("candidate")))
            }
        }
    }

    private fun createAnswer(offerSdp: String) {
        pc.createAnswer(object : SimpleSdp() {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(object : SimpleSdp() {
                    override fun onSetSuccess() {
                        events.onLocalSignal(JSONObject().put("type", "answer").put("sdp", desc.description))
                        events.onAnswerReady(desc.description, offerSdp)
                    }
                    override fun onSetFailure(error: String?) = events.onError("setLocalDescription: $error")
                }, desc)
            }
            override fun onCreateFailure(error: String?) = events.onError("createAnswer: $error")
        }, MediaConstraints())
    }

    fun stats(cb: (StreamStats) -> Unit) {
        pc.getStats { report ->
            var s = StreamStats()
            val map = report.statsMap
            var pairId: String? = null
            for (r in map.values) {
                when (r.type) {
                    "transport" -> pairId = r.members["selectedCandidatePairId"] as? String
                    "inbound-rtp" -> if (r.members["kind"] == "video") {
                        val bytes = (r.members["bytesReceived"] as? java.math.BigInteger)?.toLong() ?: (r.members["bytesReceived"] as? Long)
                        val ts = r.timestampUs / 1000.0
                        val kbps = lastBytes?.let { (b0, t0) -> if (bytes != null && ts > t0) (((bytes - b0) * 8) / (ts - t0)).toInt() else null }
                        if (bytes != null) lastBytes = bytes to ts
                        val codecId = r.members["codecId"] as? String
                        s = s.copy(
                            width = (r.members["frameWidth"] as? Number)?.toInt(),
                            height = (r.members["frameHeight"] as? Number)?.toInt(),
                            fps = (r.members["framesPerSecond"] as? Number)?.toDouble(),
                            bitrateKbps = kbps,
                            packetsLost = (r.members["packetsLost"] as? Number)?.toLong(),
                            jitterMs = (r.members["jitter"] as? Number)?.toDouble()?.times(1000),
                            decoder = r.members["decoderImplementation"] as? String,
                            codec = codecId?.let { map[it]?.members?.get("mimeType") as? String },
                        )
                    }
                }
            }
            val pair = pairId?.let { map[it] }
            if (pair != null) {
                val local = map[pair.members["localCandidateId"] as? String]?.members?.get("candidateType") as? String
                val remote = map[pair.members["remoteCandidateId"] as? String]?.members?.get("candidateType") as? String
                s = s.copy(
                    rttMs = (pair.members["currentRoundTripTime"] as? Number)?.toDouble()?.times(1000)?.toInt(),
                    relayed = local == "relay" || remote == "relay",
                    candidates = "$local/$remote",
                )
            }
            cb(s)
        }
    }

    fun close() {
        channels.values.forEach { runCatching { it.unregisterObserver(); it.close() } }
        channels.clear()
        runCatching { pc.dispose() }
    }

    private open class SimpleSdp : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }
}

fun iceServersFrom(json: org.json.JSONArray?): List<PeerConnection.IceServer> {
    if (json == null) return emptyList()
    return (0 until json.length()).map { i ->
        val o = json.getJSONObject(i)
        val urls = o.opt("urls").let { u ->
            when (u) {
                is org.json.JSONArray -> (0 until u.length()).map { u.getString(it) }
                is String -> listOf(u)
                else -> emptyList()
            }
        }
        val b = PeerConnection.IceServer.builder(urls)
        if (o.has("username")) b.setUsername(o.getString("username")).setPassword(o.getString("credential"))
        b.createIceServer()
    }
}
