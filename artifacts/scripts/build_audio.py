#!/usr/bin/env python3
"""Generate the soundtrack for the Octopus pitch video.

A warm, cinematic ambient score synthesized with numpy only (no samples, no
network): evolving chord pads, a round sub bass, a bell arpeggio with echo and
a soft shaker pulse. The length is taken from the shared video timeline in
content.py so the music always matches the picture exactly.

Usage:
    python build_audio.py [output_wav] [duration_seconds]

Produces: artifacts/build/audio.wav (48 kHz, stereo, 16-bit)
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from content import total_duration  # noqa: E402

SR = 48_000
BPM = 76.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT

# Chord progression (one bar each), voiced for warm pads, root in the bass.
# Am7 - Fmaj7 - Cmaj7/G - G6 : an open, optimistic loop in C major / A minor.
PROGRESSION = [
    {"pad": [57, 60, 64, 67], "bass": 45},   # Am7   A2
    {"pad": [53, 57, 60, 64], "bass": 41},   # Fmaj7 F2
    {"pad": [55, 59, 64, 67], "bass": 48},   # Cmaj7 voicing, bass C3
    {"pad": [55, 59, 62, 64], "bass": 43},   # G6    G2
]


def midi_hz(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def raised_cosine(n: np.ndarray) -> np.ndarray:
    return 0.5 - 0.5 * np.cos(np.pi * np.clip(n, 0.0, 1.0))


def segment_env(length: int, attack: float, release: float) -> np.ndarray:
    env = np.ones(length, dtype=np.float64)
    a = min(int(attack * SR), length)
    r = min(int(release * SR), length - a) if length - a > 0 else 0
    if a:
        env[:a] = raised_cosine(np.linspace(0, 1, a))
    if r:
        env[length - r:] = raised_cosine(np.linspace(1, 0, r))
    return env


def ramp(points: list[tuple[float, float]], n: int) -> np.ndarray:
    """Piecewise-linear automation curve: [(time_s, value), ...]."""
    t = np.arange(n) / SR
    xs = np.array([p[0] for p in points], dtype=np.float64)
    ys = np.array([p[1] for p in points], dtype=np.float64)
    return np.interp(t, xs, ys)


def fft_lowpass(x: np.ndarray, cutoff: float, slope: float = 2.0) -> np.ndarray:
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / SR)
    gain = 1.0 / np.sqrt(1.0 + (freqs / cutoff) ** (2 * slope))
    return np.fft.irfft(spec * gain, n=len(x))


def build(duration: float) -> np.ndarray:
    rng = np.random.default_rng(7)
    n = int(duration * SR) + SR  # a little tail for releases, trimmed later
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)

    bars = int(np.ceil((duration + 2.0) / BAR))

    # ------------------------------------------------------------------ pads
    pad_l = np.zeros(n)
    pad_r = np.zeros(n)
    for b in range(bars):
        chord = PROGRESSION[b % len(PROGRESSION)]
        t0 = b * BAR
        i0 = int(t0 * SR)
        seg_len = int((BAR + 0.75) * SR)
        if i0 + seg_len > n:
            seg_len = n - i0
        if seg_len <= 0:
            break
        t = np.arange(seg_len) / SR
        env = segment_env(seg_len, attack=0.55, release=0.75)
        for note in chord["pad"]:
            f = midi_hz(note)
            # slightly detuned pair for width; one octave of gentle colour
            for side, det in ((0, +0.0013), (1, -0.0013)):
                ph = rng.uniform(0, 2 * np.pi)
                v = np.sin(2 * np.pi * f * (1 + det) * t + ph)
                v += 0.28 * np.sin(2 * np.pi * 2 * f * t + ph * 0.5)
                v *= env * 0.042
                if side == 0:
                    pad_l[i0:i0 + seg_len] += v
                else:
                    pad_r[i0:i0 + seg_len] += v

    # ------------------------------------------------------------------ bass
    bass = np.zeros(n)
    for b in range(bars):
        chord = PROGRESSION[b % len(PROGRESSION)]
        for k in (0.0, 2 * BEAT):
            t0 = b * BAR + k
            i0 = int(t0 * SR)
            seg_len = int(1.9 * SR)
            if i0 + seg_len > n:
                seg_len = n - i0
            if seg_len <= 0:
                break
            t = np.arange(seg_len) / SR
            f = midi_hz(chord["bass"])
            env = np.exp(-t * 2.1) * raised_cosine(np.minimum(t / 0.03, 1.0))
            v = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
            bass[i0:i0 + seg_len] += v * env * 0.16

    # ------------------------------------------------------- bell arpeggio
    arp_l = np.zeros(n)
    arp_r = np.zeros(n)
    pattern = [0, 2, 3, 2, 1, 3, 2, 3]          # indices into the chord voicing
    for b in range(bars):
        chord = PROGRESSION[b % len(PROGRESSION)]
        for step in range(8):
            t0 = b * BAR + step * (BEAT / 2)
            i0 = int(t0 * SR)
            seg_len = int(1.0 * SR)
            if i0 + seg_len > n:
                seg_len = n - i0
            if seg_len <= 0:
                break
            t = np.arange(seg_len) / SR
            note = chord["pad"][pattern[step] % len(chord["pad"])] + 12
            f = midi_hz(note)
            idx = 1.1 * np.exp(-t * 6.0)
            v = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * 2 * f * t))
            env = np.exp(-t * 4.2) * raised_cosine(np.minimum(t / 0.008, 1.0))
            amp = 0.055 * (1.0 if step % 2 == 0 else 0.72)
            v *= env * amp
            pan = 0.5 + 0.32 * (1 if step % 2 == 0 else -1)
            arp_l[i0:i0 + seg_len] += v * (1.0 - pan)
            arp_r[i0:i0 + seg_len] += v * pan
    # simple two-tap echo
    d1 = int(BEAT * 0.75 * SR)
    d2 = int(BEAT * 1.5 * SR)
    for dst, src in ((arp_l, arp_l.copy()), (arp_r, arp_r.copy())):
        dst[d1:] += src[:-d1] * 0.34
        dst[d2:] += src[:-d2] * 0.16
    arp_l = fft_lowpass(arp_l, 6500.0)
    arp_r = fft_lowpass(arp_r, 6500.0)

    # ---------------------------------------------------------------- shaker
    shake = np.zeros(n)
    step = BEAT / 2
    t_arr = np.arange(int(0.06 * SR)) / SR
    burst = np.diff(rng.standard_normal(len(t_arr) + 1))          # airy hiss
    burst *= np.exp(-t_arr * 55.0)
    burst /= (np.max(np.abs(burst)) + 1e-9)
    k = 0
    t0 = 0.0
    while t0 < duration:
        i0 = int(t0 * SR)
        if i0 + len(burst) < n:
            shake[i0:i0 + len(burst)] += burst * (0.055 if k % 2 else 0.035)
        t0 += step
        k += 1

    # ------------------------------------------------------------ automation
    total = duration
    pad_a = ramp([(0, 0.0), (2.2, 1.0), (total - 3.0, 1.0), (total, 0.85)], n)
    bass_a = ramp([(0, 0.0), (2.8, 0.0), (6.0, 1.0), (total - 4.0, 1.0), (total, 0.7)], n)
    arp_a = ramp([(0, 0.0), (9.0, 0.0), (13.0, 1.0), (total - 10.0, 1.0),
                  (total - 5.5, 0.0), (total, 0.0)], n)
    shake_a = ramp([(0, 0.0), (15.0, 0.0), (19.0, 1.0), (total - 11.0, 1.0),
                    (total - 7.0, 0.0), (total, 0.0)], n)

    left += pad_l * pad_a + bass * bass_a * 0.5 + arp_l * arp_a + shake * shake_a * 0.9
    right += pad_r * pad_a + bass * bass_a * 0.5 + arp_r * arp_a + shake * shake_a * 1.0
    # a touch of stereo on the shaker
    left += shake * shake_a * 0.1
    right -= shake * shake_a * 0.1

    # -------------------------------------------------------------- master
    n_out = int(duration * SR)
    left = left[:n_out]
    right = right[:n_out]
    left = np.tanh(left * 1.25) / 1.25
    right = np.tanh(right * 1.25) / 1.25

    fade_in = raised_cosine(np.arange(n_out) / (1.8 * SR))
    fade_out = raised_cosine(np.arange(n_out)[::-1] / (3.2 * SR))
    env = fade_in * fade_out
    left *= env
    right *= env

    peak = max(np.max(np.abs(left)), np.max(np.abs(right)), 1e-9)
    gain = 0.89 / peak
    left *= gain
    right *= gain

    stereo = np.stack([left, right], axis=1)
    return np.clip(stereo, -1.0, 1.0)


def write_wav(path: Path, data: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (data * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(pcm.tobytes())


def main() -> None:
    default_out = Path(__file__).resolve().parent.parent / "build" / "audio.wav"
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else default_out
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else total_duration()
    data = build(duration)
    write_wav(out, data)
    rms = float(np.sqrt(np.mean(data ** 2)))
    print(f"wrote {out}  {duration:.2f}s  {data.shape[0]:,} frames  "
          f"peak={np.max(np.abs(data)):.3f} rms={rms:.3f} ({20 * np.log10(rms + 1e-9):.1f} dBFS)")


if __name__ == "__main__":
    main()
