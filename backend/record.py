import gc
import threading
import time

import sounddevice as sd
import soundfile as sf

import db

MODEL = "small"  # faster-whisper size, multilingual, loaded only while transcribing to keep idle memory low
lock = threading.Lock()
state = {"stream": None, "file": None, "name": None, "start": 0, "app": None, "profile": None, "transcribing": 0}


def start(app=None):
    with lock:
        if state["stream"]:
            return
        name = time.strftime("%Y%m%d-%H%M%S") + ".flac"
        # 16 kHz mono FLAC is what Whisper wants and is about 1 MB a minute
        f = sf.SoundFile(db.FILES / name, "w", samplerate=16000, channels=1, format="FLAC")
        stream = sd.InputStream(samplerate=16000, channels=1, callback=lambda data, *_: f.write(data))
        stream.start()
        state.update(stream=stream, file=f, name=name, start=time.time(), app=app, profile=db.active_profile())


def stop():
    with lock:
        if not state["stream"]:
            return
        state["stream"].stop()
        state["stream"].close()
        state["file"].close()
        args = (state["name"], state["app"], state["profile"])
        state.update(stream=None, file=None)
        state["transcribing"] += 1
    threading.Thread(target=transcribe, args=args, daemon=True).start()


def transcribe(name, app, profile):
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(MODEL, device="cpu", compute_type="int8")
        segments, _ = model.transcribe(str(db.FILES / name), vad_filter=True)
        text = " ".join(s.text.strip() for s in segments)
        del model
        gc.collect()
        db.add(text or "(no speech)", "voice", name, app, profile)
    finally:
        with lock:
            state["transcribing"] -= 1


def status():
    on = state["stream"] is not None
    return {"on": on, "seconds": int(time.time() - state["start"]) if on else 0, "transcribing": state["transcribing"]}
