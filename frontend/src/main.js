/**
 * Electron window + overlay configuration
 * - Fullscreen, transparent, frameless
 * - Click-through with hover-based interaction
 * - Focus management to prevent minimization
 */

// This is whats behind Theo's seamless experience.

// Load environment variables
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env for apis
dotenv.config({ path: join(__dirname, "../../../.env") });

import { app, BrowserWindow, Menu, screen, ipcMain, shell } from "electron";
import path from "node:path";
import { createRequire } from "node:module";
import started from "electron-squirrel-startup";
import { GlobalKeyboardListener } from "node-global-key-listener";

const require = createRequire(import.meta.url);

let mainWindowRef = null;
let inputLockCount = 0;
let clickThroughEnabled = false;

const isInputLocked = () => inputLockCount > 0;

if (started) {
  app.quit();
}

// IPC handler for taskbar height
ipcMain.handle("get-taskbar-height", () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  return primaryDisplay.size.height - primaryDisplay.workAreaSize.height;
});

// Open URL in the system's default browser (not in Electron)
ipcMain.handle("open-external", (_event, url) => {
  if (url && typeof url === "string") shell.openExternal(url);
});

// Screen size for dialogs (scale popup to slightly smaller than screen)
ipcMain.handle("get-screen-size", () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { width, height };
});

// Renderer-controlled input lock for startup/fallback audio and ai workflow.
ipcMain.handle("set-input-lock", (_event, payload) => {
  const lock = Boolean(payload?.lock);
  inputLockCount = lock ? inputLockCount + 1 : Math.max(0, inputLockCount - 1);
  if (mainWindowRef?.webContents) {
    mainWindowRef.webContents.send("input-lock-changed", {
      locked: isInputLocked(),
      lockCount: inputLockCount,
    });
  }
  return { locked: isInputLocked(), lockCount: inputLockCount };
});

ipcMain.handle("get-input-lock-state", () => ({
  locked: isInputLocked(),
  lockCount: inputLockCount,
}));

// Initialize Groq client in main process (uses dotenv loaded earlier)
let groqClient = null;
let toFile = null;
try {
  // require is used here to avoid import ordering issues in this file
  const Groq = require("groq-sdk");
  toFile = require("groq-sdk").toFile;
  if (process.env.GROQ_API_KEY) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log("Groq client initialized in main process");
  } else {
    console.warn("GROQ_API_KEY not set in main process");
  }
} catch (err) {
  console.error("Failed to initialize Groq in main process:", err);
}

// Transcribe audio from renderer (Ctrl+Win recording) and print to terminal
ipcMain.handle("transcribe-audio", async (_event, arrayBuffer) => {
  if (!groqClient) {
    console.error(
      "[STT] Groq client not initialized. Set GROQ_API_KEY in .env",
    );
    return null;
  }
  if (!arrayBuffer || !(arrayBuffer instanceof ArrayBuffer)) {
    console.error("[STT] Invalid audio data received");
    return null;
  }
  try {
    if (!toFile) {
      console.error("[STT] toFile not available from groq-sdk");
      return null;
    }
    const buffer = Buffer.from(arrayBuffer);
    const file = await toFile(buffer, "audio.webm");
    const transcription = await groqClient.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      temperature: 0,
      response_format: "text",
    });
    const text =
      typeof transcription === "string" ? transcription : transcription?.text;
    if (text && text.trim()) {
      console.log("[STT] Transcription:", text.trim());
    }
    return text?.trim() || null;
  } catch (err) {
    console.error("[STT] Transcription failed:", err.message || err);
    return null;
  }
});

// Key state tracking
let ctrlKeyPressed = false;
let winKeyPressed = false;
let ctrlWinPressed = false;
// Must release BOTH keys before next trigger (stops mid-sentence re-trigger)
let bothKeysReleased = true;

// Short lockout after trigger to avoid key-repeat / double key-down
const TRIGGER_LOCKOUT_MS = 500;
// Cooldown after release before next Ctrl+Win can trigger (matches notch.jsx)
const COOLDOWN_AFTER_RELEASE_MS = 2000;
let lastTriggerAt = 0;
let lastReleaseAt = 0;

// Global keyboard listener
let gkl = null;

const handleCtrlWinPress = () => {
  const now = Date.now();
  if (clickThroughEnabled) return;
  if (isInputLocked()) return;
  if (now - lastTriggerAt < TRIGGER_LOCKOUT_MS) return;
  if (lastReleaseAt > 0 && now - lastReleaseAt < COOLDOWN_AFTER_RELEASE_MS)
    return;
  if (!bothKeysReleased) return;

  ctrlWinPressed = true;
  bothKeysReleased = false;
  lastTriggerAt = now;
  console.log("[STT] Ctrl+Win pressed - sending ctrl-win-key-down to renderer");

  if (mainWindowRef?.webContents) {
    mainWindowRef.webContents.send("ctrl-win-key-down");
  } else {
    console.warn("[STT] No main window ref, cannot send to renderer");
  }
};

const handleCtrlWinRelease = () => {
  if (clickThroughEnabled) return;
  if (isInputLocked()) return;
  if (!ctrlWinPressed) return;

  ctrlWinPressed = false;
  lastReleaseAt = Date.now();

  if (mainWindowRef?.webContents) {
    mainWindowRef.webContents.send("ctrl-win-key-up");
  }
};

// Key names: Windows uses "LEFT CTRL"/"RIGHT CTRL" and "LEFT META"/"RIGHT META" (standardName)
const CTRL_NAMES = [
  "LEFT CONTROL",
  "RIGHT CONTROL",
  "CONTROL",
  "LEFT CTRL",
  "RIGHT CTRL",
  "LCONTROL",
  "RCONTROL",
];
const WIN_NAMES = [
  "LEFT META",
  "RIGHT META",
  "META",
  "LEFT WIN",
  "RIGHT WIN",
  "WIN",
  "LWIN",
  "RWIN",
];

const isCtrlKey = (name) => name && CTRL_NAMES.includes(name);
const isWinKey = (name) => name && WIN_NAMES.includes(name);

const initializeGlobalKeyListener = async () => {
  // Resolve WinKeyServer.exe from the package (Vite bundle breaks __dirname inside the lib)
  let keyListenerConfig = {};
  if (process.platform === "win32") {
    try {
      const pkgPath = require.resolve("node-global-key-listener/package.json");
      const winKeyServerPath = path.join(
        path.dirname(pkgPath),
        "bin",
        "WinKeyServer.exe",
      );
      keyListenerConfig = { windows: { serverPath: winKeyServerPath } };
    } catch (e) {
      console.warn("[STT] Could not resolve WinKeyServer path:", e.message);
    }
  }

  gkl = new GlobalKeyboardListener(keyListenerConfig);

  await gkl.addListener((e, down) => {
    const ctrlHeld = CTRL_NAMES.some((k) => down[k]);
    const winHeld = WIN_NAMES.some((k) => down[k]);

    if (
      e.state === "UP" &&
      ctrlWinPressed &&
      (isCtrlKey(e.name) || isWinKey(e.name))
    ) {
      handleCtrlWinRelease();
    }

    ctrlKeyPressed = ctrlHeld;
    winKeyPressed = winHeld;

    // Allow next trigger only after BOTH keys have been released (stops mid-sentence re-trigger)
    if (!ctrlHeld && !winHeld) {
      bothKeysReleased = true;
    }

    // Trigger only: keydown, both held, we're allowed (both were released before), and not already active
    if (
      e.state === "DOWN" &&
      ctrlKeyPressed &&
      winKeyPressed &&
      bothKeysReleased &&
      !ctrlWinPressed
    ) {
      handleCtrlWinPress();
    }
  });

  console.log(
    "[STT] Global keyboard listener started - hold Ctrl+Win to record, release to transcribe",
  );
};

const createWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().size;

  const mainWindow = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    minimizable: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });

  // Load .env from project root (theo/.env)
  require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

  // Pass environment variables to renderer
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send("set-env", {
      GROQ_API_KEY: process.env.GROQ_API_KEY,
    });
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true);

  mainWindowRef = mainWindow;

  // IPC: quit
  ipcMain.on("quit-app", () => app.quit());

  // Click-through: overlay ignores mouse except over notch (notch stays clickable)
  let notchBounds = null; // { x, y, width, height } in window coordinates
  let clickThroughInterval = null;
  const NOTCH_POLL_MS = 80;

  ipcMain.handle("set-click-through", (_event, { enabled, agentMode }) => {
    clickThroughEnabled = Boolean(enabled);
    if (clickThroughInterval) {
      clearInterval(clickThroughInterval);
      clickThroughInterval = null;
    }
    if (!clickThroughEnabled) {
      mainWindow.setIgnoreMouseEvents(false);
      return { ok: true, enabled: false };
    }
    // turn off lock down for ai runs
    if (agentMode) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      return { ok: true, enabled: true };
    }
    const check = () => {
      if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      const winBounds = mainWindow.getBounds();
      const wx = cursor.x - winBounds.x;
      const wy = cursor.y - winBounds.y;
      const inside =
        notchBounds &&
        wx >= notchBounds.x &&
        wx <= notchBounds.x + notchBounds.width &&
        wy >= notchBounds.y &&
        wy <= notchBounds.y + notchBounds.height;
      mainWindow.setIgnoreMouseEvents(!inside, { forward: true });
    };
    check();
    clickThroughInterval = setInterval(check, NOTCH_POLL_MS);
    return { ok: true, enabled: true };
  });

  ipcMain.handle("set-notch-bounds", (_event, bounds) => {
    if (
      bounds &&
      typeof bounds.x === "number" &&
      typeof bounds.y === "number"
    ) {
      notchBounds = {
        x: bounds.x,
        y: bounds.y,
        width: Math.max(0, Number(bounds.width) || 0),
        height: Math.max(0, Number(bounds.height) || 0),
      };
    } else {
      notchBounds = null;
    }
    return { ok: true };
  });

  mainWindow.on("closed", () => {
    mainWindowRef = null;
  });

  Menu.setApplicationMenu(null);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();

    setTimeout(() => {
      mainWindow.setFullScreen(true);
      mainWindow.setAlwaysOnTop(true, "screen-saver");
    }, 50);
  });
};

app.whenReady().then(() => {
  createWindow();

  // start key listener in background so a slow/hanging spawn doesn't block the window
  initializeGlobalKeyListener().catch((err) => {
    console.error("[STT] Global key listener failed:", err.message || err);
    console.warn("[STT] Ctrl+Win shortcut will not work. App will still run.");
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  if (gkl) gkl.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
