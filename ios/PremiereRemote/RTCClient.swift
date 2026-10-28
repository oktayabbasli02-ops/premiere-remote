import Foundation
import AVFoundation
import WebRTC

struct StreamStats: Equatable {
    var rttMs: Int?
    var width: Int?
    var height: Int?
    var fps: Double?
    var bitrateKbps: Int?
    var packetsLost: Int?
    var jitterMs: Double?
    var codec: String?
    var decoder: String?
    var relayed: Bool?
    var candidates: String?
}

/// Answerer side of one session (the PC offers; it owns the media). Delegate callbacks arrive on
/// WebRTC's signaling thread and are forwarded to the main queue.
final class RTCClient: NSObject {
    struct Events {
        var localSignal: ([String: Any]) -> Void
        var answerReady: (_ localSdp: String, _ remoteSdp: String) -> Void
        var message: (_ label: String, _ text: String) -> Void
        var state: (RTCPeerConnectionState) -> Void
        var error: (String) -> Void
    }

    static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    private var pc: RTCPeerConnection!
    private var channels: [String: RTCDataChannel] = [:]
    private let renderer: RTCVideoRenderer
    private let events: Events
    private var lastBytes: (Double, Double)?

    init?(iceServers: [[String: Any]], renderer: RTCVideoRenderer, events: Events) {
        self.renderer = renderer
        self.events = events
        super.init()
        // receive-only: playback audio session (no microphone permission needed)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        let cfg = RTCConfiguration()
        cfg.iceServers = iceServers.compactMap { s in
            let urls: [String] = (s["urls"] as? [String]) ?? ((s["urls"] as? String).map { [$0] } ?? [])
            guard !urls.isEmpty else { return nil }
            return RTCIceServer(urlStrings: urls, username: s["username"] as? String, credential: s["credential"] as? String)
        }
        cfg.sdpSemantics = .unifiedPlan
        cfg.bundlePolicy = .maxBundle
        cfg.rtcpMuxPolicy = .require
        cfg.continualGatheringPolicy = .gatherContinually
        guard let p = RTCClient.factory.peerConnection(with: cfg, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self) else { return nil }
        pc = p
    }

    func onRemoteSignal(_ data: [String: Any]) {
        switch data["type"] as? String {
        case "offer":
            guard let sdp = data["sdp"] as? String else { return }
            pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [weak self] err in
                guard let self else { return }
                if let err { return self.main { self.events.error("setRemoteDescription: \(err.localizedDescription)") } }
                self.answer(offerSdp: sdp)
            }
        case "candidate":
            guard let c = data["candidate"] as? [String: Any], let s = c["candidate"] as? String, !s.isEmpty else { return }
            let cand = RTCIceCandidate(sdp: s, sdpMLineIndex: Int32(c["sdpMLineIndex"] as? Int ?? 0), sdpMid: c["sdpMid"] as? String)
            pc.add(cand) { _ in }
        default:
            break
        }
    }

    private func answer(offerSdp: String) {
        pc.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self] desc, err in
            guard let self, let desc else { self?.main { self?.events.error("createAnswer: \(err?.localizedDescription ?? "?")") }; return }
            self.pc.setLocalDescription(desc) { err in
                if let err { return self.main { self.events.error("setLocalDescription: \(err.localizedDescription)") } }
                self.main {
                    self.events.localSignal(["type": "answer", "sdp": desc.sdp])
                    self.events.answerReady(desc.sdp, offerSdp)
                }
            }
        }
    }

    @discardableResult
    func send(_ label: String, _ obj: [String: Any]) -> Bool {
        guard let dc = channels[label], dc.readyState == .open else { return false }
        // never queue stale pointer data behind a congested channel
        if label == "pointer" && dc.bufferedAmount > 16_384 { return false }
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return false }
        return dc.sendData(RTCDataBuffer(data: d, isBinary: false))
    }

    func stats(_ done: @escaping (StreamStats) -> Void) {
        pc.statistics { [weak self] report in
            guard let self else { return }
            var s = StreamStats()
            var pairId: String?
            let all = report.statistics
            for st in all.values {
                if st.type == "transport", let id = st.values["selectedCandidatePairId"] as? String { pairId = id }
                if st.type == "inbound-rtp", (st.values["kind"] as? String) == "video" {
                    s.width = (st.values["frameWidth"] as? NSNumber)?.intValue
                    s.height = (st.values["frameHeight"] as? NSNumber)?.intValue
                    s.fps = (st.values["framesPerSecond"] as? NSNumber)?.doubleValue
                    s.packetsLost = (st.values["packetsLost"] as? NSNumber)?.intValue
                    s.jitterMs = (st.values["jitter"] as? NSNumber).map { $0.doubleValue * 1000 }
                    s.decoder = st.values["decoderImplementation"] as? String
                    if let cid = st.values["codecId"] as? String { s.codec = all[cid]?.values["mimeType"] as? String }
                    if let bytes = (st.values["bytesReceived"] as? NSNumber)?.doubleValue {
                        let t = st.timestamp_us / 1000
                        if let (b0, t0) = self.lastBytes, t > t0 { s.bitrateKbps = Int((bytes - b0) * 8 / (t - t0)) }
                        self.lastBytes = (bytes, t)
                    }
                }
            }
            if let pid = pairId, let pair = all[pid] {
                let lc = (pair.values["localCandidateId"] as? String).flatMap { all[$0]?.values["candidateType"] as? String }
                let rc = (pair.values["remoteCandidateId"] as? String).flatMap { all[$0]?.values["candidateType"] as? String }
                s.rttMs = (pair.values["currentRoundTripTime"] as? NSNumber).map { Int($0.doubleValue * 1000) }
                s.relayed = lc == "relay" || rc == "relay"
                s.candidates = "\(lc ?? "?")/\(rc ?? "?")"
            }
            self.main { done(s) }
        }
    }

    func close() {
        channels.values.forEach { $0.close() }
        channels.removeAll()
        pc?.close()
    }

    private func main(_ f: @escaping () -> Void) { DispatchQueue.main.async(execute: f) }
}

extension RTCClient: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let c: [String: Any] = ["candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? "", "sdpMLineIndex": Int(candidate.sdpMLineIndex)]
        main { self.events.localSignal(["type": "candidate", "candidate": c]) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        main { self.events.state(newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        if let video = rtpReceiver.track as? RTCVideoTrack { video.add(renderer) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        dataChannel.delegate = self
        main { self.channels[dataChannel.label] = dataChannel }
    }
}

extension RTCClient: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, let text = String(data: buffer.data, encoding: .utf8) else { return }
        let label = dataChannel.label
        main { self.events.message(label, text) }
    }
}
