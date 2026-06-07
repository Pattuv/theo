import { createRoot } from "react-dom/client";
import { useEffect, useState, useRef } from "react";
import "./index.css";
import "./ai-overlay.css";
import Notch from "./components/notch";
import startupSound from "./assets/verbalpreset/startup2.wav";
import ping1 from "./assets/ping1.mp3";
import loadingSound from "./assets/loading.mp3";
import { initPushToTalk } from "./utils/sttUtil";
import {
  getSavedSpeakerDeviceId,
  getSavedStartupSoundFull,
  applySpeakerToElement,
} from "./utils/settingsUtil";

async function setInputLock(lock) {
  if (!window.electron?.ipcRenderer?.invoke) return;
  try {
    await window.electron.ipcRenderer.invoke("set-input-lock", { lock });
  } catch (err) {
    console.error("[APP] Failed to update input lock:", err);
  }
}

function waitForAudioEnd(audio) {
  return new Promise((resolve) => {
    const done = () => {
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      resolve();
    };
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
  });
}

const App = () => {
  const [taskbarHeight, setTaskbarHeight] = useState(0);

  // Initialize app - retry if electron isn't ready yet (preload can lag)
  useEffect(() => {
    function setupPushToTalk() {
      if (!window.electron?.ipcRenderer) {
        console.warn("[STT] ipcRenderer not ready, retrying in 500ms...");
        setTimeout(setupPushToTalk, 500);
        return;
      }
      try {
        initPushToTalk();
        console.log("[STT] Push-to-talk initialized - hold Ctrl+Win to record");
      } catch (err) {
        console.error("Failed to initialize push-to-talk:", err);
      }
    }
    setupPushToTalk();

    const getTaskbarHeight = async () => {
      if (window.electron?.ipcRenderer) {
        try {
          const height =
            await window.electron.ipcRenderer.invoke("get-taskbar-height");
          setTaskbarHeight(height);
        } catch (error) {
          console.error("Failed to get taskbar height:", error);
        }
      }
    };

    getTaskbarHeight();
  }, []);

  const [aiActive, setAiActive] = useState(false);
  const loadingLoopRef = useRef(null);
  const loadingActiveRef = useRef(false);

  useEffect(() => {
    const onAiGo = () => setAiActive(true);
    const onAiDone = () => setAiActive(false);
    // ai-script-done fires as soon as the automation script finishes (before TTS ends)
    const onAiScriptDone = () => setAiActive(false);
    const onAgentOverrideCancelled = () => {
      window.dispatchEvent(
        new CustomEvent("output-playing-changed", {
          detail: { playing: false },
        }),
      );
      window.dispatchEvent(new CustomEvent("ai-done"));
    };
    window.addEventListener("ai-go", onAiGo);
    window.addEventListener("ai-done", onAiDone);
    window.addEventListener("ai-script-done", onAiScriptDone);
    window.electron?.ipcRenderer?.on?.(
      "agent-override-cancelled",
      onAgentOverrideCancelled,
    );
    return () => {
      window.removeEventListener("ai-go", onAiGo);
      window.removeEventListener("ai-done", onAiDone);
      window.removeEventListener("ai-script-done", onAiScriptDone);
      window.electron?.ipcRenderer?.removeListener?.(
        "agent-override-cancelled",
        onAgentOverrideCancelled,
      );
    };
  }, []);

  // Loading sound: loop when AI processing starts, stop when TTS starts or ai-done
  useEffect(() => {
    const LOOP_DELAY_MS = 500;

    const stopLoadingSound = () => {
      loadingActiveRef.current = false;
      if (loadingLoopRef.current) {
        clearTimeout(loadingLoopRef.current);
        loadingLoopRef.current = null;
      }
    };

    const runLoadingLoop = () => {
      try {
        if (!loadingActiveRef.current) return;
        const audio = new Audio(loadingSound);
        const deviceId = getSavedSpeakerDeviceId();
        if (deviceId) applySpeakerToElement(audio, deviceId).catch(() => {});
        audio
          .play()
          .catch((err) => console.error("[Loading] Play error:", err));
        const onEnded = () => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onEnded);
          if (!loadingActiveRef.current) return;
          loadingLoopRef.current = setTimeout(runLoadingLoop, LOOP_DELAY_MS);
        };
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onEnded);
      } catch (err) {
        console.error("[Loading] Loop error:", err);
      }
    };

    const onAiLoadingStart = () => {
      try {
        loadingActiveRef.current = true;
        runLoadingLoop();
      } catch (err) {
        console.error("[Loading] Start error:", err);
      }
    };

    const onAiDone = () => {
      stopLoadingSound();
    };

    const onOutputPlayingChanged = ({ detail }) => {
      if (detail?.playing) stopLoadingSound();
    };

    window.addEventListener("ai-loading-start", onAiLoadingStart);
    window.addEventListener("ai-done", onAiDone);
    window.addEventListener("output-playing-changed", onOutputPlayingChanged);

    return () => {
      stopLoadingSound();
      window.removeEventListener("ai-loading-start", onAiLoadingStart);
      window.removeEventListener("ai-done", onAiDone);
      window.removeEventListener(
        "output-playing-changed",
        onOutputPlayingChanged,
      );
    };
  }, []);

  // Lock input while backend delivers a proactive calendar reminder.
  useEffect(() => {
    let lockedForReminder = false;
    const poll = async () => {
      try {
        const res = await fetch("http://127.0.0.1:5000/tts-status");
        if (!res.ok) return;
        const data = await res.json();
        if (data.reminder && !lockedForReminder) {
          lockedForReminder = true;
          await setInputLock(true);
        } else if (!data.reminder && lockedForReminder) {
          lockedForReminder = false;
          await setInputLock(false);
        }
      } catch {
        /* backend not ready yet */
      }
    };
    const id = setInterval(poll, 500);
    poll();
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const playStartup = async () => {
      const soundSrc = getSavedStartupSoundFull() ? startupSound : ping1;
      const audio = new Audio(soundSrc);
      const deviceId = getSavedSpeakerDeviceId();
      if (deviceId) await applySpeakerToElement(audio, deviceId);
      audio.currentTime = 0;
      await setInputLock(true);
      try {
        await audio.play();
        await waitForAudioEnd(audio);
      } catch (err) {
        console.error("Startup sound error:", err);
      } finally {
        await setInputLock(false);
      }
    };

    playStartup().catch((err) => {
      console.error("Failed to play startup sound:", err);
    });
  }, []);

  return (
    <div className="pointer-events-auto">
      <div
        className={`ai-active-overlay ${aiActive ? "visible" : ""}`}
        aria-hidden="true"
      />
      <Notch taskbarHeight={taskbarHeight} />
    </div>
  );
};

const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);
