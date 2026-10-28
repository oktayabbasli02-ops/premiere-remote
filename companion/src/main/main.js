// Premiere Remote companion — Electron main process.

import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, safeStorage, desktopCapturer, screen, powerMonitor, powerSaveBlocker, shell, nativeImage, session as electronSession } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createLogger } from '@premiere-remote/shared/redact';
import { DEFAULT_SHORTCUT_PROFILE } from '@premiere-remote/shared/commands';
import { Vault, loadSettings, saveSettings } from './vault.js';
import { Desktop } from './desktop.js';
import { PluginBridge } from './plugin-bridge.js';
import { CommandExecutor } from './executor.js';
import { CaptureSources } from './capture.js';
import { HostCore } from './host-core.js';
import { parseCombo } from './keys.js';

const here = dirname(fileURLToPath(import.meta.url));
const log = createLogger('companion');

// isolated profile for development/testing (e.g. PR_USER_DATA_DIR=C:\tmp\pr-test)
if (process.env.PR_USER_DATA_DIR) app.setPath('userData', process.env.PR_USER_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();

let uiWin = null;
let engineWin = null;
let tray = null;
let core = null;

function loadProfile(dir) {
  const f = join(dir, 'shortcuts.json');
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify(DEFAULT_SHORTCUT_PROFILE, null, 2));
    return { ...DEFAULT_SHORTCUT_PROFILE };
  }
  try {
    const p = JSON.parse(readFileSync(f, 'utf8'));
    for (const [k, v] of Object.entries(p.shortcuts ?? {})) {
      try { parseCombo(v); } catch (e) { log.warn('invalid shortcut ignored', { name: k, err: e.message }); delete p.shortcuts[k]; }
    }
    return { id: p.id ?? 'custom', name: p.name ?? 'Custom', shortcuts: p.shortcuts ?? {} };
  } catch (e) {
    log.error('shortcuts.json unreadable, using defaults', { err: e.message });
    return { ...DEFAULT_SHORTCUT_PROFILE };
  }
}

function createEngine() {
  engineWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(here, '../preload/engine-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep encoding/timers at full rate while hidden
    },
  });
  engineWin.loadFile(join(here, '../renderer/engine.html'));
  engineWin.on('closed', () => { engineWin = null; });
}

const engine = {
  send(name, payload) { engineWin?.webContents.send(`engine:${name}`, payload); },
  start(sessionId, opts) { this.send('start', { sessionId, ...opts }); },
  signal(sessionId, data) { this.send('signal', { sessionId, data }); },
  enableMedia(sessionId) { this.send('enable-media', { sessionId }); },
  switchSource(sessionId) { this.send('switch-source', { sessionId }); },
  setQuality(sessionId, profile) { this.send('set-quality', { sessionId, profile }); },
  dcSend(sessionId, channel, msg) { this.send('dc-send', { sessionId, channel, msg }); },
  stop(sessionId) { this.send('stop', { sessionId }); },
};

function createUi() {
  if (uiWin) { uiWin.show(); uiWin.focus(); return; }
  uiWin = new BrowserWindow({
    width: 520, height: 820, title: 'Premiere Remote',
    webPreferences: { preload: join(here, '../preload/ui-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  uiWin.setMenuBarVisibility(false);
  uiWin.loadFile(join(here, '../renderer/ui.html'));
  uiWin.on('closed', () => { uiWin = null; });
}

function trayIcon() {
  // 16x16 solid purple square; replace with a real .ico for release builds
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) buf.set([0xf0, 0x4c, 0x5b, 0xff], i * 4);
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTray(st) {
  if (!tray) return;
  const live = st.session?.authed;
  tray.setToolTip(live ? `Premiere Remote — ${st.session.deviceName} connected` : st.remoteEnabled ? 'Premiere Remote — remote access ON' : 'Premiere Remote — off');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Premiere Remote', click: createUi },
    { type: 'separator' },
    st.remoteEnabled
      ? { label: 'Stop remote access', click: () => core.disableRemote() }
      : { label: 'Enable remote access', click: () => core.enableRemote().catch((e) => dialog.showErrorBox('Premiere Remote', e.message)) },
    { label: 'Disconnect phone', enabled: !!st.session, click: () => core.endSession('disconnected_on_host') },
    { type: 'separator' },
    { label: 'Quit', click: () => { core.disableRemote('host_quit'); app.exit(0); } },
  ]));
}

async function main() {
  await app.whenReady();
  const dir = app.getPath('userData');
  const vault = new Vault({ dir, safeStorage }).load();
  const settings = loadSettings(dir);
  let profile = loadProfile(dir);

  const desktop = new Desktop();
  const capture = new CaptureSources({ desktopCapturer, screen, log });
  capture.install(electronSession.defaultSession);

  const plugin = new PluginBridge({
    log,
    callerAllowlist: settings.pluginCallerAllowlist,
    getTokenHashes: () => vault.data.pluginTokenHashes,
    addTokenHash: (h) => vault.update((d) => { d.pluginTokenHashes = [...d.pluginTokenHashes.slice(-4), h]; }),
    approveConnection: async ({ process }) => {
      const r = await dialog.showMessageBox({
        type: 'question',
        title: 'Premiere Remote',
        message: 'Allow the Premiere Remote panel to connect?',
        detail: `A local process (${process}) wants to control this companion. Only allow this if you just opened the Premiere Remote panel in Premiere Pro.`,
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
      });
      return r.response === 0;
    },
  });

  const executor = new CommandExecutor({ desktop, plugin, getProfile: () => profile });
  const power = {
    id: null,
    preventSleep(on) {
      if (on && this.id === null) this.id = powerSaveBlocker.start('prevent-display-sleep');
      if (!on && this.id !== null) { powerSaveBlocker.stop(this.id); this.id = null; }
    },
  };

  core = new HostCore({
    vault, settings, profile: () => profile, desktop, plugin, executor: {
      execute: async (action, args, ctx) => {
        const r = await executor.execute(action, args, ctx);
        core.noteCommandResult(action, r);
        return r;
      },
    }, engine, capture, log, power,
  });

  for (const evt of ['signal', 'dc-open', 'dc-message', 'state', 'capture', 'stats', 'error']) {
    ipcMain.on(`engine-out:${evt}`, (e, payload) => {
      if (engineWin && e.sender === engineWin.webContents) core.onEngine(evt, payload);
    });
  }

  const actions = {
    enableRemote: () => core.enableRemote(),
    disableRemote: () => core.disableRemote(),
    newCode: () => core.newPairingCode(),
    cancelCode: () => core.cancelPairingCode(),
    decide: (a) => core.decide(a.id, { approve: !!a.approve, control: a.control !== false, unattended: !!a.unattended }),
    revokeDevice: (a) => core.revokeDevice(a.deviceId),
    updateDevice: (a) => core.updateDevice(a.deviceId, a),
    endSession: () => core.endSession('disconnected_on_host'),
    openConfigFolder: () => shell.openPath(dir),
    saveSettings: (a) => {
      const urlChanged = typeof a.serverUrl === 'string' && a.serverUrl !== settings.serverUrl;
      if (typeof a.serverUrl === 'string') {
        if (a.serverUrl && !/^https:\/\//.test(a.serverUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(a.serverUrl)) throw new Error('Server URL must be https:// (http only for localhost testing).');
        settings.serverUrl = a.serverUrl.replace(/\/$/, '');
      }
      if (a.registrationKey) settings.registrationKey = a.registrationKey;
      if (['auto', 'saver', 'responsive', 'balanced', 'quality'].includes(a.quality)) settings.quality = a.quality;
      if (['window', 'display'].includes(a.captureMode)) settings.captureMode = a.captureMode;
      if (typeof a.allowInputOutsidePremiere === 'boolean') settings.allowInputOutsidePremiere = a.allowInputOutsidePremiere;
      if (Number.isInteger(a.saveReminderMinutes)) settings.saveReminderMinutes = Math.max(0, Math.min(120, a.saveReminderMinutes));
      saveSettings(dir, settings);
      profile = loadProfile(dir);
      if (urlChanged && core.remoteEnabled) core.disableRemote('server_changed');
      core.changed();
    },
  };
  ipcMain.handle('ui:action', async (e, name, args) => {
    if (!uiWin || e.sender !== uiWin.webContents) throw new Error('forbidden');
    const fn = actions[name];
    if (!fn) throw new Error('unknown action');
    return fn(args);
  });
  ipcMain.on('ui:ready', () => uiWin?.webContents.send('ui:state', core.snapshotState()));

  // the Premiere panel drives the same actions
  plugin.on('ui', async (m) => {
    try {
      const fn = { enableRemote: actions.enableRemote, disableRemote: actions.disableRemote, newCode: actions.newCode, cancelCode: actions.cancelCode, decide: actions.decide, revokeDevice: actions.revokeDevice, updateDevice: actions.updateDevice, endSession: actions.endSession }[m.action];
      if (fn) await fn(m.args ?? {});
    } catch (e) {
      core.warn(e.message);
    }
  });
  plugin.on('connected', () => core.changed());
  plugin.on('disconnected', () => core.changed());
  plugin.on('rejectedCaller', (p) => core.warn(`Blocked a local connection from "${p}". If this is Premiere's UXP runtime, add it to pluginCallerAllowlist in settings.json.`));
  plugin.start();

  core.on('state', (st) => {
    uiWin?.webContents.send('ui:state', st);
    updateTray(st);
  });
  core.on('attention', () => {
    createUi();
    uiWin?.flashFrame(true);
  });

  powerMonitor.on('lock-screen', () => { desktop.locked = true; core.session?.rs?.notice('host_locked', 'Windows is locked. The stream shows the lock screen or freezes; input is paused until someone unlocks the PC.'); core.changed(); });
  powerMonitor.on('unlock-screen', () => { desktop.locked = false; core.changed(); });
  powerMonitor.on('suspend', () => core.endSession('host_suspended'));

  createEngine();
  createUi();
  tray = new Tray(trayIcon());
  tray.on('click', createUi);
  updateTray(core.snapshotState());

  setInterval(() => core.tick().catch((e) => log.warn('tick failed', { err: e.message })), 1000);
}

app.on('window-all-closed', (e) => e.preventDefault?.()); // keep running in the tray
app.on('second-instance', () => createUi());
main().catch((e) => {
  log.error('fatal', { err: e.message });
  dialog.showErrorBox('Premiere Remote', e.message);
  app.exit(1);
});
