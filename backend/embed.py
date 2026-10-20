"""multilingual-e5-small (int8 ONNX) in a child process that dies after IDLE seconds, because freeing a model in-process keeps ~400 MB."""
import base64
import json
import subprocess
import sys
import threading
from pathlib import Path

DIR = Path(sys.argv[1]) if __name__ == "__main__" else None  # <data>/model, db.py sets it and passes it to the child
ONNX = "onnx/model_quantized.onnx"
IDLE = 180
MAXLEN = 256
lock = threading.Lock()
proc = timer = None


def child():
    import numpy as np
    import onnxruntime as ort
    import sentencepiece as spm
    from huggingface_hub import hf_hub_download

    for repo, name, rev in [("intfloat/multilingual-e5-small", "sentencepiece.bpe.model", None),
                            ("Xenova/multilingual-e5-small", "onnx/model_quantized.onnx", "761b726dd34fb83930e26aab4e9ac3899aa1fa78")]:
        if not (DIR / name).exists():
            hf_hub_download(repo, name, revision=rev, local_dir=DIR)
    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = False  # saves ~100 MB of peak memory, same speed
    sess = ort.InferenceSession(DIR / ONNX, opts, providers=["CPUExecutionProvider"])
    sp = spm.SentencePieceProcessor(model_file=str(DIR / "sentencepiece.bpe.model"))
    for line in sys.stdin:
        # XLM-R ids are sentencepiece ids + 1, with <s>=0, <pad>=1, </s>=2
        ids = [[0] + [i + 1 for i in sp.encode(t)[:MAXLEN - 2]] + [2] for t in json.loads(line)]
        x = np.array([i + [1] * (max(map(len, ids)) - len(i)) for i in ids])
        mask = (x != 1).astype(np.int64)
        h = sess.run(None, {"input_ids": x, "attention_mask": mask, "token_type_ids": np.zeros_like(x)})[0]
        v = (h * mask[..., None]).sum(1) / mask.sum(1, keepdims=True)
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        print(json.dumps([base64.b64encode(r.astype(np.float16).tobytes()).decode() for r in v]), flush=True)


def stop():
    with lock:
        proc.kill()
        proc.wait()


def embed(texts, query=False):
    """One float16 vector (bytes) per text, None if the model is missing or fails. Only saves download it, searches never wait."""
    global proc, timer
    if query and not (DIR / ONNX).exists():
        return None
    with lock:
        if timer:
            timer.cancel()
        try:
            if proc is None or proc.poll() is not None:
                proc = subprocess.Popen([sys.executable, __file__, str(DIR)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            proc.stdin.write(json.dumps([("query: " if query else "passage: ") + t for t in texts]) + "\n")
            proc.stdin.flush()
            out = [base64.b64decode(x) for x in json.loads(proc.stdout.readline())]
        except (OSError, ValueError):
            return None
        timer = threading.Timer(IDLE, stop)
        timer.daemon = True
        timer.start()
        return out


if __name__ == "__main__":
    child()
