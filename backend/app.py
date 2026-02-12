import io
import logging
import threading
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
from services.TTS.ttsClient import speak_text
from utils.audioFeedback.audioFeedback import play_image_error_sound
from utils.audioFeedback.audioFeedback import play_warning_sound
from utils.imageProcessor.imageProcessor import image_processor
from utils.llmclassifer.llmClassifier import llmclassifier

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Load .env for keys
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

app = Flask(__name__)
CORS(app)

# single-session memory: last 6 turns. resets every run.
SESSION_MEMORY: list[dict] = []
MAX_MEMORY_TURNS = 12  # 6 turns = 6 user + 6 assistant messages combined together


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


def aiGO(user_input: str, classification: str) -> dict:
    """
    Orchestrate the full AI workflow: screenshot -> LLM -> parse -> script (if AGENT) -> TTS.
    Returns structured result dict for route response.
    """
    if classification not in ("---CHAT---", "---AGENT---"):
        return {"ok": False, "error": f"Invalid classification: {classification}"}

    # screenshot
    try:
        result = image_processor()
    except Exception as e:
        logger.exception("Screenshot capture failed")
        play_image_error_sound()
        return {"ok": False, "error": "Screenshot failed", "detail": str(e)}

    # convert PIL image to bytes
    img = result["image"]
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    image_bytes = buf.getvalue()

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
        instructions = load_main_system_prompt()
        input_items = build_main_input(
            classification=classification,
            user_text=user_input,
            image_bytes=image_bytes,
            meta=meta,
            memory_messages=SESSION_MEMORY[:-1],  
        )
        raw_text = run_main_llm(instructions=instructions, input_items=input_items)

        
        script_text, theo_response_text = parse_main_output(raw_text, classification)

        # add assistant response to memory
        SESSION_MEMORY.append({"role": "assistant", "content": theo_response_text})
        _trim_memory()

        # 7. If AGENT, run script
        script_result = None
        if classification == "---AGENT---" and script_text.strip():
            script_result = run_script(script_text)
            if not script_result.get("ok"):
                fallback_msg = f"Script encountered an error: {script_result.get('error', 'unknown')}" if script_result.get("error") else "The script failed to complete."
                speak_text(fallback_msg, async_play=True)
                return {
                    "ok": True,
                    "classification": classification,
                    "script_ok": False,
                    "script_error": script_result.get("error"),
                    "theo_response": theo_response_text,
                }
        elif classification == "---AGENT---" and not script_text.strip():
            logger.warning("AGENT classification but empty script from model")

        # 8. Speak Theo response in background so we return immediately after script.
        # Frontend gets response, disables click-through right away; TTS plays in background.
        def _speak_in_background():
            speak_text(theo_response_text, async_play=False)

        threading.Thread(target=_speak_in_background, daemon=True).start()

        return {
            "ok": True,
            "classification": classification,
            "script_ok": script_result.get("ok", True) if script_result else None,
            "theo_response": theo_response_text,
        }

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
    return jsonify({"ok": True, "classification": classification}), 200


@app.route("/ai", methods=["GET"])
def ai():
    user_input = request.args.get("user_input")
    if not user_input or not str(user_input).strip():
        return jsonify({"ok": False, "error": "user_input is required and must be non-empty"}), 400

    user_input = str(user_input).strip()
    classification_param = request.args.get("classification")
    if classification_param and classification_param.strip() in ("---CHAT---", "---AGENT---", "---UNSAFE---"):
        classification = classification_param.strip()
    else:
        raw_classification = llmclassifier(user_input)
        classification = _normalize_classification(raw_classification)

    if classification == "---UNSAFE---":
        play_warning_sound(blocking=True)
        return jsonify({"ok": False, "classification": classification}), 400

    if classification in ("---CHAT---", "---AGENT---"):
        result = aiGO(user_input, classification)
        if result.get("ok"):
            return jsonify({
                "ok": True,
                "classification": result.get("classification", classification),
                "script_ok": result.get("script_ok"),
                "theo_response": result.get("theo_response"),
            }), 200
        else:
            return jsonify({
                "ok": False,
                "classification": classification,
                "error": result.get("error"),
                "detail": result.get("detail"),
            }), 500

    # Fallback: unknown classification
    return jsonify({"ok": False, "error": "Unknown classification", "classification": classification}), 400


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
