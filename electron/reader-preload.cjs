/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("axisReader", {
  getArticle: (articleId) => ipcRenderer.invoke("axis-reader:get", articleId),
});
