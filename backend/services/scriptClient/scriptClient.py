

import ast
import builtins
import logging
from typing import Any

import math
import pyautogui
import random
import time

try:
    import PIL
except ImportError:
    PIL = None

logger = logging.getLogger(__name__)


def _validate_script(script_text: str) -> None:
    """Validate Python syntax only. No import restrictions (dev mode)."""
    try:
        ast.parse(script_text)
    except SyntaxError as e:
        raise ValueError(f"Invalid Python syntax: {e}") from e


def run_script(script_text: str) -> dict[str, Any]:
    """
    Validate and execute the script text in-process.
    All imports allowed (dev mode); use standard __builtins__.

    Returns:
        {"ok": True} on success, {"ok": False, "error": "..."} on validation or runtime error.
    """
    script_text = (script_text or "").strip()
    if not script_text:
        return {"ok": False, "error": "Empty script"}

    try:
        _validate_script(script_text)
    except ValueError as e:
        logger.warning("Script validation failed: %s", e)
        return {"ok": False, "error": str(e)}


    script_globals: dict[str, Any] = {
        "pyautogui": pyautogui,
        "time": time,
        "random": random,
        "math": math,
        "__builtins__": builtins.__dict__,
    }
    if PIL is not None:
        script_globals["PIL"] = PIL

    try:
        exec(compile(script_text, "<script>", "exec"), script_globals)
        return {"ok": True}
    except Exception as e:
        logger.exception("Script execution failed")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
