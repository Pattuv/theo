const AI_URL = "http://127.0.0.1:5000/ai";
const CLASSIFY_URL = "http://127.0.0.1:5000/ai/classify";
const TTS_STATUS_URL = "http://127.0.0.1:5000/tts-status";
const TTS_POLL_INTERVAL_MS = 300;
const TTS_MAX_WAIT_MS = 120_000;

async function setInputLock(lock) {
  if (!window.electron?.ipcRenderer?.invoke) return;
  try {
    await window.electron.ipcRenderer.invoke("set-input-lock", { lock });
  } catch (err) {
    console.error("[AI] Failed to update input lock:", err);
  }
}

async function setClickThrough(enabled) {
  if (!window.electron?.setClickThrough) return;
  try {
    // remove lock down for ai runs
    await window.electron.setClickThrough(enabled, true);
  } catch (err) {
    console.error("[AI] Failed to set click-through:", err);
  }
}

async function setOutputPlaying(playing) {
  window.dispatchEvent(new CustomEvent("output-playing-changed", { detail: { playing } }));
  if (!window.electron?.ipcRenderer?.invoke) return;
  try {
    await window.electron.ipcRenderer.invoke("set-output-playing", { playing });
  } catch (err) {
    console.error("[AI] Failed to set output-playing:", err);
  }
}

async function waitForTtsComplete() {
  const start = Date.now();
  while (Date.now() - start < TTS_MAX_WAIT_MS) {
    try {
      const res = await fetch(TTS_STATUS_URL);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.playing) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, TTS_POLL_INTERVAL_MS));
  }
}

function normalizeClassification(raw) {
  const text = String(raw || "").toUpperCase();
  if (text.includes("---UNSAFE---")) return "---UNSAFE---";
  if (text.includes("---AGENT---")) return "---AGENT---";
  if (text.includes("---CHAT---")) return "---CHAT---";
  return "---CHAT---";
}

async function classifyText(text) {
  // #region agent log
  const _tc0 = Date.now();
  // #endregion
  try {
    const classifyRes = await fetch(
      `${CLASSIFY_URL}?user_input=${encodeURIComponent(text)}`,
    );
    if (!classifyRes.ok) {
      throw new Error(`Classify failed with ${classifyRes.status}`);
    }
    const data = await classifyRes.json();
    const classification = normalizeClassification(data?.classification);
    const raw = data?.raw != null ? String(data.raw) : "";
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/b0115b3f-3b50-439f-acd0-e9708e2326d8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'workflow.js:classify_done',message:'classify round-trip',data:{classify_ms:Date.now()-_tc0,result:data?.classification},timestamp:Date.now(),hypothesisId:'H-D'})}).catch(()=>{});
    // #endregion
    return { classification, raw: raw.trim() ? raw : undefined };
  } catch (err) {
    // Fail-safe: never default to AGENT on classifier failures.
    console.error("[AI] Classification failed, defaulting to CHAT:", err);
    return { classification: "---CHAT---", raw: undefined };
  }
}

export async function aiGO(text) {
  if (!text) return;
  await setOutputPlaying(false);
  await setInputLock(true);
  try {
    const { classification, raw } = await classifyText(text);
    if (classification === "---AGENT---") {
      window.dispatchEvent(new CustomEvent("ai-go"));
      await setClickThrough(true);
    }

    queueMicrotask(() => window.dispatchEvent(new CustomEvent("ai-loading-start")));
    const rawParam = raw ? `&classifier_raw=${encodeURIComponent(raw)}` : "";
    const url = `${AI_URL}?user_input=${encodeURIComponent(text)}&classification=${encodeURIComponent(classification)}${rawParam}`;
    // #region agent log
    const _t0 = Date.now();
    const _tClassify = _t0; // classify already done above
    // #endregion
    const response = await fetch(url);
    if (response.ok) {
      // #region agent log
      const _tFetchDone = Date.now();
      try {
        const _body = await response.clone().json();
        fetch('http://127.0.0.1:7243/ingest/b0115b3f-3b50-439f-acd0-e9708e2326d8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'workflow.js:fetch_done',message:'timing breakdown',data:{frontend_fetch_ms:_tFetchDone-_t0,classification,backend_timings:_body?.timings||null},timestamp:Date.now(),hypothesisId:'H-A,H-B,H-C,H-D'})}).catch(()=>{});
      } catch(_e) {}
      // #endregion
      // Script is finished — end the animation and re-enable mouse input immediately
      // so click-through no longer blocks the Ctrl-key TTS cutoff handler in main.js.
      if (classification === "---AGENT---") {
        window.dispatchEvent(new CustomEvent("ai-script-done"));
        await setClickThrough(false);
      }
      await setOutputPlaying(true);
      // #region agent log
      const _tTts0 = Date.now();
      // #endregion
      // Keep input locked until TTS finishes — prevents Ctrl+Win spam during playback.
      // Pressing Ctrl+Win while locked routes to triggerAgentOverrideCancel (intentional cancel).
      await waitForTtsComplete();
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/b0115b3f-3b50-439f-acd0-e9708e2326d8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'workflow.js:tts_done',message:'TTS playback wait duration',data:{tts_wait_ms:Date.now()-_tTts0},timestamp:Date.now(),hypothesisId:'H-C'})}).catch(()=>{});
      // #endregion
    } else {
      const body = await response.text();
      console.error("[AI] Request failed:", response.status, body);
    }
  } catch (err) {
    console.error("[AI] Request error:", err);
  } finally {
    await setOutputPlaying(false);
    await aiDone();
  }
}

export async function aiDone() {
  window.dispatchEvent(new CustomEvent("ai-done"));
  await setClickThrough(false);
  await setInputLock(false);
}
