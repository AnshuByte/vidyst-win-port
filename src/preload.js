'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  devices: () => ipcRenderer.invoke('devices:list'),
  displays: () => ipcRenderer.invoke('displays:list'),
  preview: (o) => ipcRenderer.invoke('preview:frame', o),
  start: (o) => ipcRenderer.invoke('stream:start', o),
  apply: (o) => ipcRenderer.invoke('stream:apply', o),
  stop: () => ipcRenderer.invoke('stream:stop'),
  state: () => ipcRenderer.invoke('stream:state'),
  args: () => ipcRenderer.invoke('stream:args'),
  pickRecordPath: () => ipcRenderer.invoke('dialog:recordPath'),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  sinkStart: () => ipcRenderer.invoke('sink:start'),
  sinkStop: () => ipcRenderer.invoke('sink:stop'),
  onLog: (cb) => ipcRenderer.on('stream:log', (_e, line) => cb(line)),
  onState: (cb) => ipcRenderer.on('stream:state', (_e, s) => cb(s)),
});
