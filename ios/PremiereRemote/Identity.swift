import Foundation
import CryptoKit
import Security

struct PairedHost: Codable, Identifiable, Equatable {
    var id: String { hostId }
    let hostId: String
    let hostName: String
    let serverUrl: String
    let deviceId: String
    let hostPublicKey: String
    let canControl: Bool
}

/// Long-lived credentials.
///  - Device identity: P-256 signing key in the Secure Enclave (non-exportable; its opaque
///    `dataRepresentation` blob is only usable by this device's enclave). On the Simulator, which
///    has no enclave, a software key is kept in the Keychain (ThisDeviceOnly) instead.
///  - Device tokens: Keychain generic passwords, ThisDeviceOnly (never synced, not in backups).
final class Identity {
    static let shared = Identity()
    private let service = "com.premiereremote.app"

    // MARK: identity key
    private enum Key {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)

        var publicKey: P256.Signing.PublicKey {
            switch self {
            case .enclave(let k): return k.publicKey
            case .software(let k): return k.publicKey
            }
        }

        func sign(_ data: Data) throws -> P256.Signing.ECDSASignature {
            switch self {
            case .enclave(let k): return try k.signature(for: data)
            case .software(let k): return try k.signature(for: data)
            }
        }
    }

    private lazy var key: Key = loadOrCreateKey()

    private func loadOrCreateKey() -> Key {
        if SecureEnclave.isAvailable {
            if let blob = keychainGet("identity.enclave"), let k = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob) {
                return .enclave(k)
            }
            if let k = try? SecureEnclave.P256.Signing.PrivateKey() {
                keychainSet("identity.enclave", k.dataRepresentation)
                return .enclave(k)
            }
        }
        if let raw = keychainGet("identity.software"), let k = try? P256.Signing.PrivateKey(rawRepresentation: raw) {
            return .software(k)
        }
        let k = P256.Signing.PrivateKey()
        keychainSet("identity.software", k.rawRepresentation)
        return .software(k)
    }

    var usesSecureEnclave: Bool { if case .enclave = key { return true } else { return false } }

    /// SubjectPublicKeyInfo DER, base64 — same encoding Node and Android use.
    var publicKeySpki: String { key.publicKey.derRepresentation.base64EncodedString() }

    var keyId: String { PRProtocol.keyHash(spkiBase64: publicKeySpki) ?? "?" }

    /// SHA256withECDSA, DER signature (what the PC verifies with Node's crypto.verify).
    func sign(_ transcript: String) throws -> String {
        try key.sign(Data(transcript.utf8)).derRepresentation.base64EncodedString()
    }

    func verifyHost(spki: String, transcript: String, signature: String) -> Bool {
        guard let der = Data(base64Encoded: spki), let sigData = Data(base64Encoded: signature),
              let pub = try? P256.Signing.PublicKey(derRepresentation: der),
              let sig = try? P256.Signing.ECDSASignature(derRepresentation: sigData) else { return false }
        return pub.isValidSignature(sig, for: Data(transcript.utf8))
    }

    // MARK: hosts + tokens
    func hosts() -> [PairedHost] {
        guard let d = UserDefaults.standard.data(forKey: "hosts") else { return [] }
        return (try? JSONDecoder().decode([PairedHost].self, from: d)) ?? []
    }

    func save(host: PairedHost, deviceToken: String) {
        keychainSet("token.\(host.hostId)", Data(deviceToken.utf8))
        let list = hosts().filter { $0.hostId != host.hostId } + [host]
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: "hosts")
    }

    func token(hostId: String) -> String? {
        keychainGet("token.\(hostId)").flatMap { String(data: $0, encoding: .utf8) }
    }

    func forget(hostId: String) {
        keychainDelete("token.\(hostId)")
        UserDefaults.standard.set(try? JSONEncoder().encode(hosts().filter { $0.hostId != hostId }), forKey: "hosts")
    }

    var lastServerUrl: String {
        get { UserDefaults.standard.string(forKey: "lastServer") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "lastServer") }
    }

    // MARK: keychain
    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func keychainSet(_ account: String, _ data: Data) {
        SecItemDelete(query(account) as CFDictionary)
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    private func keychainGet(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private func keychainDelete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
