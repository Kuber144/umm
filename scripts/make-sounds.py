"""Makes the five umm sounds (44.1 kHz mono WAV) in app/sounds. They share one timbre.
Run: cd backend && uv run python ../scripts/make-sounds.py"""
import wave
from pathlib import Path
import numpy as np

SR = 44100
OUT = Path(__file__).resolve().parent.parent / "app" / "sounds"


def tone(f, d, bend=0.0, h2=0.2, h3=0.1):
    """a sine with 2nd and 3rd harmonic, 5 ms attack, exponential decay over d seconds"""
    t = np.arange(int(SR * d)) / SR
    p = 2 * np.pi * np.cumsum(f * (1 - bend * t / d)) / SR
    return (np.sin(p) + h2 * np.sin(2 * p) + h3 * np.sin(3 * p)) * np.minimum(t / 0.005, 1) * np.exp(-5 * t / d)


def notes(freqs, step, d):
    y = np.zeros(int(SR * (step * (len(freqs) - 1) + d)))
    for i, f in enumerate(freqs):
        n = tone(f, d)
        y[int(SR * step * i):][:len(n)] += n
    return y


def save(name, y):
    y = y / abs(y).max() * 10 ** (-14 / 20)  # peak at -14 dBFS
    n = int(SR * 0.005)
    y[:n] *= np.linspace(0, 1, n)
    y[-n:] *= np.linspace(1, 0, n)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767).astype("<i2").tobytes())


thump = tone(180, 0.12, h2=0, h3=0)
click = np.convolve(np.random.default_rng(0).standard_normal(int(SR * 0.025)), np.ones(6) / 6, "same")
click *= np.exp(-5 * np.arange(len(click)) / len(click)) * 0.6 / abs(click).max()
thump[:len(click)] += click

OUT.mkdir(exist_ok=True)
save("shutter", thump)
save("saved", notes([659, 988], 0.07, 0.11))
save("rec-start", notes([440, 554, 659], 0.06, 0.1))
save("rec-stop", notes([659, 554, 440], 0.06, 0.1))
save("error", tone(220, 0.22, bend=0.08, h2=0.15, h3=0))
