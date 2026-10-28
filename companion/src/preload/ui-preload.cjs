// IPC surface for the companion's own status window.
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set([
  'enableRemote', 'disableRemote', 'newCode', 'cancelCode', 'decide', 'revokeDevice', 'updateDevice',
  'endSession', 'saveSettings', 'openConfigFolder', 'allowCallerProcess',
]);

contextBridge.exposeInMainWorld('hostApi', {
  onState: (fn) => ipcRenderer.on('ui:state', (_e, s) => fn(s)),
  action: (name, args) => {
    if (!ACTIONS.has(name)) throw new Error(`unknown action ${name}`);
    return ipcRenderer.invoke('ui:action', name, args ?? {});
  },
  ready: () => ipcRenderer.send('ui:ready'),
});
