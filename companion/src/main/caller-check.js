// Identifies the local process on the other end of a loopback TCP connection
// (used to validate that the plugin socket really comes from Premiere's UXP runtime).

import { execFile } from 'node:child_process';

/**
 * @param {number} remotePort the client's ephemeral port (req.socket.remotePort)
 * @param {number} serverPort our listening port
 * @returns {Promise<{pid:number, path:string}|null>}
 */
export function processForLoopbackClient(remotePort, serverPort) {
  const script = `$c = Get-NetTCPConnection -LocalPort ${Number(remotePort)} -RemotePort ${Number(serverPort)} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; "$($c.OwningProcess)|$($p.Path)" }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.trim().split(/\r?\n/).pop() ?? '';
      const [pid, path] = line.split('|');
      if (!pid) return resolve(null);
      resolve({ pid: Number(pid), path: path ?? '' });
    });
  });
}

export function matchesAllowlist(path, allowlist) {
  if (!path) return false;
  const exe = path.split('\\').pop().toLowerCase();
  return allowlist.some((a) => a.toLowerCase() === exe);
}
