// Secrets at rest: host token, host identity private key, trusted devices and plugin token hashes.
// Encrypted with Electron safeStorage, which uses Windows DPAPI bound to the current user account.
// Non-secret settings live in settings.json next to it.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EMPTY = () => ({ hostId: null, hostToken: null, serverUrl: null, hostKey: null, devices: [], pluginTokenHashes: [] });

export class Vault {
  /** @param {{dir:string, safeStorage:{isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string}}} opts */
  constructor({ dir, safeStorage }) {
    this.file = join(dir, 'vault.bin');
    this.dir = dir;
    this.safe = safeStorage;
    this.data = EMPTY();
  }

  load() {
    if (!this.safe.isEncryptionAvailable()) throw new Error('Windows secure storage (DPAPI) is not available');
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.file)) this.data = { ...EMPTY(), ...JSON.parse(this.safe.decryptString(readFileSync(this.file))) };
    return this;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.safe.encryptString(JSON.stringify(this.data)));
    renameSync(tmp, this.file);
  }

  update(fn) {
    fn(this.data);
    this.save();
  }

  device(deviceId) {
    return this.data.devices.find((d) => d.deviceId === deviceId) ?? null;
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  serverUrl: '',
  registrationKey: '',
  quality: 'auto',
  captureMode: 'window', // window | display
  displayId: null,
  allowInputOutsidePremiere: false,
  preventSleepWhileEnabled: true,
  saveReminderMinutes: 10,
  pluginCallerAllowlist: ['Adobe Premiere Pro.exe'],
  shortcutProfileFile: null,
});

export function loadSettings(dir) {
  const f = join(dir, 'settings.json');
  if (!existsSync(f)) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(f, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(dir, s) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(s, null, 2));
}
