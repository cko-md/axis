/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("axisBrowser", {
  back: () => ipcRenderer.invoke("axis-browser:back"),
  forward: () => ipcRenderer.invoke("axis-browser:forward"),
  reload: () => ipcRenderer.invoke("axis-browser:reload"),
  stop: () => ipcRenderer.invoke("axis-browser:stop"),
  navigate: (url) => ipcRenderer.invoke("axis-browser:navigate", url),
  openExternal: () => ipcRenderer.invoke("axis-browser:external"),
  showCapabilities: () => ipcRenderer.invoke("axis-browser:capabilities"),
  reader: () => ipcRenderer.invoke("axis-browser:reader"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("axis-browser:state", listener);
    return () => ipcRenderer.removeListener("axis-browser:state", listener);
  },
});
