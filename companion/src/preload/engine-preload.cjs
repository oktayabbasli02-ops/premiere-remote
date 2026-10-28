// Narrow IPC surface for the media engine renderer (contextIsolation + sandbox on).
const { contextBridge, ipcRenderer } = require('electron');

const IN = new Set(['start', 'signal', 'enable-media', 'switch-source', 'set-quality', 'dc-send', 'stop']);
const OUT = new Set(['signal', 'dc-open', 'dc-message', 'state', 'capture', 'stats', 'error']);

contextBridge.exposeInMainWorld('engineApi', {
  on: (name, fn) => {
    if (!IN.has(name)) throw new Error(`unknown engine event ${name}`);
    ipcRenderer.on(`engine:${name}`, (_e, payload) => fn(payload));
  },
  emit: (name, payload) => {
    if (!OUT.has(name)) throw new Error(`unknown engine output ${name}`);
    ipcRenderer.send(`engine-out:${name}`, payload);
  },
});
