import os
import queue
import subprocess
import sys
import threading
import time
from datetime import datetime

import sounddevice as sd
import soundfile as sf

import db
import settings

lock = threading.Lock()
state = {"stream": None, "queue": None, "writer": None, "name": None, "start": 0, "app": None, "meta": None, "note": None, "profile": None, "transcribing": 0}


def writer(f, q):
    """The audio callback only queues chunks, a disk stall in it would drop audio."""
    while (chunk := q.get()) is not None:  # `is not`, numpy arrays can't be compared with ==
        f.write(chunk)
    f.close()


def start(app=None, meta=None, note=None):
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
        state.update(stream=stream, queue=q, writer=w, name=name, start=time.time(), app=app, meta=meta, note=note, profile=db.active_profile())


def stop():
    with lock:
        if not state["stream"]:
            return
        state["stream"].stop()
        state["stream"].close()
        state["queue"].put(None)
        state["writer"].join()
        try:  # on stays true until the item exists, so a poll that sees it off finds the item
            args = save(state["name"], state["app"], state["profile"], state["meta"], state["note"])
            state["transcribing"] += 1
        finally:
            state.update(stream=None)
    threading.Thread(target=transcribe, args=args, daemon=True).start()


def save(name, app, profile, meta=None, note=None):
    """Adds the voice item at once, playable, with empty content and meta.transcribing. Returns (id, file)."""
    # WebKit can't play FLAC, AAC plays everywhere and is ~3x smaller. Whisper reads the m4a, so the file name never changes
    m4a = name.replace(".flac", ".m4a")
    ok = subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "32000", str(db.FILES / name), str(db.FILES / m4a)]).returncode == 0
    id = db.add("", "voice", m4a if ok else name, app, profile, {**(meta or {}), "transcribing": True}, note)
    if ok:
        (db.FILES / name).unlink()
    return id, m4a if ok else name


def whisper(path):
    from faster_whisper import WhisperModel, decode_audio
    s = settings.get()
    model, audio, language = WhisperModel(s["model"], device="cpu", compute_type="int8"), decode_audio(path), None
    if s["languages"]:
        language = max((p, lang) for lang, p in model.detect_language(audio, vad_filter=True)[2] if lang in s["languages"])[1]
    segments, info = model.transcribe(audio, vad_filter=True, language=language)
    text = " ".join(s.text.strip() for s in segments)
    if info.language == "en" or not text:
        return text
    # keep the exact words and add an English version so English searches find it
    segments, _ = model.transcribe(audio, vad_filter=True, language=info.language, task="translate")
    return text + "\n\nEnglish: " + " ".join(s.text.strip() for s in segments)


def transcribe(id, name):
    try:
        # a child process gives the model's ~500 MB back to the OS on exit, gc alone does not
        p = subprocess.run([sys.executable, __file__, str(db.FILES / name)], capture_output=True, text=True)
        db.update(id, p.stdout.strip() or "(no speech)" if p.returncode == 0 else "(transcription failed)")  # clears meta.transcribing
    finally:
        with lock:
            state["transcribing"] -= 1


def recover():
    """Recordings a quit or crash left behind: a .flac without an item, or an item still marked transcribing. One at a time."""
    flacs = [f.name for f in sorted(db.FILES.glob("*.flac")) if not db.has_file(f.name)]
    todo = db.transcribing()  # before a new recording can add one
    with lock:
        state["transcribing"] += len(flacs) + len(todo)
    threading.Thread(target=lambda: [transcribe(*t) for t in todo + [save(n, None, db.active_profile()) for n in flacs]], daemon=True).start()


def status():
    on = state["stream"] is not None
    return {"on": on, "seconds": int(time.time() - state["start"]) if on else 0, "transcribing": state["transcribing"]}


def orphaned(parent):
    while os.getppid() == parent:
        time.sleep(1)
    os._exit(1)  # the backend died, so don't keep transcribing for nobody


if __name__ == "__main__":
    threading.Thread(target=orphaned, args=(os.getppid(),), daemon=True).start()
    print(whisper(sys.argv[1]))
