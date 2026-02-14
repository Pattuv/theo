#This is a thin TTS client that generates speech from text and plays it back.

import logging
import threading
from pathlib import Path
from typing import Optional

from .tts import synthesize_tts

logger = logging.getLogger(__name__)


def _play_wav(path: Path, async_play: bool = False, started_event: Optional[threading.Event] = None) -> None:
    path = path.resolve()
    if not path.is_file():
        logger.warning("TTS WAV not found at %s", path)
        if started_event:
            started_event.set()
        return

    def _do_play() -> None:
        try:
            import sounddevice as sd
            import soundfile as sf
            data, sample_rate = sf.read(path)
            if data.dtype.kind == "i":
                data = data.astype("float32") / (2 ** (data.dtype.itemsize * 8 - 1))
            elif data.dtype != "float32":
                data = data.astype("float32")
            if data.ndim == 1:
                data = data.reshape(-1, 1)
            if started_event:
                started_event.set()
            sd.play(data, sample_rate)
            sd.wait()
        except Exception as e:
            if started_event:
                started_event.set()
            logger.warning("Could not play TTS WAV %s: %s", path, e)

    if async_play:
        import threading
        threading.Thread(target=_do_play, daemon=True).start()
    else:
        _do_play()


def stop_playback() -> None:
    """Stop any currently playing TTS audio."""
    try:
        import sounddevice as sd
        sd.stop()
    except Exception as e:
        logger.warning("Could not stop TTS playback: %s", e)


def speak_text(text: str, out_path: Optional[Path] = None, async_play: bool = False) -> Path:
    #Generate TTS for text and play it back.
    audio_path = synthesize_tts(text, out_path=out_path)
    _play_wav(audio_path, async_play=async_play)
    return audio_path


def speak_text_with_started_event(
    text: str,
    started_event: threading.Event,
    out_path: Optional[Path] = None,
    async_play: bool = False,
) -> Path:
    """Generate TTS and signal once playback is about to start."""
    audio_path = synthesize_tts(text, out_path=out_path)
    _play_wav(audio_path, async_play=async_play, started_event=started_event)
    return audio_path
