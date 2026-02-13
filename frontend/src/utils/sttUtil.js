import { sttFallback } from "./sttFallback.js";
import { aiGO } from "./workflow.js";

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let stream = null;

function log(message, data) {
  console.log(`[STT] ${message}`, data || "");
}

function cleanup() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  audioChunks = [];
  isRecording = false;
}

export function initPushToTalk() {
  log("Initializing push-to-talk...");

  cleanup();

  // start talking

  window.electron.ipcRenderer.on("ctrl-win-key-down", async () => {
    log("Received ctrl-win-key-down - requesting microphone...");
    if (isRecording) {
      log("Already recording, ignoring duplicate start");
      return;
    }

    log("Starting recording...");
    isRecording = true;

    try {
      // Clean up any existing stream
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }

      // Request microphone access
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });

      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          log(`Received audio chunk: ${e.data.size} bytes`);
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onerror = (e) => {
        console.error("MediaRecorder error:", e.error || "Unknown error");
        sttFallback();
        cleanup();
      };

      mediaRecorder.onstop = () => {
        log("Recording stopped");
      };

      mediaRecorder.start(100);
      log("Recording started");
    } catch (err) {
      console.error("Failed to start recording:", err);
      sttFallback();
      cleanup();
    }
  });

  // Stop talking
  window.electron.ipcRenderer.on("ctrl-win-key-up", async () => {
    if (!isRecording || !mediaRecorder) {
      log("Not recording or no media recorder, ignoring stop");
      return;
    }

    log("Stopping recording...");
    isRecording = false;

    const recorder = mediaRecorder;

    try {
      // Set onstop BEFORE calling stop() so the handler runs when recording stops
      recorder.onstop = async () => {
        try {
          // Use audioChunks at stop time (includes data from requestData())
          const chunksToProcess = [...audioChunks];
          log(`Processing ${chunksToProcess.length} audio chunks`);

          if (chunksToProcess.length === 0) {
            console.error("No audio data recorded");
            sttFallback();
            return;
          }

          const blob = new Blob(chunksToProcess, {
            type: "audio/webm;codecs=opus",
          });
          log(`Audio blob size: ${blob.size} bytes`);

          const arrayBuffer = await blob.arrayBuffer();

          log("Sending audio to main process for transcription...");
          const text = await window.electron.ipcRenderer.invoke(
            "transcribe-audio",
            arrayBuffer,
          );

          if (!text) {
            console.error("Empty transcription result - no STT response");
            sttFallback();
            return;
          }

          console.log("Transcription successful:", text);
          await aiGO(text);
        } catch (err) {
          console.error("Error processing recording:", err);
          sttFallback();
        } finally {
          cleanup();
        }
      };

      recorder.requestData();
      recorder.stop();
    } catch (err) {
      console.error("Error stopping recording:", err);
      sttFallback();
      cleanup();
    }
  });

  // clean up on window unload
  window.addEventListener("beforeunload", cleanup);

  log("Push-to-talk initialized");
}
