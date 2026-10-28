import Foundation

enum PairResult {
    case approved(PairedHost, deviceToken: String)
    case failed(String)
}

/// Claims the 8-digit code, then long-polls until the PC owner approves or rejects.
struct PairingAPI {
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 40
        return URLSession(configuration: c)
    }()

    private func post(_ base: String, _ path: String, _ body: [String: Any]) async throws -> (Int, [String: Any]) {
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, json)
    }

    func pair(server: String, code: String, deviceName: String, onWaiting: @MainActor @escaping () -> Void) async -> PairResult {
        let claim: (Int, [String: Any])
        do {
            claim = try await post(server, "/v1/pair/claim", ["code": code, "deviceName": deviceName, "devicePublicKey": Identity.shared.publicKeySpki])
        } catch {
            return .failed("Cannot reach server: \(error.localizedDescription)")
        }
        switch claim.0 {
        case 200: break
        case 404: return .failed("Code is wrong, expired or already used. Generate a new code on the PC.")
        case 429: return .failed("Too many attempts. Wait \(claim.1["retryAfterSec"] as? Int ?? 60) s.")
        default: return .failed("Server error (\(claim.0))")
        }
        await onWaiting()
        let waitBody: [String: Any] = ["pairingId": claim.1["pairingId"] ?? "", "pairingSecret": claim.1["pairingSecret"] ?? ""]
        for _ in 0..<16 {
            guard let (status, r) = try? await post(server, "/v1/pair/wait", waitBody) else { return .failed("Lost connection while waiting for approval.") }
            guard status == 200 else { return .failed("Pairing request expired.") }
            switch r["status"] as? String {
            case "approved":
                guard let hostId = r["hostId"] as? String, let deviceId = r["deviceId"] as? String,
                      let token = r["deviceToken"] as? String, let hostKey = r["hostPublicKey"] as? String else { return .failed("Malformed server response.") }
                let control = (r["permissions"] as? [String: Any])?["control"] as? Bool ?? false
                return .approved(PairedHost(hostId: hostId, hostName: r["hostName"] as? String ?? "PC", serverUrl: server,
                                            deviceId: deviceId, hostPublicKey: hostKey, canControl: control), deviceToken: token)
            case "rejected":
                return .failed((r["reason"] as? String) == "host_offline" ? "The PC is offline." : "The PC owner rejected the request.")
            case "expired":
                return .failed("Pairing request expired.")
            default:
                continue // pending
            }
        }
        return .failed("No decision from the PC.")
    }
}
