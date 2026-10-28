# Protocol reference (v1)

Source of truth: `shared/src/protocol.js` (Node) and `android/.../protocol/Protocol.kt` (Kotlin). All messages are JSON objects with a `t` field.

## HTTP (signaling server)

| Method / path | Body | Response |
|---|---|---|
| `GET /healthz` | — | `{ok, v}` |
| `POST /v1/hosts/register` | `{name, registrationKey?}` | `{hostId, hostToken}` (rate-limited 3/h/IP) |
| `POST /v1/pair/claim` | `{code, deviceName, devicePublicKey}` (SPKI base64, P-256) | `200 {pairingId, pairingSecret}` · `404 {error:"expired"}` for wrong/expired/used · `429 {retryAfterSec}` |
| `POST /v1/pair/wait` | `{pairingId, pairingSecret}` | long-poll ≤25 s: `{status:"pending"}` · `{status:"approved", hostId, hostName, hostPublicKey, deviceId, deviceToken, permissions}` (delivered once) · `{status:"rejected", reason}` |

## Signaling WebSocket `/v1/ws`

First frame: `{t:"hello", role:"host", hostId, token}` or `{t:"hello", role:"device", deviceId, token}` → `{t:"welcome", …}` or `{t:"error", code:"unauthorized"}` + close `4001`.

Host → server: `pairing.create`, `pairing.cancel`, `pairing.decision {pairingId, approve, hostPublicKey, hostName, permissions:{control}}`, `device.revoke {deviceId}`, `devices.sync {deviceIds}`, `session.accept|session.reject|session.end {sessionId}`, `signal {sessionId, data}`.
Server → host: `pairing.code {code, expiresAt, ttlMs}`, `pairing.request {pairingId, deviceName, devicePublicKey}`, `pairing.completed {pairingId, deviceId}`, `device.revoked`, `session.request {sessionId, deviceId, iceServers}`, `signal`, `session.end`.
Device → server: `session.request {clientRef}`, `signal`, `session.end`.
Server → device: `welcome {hostId, hostOnline}`, `host.status {online}`, `session.created {sessionId}`, `session.accept {sessionId, iceServers}`, `session.reject {reason}`, `signal`, `session.end {reason}`.
Close codes: `4001` unauthorized, `4002` replaced by a newer connection, `4003` revoked, `4029` rate limited.

`signal.data`: `{type:"offer"|"answer", sdp}` or `{type:"candidate", candidate:{candidate, sdpMid, sdpMLineIndex}}`. The host is always the offerer (also for ICE restarts).

## Data channels

- `control` — reliable, ordered.
- `pointer` — unordered, `maxRetransmits: 0`; only `move` and `rel` (continuous, may be dropped).

### Authentication (control)

1. host → `{t:"auth.challenge", hostNonce, sessionId, hostId}`
2. device → `{t:"auth.response", deviceNonce, sig}` — `sig` = ECDSA-P256-SHA256 (DER, base64) over
   `PREMIERE-REMOTE-AUTH-V1|device|hostId|deviceId|sessionId|hostNonce|deviceNonce|hostFp|deviceFp`
   (`hostFp`/`deviceFp` = `a=fingerprint:sha-256` of the host offer / device answer, upper-case).
3. host → `{t:"auth.ok", sig, permissions:{view, control}, capabilities:[{action, impl, destructive, verified, shortcut}], profile}` with `sig` over the same transcript with role `host`; or `{t:"auth.fail"}`.
4. device → `{t:"epoch", epoch}` (new UUID per connection).

### Commands

- device → `{t:"cmd", id:<uuid>, action, args, expect?:{sequenceGuid}}`
- host → `{t:"ack", id, status:"ok"|"error"|"unsupported"|"forbidden"|"in_progress", via:"api"|"keyboard", verified, data?, note?, error?:{code,message}, duplicate?}`
- device → `{t:"cmd.query", ids:[…]}` → host `{t:"cmd.status", results:[{id, state:"done"|"inflight"|"unknown", result?}]}`

Rules: commands run strictly in order (one queue per session); the journal (per device, 15 min) answers duplicates without re-executing; after reconnect the phone **queries** pending ids and never re-sends destructive commands automatically.

### Input

- `{t:"ptr", kind:"down"|"up"|"click"|"dblclick"|"scroll", x?, y?, button, dy?, dx?, epoch, id?}` on `control` (normalized 0..1 coordinates of the streamed frame; omitted = current cursor).
- `{t:"move", x, y, seq, ts, epoch}` / `{t:"rel", dx, dy, seq, ts, epoch}` on `pointer`; dropped when `epoch` is old, `seq` not increasing, or older than 350 ms (clock offset from host ping/pong).
- `{t:"key", id, combo}` (e.g. `"Ctrl+Shift+Z"`), `{t:"text", id, text}` → `ack`.

### Status / misc

- host → `{t:"status", premiere:{running, minimized, modal, locked, foreground:{isPremiere, isMain, title}, project}, capture:{mode,width,height,title}, stream:{…getStats}, quality, auto, plugin, appRttMs}` every second.
- host → `{t:"notice", code, message}` (save reminder, capture/audio problems, lock screen, mapping warning).
- `{t:"capture.set", mode:"window"|"display"}`, `{t:"quality.set", profile:"auto"|"saver"|"responsive"|"balanced"|"quality"}`.
- `{t:"ping", id, ts}` ↔ `{t:"pong", id, ts, hostTs}` (both directions).

## Local panel bridge `ws://127.0.0.1:47631`

panel → `{t:"hello", pluginVersion, pluginToken?}` · companion → `{t:"welcome", pluginToken?}` | `{t:"denied", reason}`
companion → `{t:"req", id, op, args}` · panel → `{t:"res", id, ok, result|error}` (ops = API actions + `countTrackItems`, `playerPosition`)
companion → `{t:"state", state}` · panel → `{t:"ui", action, args}` (`enableRemote`, `disableRemote`, `newCode`, `cancelCode`, `decide`, `revokeDevice`, `updateDevice`, `endSession`)
