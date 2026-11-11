#!/usr/bin/env python3
"""Compare a capture directory with the baseline PNGs and the committed manifest.

For every screen and viewport in ``manifest.json``:
* the capture must exist;
* if its sha256 equals the manifest hash, it has 0 changed pixels;
* otherwise the capture is diffed against the baseline PNG with Pillow ``ImageChops``. A pixel counts as changed when
  any RGBA channel differs by more than the screen's ``channel_tolerance`` (default 0). The screen passes when the
  changed count is at most its ``max_changed_pixels`` (default 0).

The baseline PNG must match the manifest hash, so a stale or edited baseline cannot hide a difference.

Usage:
    backend/.venv/bin/python scripts/visual/compare.py --captures ./visual-run-2 --baseline ./visual-baseline

Exit status: 0 when every screen passes, 1 when any screen fails, 2 when the manifest or baseline is unusable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "manifest.json"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as img:
        return img.size


def changed_pixels(capture: Path, baseline: Path, tolerance: int) -> tuple[int, int]:
    """Return (changed pixels, total pixels). Raises ValueError when the image sizes differ."""
    with Image.open(capture) as a_img, Image.open(baseline) as b_img:
        a = a_img.convert("RGBA")
        b = b_img.convert("RGBA")
    if a.size != b.size:
        raise ValueError(f"size {a.size[0]}x{a.size[1]} differs from baseline {b.size[0]}x{b.size[1]}")
    diff = ImageChops.difference(a, b)
    red, green, blue, alpha = diff.split()
    per_pixel_max = ImageChops.lighter(ImageChops.lighter(red, green), ImageChops.lighter(blue, alpha))
    mask = per_pixel_max.point(lambda value: 255 if value > tolerance else 0)
    return mask.histogram()[255], a.size[0] * a.size[1]


def check_screen(entry: dict, captures: Path, baseline: Path) -> dict:
    name, viewport = entry["screen"], entry["viewport"]
    capture = captures / viewport / f"{name}.png"
    reference = baseline / viewport / f"{name}.png"
    expected = entry["sha256"]
    limit = int(entry.get("max_changed_pixels", 0))
    tolerance = int(entry.get("channel_tolerance", 0))
    row = {"screen": name, "viewport": viewport, "changed": None, "total": None, "status": "FAIL", "note": ""}

    if not capture.is_file():
        row["note"] = "capture missing"
        return row
    if sha256_file(capture) == expected:
        row.update(changed=0, total=image_size(capture)[0] * image_size(capture)[1], status="PASS",
                   note="sha256 matches manifest")
        return row
    if not reference.is_file():
        row["note"] = "sha256 differs from manifest and no baseline PNG to diff against"
        return row
    if sha256_file(reference) != expected:
        row.update(status="ERROR", note="baseline PNG does not match the manifest hash")
        return row
    try:
        changed, total = changed_pixels(capture, reference, tolerance)
    except ValueError as exc:
        row["note"] = str(exc)
        return row
    row.update(changed=changed, total=total, status="PASS" if changed <= limit else "FAIL",
               note="same pixels, different PNG bytes" if changed == 0 else
               f"threshold {limit} px, tolerance {tolerance}")
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--captures", required=True, type=Path, help="directory written by capture.py")
    parser.add_argument("--baseline", required=True, type=Path, help="directory with the baseline PNG files")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    args = parser.parse_args()

    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read manifest {args.manifest}: {exc}", file=sys.stderr)
        return 2
    if manifest.get("format") != 1:
        print(f"error: unsupported manifest format {manifest.get('format')!r}", file=sys.stderr)
        return 2

    rows = [check_screen(entry, args.captures, args.baseline) for entry in manifest["screens"]]
    header = f"{'viewport':<10} {'screen':<17} {'changed px':>11} {'ratio':>10}  status  note"
    print(header)
    print("-" * len(header))
    for r in rows:
        ratio = "-" if r["total"] in (None, 0) else f"{100 * r['changed'] / r['total']:.4f}%"
        changed = "-" if r["changed"] is None else str(r["changed"])
        print(f"{r['viewport']:<10} {r['screen']:<17} {changed:>11} {ratio:>10}  {r['status']:<6}  {r['note']}")
    failed = [r for r in rows if r["status"] != "PASS"]
    print(f"\n{len(rows) - len(failed)}/{len(rows)} screens passed (seed version {manifest.get('seed_version')})")
    if any(r["status"] == "ERROR" for r in rows):
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
