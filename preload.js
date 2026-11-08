'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  listConnections: invoke('conn:list'),
  saveConnection: invoke('conn:save'),
  deleteConnection: invoke('conn:delete'),
  test: invoke('pg:test'),
  connect: invoke('pg:connect'),
  disconnect: invoke('pg:disconnect'),
  releaseDatabase: invoke('pg:releaseDatabase'),
  query: invoke('pg:query'),
  cancel: invoke('pg:cancel'),
  closeSession: invoke('pg:closeSession'),
  sessionInfo: invoke('pg:sessionInfo'),
  exportData: invoke('pg:export'),
  saveDialog: invoke('dlg:save'),
  openDialog: invoke('dlg:open'),
  readFile: invoke('file:read'),
  writeFile: invoke('file:write'),
  showItem: invoke('shell:showItem'),
  openExternal: invoke('shell:openExternal'),
  toolsInfo: invoke('tools:info'),
  runTool: invoke('tools:run'),
  killTool: invoke('tools:kill'),
  appInfo: invoke('app:info'),
  onToolLog: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('tools:log', h);
    return () => ipcRenderer.removeListener('tools:log', h);
  },
  onMenu: (cb) => ipcRenderer.on('menu', (_e, ch) => cb(ch)),
});
