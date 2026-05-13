import io
import logging
import os
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, send_file, request
from flask_cors import CORS

from services.aiService.aiService import (
    build_main_input,
    load_main_system_prompt,
    parse_main_output,
    run_main_llm,
)
from services.scriptClient.scriptClient import run_script
from services.toolCaller.toolCaller import parse_classifier_raw, run_tool_segments
from services.TTS.ttsClient import speak_text, speak_text_with_started_event, stop_playback
from utils.audioFeedback.audioFeedback import play_image_error_sound
from utils.audioFeedback.audioFeedback import play_warning_sound
from utils.imageProcessor.imageProcessor import image_processor
from utils.llmclassifer.llmClassifier import llmclassifier

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# TTS playback state — set True when background TTS starts, False when it ends.
# Polled by the frontend via /tts-status to know when it's safe to allow next input.
_tts_playing: bool = False
_tts_lock = threading.Lock()


def _set_tts_playing(playing: bool) -> None:
    global _tts_playing
    with _tts_lock:
        _tts_playing = playing


def _perf_timer() -> float:
    """Return current monotonic time in seconds."""
    return time.perf_counter()

# Load .env for keys
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

app = Flask(__name__)
CORS(app)

# single-session memory: last 6 turns. resets every run.
SESSION_MEMORY: list[dict] = []
MAX_MEMORY_TURNS = 12  # 6 turns = 6 user + 6 assistant messages combined together


def _is_datetime_query(user_input: str) -> bool:
    text = (user_input or "").strip().lower()
    patterns = (
        "what time",
        "current time",
        "time is it",
        "what date",
        "current date",
        "what day",
        "day is it",
        "day of the week",
        "today's date",
        "todays date",
    )
    return any(p in text for p in patterns)


def _is_screen_read_query(user_input: str) -> bool:
    """
    Detect requests that should read/describe on-screen content without automation.
    These must never trigger AGENT execution.
    """
    text = (user_input or "").strip().lower()
    patterns = (
        "read my screen",
        "read the screen",
        "read out my screen",
        "read out the screen",
        "describe my screen",
        "describe the screen",
        "what's on my screen",
        "whats on my screen",
        "what is on my screen",
        "tell me what's on my screen",
        "tell me what is on my screen",
        "screen reader",
    )
    return any(p in text for p in patterns)


def _build_datetime_response() -> str:
    now = datetime.now()
    return (
        f"Today is {now.strftime('%A')}, {now.strftime('%B %d, %Y')}. "
        f"The current time is {now.strftime('%I:%M %p').lstrip('0')}."
    )


def _normalize_classification(raw: str) -> str:
    """Extract classification from classifier output; tolerates extra text/whitespace."""
    s = (raw or "").strip().upper()
    for label in ("---UNSAFE---", "---AGENT---", "---CHAT---"):
        if label in s:
            return label
    return raw.strip() if raw else "---CHAT---"


def _trim_memory() -> None:
    """Keep only the last MAX_MEMORY_TURNS messages."""
    global SESSION_MEMORY
    if len(SESSION_MEMORY) > MAX_MEMORY_TURNS:
        SESSION_MEMORY[:] = SESSION_MEMORY[-MAX_MEMORY_TURNS:]


def aiGO(user_input: str, classification: str, tool_context: str | None = None) -> dict:
    """
    Orchestrate the full AI workflow: screenshot -> LLM -> parse -> script (if AGENT) -> TTS.
    Returns structured result dict for route response.
    """
    if classification not in ("---CHAT---", "---AGENT---"):
        return {"ok": False, "error": f"Invalid classification: {classification}"}

    timings = {}
    t0 = _perf_timer()

    # screenshot
    try:
        t_screen = _perf_timer()
        result = image_processor()
        timings["screenshot_ms"] = round((_perf_timer() - t_screen) * 1000)
    except Exception as e:
        logger.exception("Screenshot capture failed")
        play_image_error_sound()
        return {"ok": False, "error": "Screenshot failed", "detail": str(e)}

    # convert PIL image to bytes (optimize=False for faster encoding on live path)
    t_encode = _perf_timer()
    img = result["image"]
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    image_bytes = buf.getvalue()
    timings["encode_ms"] = round((_perf_timer() - t_encode) * 1000)

    meta = {
        "width": result["width"],
        "height": result["height"],
        "grid": result["grid"],
        "scale": result["scale"],
    }

    SESSION_MEMORY.append({"role": "user", "content": user_input})
    _trim_memory()

    try:
        # call AI service
        t_llm = _perf_timer()
        instructions = load_main_system_prompt()
        input_items = build_main_input(
            classification=classification,
            user_text=user_input,
            image_bytes=image_bytes,
            meta=meta,
            memory_messages=SESSION_MEMORY[:-1],
            tool_context=tool_context,
        )
        raw_text = run_main_llm(instructions=instructions, input_items=input_items)
        timings["llm_ms"] = round((_perf_timer() - t_llm) * 1000)

        script_text, theo_response_text = parse_main_output(raw_text, classification)

        # add assistant response to memory
        SESSION_MEMORY.append({"role": "assistant", "content": theo_response_text})
        _trim_memory()

        # Start TTS in background (runs in parallel with script for AGENT)
        tts_started = threading.Event()

        def _speak_in_background():
            _set_tts_playing(True)
            try:
                speak_text_with_started_event(
                    theo_response_text,
                    started_event=tts_started,
                    async_play=False,
                )
            finally:
                _set_tts_playing(False)

        threading.Thread(target=_speak_in_background, daemon=True).start()

        # If AGENT, run script (blocking until done; TTS runs in parallel)
        script_result = None
        if classification == "---AGENT---" and script_text.strip():
            t_script = _perf_timer()
            script_result = run_script(script_text)
            timings["script_ms"] = round((_perf_timer() - t_script) * 1000)
            if not script_result.get("ok"):
                fallback_msg = (
                    f"Script encountered an error: {script_result.get('error', 'unknown')}"
                    if script_result.get("error")
                    else "The script failed to complete."
                )
                speak_text(fallback_msg, async_play=True)
        elif classification == "---AGENT---" and not script_text.strip():
            logger.warning("AGENT classification but empty script from model")

        timings["total_ms"] = round((_perf_timer() - t0) * 1000)
        tts_started_ok = tts_started.wait(timeout=5.0)
        timings["tts_started"] = bool(tts_started_ok)
        logger.info("aiGO timings: %s", timings)

        result_payload = {
            "ok": True,
            "classification": classification,
            "script_ok": script_result.get("ok", True) if script_result else None,
            "theo_response": theo_response_text,
            "timings": timings,
        }
        if script_result and not script_result.get("ok"):
            result_payload["script_error"] = script_result.get("error")
        return result_payload

    except ValueError as e:
        # Parse error
        logger.warning("Parse error: %s", e)
        SESSION_MEMORY.pop()  # remove the user entry we just added
        fallback_msg = f"I had trouble understanding the response. Please try again. {e}"
        speak_text(fallback_msg, async_play=True)
        return {"ok": False, "error": "Parse failed", "detail": str(e)}

    except Exception as e:
        logger.exception("aiGO failed")
        SESSION_MEMORY.pop()  # remove the user entry we just added
        fallback_msg = "Something went wrong. Please try again."
        speak_text(fallback_msg, async_play=True)
        return {"ok": False, "error": "AI workflow failed", "detail": str(e)}


@app.route("/ping", methods=["GET"])
def ping():
    return "hello from THEO BACKEND"


@app.route("/screenshot", methods=["GET"])
def screenshot():
    """Capture screen with grid overlay; return PIL Image + metadata in-process (no base64)."""
    try:
        result = image_processor()
        metadata = {
            "width": result["width"],
            "height": result["height"],
            "grid": result["grid"],
            "scale": result["scale"],
        }
        return jsonify(metadata)
    except Exception as e:
        logger.exception("Screenshot capture failed")
        play_image_error_sound()
        return jsonify({"error": "Failed to capture screenshot", "detail": str(e)}), 500


@app.route("/screenshot/preview", methods=["GET"])
def screenshot_preview():
    """Return the screenshot image as PNG for testing (view in browser)."""
    try:
        result = image_processor()
        buf = io.BytesIO()
        result["image"].save(buf, format="PNG", optimize=True)
        buf.seek(0)
        return send_file(buf, mimetype="image/png")
    except Exception as e:
        logger.exception("Screenshot preview failed")
        play_image_error_sound()
        return jsonify({"error": "Failed to capture screenshot", "detail": str(e)}), 500


@app.route("/ai/classify", methods=["GET"])
def ai_classify():
    """Lightweight classification only; used by frontend to decide click-through."""
    user_input = request.args.get("user_input")
    if not user_input or not str(user_input).strip():
        return jsonify({"ok": False, "error": "user_input required"}), 400
    user_input = str(user_input).strip()
    raw_classification = llmclassifier(user_input)
    classification = _normalize_classification(raw_classification)
    return jsonify({"ok": True, "classification": classification, "raw": raw_classification}), 200


@app.route("/ai", methods=["GET"])
def ai():
    user_input = request.args.get("user_input")
    if not user_input or not str(user_input).strip():
        return jsonify({"ok": False, "error": "user_input is required and must be non-empty"}), 400

    user_input = str(user_input).strip()

    # Fast path for day/date/time requests (no classifier/main model round-trip).
    if _is_datetime_query(user_input):
        theo_response = _build_datetime_response()
        speak_text(theo_response, async_play=False)
        return jsonify({
            "ok": True,
            "classification": "---CHAT---",
            "script_ok": None,
            "theo_response": theo_response,
        }), 200

    classification_param = request.args.get("classification")
    classifier_raw_param = (request.args.get("classifier_raw") or "").strip()
    classify_ms = None
    classification_source = "backend_classifier"
    tool_segments: list[tuple[str, ...]] = []
    # Guardrail: screen-reading requests should describe screen content, not automate UI.
    if _is_screen_read_query(user_input):
        classification = "---CHAT---"
        classification_source = "screen_reader_rule"
    elif classification_param and classification_param.strip() in ("---CHAT---", "---AGENT---", "---UNSAFE---"):
        classification = classification_param.strip()
        classification_source = "frontend_param"
        if classifier_raw_param:
            _, tool_segments = parse_classifier_raw(classifier_raw_param)
    else:
        t_classify = _perf_timer()
        raw_classification = llmclassifier(user_input)
        classification, tool_segments = parse_classifier_raw(raw_classification)
        classify_ms = round((_perf_timer() - t_classify) * 1000)
        classification_source = "backend_classifier"

    logger.info(
        "Classification resolved: %s (classification_source=%s)",
        classification,
        classification_source,
    )

    if classification == "---UNSAFE---":
        play_warning_sound(blocking=True)
        return jsonify({"ok": False, "classification": classification}), 400

    if classification in ("---CHAT---", "---AGENT---"):
        t_tools = _perf_timer()
        tool_context = run_tool_segments(tool_segments) if tool_segments else None
        tools_ms = round((_perf_timer() - t_tools) * 1000) if tool_segments else None

        result = aiGO(user_input, classification, tool_context=tool_context)
        if result.get("ok"):
            payload = {
                "ok": True,
                "classification": result.get("classification", classification),
                "script_ok": result.get("script_ok"),
                "theo_response": result.get("theo_response"),
            }
            timings = result.get("timings", {})
            if classify_ms is not None:
                timings["classify_ms"] = classify_ms
            if tools_ms is not None:
                timings["tools_ms"] = tools_ms
            if timings:
                payload["timings"] = timings
            return jsonify(payload), 200
        else:
            return jsonify({
                "ok": False,
                "classification": classification,
                "error": result.get("error"),
                "detail": result.get("detail"),
            }), 500

    # Fallback: unknown classification
    return jsonify({"ok": False, "error": "Unknown classification", "classification": classification}), 400


@app.route("/stop-tts", methods=["POST"])
def stop_tts():
    """Stop current TTS playback (called when user interrupts with Ctrl+Win)."""
    stop_playback()
    return jsonify({"ok": True}), 200


@app.route("/tts-status", methods=["GET"])
def tts_status():
    """Poll whether TTS is currently playing. Frontend holds input lock until this returns false."""
    with _tts_lock:
        return jsonify({"playing": _tts_playing}), 200


@app.route("/shutdown", methods=["POST"])
def shutdown():
    """Shutdown the Flask server (called by Electron on quit)."""
    logger.info("Shutdown requested by Electron")
    os._exit(0)


def _launch_electron():
    """Spawn Electron in background after a short delay so Flask is ready."""
    time.sleep(2)
    project_root = Path(__file__).resolve().parent.parent
    frontend_dir = project_root / "frontend"
    if not frontend_dir.exists():
        logger.warning("Frontend dir not found at %s, skipping Electron launch", frontend_dir)
        return
    try:
        if sys.platform == "win32":
            subprocess.Popen(
                ["npm", "start"],
                cwd=str(frontend_dir),
                shell=True,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        else:
            subprocess.Popen(["npm", "start"], cwd=str(frontend_dir))
        logger.info("Launched Electron from %s", frontend_dir)
    except Exception as e:
        logger.exception("Failed to launch Electron: %s", e)


if __name__ == "__main__":
    # Only launch Electron once: in the reloader child when debug=True, or always when debug=False.
    # Flask debug mode runs the script twice (parent + child); we must not spawn from the parent.
    _debug = True
    _is_reloader_child = os.environ.get("WERKZEUG_RUN_MAIN") == "true"
    if _is_reloader_child or not _debug:
        threading.Thread(target=_launch_electron, daemon=True).start()
    app.run(host="127.0.0.1", port=5000, debug=_debug)
