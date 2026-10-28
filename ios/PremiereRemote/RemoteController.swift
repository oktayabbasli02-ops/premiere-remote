import Foundation
import Combine
import CoreGraphics
import WebRTC

enum Phase: String { case connecting, hostOffline, waitingApproval, connectingMedia, authenticating, live, reconnecting, rejected, revoked, securityError, ended }

struct Capability: Equatable { let action: String; let impl: String; let destructive: Bool }
struct PendingCommand { let id: String; let action: String; let label: String; let sentAt: Date }
struct AckInfo: Equatable { let status: String; let verified: Bool; let message: String; let at: Date }

struct HostView: Equatable {
    var premiereRunning = false, minimized = false, modal = false, locked = false
    var foregroundTitle = "", foregroundIsPremiere = true
    var projectName: String?, sequenceName: String?, sequenceGuid: String?
    var captureMode: String?, captureW: Int?, captureH: Int?
    var quality: String?, autoQuality = false, pluginConnected = false, hostEncoder: String?
}

/// One phone <-> PC connection with safe reconnection — same rules as Android/web:
/// every reconnect is a new session + input epoch; unacknowledged commands are queried, never re-sent.
@MainActor
final class RemoteController: ObservableObject {
    @Published private(set) var phase: Phase = .connecting
    @Published private(set) var message = ""
    @Published private(set) var canControl = false
    @Published private(set) var capabilities: [Capability] = []
    @Published private(set) var host = HostView()
    @Published private(set) var stats = StreamStats()
    @Published private(set) var appRttMs: Int?
    @Published private(set) var lastAck: AckInfo?
    @Published private(set) var notices: [String] = []

    let paired: PairedHost
    private let renderer: RTCVideoRenderer
    private var signaling: SignalingClient?
    private var rtc: RTCClient?
    private var sessionId: String?
    private var fingerprints: (host: String, device: String)?
    private var nonces: (host: String, device: String)?
    private var epoch = UUID().uuidString
    private var seq = 0
    private var pending: [String: PendingCommand] = [:]
    private var pings: [String: Date] = [:]
    private var userStopped = false
    private var backoff: TimeInterval = 1
    private var failedSince: Date?
    private var timer: Timer?

    init(paired: PairedHost, renderer: RTCVideoRenderer) {
        self.paired = paired
        self.renderer = renderer
    }

    private func set(_ p: Phase, _ m: String = "") { phase = p; message = m }

    // MARK: lifecycle
    func start() {
        userStopped = false
        connectSignaling()
    }

    func stop() {
        userStopped = true
        sendControl(["t": PRProtocol.Ctl.bye])
        if let sid = sessionId { signaling?.send(["t": PRProtocol.Sig.sessionEnd, "sessionId": sid]) }
        teardown()
        signaling?.close()
        signaling = nil
        set(.ended, "Disconnected.")
    }

    /// Call from scenePhase .active / network path changes.
    func resume() {
        guard !userStopped else { return }
        backoff = 0.5
        if signaling == nil { connectSignaling() }
    }

    private func connectSignaling() {
        guard let token = Identity.shared.token(hostId: paired.hostId) else { return set(.revoked, "Credentials for this PC are missing. Pair again.") }
        set(phase == .live ? .reconnecting : .connecting, "Connecting to server…")
        guard let s = SignalingClient(serverUrl: paired.serverUrl, deviceId: paired.deviceId, token: token) else { return set(.revoked, "Invalid server URL.") }
        s.onMessage = { [weak self] m in self?.onSignal(m) }
        s.onClose = { [weak self] code in self?.onSignalingClosed(code) }
        signaling = s
        s.connect()
    }

    private func onSignalingClosed(_ code: Int) {
        teardown()
        signaling = nil
        guard !userStopped else { return }
        if code == 4003 || code == 4001 { return set(.revoked, "This device's access was revoked on the PC. Pair again.") }
        set(.reconnecting, "Connection lost. Reconnecting…")
        let delay = backoff
        backoff = min(backoff * 2, 15)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.userStopped, self.signaling == nil else { return }
            self.connectSignaling()
        }
    }

    // MARK: signaling
    private func onSignal(_ m: [String: Any]) {
        let t = m["t"] as? String
        switch t {
        case PRProtocol.Sig.welcome:
            backoff = 1
            if m["hostOnline"] as? Bool == true { requestSession() } else { set(.hostOffline, "The PC is offline or remote access is off. Waiting…") }
        case PRProtocol.Sig.hostStatus:
            if m["online"] as? Bool == true, sessionId == nil { requestSession() }
            if m["online"] as? Bool == false { teardown(); set(.hostOffline, "The PC went offline. Waiting…") }
        case PRProtocol.Sig.sessionCreated:
            sessionId = m["sessionId"] as? String
            set(.waitingApproval, "Waiting for the PC to accept (approve on the PC if this device is not trusted for unattended access)…")
        case PRProtocol.Sig.sessionAccept:
            if m["sessionId"] as? String == sessionId { startRtc(m["iceServers"] as? [[String: Any]] ?? []) }
        case PRProtocol.Sig.sessionReject:
            teardown()
            switch m["reason"] as? String {
            case "host_offline": set(.hostOffline, "The PC is offline. Waiting…")
            case "busy": set(.rejected, "Another phone is connected to this PC.")
            case "unauthorized": set(.revoked, "This device is no longer trusted by the PC. Pair again.")
            default: set(.rejected, "The PC declined the connection.")
            }
        case PRProtocol.Sig.sessionEnd:
            guard m["sessionId"] as? String == sessionId else { return }
            teardown()
            if m["reason"] as? String == "revoked" { set(.revoked, "Access revoked on the PC.") }
            else if !userStopped {
                set(.reconnecting, "Session ended (\(m["reason"] as? String ?? "?")). Reconnecting…")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                    guard let self, self.sessionId == nil, !self.userStopped else { return }
                    self.requestSession()
                }
            }
        case PRProtocol.Sig.signal:
            if m["sessionId"] as? String == sessionId, let d = m["data"] as? [String: Any] { rtc?.onRemoteSignal(d) }
        case PRProtocol.Sig.error:
            if m["code"] as? String == "unauthorized" {
                set(.revoked, m["reason"] as? String == "revoked" ? "This device's access was revoked on the PC. Pair again." : "Server rejected this device. Pair again.")
            }
        default:
            break
        }
    }

    private func requestSession() {
        guard sessionId == nil else { return }
        signaling?.send(["t": PRProtocol.Sig.sessionRequest, "clientRef": UUID().uuidString])
    }

    private func startRtc(_ ice: [[String: Any]]) {
        set(.connectingMedia, "Connecting media (direct or via TURN)…")
        fingerprints = nil
        guard let sid = sessionId else { return }
        rtc = RTCClient(iceServers: ice, renderer: renderer, events: .init(
            localSignal: { [weak self] data in self?.signaling?.send(["t": PRProtocol.Sig.signal, "sessionId": sid, "data": data]) },
            answerReady: { [weak self] local, remote in
                guard let self, self.fingerprints == nil else { return } // ICE restart: identity unchanged
                guard let h = PRProtocol.extractFingerprint(remote), let d = PRProtocol.extractFingerprint(local) else { return self.securityError("Missing DTLS fingerprint") }
                self.fingerprints = (h, d)
            },
            message: { [weak self] _, text in
                guard let d = text.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
                self?.onControl(m)
            },
            state: { [weak self] s in self?.onPcState(s) },
            error: { [weak self] e in self?.notice("WebRTC: \(e)") }
        ))
        startTimers()
    }

    private func onPcState(_ s: RTCPeerConnectionState) {
        switch s {
        case .connected:
            failedSince = nil
            if phase == .reconnecting { set(.live) }
        case .disconnected, .failed:
            if failedSince == nil { failedSince = Date() }
            if phase == .live { set(.reconnecting, "Network interrupted. Waiting for the PC to restart ICE…") }
        default:
            break
        }
    }

    private func teardown() {
        timer?.invalidate()
        timer = nil
        rtc?.close()
        rtc = nil
        sessionId = nil
        fingerprints = nil
        nonces = nil
        failedSince = nil
    }

    private func securityError(_ msg: String) {
        if let sid = sessionId { signaling?.send(["t": PRProtocol.Sig.sessionEnd, "sessionId": sid, "reason": "security"]) }
        teardown()
        userStopped = true
        signaling?.close()
        signaling = nil
        set(.securityError, "Security check failed: \(msg). Not reconnecting. If this persists, revoke and pair again.")
    }

    // MARK: data channel protocol
    private func onControl(_ m: [String: Any]) {
        switch m["t"] as? String {
        case PRProtocol.Ctl.authChallenge: onChallenge(m)
        case PRProtocol.Ctl.authOk: onAuthOk(m)
        case PRProtocol.Ctl.authFail: securityError("the PC rejected this device's signature")
        case PRProtocol.Ctl.ack: onAck(m)
        case PRProtocol.Ctl.cmdStatus: onCmdStatus(m)
        case PRProtocol.Ctl.status: onStatus(m)
        case PRProtocol.Ctl.notice: notice(m["message"] as? String ?? "")
        case PRProtocol.Ctl.ping:
            sendControl(["t": PRProtocol.Ctl.pong, "id": m["id"] ?? "", "hostTs": m["hostTs"] ?? 0, "ts": Int(Date().timeIntervalSince1970 * 1000)])
        case PRProtocol.Ctl.pong:
            if let id = m["id"] as? String, let sent = pings.removeValue(forKey: id) { appRttMs = Int(Date().timeIntervalSince(sent) * 1000) }
        default: break
        }
    }

    private func randomNonce() -> String {
        var b = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func onChallenge(_ m: [String: Any]) {
        guard let fp = fingerprints else { return securityError("challenge before DTLS fingerprints were known") }
        guard let sid = sessionId, m["sessionId"] as? String == sid, m["hostId"] as? String == paired.hostId,
              let hn = m["hostNonce"] as? String else { return securityError("challenge for a different session/host") }
        let dn = randomNonce()
        nonces = (hn, dn)
        do {
            let t = try PRProtocol.transcript(role: "device", hostId: paired.hostId, deviceId: paired.deviceId, sessionId: sid,
                                              hostNonce: hn, deviceNonce: dn, hostFingerprint: fp.host, deviceFingerprint: fp.device)
            sendControl(["t": PRProtocol.Ctl.authResponse, "deviceNonce": dn, "sig": try Identity.shared.sign(t)])
            set(.authenticating, "Verifying the PC's identity…")
        } catch {
            securityError("could not sign the session transcript")
        }
    }

    private func onAuthOk(_ m: [String: Any]) {
        guard let fp = fingerprints, let n = nonces, let sid = sessionId,
              let t = try? PRProtocol.transcript(role: "host", hostId: paired.hostId, deviceId: paired.deviceId, sessionId: sid,
                                                 hostNonce: n.host, deviceNonce: n.device, hostFingerprint: fp.host, deviceFingerprint: fp.device) else { return }
        guard Identity.shared.verifyHost(spki: paired.hostPublicKey, transcript: t, signature: m["sig"] as? String ?? "") else {
            return securityError("the PC's identity key does not match the one pinned at pairing")
        }
        capabilities = (m["capabilities"] as? [[String: Any]] ?? []).compactMap { c in
            guard let a = c["action"] as? String, let i = c["impl"] as? String else { return nil }
            return Capability(action: a, impl: i, destructive: c["destructive"] as? Bool ?? false)
        }
        canControl = (m["permissions"] as? [String: Any])?["control"] as? Bool == true
        epoch = UUID().uuidString
        seq = 0
        sendControl(["t": PRProtocol.Ctl.epoch, "epoch": epoch])
        set(.live)
        backoff = 1
        if !pending.isEmpty { sendControl(["t": PRProtocol.Ctl.cmdQuery, "ids": Array(pending.keys)]) }
    }

    private func onAck(_ m: [String: Any]) {
        guard let id = m["id"] as? String, let p = pending[id] else { return }
        let status = m["status"] as? String ?? "error"
        if status == "in_progress" { return }
        pending.removeValue(forKey: id)
        let verified = m["verified"] as? Bool ?? false
        let err = (m["error"] as? [String: Any])?["message"] as? String
        let msg: String
        switch status {
        case "ok": msg = verified ? "\(p.label): done" : "\(p.label): sent" + ((m["note"] as? String).map { " — \($0)" } ?? " (cannot be verified)")
        case "unsupported": msg = "\(p.label): not supported (\(err ?? ""))"
        case "forbidden": msg = "\(p.label): this device is view-only"
        default: msg = "\(p.label) failed: \(err ?? status)"
        }
        lastAck = AckInfo(status: status, verified: verified, message: msg, at: Date())
    }

    private func onCmdStatus(_ m: [String: Any]) {
        for r in m["results"] as? [[String: Any]] ?? [] {
            guard let id = r["id"] as? String, let p = pending[id] else { continue }
            switch r["state"] as? String {
            case "done":
                var res = r["result"] as? [String: Any] ?? [:]
                res["id"] = id
                onAck(res)
            case "unknown":
                pending.removeValue(forKey: id)
                lastAck = AckInfo(status: "lost", verified: false, message: "\(p.label) never reached the PC and was NOT re-sent. Check the timeline, then repeat it if needed.", at: Date())
            default:
                break
            }
        }
    }

    private func onStatus(_ m: [String: Any]) {
        let pr = m["premiere"] as? [String: Any] ?? [:]
        let proj = pr["project"] as? [String: Any]
        let seqd = proj?["sequence"] as? [String: Any]
        let cap = m["capture"] as? [String: Any]
        let fg = pr["foreground"] as? [String: Any]
        host = HostView(
            premiereRunning: pr["running"] as? Bool ?? false, minimized: pr["minimized"] as? Bool ?? false,
            modal: pr["modal"] as? Bool ?? false, locked: pr["locked"] as? Bool ?? false,
            foregroundTitle: fg?["title"] as? String ?? "", foregroundIsPremiere: fg?["isPremiere"] as? Bool ?? true,
            projectName: (proj?["project"] as? [String: Any])?["name"] as? String,
            sequenceName: seqd?["name"] as? String, sequenceGuid: seqd?["guid"] as? String,
            captureMode: cap?["mode"] as? String, captureW: cap?["width"] as? Int, captureH: cap?["height"] as? Int,
            quality: m["quality"] as? String, autoQuality: m["auto"] as? Bool ?? false,
            pluginConnected: m["plugin"] as? Bool ?? false, hostEncoder: (m["stream"] as? [String: Any])?["encoder"] as? String)
    }

    func notice(_ text: String) {
        guard !text.isEmpty else { return }
        notices = Array((notices.filter { $0 != text } + [text]).suffix(3))
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.notices.removeAll { $0 == text } }
    }

    func dismissNotices() { notices = [] }

    private func startTimers() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func tick() {
        rtc?.stats { [weak self] s in self?.stats = s }
        if phase == .live {
            let id = UUID().uuidString
            pings[id] = Date()
            if pings.count > 10, let oldest = pings.min(by: { $0.value < $1.value })?.key { pings.removeValue(forKey: oldest) }
            sendControl(["t": PRProtocol.Ctl.ping, "id": id, "ts": Int(Date().timeIntervalSince1970 * 1000)])
            let stale = pending.values.filter { Date().timeIntervalSince($0.sentAt) > 8 }.map(\.id)
            if !stale.isEmpty { sendControl(["t": PRProtocol.Ctl.cmdQuery, "ids": stale]) }
        }
        if let since = failedSince, Date().timeIntervalSince(since) > 12 {
            // the PC could not restart ICE: start a fresh session (new epoch)
            if let sid = sessionId { signaling?.send(["t": PRProtocol.Sig.sessionEnd, "sessionId": sid, "reason": "media_failed"]) }
            teardown()
            set(.reconnecting, "Re-establishing the stream…")
            requestSession()
        }
    }

    @discardableResult
    private func sendControl(_ m: [String: Any]) -> Bool { rtc?.send("control", m) ?? false }

    // MARK: public actions
    func command(_ action: String, label: String, args: [String: Any] = [:]) {
        guard phase == .live else {
            lastAck = AckInfo(status: "offline", verified: false, message: "\(label) not sent: not connected.", at: Date())
            return
        }
        let id = UUID().uuidString.lowercased()
        var msg: [String: Any] = ["t": PRProtocol.Ctl.cmd, "id": id, "action": action, "args": args]
        if PRProtocol.destructive.contains(action), let g = host.sequenceGuid, !g.isEmpty { msg["expect"] = ["sequenceGuid": g] }
        if sendControl(msg) { pending[id] = PendingCommand(id: id, action: action, label: label, sentAt: Date()) }
    }

    func move(_ p: CGPoint) {
        seq += 1
        rtc?.send("pointer", ["t": "move", "x": p.x, "y": p.y, "seq": seq, "ts": Int(Date().timeIntervalSince1970 * 1000), "epoch": epoch])
    }

    func rel(dx: CGFloat, dy: CGFloat) {
        seq += 1
        rtc?.send("pointer", ["t": "rel", "dx": dx, "dy": dy, "seq": seq, "ts": Int(Date().timeIntervalSince1970 * 1000), "epoch": epoch])
    }

    func pointer(_ kind: String, at p: CGPoint?, button: String = "left", dy: Int = 0) {
        var m: [String: Any] = ["t": PRProtocol.Ctl.pointer, "kind": kind, "button": button, "epoch": epoch]
        if let p { m["x"] = p.x; m["y"] = p.y }
        if kind == "scroll" { m["dy"] = dy }
        sendControl(m)
    }

    func key(_ combo: String) {
        let id = UUID().uuidString.lowercased()
        if sendControl(["t": PRProtocol.Ctl.key, "id": id, "combo": combo]) { pending[id] = PendingCommand(id: id, action: "key", label: combo, sentAt: Date()) }
    }

    func text(_ s: String) {
        guard !s.isEmpty else { return }
        let id = UUID().uuidString.lowercased()
        if sendControl(["t": PRProtocol.Ctl.text, "id": id, "text": String(s.prefix(500))]) { pending[id] = PendingCommand(id: id, action: "text", label: "Typing", sentAt: Date()) }
    }

    func setCapture(_ mode: String) { sendControl(["t": PRProtocol.Ctl.captureSet, "mode": mode]) }
    func setQuality(_ p: String) { sendControl(["t": PRProtocol.Ctl.qualitySet, "profile": p]) }
}
