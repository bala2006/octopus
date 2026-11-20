"""Generate the narration with Sarvam TTS, one clip per line, and assemble it with measured timings.

Outputs (in video/public/audio/):
  narration.wav   the full voice track, 48 kHz mono 16-bit
  timing.json     scenes -> lines -> {start, end, words:[{w, t}]} in seconds on the voice track
Cached per line in narration/cache/ so re-runs only call the API for changed lines.
Usage: python3 voice.py [--check]   (--check transcribes every line with Sarvam STT and reports mismatches)
"""
import array
import base64
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.request
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "video", "public", "audio")
CACHE = os.path.join(HERE, "cache")
RATE = 48000


def env_key() -> str:
    for line in open(os.path.join(ROOT, ".env")):
        if line.startswith("SARVAM_API_KEY="):
            return line.strip().split("=", 1)[1]
    raise SystemExit("SARVAM_API_KEY missing in .env")


KEY = env_key()


def tts(text: str, voice: dict) -> bytes:
    body = json.dumps({
        "text": text, "language_code": voice["language_code"], "model": voice["model"], "speaker": voice["speaker"],
        "pace": voice.get("pace", 1.0), "speech_sample_rate": RATE, "enable_preprocessing": True,
    }).encode()
    for attempt in range(5):
        try:
            req = urllib.request.Request("https://api.sarvam.ai/text-to-speech", data=body,
                                         headers={"api-subscription-key": KEY, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.load(r)
            return base64.b64decode("".join(d["audios"]))
        except Exception as e:  # rate limits / transient errors
            print("  retry", attempt, e)
            time.sleep(2 + attempt * 3)
    raise RuntimeError("TTS failed: " + text)


def stt(wav_bytes: bytes) -> str:
    boundary = "----vox" + hashlib.md5(wav_bytes[:1000]).hexdigest()
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsaaras:v4\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\nen-IN\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode(),
        wav_bytes, f"\r\n--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request("https://api.sarvam.ai/speech-to-text", data=b"".join(parts),
                                 headers={"api-subscription-key": KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["transcript"]


def read_pcm(wav_bytes: bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        assert w.getsampwidth() == 2, "expected 16-bit audio"
        ch, sr = w.getnchannels(), w.getframerate()
        a = array.array("h", w.readframes(w.getnframes()))
    if ch > 1:
        a = array.array("h", a[::ch])
    assert sr == RATE, f"sample rate {sr}"
    return a


def trim(a: array.array, thresh=500, pad=0.04):
    """Cut leading/trailing silence, keeping `pad` seconds; returns trimmed samples."""
    win = int(RATE * 0.01)
    def loud(i):
        seg = a[i:i + win]
        return max(abs(x) for x in seg) > thresh if len(seg) else False
    s = 0
    while s < len(a) and not loud(s):
        s += win
    e = len(a)
    while e > s and not loud(e - win):
        e -= win
    p = int(RATE * pad)
    return a[max(0, s - p):min(len(a), e + p)]


def word_times(text: str, dur: float):
    """Spread words over the clip by a syllable-ish weight; punctuation adds a small pause."""
    words = text.split()
    def weight(w):
        core = re.sub(r"[^A-Za-z0-9]", "", w)
        v = max(1, len(re.findall(r"[aeiouy]+", core.lower()))) + len(core) * 0.08
        return v
    pause = [0.35 if re.search(r"[.,?!;:]$", w) else 0.0 for w in words]
    total = sum(weight(w) for w in words) + sum(pause)
    t, out = 0.0, []
    for w, p in zip(words, pause):
        out.append({"w": w, "t": round(t / total * dur, 3)})
        t += weight(w) + p
    return out


def main():
    check = "--check" in sys.argv
    spec = json.load(open(os.path.join(HERE, "script.json")))
    voice = spec["voice"]
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    track = array.array("h")
    timing = {"scenes": []}
    problems = []
    for si, scene in enumerate(spec["scenes"]):
        if si:
            track.extend([0] * int(RATE * spec["gapScene"]))
        sc = {"id": scene["id"], "start": len(track) / RATE, "lines": []}
        for li, text in enumerate(scene["lines"]):
            if li:
                track.extend([0] * int(RATE * spec["gapLine"]))
            h = hashlib.sha1(json.dumps([text, voice]).encode()).hexdigest()[:16]
            path = os.path.join(CACHE, f"{h}.wav")
            if not os.path.exists(path):
                print("TTS", scene["id"], li, text[:60])
                open(path, "wb").write(tts(text, voice))
            raw = open(path, "rb").read()
            a = trim(read_pcm(raw))
            start = len(track) / RATE
            track.extend(a)
            dur = len(a) / RATE
            sc["lines"].append({"text": text, "start": round(start, 3), "end": round(start + dur, 3),
                                "words": [{"w": x["w"], "t": round(start + x["t"], 3)} for x in word_times(text, dur)]})
            if check:
                got = stt(raw)
                norm = lambda s: re.sub(r"[^a-z0-9 ]", "", s.lower()).split()
                exp, act = norm(text), norm(got)
                common = len(set(exp) & set(act)) / max(1, len(set(exp)))
                flag = "" if common > 0.8 else "   <-- CHECK"
                if flag:
                    problems.append((scene["id"], li, text, got))
                print(f"{scene['id']}[{li}] {dur:5.2f}s match={common:.2f}{flag}\n   said: {got}")
        sc["end"] = len(track) / RATE
        timing["scenes"].append(sc)
    track.extend([0] * int(RATE * 1.5))
    with wave.open(os.path.join(OUT, "narration.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(track.tobytes())
    timing["duration"] = len(track) / RATE
    json.dump(timing, open(os.path.join(OUT, "timing.json"), "w"), indent=1)
    print(f"total {timing['duration']:.1f}s, {sum(len(s['lines']) for s in timing['scenes'])} lines")
    for s in timing["scenes"]:
        print(f"  {s['id']:8s} {s['start']:6.1f} -> {s['end']:6.1f}  ({s['end'] - s['start']:.1f}s)")
    if problems:
        print("PROBLEMS:")
        for p in problems:
            print(" ", p)


if __name__ == "__main__":
    main()
