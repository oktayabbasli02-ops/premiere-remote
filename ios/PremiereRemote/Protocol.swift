import Foundation
import CryptoKit

/// Mirrors shared/src/protocol.js + auth.js (and the Kotlin Protocol.kt). Keep them in sync.
enum PRProtocol {
    static let authContext = "PREMIERE-REMOTE-AUTH-V1"

    enum Sig {
        static let hello = "hello", welcome = "welcome", error = "error"
        static let sessionRequest = "session.request", sessionCreated = "session.created"
        static let sessionAccept = "session.accept", sessionReject = "session.reject", sessionEnd = "session.end"
        static let signal = "signal", hostStatus = "host.status"
    }

    enum Ctl {
        static let authChallenge = "auth.challenge", authResponse = "auth.response", authOk = "auth.ok", authFail = "auth.fail"
        static let cmd = "cmd", ack = "ack", cmdQuery = "cmd.query", cmdStatus = "cmd.status"
        static let pointer = "ptr", key = "key", text = "text", status = "status"
        static let captureSet = "capture.set", qualitySet = "quality.set"
        static let ping = "ping", pong = "pong", notice = "notice", epoch = "epoch", bye = "bye"
    }

    /// Commands that change the project; never re-sent automatically after a reconnect.
    static let destructive: Set<String> = [
        "setIn", "setOut", "addMarker", "addEdit", "deleteSelection", "rippleDeleteSelection",
        "trimPrevToPlayhead", "trimNextToPlayhead", "undo", "redo",
    ]

    enum TranscriptError: Error { case invalidField }

    static func transcript(role: String, hostId: String, deviceId: String, sessionId: String,
                           hostNonce: String, deviceNonce: String, hostFingerprint: String, deviceFingerprint: String) throws -> String {
        let fields = [role, hostId, deviceId, sessionId, hostNonce, deviceNonce, hostFingerprint, deviceFingerprint]
        guard fields.allSatisfy({ !$0.isEmpty && !$0.contains("|") }) else { throw TranscriptError.invalidField }
        return ([authContext] + fields).joined(separator: "|")
    }

    static func extractFingerprint(_ sdp: String) -> String? {
        // SDP lines end in CRLF, and Swift treats "\r\n" as ONE Character, so split on Unicode
        // scalars (CharacterSet.newlines) rather than comparing Characters to "\r" / "\n".
        for line in sdp.components(separatedBy: .newlines) {
            let prefix = "a=fingerprint:sha-256 "
            guard line.hasPrefix(prefix) else { continue }
            let fp = line.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
            if fp.count == 95 { return fp.uppercased() }
        }
        return nil
    }

    /// Short key ID shown on both phone and PC during pairing, e.g. "3FA2-91C0".
    static func keyHash(spkiBase64: String) -> String? {
        guard let der = Data(base64Encoded: spkiBase64) else { return nil }
        let hex = SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined()
        return "\(hex.prefix(4))-\(hex.dropFirst(4).prefix(4))"
    }

    static func normalizeCode(_ input: String) -> String? {
        let digits = input.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
        guard digits.count == 8, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return digits
    }
}
