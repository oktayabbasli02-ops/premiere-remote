// Log redaction. Pairing codes, tokens, secrets, keys, SDP and signatures never reach logs.

const SECRET_KEYS = /^(code|token|hostToken|deviceToken|pairingSecret|secret|password|credential|sig|signature|sdp|candidate|privateKey.*|registrationKey|authorization|pluginToken)$/i;

export function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // belt and braces: an 8-digit run anywhere in free text is masked
    return value.replace(/\b\d{8}\b/g, '[8-digit redacted]');
  }
  return value;
}

export function createLogger(name, sink = console) {
  const emit = (level, msg, fields) => {
    const line = { ts: new Date().toISOString(), level, name, msg: redact(String(msg)) };
    if (fields !== undefined) line.fields = redact(fields);
    sink[level === 'error' ? 'error' : 'log'](JSON.stringify(line));
  };
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    debug: (msg, fields) => (process.env.PR_DEBUG ? emit('debug', msg, fields) : undefined),
  };
}
