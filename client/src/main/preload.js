'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wp', {
  async call(channel, ...args) {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) { const e = new Error(r.error); e.status = r.status; throw e; }
    return r.data;
  },
  on(handler) {
    const fn = (_e, channel, payload) => handler(channel, payload);
    ipcRenderer.on('evt', fn);
    return () => ipcRenderer.removeListener('evt', fn);
  },
  platform: process.platform,
});
