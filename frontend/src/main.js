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

const require = createRequire(import.meta.url);
const { uIOhook, UiohookKey } = require("uiohook-napi");

let mainWindowRef = null;
let inputLockCount = 0;
let clickThroughEnabled = false;

const isInputLocked = () => inputLockCount > 0;

if (started) {
  app.quit();
}

// Settings: startup (launch at login)
ipcMain.handle("get-startup-enabled", () => {
  const settings = app.getLoginItemSettings();
  return { enabled: Boolean(settings?.openAtLogin) };
});

ipcMain.handle("set-startup-enabled", (_event, { enabled }) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    const settings = app.getLoginItemSettings();
    return { ok: true, enabled: Boolean(settings?.openAtLogin) };
  } catch (err) {
    console.error(
      "[Settings] set-startup-enabled failed:",
      err?.message || err,
    );
    return {
      ok: false,
      enabled: app.getLoginItemSettings()?.openAtLogin ?? false,
    };
  }
});

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



// Output playing: TTS is playing. Allow Ctrl+Win to interrupt and ask new prompt.
// For AGENT mode, we only set this after script is done (when fetch returns).
let outputPlaying = false;

// uiohook-napi key-code helpers
const isCtrlCode = (kc) => kc === UiohookKey.Ctrl || kc === UiohookKey.CtrlRight;
const isWinCode  = (kc) => kc === UiohookKey.Meta || kc === UiohookKey.MetaRight;
const isAltCode  = (kc) => kc === UiohookKey.Alt  || kc === UiohookKey.AltRight;

ipcMain.handle("set-output-playing", (_event, payload) => {
  outputPlaying = Boolean(payload?.playing);
  return { ok: true };
});

const triggerAgentOverrideCancel = () => {
  // Stop speech immediately.
  fetch("http://127.0.0.1:5000/stop-tts", { method: "POST" }).catch(() => {});
  outputPlaying = false;

  // Force overlay to accept mouse again.
  clickThroughEnabled = false;
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.setIgnoreMouseEvents(false);
  }

  // Release input lock so user can interact right away.
  if (isInputLocked()) {
    inputLockCount = 0;
    if (mainWindowRef?.webContents) {
      mainWindowRef.webContents.send("input-lock-changed", {
        locked: false,
        lockCount: inputLockCount,
      });
    }
  }

  // Tell renderer to drop AGENT/loading UI immediately.
  if (mainWindowRef?.webContents) {
    mainWindowRef.webContents.send("agent-override-cancelled");
  }
  console.log("[STT] Agent override cancel triggered via Ctrl+Win");
};

const handleCtrlWinPress = () => {
  const now = Date.now();
  if (clickThroughEnabled || isInputLocked()) {
    triggerAgentOverrideCancel();
    return;
  }
  if (now - lastTriggerAt < TRIGGER_LOCKOUT_MS) return;
  // Bypass cooldown when TTS is playing (user can interrupt to ask new prompt)
  const canInterrupt = outputPlaying;
  if (
    !canInterrupt &&
    lastReleaseAt > 0 &&
    now - lastReleaseAt < COOLDOWN_AFTER_RELEASE_MS
  )
    return;
  if (!bothKeysReleased) return;

  ctrlWinPressed = true;
  bothKeysReleased = false;
  lastTriggerAt = now;
  // Always stop TTS when Ctrl+Win pressed - no matter what
  fetch("http://127.0.0.1:5000/stop-tts", { method: "POST" }).catch(() => {});
  if (outputPlaying) outputPlaying = false;
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

const initializeGlobalKeyListener = () => {
  // Track which keys are physically held so keyup correctly reflects state
  // after a key is released (uiohook modifier flags behave like browser events).
  const heldKeys = new Set();

  uIOhook.on("keydown", (e) => {
    heldKeys.add(e.keycode);

    const ctrlHeld = heldKeys.has(UiohookKey.Ctrl) || heldKeys.has(UiohookKey.CtrlRight);
    const winHeld  = heldKeys.has(UiohookKey.Meta) || heldKeys.has(UiohookKey.MetaRight);
    const altHeld  = heldKeys.has(UiohookKey.Alt)  || heldKeys.has(UiohookKey.AltRight);

    // Ctrl+Alt: toggle lockdown (click-through) on/off
    if (ctrlHeld && altHeld && !winHeld && (isCtrlCode(e.keycode) || isAltCode(e.keycode))) {
      if (mainWindowRef?.webContents) {
        mainWindowRef.webContents.send("ctrl-alt-toggle-lockdown");
      }
    }

    // Ctrl alone (no Win, no Alt): stop TTS.
    // Ignored during AGENT click-through mode — PyAutoGUI synthesises Ctrl
    // keystrokes that would otherwise cut off Theo's speech.
    if (!clickThroughEnabled && isCtrlCode(e.keycode) && ctrlHeld && !winHeld && !altHeld) {
      fetch("http://127.0.0.1:5000/stop-tts", { method: "POST" }).catch(() => {});
      if (outputPlaying) outputPlaying = false;
    }

    ctrlKeyPressed = ctrlHeld;
    winKeyPressed  = winHeld;

    if (!ctrlHeld && !winHeld) bothKeysReleased = true;

    // Trigger when both Ctrl+Win are held, both were released before, and not already active
    if (ctrlHeld && winHeld && bothKeysReleased && !ctrlWinPressed) {
      handleCtrlWinPress();
    }
  });

  uIOhook.on("keyup", (e) => {
    heldKeys.delete(e.keycode);

    const ctrlHeld = heldKeys.has(UiohookKey.Ctrl) || heldKeys.has(UiohookKey.CtrlRight);
    const winHeld  = heldKeys.has(UiohookKey.Meta) || heldKeys.has(UiohookKey.MetaRight);

    if (ctrlWinPressed && (isCtrlCode(e.keycode) || isWinCode(e.keycode))) {
      handleCtrlWinRelease();
    }

    ctrlKeyPressed = ctrlHeld;
    winKeyPressed  = winHeld;

    if (!ctrlHeld && !winHeld) bothKeysReleased = true;
  });

  uIOhook.start();
  console.log("[STT] Global keyboard listener started - hold Ctrl+Win to record, release to transcribe");
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

  // IPC: quit - shutdown Flask backend then quit Electron
  ipcMain.on("quit-app", () => {
    const shutdownFlask = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1000);
        await fetch("http://127.0.0.1:5000/shutdown", {
          method: "POST",
          signal: ctrl.signal,
        });
        clearTimeout(t);
      } catch (_) {
        // Backend may not be running - continue to quit
      }
      app.quit();
    };
    shutdownFlask();
  });

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

  try {
    initializeGlobalKeyListener();
  } catch (err) {
    console.error("[STT] Global key listener failed:", err.message || err);
    console.warn("[STT] Ctrl+Win shortcut will not work. App will still run.");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  try { uIOhook.stop(); } catch (_) { /* already stopped or never started */ }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
