#Backend-based fallback sounds.

import logging
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

_ASSETS_DIR = Path(__file__).resolve().parent


def _play_wav(filename: str, blocking: bool = False) -> None:
    def _play():
        try:
            path = (_ASSETS_DIR / filename).resolve()
            if not path.is_file():
                logger.warning("%s not found at %s", filename, path)
                return
            import sounddevice as sd
            import soundfile as sf
            data, sample_rate = sf.read(path)
            if data.dtype.kind == "i":
                data = data.astype("float32") / (2 ** (data.dtype.itemsize * 8 - 1))
            elif data.dtype != "float32":
                data = data.astype("float32")
            if data.ndim == 1:
                data = data.reshape(-1, 1)
            logger.info("Playing %s from %s", filename, path)
            sd.play(data, sample_rate)
            sd.wait()
        except Exception as e:
            logger.warning("Could not play %s: %s", filename, e)

    if blocking:
        _play()
        return
    threading.Thread(target=_play, daemon=True).start()


def play_image_error_sound(blocking: bool = False) -> None:
    _play_wav("outerror.wav", blocking=blocking)


def play_warning_sound(blocking: bool = False) -> None:
    _play_wav("warning.wav", blocking=blocking)
