// This is default preload code in the electron boilerplate. We modifed it for theo input.

// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require("electron");

// Store environment variables
let env = {
  GROQ_API_KEY: null,
};

// Listen for environment variables from main process
ipcRenderer.on("set-env", (event, newEnv) => {
  Object.assign(env, newEnv);
  console.log("Environment variables updated:", env);
});

// Expose to renderer
contextBridge.exposeInMainWorld("electron", {
  env,
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  getScreenSize: () => ipcRenderer.invoke("get-screen-size"),
  setClickThrough: (enabled, agentMode) =>
    ipcRenderer.invoke("set-click-through", { enabled, agentMode }),
  setNotchBounds: (bounds) => ipcRenderer.invoke("set-notch-bounds", bounds),
  ipcRenderer: {
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, func) => {
      const validChannels = [
        "ctrl-win-key-down",
        "ctrl-win-key-up",
        "set-env",
        "input-lock-changed",
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    },
    removeListener: (channel, func) => {
      ipcRenderer.removeListener(channel, func);
    },
  },
});
