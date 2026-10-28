// Media engine (hidden renderer). Owns RTCPeerConnection, screen/audio capture and encoding.
// Chromium's WebRTC stack gives us: hardware H.264 encoding via Media Foundation where the GPU
// supports it (falls back to software), GCC congestion control (adaptive bitrate), DTLS-SRTP.
// Media tracks are attached only after the main process reports successful device auth.

/* global engineApi */

const sessions = new Map();

function log(...a) {
  console.log('[engine]', ...a);
}

function preferCodecs(transceiver) {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps || typeof transceiver.setCodecPreferences !== 'function') return;
  const rank = (c) => {
    if (/h264/i.test(c.mimeType)) return /packetization-mode=1/.test(c.sdpFmtpLine ?? '') && /profile-level-id=42e01f/.test(c.sdpFmtpLine ?? '') ? 0 : 1;
    if (/vp8/i.test(c.mimeType)) return 2;
    if (/vp9/i.test(c.mimeType)) return 3;
    if (/(rtx|red|ulpfec)/i.test(c.mimeType)) return 5;
    return 4;
  };
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  transceiver.setCodecPreferences(sorted);
}

async function acquire(s) {
  // the main process decides which source this resolves to (Premiere window or a display)
  const video = { width: { max: s.profile.maxWidth }, height: { max: s.profile.maxHeight }, frameRate: { max: s.profile.maxFps }, cursor: 'always' };
  if (!s.audioBroken) {
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video, audio: true });
    } catch (e) {
      // e.g. no default playback device: keep streaming video rather than failing the session
      s.audioBroken = true;
      engineApi.emit('error', { sessionId: s.id, message: `System audio capture failed (${e.message}); streaming video only.` });
    }
  }
  return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
}

async function applyQuality(s, profile) {
  s.profile = profile;
  const vt = s.stream?.getVideoTracks()[0];
  if (vt) {
    try {
      await vt.applyConstraints({ width: { max: profile.maxWidth }, height: { max: profile.maxHeight }, frameRate: { max: profile.maxFps } });
    } catch (e) {
      log('applyConstraints failed', e.message);
    }
  }
  const sender = s.videoTx.sender;
  const p = sender.getParameters();
  if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
  p.encodings[0].maxBitrate = profile.maxBitrate;
  p.encodings[0].maxFramerate = profile.maxFps;
  p.degradationPreference = 'balanced';
  try {
    await sender.setParameters(p);
  } catch (e) {
    log('setParameters failed', e.message);
  }
}

async function attachMedia(s) {
  if (!s.stream) s.stream = await acquire(s);
  const vt = s.stream.getVideoTracks()[0];
  const at = s.stream.getAudioTracks()[0] ?? null;
  vt.addEventListener('ended', () => engineApi.emit('error', { sessionId: s.id, message: 'Capture source ended (window closed or display removed).' }));
  await s.videoTx.sender.replaceTrack(vt);
  await s.audioTx.sender.replaceTrack(at);
  if (!at && !s.audioBroken) engineApi.emit('error', { sessionId: s.id, message: 'System audio capture unavailable; streaming video only.' });
  await applyQuality(s, s.profile);
  // The real frame size is reported from outbound-rtp stats (collectStats): getSettings() echoes the
  // max constraints (e.g. 1280x720) rather than the aspect-preserving size actually produced (1280x688).
  s.lastCapture = null;
}

async function start({ sessionId, iceServers, quality }) {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  const s = { id: sessionId, pc, profile: quality, stream: null, mediaEnabled: false, lastBytes: null };
  sessions.set(sessionId, s);

  s.videoTx = pc.addTransceiver('video', { direction: 'sendonly' });
  s.audioTx = pc.addTransceiver('audio', { direction: 'sendonly' });
  preferCodecs(s.videoTx);

  s.control = pc.createDataChannel('control', { ordered: true });
  s.pointer = pc.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 });
  for (const [name, dc] of [['control', s.control], ['pointer', s.pointer]]) {
    dc.onopen = () => engineApi.emit('dc-open', { sessionId, channel: name });
    dc.onmessage = (e) => { if (typeof e.data === 'string') engineApi.emit('dc-message', { sessionId, channel: name, msg: e.data }); };
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) engineApi.emit('signal', { sessionId, data: { type: 'candidate', candidate: e.candidate.toJSON() } });
  };
  let disconnectTimer = null;
  pc.onconnectionstatechange = () => {
    engineApi.emit('state', { sessionId, state: pc.connectionState });
    clearTimeout(disconnectTimer);
    if (pc.connectionState === 'disconnected') disconnectTimer = setTimeout(() => restartIce(s), 3000);
    if (pc.connectionState === 'failed') restartIce(s);
  };

  await pc.setLocalDescription(await pc.createOffer());
  engineApi.emit('signal', { sessionId, data: { type: 'offer', sdp: pc.localDescription.sdp } });

  s.statsTimer = setInterval(() => collectStats(s), 2000);
}

async function restartIce(s) {
  if (s.restarting || s.pc.signalingState === 'closed') return;
  s.restarting = true;
  try {
    log('ICE restart');
    await s.pc.setLocalDescription(await s.pc.createOffer({ iceRestart: true }));
    engineApi.emit('signal', { sessionId: s.id, data: { type: 'offer', sdp: s.pc.localDescription.sdp, iceRestart: true } });
  } catch (e) {
    engineApi.emit('error', { sessionId: s.id, message: `ICE restart failed: ${e.message}` });
  } finally {
    setTimeout(() => { s.restarting = false; }, 5000);
  }
}

async function onSignal({ sessionId, data }) {
  const s = sessions.get(sessionId);
  if (!s || !data) return;
  try {
    if (data.type === 'answer') await s.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    else if (data.type === 'candidate' && data.candidate) await s.pc.addIceCandidate(data.candidate);
  } catch (e) {
    log('signal handling failed', e.message);
  }
}

async function collectStats(s) {
  const report = await s.pc.getStats();
  const out = { ts: Date.now() };
  let pairId = null;
  const byId = new Map();
  report.forEach((r) => byId.set(r.id, r));
  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    if (r.type === 'outbound-rtp' && r.kind === 'video') {
      out.frameWidth = r.frameWidth;
      out.frameHeight = r.frameHeight;
      const key = `${r.frameWidth}x${r.frameHeight}`;
      if (r.frameWidth && r.frameHeight && s.lastCapture !== key) {
        s.lastCapture = key;
        engineApi.emit('capture', { sessionId: s.id, width: r.frameWidth, height: r.frameHeight });
      }
      out.fps = r.framesPerSecond;
      out.encoder = r.encoderImplementation;
      out.powerEfficientEncoder = r.powerEfficientEncoder;
      out.qualityLimitationReason = r.qualityLimitationReason;
      if (s.lastBytes) out.videoBitrate = Math.round(((r.bytesSent - s.lastBytes.bytes) * 8) / ((r.timestamp - s.lastBytes.ts) / 1000));
      s.lastBytes = { bytes: r.bytesSent, ts: r.timestamp };
      const codec = byId.get(r.codecId);
      if (codec) out.codec = codec.mimeType;
    }
  });
  const pair = pairId ? byId.get(pairId) : null;
  if (pair) {
    out.rttMs = pair.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : null;
    out.availableOutgoingBitrate = pair.availableOutgoingBitrate ?? null;
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    out.localCandidate = local?.candidateType;
    out.remoteCandidate = remote?.candidateType;
    out.relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  }
  engineApi.emit('stats', { sessionId: s.id, stats: out });
}

function stop({ sessionId }) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  clearInterval(s.statsTimer);
  s.stream?.getTracks().forEach((t) => t.stop());
  try { s.pc.close(); } catch { /* ignore */ }
}

engineApi.on('start', (p) => start(p).catch((e) => engineApi.emit('error', { sessionId: p.sessionId, message: e.message })));
engineApi.on('signal', onSignal);
engineApi.on('enable-media', async ({ sessionId }) => {
  const s = sessions.get(sessionId);
  if (!s || s.mediaEnabled) return;
  s.mediaEnabled = true;
  try {
    await attachMedia(s);
  } catch (e) {
    engineApi.emit('error', { sessionId, message: `Capture failed: ${e.message}` });
  }
});
engineApi.on('switch-source', async ({ sessionId }) => {
  const s = sessions.get(sessionId);
  if (!s || !s.mediaEnabled) return;
  const old = s.stream;
  s.stream = null;
  try {
    await attachMedia(s);
    old?.getTracks().forEach((t) => t.stop());
  } catch (e) {
    s.stream = old;
    engineApi.emit('error', { sessionId, message: `Switching capture failed: ${e.message}` });
  }
});
engineApi.on('set-quality', ({ sessionId, profile }) => {
  const s = sessions.get(sessionId);
  if (s) applyQuality(s, profile); // new frame size arrives via stats
});
engineApi.on('dc-send', ({ sessionId, channel, msg }) => {
  const s = sessions.get(sessionId);
  const dc = channel === 'pointer' ? s?.pointer : s?.control;
  if (dc?.readyState === 'open') dc.send(JSON.stringify(msg));
});
engineApi.on('stop', stop);
log('ready');
