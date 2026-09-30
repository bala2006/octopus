#!/usr/bin/env python3
"""Render the Octopus pitch video for Vivek.

1920x1080 @ 60 fps, frame-accurate motion design built with Pillow + numpy:

  * per-scene animated backgrounds (gradient, glow, org-graph decoration,
    vignette, dithering noise) with slow parallax drift
  * staggered text entrances (fade + eased slide), wipe-in accent rules
  * alternating cross-fade and push transitions with smoother-step easing
  * persistent chrome: progress bar, brand line, scene counter
  * a synthesized soundtrack (see build_audio.py) muxed in at the end

The render is split into segments so each command stays well inside the
terminal time budget:

    python render_video.py render --segment 0 --segments 4
    ...
    python render_video.py concat
    python render_video.py mux --audio build/audio.wav --out ../octopus-pitch-for-vivek.mp4
"""

from __future__ import annotations

import argparse
import math
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from content import (  # noqa: E402
    FPS,
    HEIGHT,
    PALETTE,
    TRANSITION,
    VIDEO_SCENES,
    WIDTH,
    scene_starts,
    segment_bounds,
    total_duration,
    total_frames,
)

SCRIPT_DIR = Path(__file__).resolve().parent
OUT_DIR = SCRIPT_DIR.parent / "build"
FONT_DIR = SCRIPT_DIR / "fonts"

W, H = WIDTH, HEIGHT
MARGIN = 150
CONTENT_R = W - MARGIN
BLACK = (0, 0, 0)

FONT_URLS = {
    "Poppins-ExtraBold.ttf": "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf",
    "Poppins-SemiBold.ttf": "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf",
    "Poppins-Medium.ttf": "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Medium.ttf",
    "Lato-Regular.ttf": "https://raw.githubusercontent.com/google/fonts/main/ofl/lato/Lato-Regular.ttf",
    "Lato-Bold.ttf": "https://raw.githubusercontent.com/google/fonts/main/ofl/lato/Lato-Bold.ttf",
}

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


# ---------------------------------------------------------------------------
# Math / easing
# ---------------------------------------------------------------------------
def clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def ease_out_cubic(p: float) -> float:
    p = clamp01(p)
    return 1 - (1 - p) ** 3


def smoothstep(p: float) -> float:
    p = clamp01(p)
    return p * p * (3 - 2 * p)


def smootherstep(p: float) -> float:
    p = clamp01(p)
    return p * p * p * (p * (p * 6 - 15) + 10)


def hex_rgb(value: str) -> tuple[int, int, int]:
    v = value.lstrip("#")
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


ACCENT = hex_rgb(PALETTE["accent"])
OLIVE = hex_rgb(PALETTE["olive"])
STEEL = hex_rgb(PALETTE["steel"])
CREAM = hex_rgb(PALETTE["text"])
MUTED = hex_rgb(PALETTE["muted"])
SOFT = hex_rgb(PALETTE["text_soft"])


# ---------------------------------------------------------------------------
# Fonts & text helpers
# ---------------------------------------------------------------------------
def ensure_fonts() -> None:
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in FONT_URLS.items():
        dest = FONT_DIR / name
        if dest.exists() and dest.stat().st_size > 10_000:
            continue
        print(f"downloading {name} ...")
        urllib.request.urlretrieve(url, dest)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    key = (name, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(str(FONT_DIR / name), size)
    return _font_cache[key]


def wrap_lines(text: str, fnt: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    out: list[str] = []
    for raw in text.split("\n"):
        words = raw.split(" ")
        line = ""
        for word in words:
            trial = word if not line else line + " " + word
            if fnt.getlength(trial) <= max_w or not line:
                line = trial
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


def text_image(
    text: str,
    fnt: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    max_w: int | None = None,
    line_gap: int = 10,
    align: str = "left",
    track: int = 0,
) -> Image.Image:
    """Render text (auto-wrapped) into a tight RGBA image."""
    lines = wrap_lines(text, fnt, max_w) if max_w else text.split("\n")
    asc, desc = fnt.getmetrics()
    line_h = asc + desc
    widths: list[int] = []
    if track:
        for ln in lines:
            widths.append(int(sum(fnt.getlength(ch) + track for ch in ln)))
    else:
        widths = [int(fnt.getlength(ln)) for ln in lines]
    img_w = max(widths) + 4
    img_h = len(lines) * line_h + max(0, len(lines) - 1) * line_gap + 4
    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y = 2
    for ln, lw in zip(lines, widths):
        if align == "center":
            x = (img_w - lw) // 2
        elif align == "right":
            x = img_w - lw - 2
        else:
            x = 2
        if track:
            for ch in ln:
                d.text((x, y), ch, font=fnt, fill=fill)
                x += int(fnt.getlength(ch)) + track
        else:
            d.text((x, y), ln, font=fnt, fill=fill)
        y += line_h + line_gap
    return img


def tracked_image(text: str, fnt: ImageFont.FreeTypeFont, fill, track: int) -> Image.Image:
    return text_image(text, fnt, fill, max_w=None, track=track)


# ---------------------------------------------------------------------------
# Scene pre-rendering
# ---------------------------------------------------------------------------
def make_background(seed: int, focus_right: bool) -> Image.Image:
    bw, bh = W + 170, H + 170
    rng = np.random.default_rng(seed * 977 + 13)
    ys = np.linspace(0.0, 1.0, bh, dtype=np.float32)[:, None]
    xs = np.linspace(0.0, 1.0, bw, dtype=np.float32)[None, :]
    g = (0.62 * ys + 0.38 * xs).astype(np.float32)

    c0 = np.array([37, 34, 32], dtype=np.float32)      # warm lift top-left
    c1 = np.array([16, 16, 15], dtype=np.float32)      # deep bottom-right
    rgb = c0[None, None, :] * (1 - g)[..., None] + c1[None, None, :] * g[..., None]

    # soft glow discs
    yy, xx = np.mgrid[0:bh, 0:bw].astype(np.float32)
    blobs = [
        (bw * (0.78 if focus_right else 0.30), bh * 0.24, bw * 0.34, ACCENT, 34.0),
        (bw * (0.18 if focus_right else 0.82), bh * 0.78, bw * 0.30, STEEL, 26.0),
        (bw * 0.55, bh * 0.92, bw * 0.36, OLIVE, 20.0),
    ]
    for cx, cy, radius, col, amp in blobs:
        d2 = (xx - cx) ** 2 + (yy - cy) ** 2
        w = np.exp(-d2 / (2 * radius * radius)) * amp
        rgb += w[..., None] * np.array(col, dtype=np.float32)[None, None, :] / 255.0 * 0.9

    # vignette
    dx = (xx / bw - 0.5) * 2.0
    dy = (yy / bh - 0.5) * 2.0
    dist = np.sqrt(dx * dx * 0.9 + dy * dy)
    vig = 1.0 - 0.34 * np.clip(dist, 0, 1.4) ** 2.2
    rgb *= vig[..., None]

    # dither noise (keeps gradients from banding)
    rgb += rng.normal(0.0, 1.15, size=rgb.shape).astype(np.float32)

    base = np.clip(rgb, 0, 255).astype(np.uint8)
    img = Image.fromarray(base, "RGB").convert("RGBA")

    # faint org-graph decoration
    deco = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    dd = ImageDraw.Draw(deco)
    n = 15
    px = rng.uniform(0.05, 0.95, n) * bw
    py = rng.uniform(0.08, 0.92, n) * bh
    if focus_right:
        px = bw * (0.52 + 0.44 * rng.uniform(0, 1, n))
    for i in range(1, n):
        j = int(rng.integers(0, i))
        dd.line([(px[i], py[i]), (px[j], py[j])], fill=(150, 144, 136, 42), width=2)
        dd.line([(px[i], py[i]), (px[(i + 3) % n], py[(i + 3) % n])], fill=(150, 144, 136, 26), width=2)
    palette = [ACCENT, OLIVE, STEEL, (200, 195, 186)]
    for i in range(n):
        col = palette[i % len(palette)]
        r = int(rng.uniform(6, 10))
        dd.ellipse([px[i] - r, py[i] - r, px[i] + r, py[i] + r],
                   fill=(col[0], col[1], col[2], 118))
        dd.ellipse([px[i] - r - 6, py[i] - r - 6, px[i] + r + 6, py[i] + r + 6],
                   outline=(col[0], col[1], col[2], 60), width=2)
    return Image.alpha_composite(img, deco)


def make_glow(color, size: int = 820, peak: int = 52) -> Image.Image:
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    c = (size - 1) / 2.0
    d2 = (xx - c) ** 2 + (yy - c) ** 2
    sigma = size / 5.2
    a = np.exp(-d2 / (2 * sigma * sigma)) * peak
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[..., 0] = color[0]
    rgba[..., 1] = color[1]
    rgba[..., 2] = color[2]
    rgba[..., 3] = np.clip(a, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def make_dot(color, size: int = 26, peak: int = 150) -> Image.Image:
    return make_glow(color, size=size, peak=peak)


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------
def layer(img: Image.Image, x: float, y: float, delay: float, dur: float = 0.7,
          dy: int = 34, wipe: bool = False) -> dict:
    return {
        "img": img,
        "x": int(x),
        "y": int(y),
        "delay": delay,
        "dur": dur,
        "dy": dy,
        "wipe": wipe,
        "alpha": img.getchannel("A"),
    }


def paste_rgba(canvas: Image.Image, img: Image.Image, x: int, y: int) -> None:
    canvas.paste(img, (x, y), img)


class Scene:
    def __init__(self, spec: dict, index: int):
        self.spec = spec
        self.index = index
        rng = np.random.default_rng(index * 31 + 5)
        self.bg = make_background(index + 1, focus_right=(spec["kind"] not in ("hero", "closing")))
        self.phase = rng.uniform(0, math.tau, 4)
        self.glows = [
            (make_glow(ACCENT, 900, 46), 0.62, 0.0, 0.0),
            (make_glow(STEEL, 780, 40), 0.4, W * 0.55, H * 0.4),
            (make_glow(OLIVE, 700, 30), 0.3, W * 0.2, H * 0.62),
        ]
        self.dots = [make_dot(color, 24, 150) for color in (CREAM, STEEL, ACCENT)]
        self.dust = []
        for i in range(26):
            sprite = int(rng.integers(0, 3))
            self.dust.append({
                "sprite": sprite,
                "x0": float(rng.uniform(0, 1)),
                "y0": float(rng.uniform(0, 1)),
                "vy": float(rng.uniform(9, 26)),
                "ph": float(rng.uniform(0, math.tau)),
                "a": float(rng.uniform(0.45, 1.0)),
            })
        self.layers: list[dict] = []
        self._build()

    # -- layout helpers ----------------------------------------------------
    def _title_block(self) -> tuple[float, Image.Image | None, float]:
        spec = self.spec
        if spec["kind"] in ("hero", "closing"):
            return 0.0, None, 0.0
        title = spec.get("title", "")
        longest = max((len(s) for s in title.split("\n")), default=0)
        size = 64 if longest <= 24 else 56
        fnt = font("Poppins-SemiBold.ttf", size)
        img = text_image(title, fnt, CREAM + (255,), max_w=W - 2 * MARGIN, line_gap=8)
        self.layers.append(layer(img, MARGIN, 205, delay=0.22, dur=0.75, dy=28))
        line_h = int(size * 1.2)
        n_lines = len(title.split("\n"))
        rule_y = 205 + n_lines * line_h + 22
        rule = Image.new("RGBA", (150, 9), ACCENT + (255,))
        self.layers.append(layer(rule, MARGIN, rule_y, delay=0.5, dur=0.55, dy=0, wipe=True))
        kicker_txt = spec.get("kicker", "")
        if kicker_txt:
            kicker = tracked_image(kicker_txt, font("Poppins-Medium.ttf", 27), ACCENT + (255,), 8)
            self.layers.append(layer(kicker, MARGIN, 148, delay=0.06, dur=0.6, dy=18))
        return rule_y + 62.0, None, 0.0

    def _build(self) -> None:
        spec = self.spec
        kind = spec["kind"]
        content_y, _, _ = self._title_block()

        if kind == "hero":
            self._build_hero()
        elif kind == "closing":
            self._build_closing()
        elif kind == "bullets":
            self._build_bullets(content_y)
        elif kind == "cards4":
            self._build_cards(content_y, spec["cards"], cols=2, gap_x=40, gap_y=40)
        elif kind == "cards3":
            self._build_cards(content_y, spec["cards"], cols=3, gap_x=30, gap_y=30, h=300, numbered=True)
        elif kind == "steps":
            self._build_steps(content_y)
        else:
            raise ValueError(f"unknown scene kind: {kind}")

    def _build_hero(self) -> None:
        spec = self.spec
        kicker = tracked_image(spec["kicker"], font("Poppins-Medium.ttf", 30), ACCENT + (255,), 10)
        self.layers.append(layer(kicker, MARGIN, 330, delay=0.15, dur=0.7, dy=22))
        title = text_image(spec["title"], font("Poppins-ExtraBold.ttf", 196), CREAM + (255,))
        self.layers.append(layer(title, MARGIN - 8, 386, delay=0.35, dur=0.9, dy=46))
        sub = text_image(spec["subtitle"], font("Poppins-Medium.ttf", 54), SOFT + (255,))
        self.layers.append(layer(sub, MARGIN, 660, delay=0.7, dur=0.8, dy=34))
        rule = Image.new("RGBA", (170, 10), ACCENT + (255,))
        self.layers.append(layer(rule, MARGIN, 762, delay=0.95, dur=0.6, dy=0, wipe=True))
        fnt = font("Lato-Bold.ttf", 25)
        x = MARGIN
        for i, chip in enumerate(spec["chips"]):
            tw = int(fnt.getlength(chip))
            cw, ch = tw + 64, 62
            img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            d.rounded_rectangle([0, 0, cw - 1, ch - 1], radius=ch // 2,
                                fill=(44, 42, 40, 236), outline=(74, 71, 66, 255), width=2)
            d.text(((cw - tw) // 2, (ch - (fnt.getmetrics()[0] + fnt.getmetrics()[1])) // 2 + 2),
                   chip, font=fnt, fill=SOFT + (255,))
            self.layers.append(layer(img, x, 828, delay=1.15 + i * 0.12, dur=0.6, dy=26))
            x += cw + 22

    def _build_closing(self) -> None:
        spec = self.spec
        fnt = font("Poppins-SemiBold.ttf", 80)
        for i, line in enumerate(spec["title"].split("\n")):
            img = text_image(line, fnt, CREAM + (255,))
            x = (W - img.width) // 2
            self.layers.append(layer(img, x, 372 + i * 108, delay=0.25 + i * 0.2, dur=0.85, dy=38))
        rule = Image.new("RGBA", (170, 10), ACCENT + (255,))
        self.layers.append(layer(rule, (W - 170) // 2, 622, delay=0.85, dur=0.6, dy=0, wipe=True))
        sub = text_image(spec["sub"], font("Lato-Bold.ttf", 42), STEEL + (255,))
        self.layers.append(layer(sub, (W - sub.width) // 2, 686, delay=1.05, dur=0.7, dy=26))
        foot = text_image(spec["footer"], font("Lato-Regular.ttf", 34), MUTED + (255,))
        self.layers.append(layer(foot, (W - foot.width) // 2, 776, delay=1.3, dur=0.7, dy=22))

    def _build_bullets(self, content_y: float) -> None:
        spec = self.spec
        f_head = font("Poppins-Medium.ttf", 40)
        f_det = font("Lato-Regular.ttf", 31)
        max_w = CONTENT_R - MARGIN - 46
        y = content_y
        for i, item in enumerate(spec["bullets"]):
            head_img = text_image(item["h"], f_head, CREAM + (255,), max_w=max_w, line_gap=4)
            det_img = text_image(item["d"], f_det, MUTED + (255,), max_w=max_w, line_gap=6)
            bh = head_img.height + 8 + det_img.height
            img = Image.new("RGBA", (max_w + 46, bh), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            cy = f_head.getmetrics()[0] // 2 + 6
            d.ellipse([6, cy - 9, 24, cy + 9], fill=ACCENT + (255,))
            img.paste(head_img, (46, 0), head_img)
            img.paste(det_img, (46, head_img.height + 8), det_img)
            delay = 0.62 + i * 0.15
            self.layers.append(layer(img, MARGIN, int(y), delay=delay, dur=0.7, dy=30))
            y += bh + 44
        end = y - 44
        if end > 975:
            print(f"  ! scene {self.index} ({spec['id']}) bullets end at {end:.0f}px")
        if "sub" in spec:
            sub = text_image(spec["sub"], font("Lato-Regular.ttf", 30),
                             (169, 166, 158, 255), max_w=max_w + 46)
            self.layers.append(layer(sub, MARGIN, int(min(y + 6, 960)), delay=1.3, dur=0.7, dy=22))

    def _build_cards(self, content_y: float, cards: list[dict], cols: int, gap_x: int, gap_y: int,
                     h: int = 280, numbered: bool = False) -> None:
        total_w = CONTENT_R - MARGIN
        cw = (total_w - gap_x * (cols - 1)) // cols
        y0 = int(content_y) + 6
        f_title = font("Poppins-SemiBold.ttf", 34)
        f_num = font("Poppins-SemiBold.ttf", 30)
        f_det = font("Lato-Regular.ttf", 26)
        for i, card in enumerate(cards):
            col, row = i % cols, i // cols
            x = MARGIN + col * (cw + gap_x)
            y = y0 + row * (h + gap_y)
            img = Image.new("RGBA", (cw, h), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            d.rounded_rectangle([0, 0, cw - 1, h - 1], radius=26,
                                fill=(44, 44, 44, 236), outline=(74, 71, 66, 255), width=2)
            pad = 44
            cy = 34
            if numbered or "n" in card:
                d.text((pad, cy), card.get("n", ""), font=f_num, fill=ACCENT + (255,))
                cy += 46
            title_lines = wrap_lines(card["t"], f_title, cw - 2 * pad)
            for ln in title_lines:
                d.text((pad, cy), ln, font=f_title, fill=CREAM + (255,))
                cy += f_title.getmetrics()[0] + f_title.getmetrics()[1] + 4
            cy += 12
            for ln in wrap_lines(card["d"], f_det, cw - 2 * pad):
                d.text((pad, cy), ln, font=f_det, fill=MUTED + (255,))
                cy += f_det.getmetrics()[0] + f_det.getmetrics()[1] + 4
            self.layers.append(layer(img, x, y, delay=0.6 + i * 0.13, dur=0.75, dy=42))
        if "sub" in self.spec:
            sub = text_image(self.spec["sub"], font("Lato-Regular.ttf", 30), MUTED + (255,),
                             max_w=CONTENT_R - MARGIN)
            sy = y0 + ((len(cards) + cols - 1) // cols) * (h + gap_y) + 8
            self.layers.append(layer(sub, MARGIN, sy, delay=1.35, dur=0.7, dy=24))

    def _build_steps(self, content_y: float) -> None:
        spec = self.spec
        n = len(spec["steps"])
        gap = 24
        cw = (CONTENT_R - MARGIN - gap * (n - 1)) // n
        y = int(content_y) + 30
        f_num = font("Poppins-Medium.ttf", 24)
        f_label = font("Poppins-SemiBold.ttf", 30)
        for i, step in enumerate(spec["steps"]):
            x = MARGIN + i * (cw + gap)
            img = Image.new("RGBA", (cw, 196), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            d.rounded_rectangle([0, 0, cw - 1, 195], radius=24,
                                fill=(44, 44, 44, 236), outline=(74, 71, 66, 255), width=2)
            d.text((34, 30), f"{i + 1:02d}", font=f_num, fill=ACCENT + (255,))
            cy = 74
            for ln in wrap_lines(step, f_label, cw - 68):
                d.text((34, cy), ln, font=f_label, fill=CREAM + (255,))
                cy += f_label.getmetrics()[0] + f_label.getmetrics()[1] + 4
            self.layers.append(layer(img, x, y, delay=0.62 + i * 0.13, dur=0.7, dy=40))
            if i < n - 1:
                tri = Image.new("RGBA", (26, 30), (0, 0, 0, 0))
                dt = ImageDraw.Draw(tri)
                dt.polygon([(2, 2), (23, 15), (2, 28)], fill=ACCENT + (255,))
                self.layers.append(layer(tri, x + cw + (gap - 26) // 2, y + 83,
                                         delay=0.75 + i * 0.13, dur=0.5, dy=0))
        sub = text_image(spec["sub"], font("Lato-Regular.ttf", 28), MUTED + (255,),
                         max_w=CONTENT_R - MARGIN, line_gap=6)
        self.layers.append(layer(sub, MARGIN, y + 196 + 56, delay=1.3, dur=0.7, dy=24))

    # -- per-frame ---------------------------------------------------------
    def frame(self, tl: float) -> Image.Image:
        dx = 85 + 48 * math.sin(0.145 * tl + self.phase[0])
        dy = 85 + 30 * math.cos(0.115 * tl + self.phase[1])
        canvas = self.bg.crop((int(dx), int(dy), int(dx) + W, int(dy) + H))

        # glow sprites (slow independent drift)
        for i, (sprite, factor, ox, oy) in enumerate(self.glows):
            gx = ox + 220 + 240 * math.sin(0.09 * tl + self.phase[0] + i * 2.1) - dx * factor
            gy = oy + 140 + 170 * math.cos(0.075 * tl + self.phase[1] + i * 1.7) - dy * factor
            paste_rgba(canvas, sprite, int(gx), int(gy))

        # floating dust
        for p in self.dust:
            x = p["x0"] * (W + 120) - 60 + 20 * math.sin(0.35 * tl + p["ph"]) - dx * 0.35
            y = (p["y0"] * (H + 140) - tl * p["vy"]) % (H + 140) - 70 - dy * 0.35
            sprite = self.dots[p["sprite"]]
            a = p["a"] * (0.6 + 0.4 * math.sin(0.9 * tl + p["ph"]))
            sp = sprite.copy()
            sp.putalpha(sprite.getchannel("A").point(lambda v: int(v * max(0.0, min(1.0, a)))))
            paste_rgba(canvas, sp, int(x), int(y))

        # entrance-animated layers
        px = dx * 0.10
        py = dy * 0.10
        for lay in self.layers:
            p = clamp01((tl - lay["delay"]) / lay["dur"])
            if p <= 0.0:
                continue
            k = ease_out_cubic(p)
            img = lay["img"]
            if lay["wipe"]:
                cut = max(1, int(img.width * k))
                piece = img.crop((0, 0, cut, img.height))
                paste_rgba(canvas, piece, lay["x"] - int(px), lay["y"] - int(py))
                continue
            if k < 0.999:
                img = img.copy()
                img.putalpha(lay["alpha"].point(lambda v: int(v * k)))
            yoff = int((1 - k) * lay["dy"])
            paste_rgba(canvas, img, lay["x"] - int(px), lay["y"] - int(py) + yoff)

        return canvas.convert("RGB")


# ---------------------------------------------------------------------------
# Global frame composer
# ---------------------------------------------------------------------------
TRANSITIONS = ["push+", "fade", "push-", "fade", "push+", "fade", "push-", "fade", "push+", "fade"]

_chrome_cache: dict | None = None


def build_chrome() -> dict:
    global _chrome_cache
    if _chrome_cache is None:
        brand = text_image("OCTOPUS  \u00b7  YOUR AI COMPANY, IN ONE FOLDER",
                           font("Lato-Bold.ttf", 21), (169, 166, 158, 175), track=3)
        counters = {
            i: text_image(f"{i + 1:02d} / {len(VIDEO_SCENES):02d}",
                          font("Poppins-Medium.ttf", 21), (169, 166, 158, 175))
            for i in range(len(VIDEO_SCENES))
        }
        _chrome_cache = {"brand": brand, "counters": counters}
    return _chrome_cache


def draw_chrome(frame: Image.Image, t: float, total: float, scene_idx: int) -> Image.Image:
    d = ImageDraw.Draw(frame)
    # progress bar
    p = clamp01(t / total)
    d.rectangle([0, 4, W, 10], fill=(58, 55, 52))
    bar_w = int(W * p)
    if bar_w > 0:
        d.rectangle([0, 4, bar_w, 10], fill=ACCENT)
        d.ellipse([bar_w - 7, 3, bar_w + 7, 11], fill=(240, 170, 140))
    chrome = build_chrome()
    alpha = clamp01((t - 0.7) / 0.8)
    if alpha > 0:
        brand = chrome["brand"].copy()
        brand.putalpha(brand.getchannel("A").point(lambda v: int(v * alpha)))
        frame.paste(brand, (MARGIN, 1018), brand)
        counter = chrome["counters"][scene_idx].copy()
        counter.putalpha(counter.getchannel("A").point(lambda v: int(v * alpha)))
        frame.paste(counter, (CONTENT_R - counter.width, 1018), counter)
    return frame


def scene_frame(scenes: list[Scene], starts: list[float], t: float) -> tuple[Image.Image, int]:
    idx = 0
    for i, s in enumerate(starts):
        if t >= s:
            idx = i
    # transition window between idx and idx+1?
    if idx < len(scenes) - 1:
        nxt = starts[idx + 1]
        if nxt <= t < nxt + TRANSITION:
            w = smootherstep((t - nxt) / TRANSITION)
            out_img = scenes[idx].frame(t - starts[idx])
            in_img = scenes[idx + 1].frame(t - starts[idx + 1])
            kind = TRANSITIONS[idx]
            if kind == "fade":
                blended = Image.blend(out_img, in_img, w)
                return blended, idx + 1 if w > 0.5 else idx
            direction = 1.0 if kind == "push+" else -1.0
            canvas = Image.new("RGB", (W, H), BLACK)
            x_in = int(direction * (1 - w) * W)
            x_out = int(-direction * w * W)
            canvas.paste(in_img, (x_in, 0))
            canvas.paste(out_img, (x_out, 0))
            return canvas, idx + 1 if w > 0.5 else idx
    return scenes[idx].frame(t - starts[idx]), idx


def render_frame(scenes, starts, t: float, total: float) -> tuple[bytes, int]:
    img, idx = scene_frame(scenes, starts, t)
    img = draw_chrome(img, t, total, idx)
    # opening / closing fades
    k = 1.0
    if t < 0.8:
        k = smoothstep(t / 0.8)
    elif t > total - 1.1:
        k = smoothstep((total - t) / 1.1)
    if k < 1.0:
        img = Image.blend(Image.new("RGB", (W, H), BLACK), img, k)
    return img.tobytes(), idx


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
def cmd_render(args) -> None:
    ensure_fonts()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    i0, i1 = segment_bounds(args.segments)[args.segment]
    out = OUT_DIR / f"seg_{args.segment}.mp4"
    starts = scene_starts()
    total = total_duration()
    scenes = [Scene(spec, i) for i, spec in enumerate(VIDEO_SCENES)]
    print(f"segment {args.segment + 1}/{args.segments}: frames {i0}..{i1 - 1} "
          f"({(i1 - i0) / FPS:.1f}s) -> {out.name}")

    cmd = [
        ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
        "-i", "pipe:0",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        str(out),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    t_start = time.time()
    try:
        for n in range(i0, i1):
            t = n / FPS
            data, _ = render_frame(scenes, starts, t, total)
            proc.stdin.write(data)
            if (n - i0) % 300 == 0 and n > i0:
                elapsed = time.time() - t_start
                rate = (n - i0) / max(elapsed, 1e-6)
                print(f"  {n - i0}/{i1 - i0} frames  {rate:.1f} fps")
    finally:
        proc.stdin.close()
    err = proc.stderr.read().decode(errors="replace")
    code = proc.wait()
    if code != 0:
        print(err[-4000:])
        raise SystemExit(f"ffmpeg failed with code {code}")
    print(f"done {out.name} in {time.time() - t_start:.1f}s "
          f"({(i1 - i0) / max(time.time() - t_start, 1e-6):.1f} fps render+encode)")


def cmd_concat(args) -> None:
    ensure_fonts()
    segs = sorted(OUT_DIR.glob("seg_*.mp4"))
    if not segs:
        raise SystemExit("no segments found; run `render` first")
    listing = OUT_DIR / "concat.txt"
    listing.write_text("".join(f"file '{p.resolve()}'\n" for p in segs))
    silent = OUT_DIR / "video_silent.mp4"
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
           "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(silent)]
    subprocess.run(cmd, check=True)
    print(f"wrote {silent}")


def cmd_mux(args) -> None:
    silent = OUT_DIR / "video_silent.mp4"
    if not silent.exists():
        raise SystemExit("video_silent.mp4 missing; run `concat` first")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
           "-i", str(silent), "-i", str(args.audio),
           "-map", "0:v:0", "-map", "1:a:0",
           "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
           "-movflags", "+faststart", "-shortest", str(out)]
    subprocess.run(cmd, check=True)
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")


def cmd_info(args) -> None:
    print(f"duration: {total_duration():.2f}s  frames: {total_frames()}  fps: {FPS}")
    starts = scene_starts()
    for i, (sc, st) in enumerate(zip(VIDEO_SCENES, starts)):
        print(f"  {i:02d} {st:7.2f}s  {sc['kind']:8s} {sc['id']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("render", help="render one segment of the video")
    r.add_argument("--segment", type=int, default=0)
    r.add_argument("--segments", type=int, default=4)
    r.set_defaults(func=cmd_render)

    c = sub.add_parser("concat", help="concatenate segments")
    c.set_defaults(func=cmd_concat)

    m = sub.add_parser("mux", help="mux the soundtrack into the video")
    m.add_argument("--audio", default=str(OUT_DIR / "audio.wav"))
    m.add_argument("--out", default=str(SCRIPT_DIR.parent / "octopus-pitch-for-vivek.mp4"))
    m.set_defaults(func=cmd_mux)

    i = sub.add_parser("info", help="print the timeline")
    i.set_defaults(func=cmd_info)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
