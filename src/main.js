/**
 * Electron window + overlay configuration
 * - Fullscreen, transparent, frameless
 * - Click-through with hover-based interaction
 * - Focus management to prevent minimization
 *
 * ! Do not change unless necessary.
 * Known to be stable as of 12/21/2025.
 */

import { app, BrowserWindow, Menu, screen, ipcMain } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import { GlobalKeyboardListener } from "node-global-key-listener";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Set up IPC handler for getting taskbar height (calculate dynamically)
ipcMain.handle("get-taskbar-height", () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const taskbarHeight =
    primaryDisplay.size.height - primaryDisplay.workAreaSize.height;
  return taskbarHeight;
});

// Global reference to main window for shortcut handlers
let mainWindowRef = null;

// Global Ctrl+Win key state tracking
let ctrlKeyPressed = false;
let winKeyPressed = false;
let ctrlWinPressed = false;

// Function to handle Ctrl+Win key press
const handleCtrlWinPress = () => {
  if (!ctrlWinPressed) {
    ctrlWinPressed = true;
    if (mainWindowRef && mainWindowRef.webContents) {
      mainWindowRef.webContents.send("ctrl-win-key-down");
    }
  }
};

// Function to handle Ctrl+Win key release
const handleCtrlWinRelease = () => {
  if (ctrlWinPressed) {
    ctrlWinPressed = false;
    if (mainWindowRef && mainWindowRef.webContents) {
      mainWindowRef.webContents.send("ctrl-win-key-up");
    }
  }
};

// Initialize global keyboard listener
let gkl = null;

const initializeGlobalKeyListener = () => {
  gkl = new GlobalKeyboardListener();

  // Listen for keydown/keyup events
  gkl.addListener((e, down) => {
    let stateChanged = false;

    // Check for Ctrl key
    if (
      e.name === "LEFT CONTROL" ||
      e.name === "RIGHT CONTROL" ||
      e.name === "CONTROL"
    ) {
      const wasPressed = ctrlKeyPressed;
      ctrlKeyPressed = down;
      stateChanged = true;

      // If Ctrl was released and we were in Ctrl+Win state, release it
      if (!down && wasPressed && ctrlWinPressed) {
        handleCtrlWinRelease();
      }
    }

    // Check for Win key (Windows key)
    // On Windows, it might be called "LEFT META", "RIGHT META", or "META"
    if (
      e.name === "LEFT META" ||
      e.name === "RIGHT META" ||
      e.name === "META" ||
      e.name === "LEFT WIN" ||
      e.name === "RIGHT WIN" ||
      e.name === "WIN"
    ) {
      const wasPressed = winKeyPressed;
      winKeyPressed = down;
      stateChanged = true;

      // If Win was released and we were in Ctrl+Win state, release it
      if (!down && wasPressed && ctrlWinPressed) {
        handleCtrlWinRelease();
      }
    }

    // If both Ctrl and Win are pressed (down), trigger the handler
    if (down && ctrlKeyPressed && winKeyPressed && !ctrlWinPressed) {
      handleCtrlWinPress();
    }
  });

  console.log(
    "Global keyboard listener started - listening for Ctrl+Win globally",
  );
};

const createWindow = () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;

  // Create the browser window (hidden at first).
  const mainWindow = new BrowserWindow({
    width: width,
    height: height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false, // important: don't show until renderer is ready
    minimizable: false, // Prevent minimization
    resizable: false, // Prevent resizing
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });

  // Force always-on-top with highest priority and make visible on all workspaces
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true);

  // Store global reference to main window
  mainWindowRef = mainWindow;

  // Set up click-through toggle handlers
  // Click-through handling removed — window will receive mouse events.
  // Renderer may still send 'enable-mouse'/'disable-mouse' IPCs; handlers
  // were intentionally removed so mouse events are always enabled here.

  // Set up quit handler
  ipcMain.on("quit-app", () => {
    app.quit();
  });

  // Clean up on window close
  mainWindow.on("closed", () => {
    mainWindowRef = null;
  });

  // Click-through disabled: keep window interactive by default.

  // Remove the menu bar (File, Edit, View, etc.)
  Menu.setApplicationMenu(null);

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Show window only after renderer is ready, then enter fullscreen.
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus(); // Force focus immediately

    // Small delay avoids compositor / GPU race issues on some Windows setups
    setTimeout(() => {
      mainWindow.setFullScreen(true);
      // Re-enforce always-on-top after fullscreen
      mainWindow.setAlwaysOnTop(true, "screen-saver");
    }, 50);
  });

  // DevTools will not open by default
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Initialize global keyboard listener
  // This works GLOBALLY regardless of window focus
  initializeGlobalKeyListener();

  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Clean up global keyboard listener when app quits
app.on("will-quit", () => {
  if (gkl) {
    gkl.kill();
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
