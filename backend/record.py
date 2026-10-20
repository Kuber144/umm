import queue
import subprocess
import sys
import threading
import time
from datetime import datetime

import sounddevice as sd
import soundfile as sf

import db

MODEL = "small"  # faster-whisper size, multilingual, runs in a child process only while transcribing to keep idle memory low
LANGUAGE = "en"  # auto detect misreads short clips (it heard "hello hello" as Arabic), set None to auto detect
lock = threading.Lock()
state = {"stream": None, "queue": None, "writer": None, "name": None, "start": 0, "app": None, "profile": None, "transcribing": 0}


def writer(f, q):
    """The audio callback only queues chunks, a disk stall in it would drop audio."""
    while (chunk := q.get()) is not None:  # `is not`, numpy arrays can't be compared with ==
        f.write(chunk)
    f.close()


def start(app=None):
    with lock:
        if state["stream"]:
            return
        name = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".flac"
        # 16 kHz mono FLAC is what Whisper wants and is about 1 MB a minute
        f = sf.SoundFile(db.FILES / name, "w", samplerate=16000, channels=1, format="FLAC")
        q = queue.SimpleQueue()
        w = threading.Thread(target=writer, args=(f, q), daemon=True)
        try:
            stream = sd.InputStream(samplerate=16000, channels=1, callback=lambda data, *_: q.put(data.copy()))
            stream.start()
        except Exception:  # no mic permission or no input device
            f.close()
            (db.FILES / name).unlink()
            raise
        w.start()
        state.update(stream=stream, queue=q, writer=w, name=name, start=time.time(), app=app, profile=db.active_profile())


def stop():
    with lock:
        if not state["stream"]:
            return
        state["stream"].stop()
        state["stream"].close()
        state["queue"].put(None)
        state["writer"].join()
        args = (state["name"], state["app"], state["profile"])
        state.update(stream=None)
        state["transcribing"] += 1
    threading.Thread(target=transcribe, args=args, daemon=True).start()


def whisper(path):
    from faster_whisper import WhisperModel
    segments, _ = WhisperModel(MODEL, device="cpu", compute_type="int8").transcribe(path, vad_filter=True, language=LANGUAGE)
    return " ".join(s.text.strip() for s in segments)


def transcribe(name, app, profile):
    try:
        # a child process gives the model's ~500 MB back to the OS on exit, gc alone does not
        p = subprocess.run([sys.executable, __file__, str(db.FILES / name)], capture_output=True, text=True)
        text = p.stdout.strip() or "(no speech)" if p.returncode == 0 else "(transcription failed)"
        # WebKit can't play FLAC, AAC plays everywhere and is ~3x smaller
        m4a = name.replace(".flac", ".m4a")
        if subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "32000", str(db.FILES / name), str(db.FILES / m4a)]).returncode == 0:
            (db.FILES / name).unlink()
            name = m4a
        db.add(text, "voice", name, app, profile)
    finally:
        with lock:
            state["transcribing"] -= 1


def status():
    on = state["stream"] is not None
    return {"on": on, "seconds": int(time.time() - state["start"]) if on else 0, "transcribing": state["transcribing"]}


if __name__ == "__main__":
    print(whisper(sys.argv[1]))
