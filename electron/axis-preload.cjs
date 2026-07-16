/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("axisDesktop", {
  openBrowser: (input) => ipcRenderer.invoke("axis-browser:open", input),
});
