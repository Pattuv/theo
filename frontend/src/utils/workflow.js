const AI_URL = "http://127.0.0.1:5000/ai";
const CLASSIFY_URL = "http://127.0.0.1:5000/ai/classify";

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

export async function aiGO(text) {
  if (!text) return;
  await setInputLock(true);
  let classification = "---CHAT---";
  try {
    const classifyRes = await fetch(
      `${CLASSIFY_URL}?user_input=${encodeURIComponent(text)}`,
    );
    if (classifyRes.ok) {
      const data = await classifyRes.json();
      classification = data.classification || "---CHAT---";
    }

    if (classification === "---AGENT---") {
      window.dispatchEvent(new CustomEvent("ai-go"));
      await setClickThrough(true);
    }

    const url = `${AI_URL}?user_input=${encodeURIComponent(text)}&classification=${encodeURIComponent(classification)}`;
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      console.error("[AI] Request failed:", response.status, body);
    }
  } catch (err) {
    console.error("[AI] Request error:", err);
  } finally {
    await aiDone();
  }
}

export async function aiDone() {
  window.dispatchEvent(new CustomEvent("ai-done"));
  await setClickThrough(false);
  await setInputLock(false);
}
