import Foundation

/// Device-side signaling over WSS (URLSessionWebSocketTask). Reconnect policy lives in
/// RemoteController so a reconnect always means a brand-new session.
final class SignalingClient {
    var onMessage: (([String: Any]) -> Void)?
    var onClose: ((Int) -> Void)?

    private let url: URL
    private let deviceId: String
    private let token: String
    private var task: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .ephemeral)
    private var closed = false

    init?(serverUrl: String, deviceId: String, token: String) {
        var s = serverUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if s.hasPrefix("https://") { s = "wss://" + s.dropFirst(8) } else if s.hasPrefix("http://") { s = "ws://" + s.dropFirst(7) }
        guard let u = URL(string: s + "/v1/ws") else { return nil }
        url = u
        self.deviceId = deviceId
        self.token = token
    }

    func connect() {
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        send(["t": PRProtocol.Sig.hello, "role": "device", "deviceId": deviceId, "token": token])
        receive(t)
        ping(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, self.task === t else { return }
            switch result {
            case .success(.string(let text)):
                if let d = text.data(using: .utf8), let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                    DispatchQueue.main.async { self.onMessage?(obj) }
                }
                self.receive(t)
            case .success:
                self.receive(t)
            case .failure:
                let code = t.closeCode.rawValue
                DispatchQueue.main.async { self.finish(code: code == 0 ? -1 : code) }
            }
        }
    }

    private func ping(_ t: URLSessionWebSocketTask) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.task === t, !self.closed else { return }
            t.sendPing { _ in }
            self.ping(t)
        }
    }

    private func finish(code: Int) {
        guard !closed else { return }
        closed = true
        task = nil
        onClose?(code)
    }

    func send(_ obj: [String: Any]) {
        guard let t = task, let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        t.send(.string(s)) { _ in }
    }

    func close() {
        closed = true
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }
}
