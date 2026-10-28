import XCTest
import CryptoKit
@testable import PremiereRemote

/// Vectors produced by shared/src/auth.js and companion keyHash() (same as the Kotlin ProtocolTest).
final class ProtocolTests: XCTestCase {
    func testTranscriptMatchesNodeImplementation() throws {
        XCTAssertEqual(try PRProtocol.transcript(role: "device", hostId: "h_1", deviceId: "d_1", sessionId: "s-1",
                                                 hostNonce: "hn", deviceNonce: "dn", hostFingerprint: "AA", deviceFingerprint: "BB"),
                       "PREMIERE-REMOTE-AUTH-V1|device|h_1|d_1|s-1|hn|dn|AA|BB")
    }

    func testTranscriptRejectsSeparator() {
        XCTAssertThrowsError(try PRProtocol.transcript(role: "device", hostId: "h|1", deviceId: "d", sessionId: "s",
                                                       hostNonce: "a", deviceNonce: "b", hostFingerprint: "c", deviceFingerprint: "d"))
    }

    func testKeyHashMatchesHost() {
        let spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw=="
        XCTAssertEqual(PRProtocol.keyHash(spkiBase64: spki), "0131-DDA9")
    }

    func testFingerprintExtraction() {
        let fp = (0..<32).map { String(format: "%02x", $0) }.joined(separator: ":")
        XCTAssertEqual(PRProtocol.extractFingerprint("v=0\r\na=fingerprint:sha-256 \(fp)\r\na=setup:active\r\n"), fp.uppercased())
        XCTAssertNil(PRProtocol.extractFingerprint("v=0\r\n"))
    }

    func testCodeNormalisationKeepsLeadingZeros() {
        XCTAssertEqual(PRProtocol.normalizeCode("0001 2345"), "00012345")
        XCTAssertNil(PRProtocol.normalizeCode("12345"))
    }

    /// The encodings the PC expects: SPKI DER public key and DER ECDSA signature over SHA-256.
    func testSignatureEncodingIsDerAndVerifies() throws {
        let k = P256.Signing.PrivateKey()
        let sig = try k.signature(for: Data("hello".utf8))
        XCTAssertEqual(sig.derRepresentation.first, 0x30)
        let spki = k.publicKey.derRepresentation.base64EncodedString()
        XCTAssertTrue(Identity.shared.verifyHost(spki: spki, transcript: "hello", signature: sig.derRepresentation.base64EncodedString()))
        XCTAssertFalse(Identity.shared.verifyHost(spki: spki, transcript: "hellO", signature: sig.derRepresentation.base64EncodedString()))
    }
}
