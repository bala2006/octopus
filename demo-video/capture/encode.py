"""Turn a CDP screencast folder (frames.json + f/*.jpg) into a constant-30fps MP4.

Frame N is shown from its own timestamp until the next frame's timestamp, so clip time equals wall-clock
time since the stream's first frame. Writes <name>.mp4 and <name>.json ({"t0": epoch_ms, "duration": s}).
Usage: python3 encode.py <capture_out_dir> <stream> [<stream> ...]
"""
import json
import os
import subprocess
import sys

FFMPEG = ["npx", "remotion", "ffmpeg"]
VIDEO_DIR = "/projects/sandbox/octopus-demo/video"


def encode(out_dir: str, name: str) -> None:
    d = os.path.abspath(os.path.join(out_dir, name))
    frames = json.load(open(os.path.join(d, "frames.json")))
    frames.sort(key=lambda f: f[0])
    lst = os.path.join(d, "concat.txt")
    with open(lst, "w") as fh:
        for i, (ts, f) in enumerate(frames):
            nxt = frames[i + 1][0] if i + 1 < len(frames) else ts + 2000
            dur = max(0.001, (nxt - ts) / 1000)
            fh.write(f"file '{os.path.join(d, f)}'\nduration {dur:.4f}\n")
        fh.write(f"file '{os.path.join(d, frames[-1][1])}'\n")
    dest = os.path.join(VIDEO_DIR, "public", "footage", f"{name}.mp4")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    cmd = FFMPEG + ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p", "-fps_mode", "cfr", "-r", "30",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "15", "-movflags", "+faststart", dest]
    subprocess.run(cmd, check=True, cwd=VIDEO_DIR)
    meta = {"t0": frames[0][0], "duration": (frames[-1][0] - frames[0][0]) / 1000 + 2}
    json.dump(meta, open(dest.replace(".mp4", ".json"), "w"))
    print(name, meta, os.path.getsize(dest) // 1_000_000, "MB")


if __name__ == "__main__":
    for s in sys.argv[2:]:
        encode(sys.argv[1], s)
