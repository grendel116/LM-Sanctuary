"""
core/stt.py — Local offline Speech-to-Text engine using faster-whisper.
"""

import os
import io
import threading
from typing import Optional

_model = None
_model_lock = threading.Lock()


def get_whisper_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                try:
                    from faster_whisper import WhisperModel
                    model_size = os.getenv("LOCAL_STT_MODEL", "tiny.en")
                    _model = WhisperModel(model_size, device="cpu", compute_type="int8")
                    print(f"[STT] Loaded local faster-whisper model ({model_size}) successfully.")
                except Exception as e:
                    print(f"[STT] Error loading faster-whisper: {e}")
    return _model


def transcribe_audio_bytes(audio_bytes: bytes, language: Optional[str] = "en") -> str:
    """Transcribes raw audio bytes into text using local faster-whisper."""
    if not audio_bytes:
        return ""

    model = get_whisper_model()
    if model is None:
        return ""

    try:
        audio_stream = io.BytesIO(audio_bytes)
        segments, info = model.transcribe(
            audio_stream,
            beam_size=3,
            language=language,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        text_parts = [segment.text for segment in segments]
        return " ".join(text_parts).strip()
    except Exception as e:
        print(f"[STT] Transcription error: {e}")
        return ""
