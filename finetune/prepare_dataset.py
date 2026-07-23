#!/usr/bin/env python3
"""
Build a supervised fine-tuning dataset for the Probable judge.

Input  : a JSONL of human-labeled clips
           {"clip": "path.mp4", "skill": 8, "difficulty": 7,
            "aesthetic": 9, "placement": "top_center"}
Output : finetune/data/{train,val}.jsonl in a vision SFT format —
           {"images": [frame paths...],
            "messages": [{"role": "user",    "content": <rubric prompt>},
                         {"role": "assistant","content": <target JSON scores>}]}

Frames are sampled with ffmpeg the same way the runtime judge samples them
(evenly across the clip, N per clip), so the model trains on the same evidence
it will see at inference. Standard library only — no ML deps needed for this step.
"""

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path

# Placement zone -> the 0-10 score the runtime uses, so training targets match
# the same scale scoring.js finalizes on (corners beat the center).
PLACEMENT_SCORE = {
    "top_left": 9, "top_center": 5, "top_right": 9,
    "mid_left": 6, "mid_center": 3, "mid_right": 6,
    "bottom_left": 8, "bottom_center": 2, "bottom_right": 8,
}

RUBRIC_PROMPT = (
    "You are judging a single football goal clip from the frames provided. "
    "Score it out of 10 on each of skill, difficulty, and aesthetic, and name "
    "the placement zone the ball finished in (one of: top_left, top_center, "
    "top_right, mid_left, mid_center, mid_right, bottom_left, bottom_center, "
    "bottom_right). Reply with ONLY a JSON object of the form "
    '{"skill": int, "difficulty": int, "aesthetic": int, "placement": str}.'
)


def ffmpeg_bin() -> str:
    return os.environ.get("FFMPEG", "ffmpeg")


def probe_duration(clip: str) -> float:
    """Clip length in seconds via ffprobe; falls back to 0 on failure."""
    ffprobe = os.environ.get("FFPROBE", "ffprobe")
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", clip],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return float(out)
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return 0.0


def sample_timestamps(duration: float, count: int) -> list[float]:
    """Evenly spaced timestamps across the middle of the clip (skip the edges)."""
    if duration <= 0:
        # Unknown duration: let ffmpeg pull the first `count` frames by index.
        return []
    lo, hi = 0.1 * duration, 0.95 * duration
    if count == 1:
        return [(lo + hi) / 2]
    step = (hi - lo) / (count - 1)
    return [lo + i * step for i in range(count)]


def extract_frames(clip: str, out_dir: Path, count: int) -> list[str]:
    """Write `count` JPEG frames for one clip; return their paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(clip).stem
    duration = probe_duration(clip)
    frames: list[str] = []
    timestamps = sample_timestamps(duration, count)

    if timestamps:
        for i, ts in enumerate(timestamps):
            dst = out_dir / f"{stem}_f{i:02d}.jpg"
            subprocess.run(
                [ffmpeg_bin(), "-y", "-ss", f"{ts:.3f}", "-i", clip,
                 "-frames:v", "1", "-q:v", "3", str(dst)],
                capture_output=True, check=True,
            )
            frames.append(str(dst))
    else:
        # No duration: grab the first `count` frames by index.
        pattern = str(out_dir / f"{stem}_f%02d.jpg")
        subprocess.run(
            [ffmpeg_bin(), "-y", "-i", clip, "-frames:v", str(count),
             "-q:v", "3", pattern],
            capture_output=True, check=True,
        )
        frames = sorted(str(p) for p in out_dir.glob(f"{stem}_f*.jpg"))
    return frames


def build_record(label: dict, frames: list[str]) -> dict:
    placement = label.get("placement", "mid_center")
    target = {
        "skill": int(label["skill"]),
        "difficulty": int(label["difficulty"]),
        "aesthetic": int(label["aesthetic"]),
        "placement": placement,
    }
    return {
        "images": frames,
        "messages": [
            {"role": "user", "content": RUBRIC_PROMPT},
            {"role": "assistant", "content": json.dumps(target)},
        ],
        # Kept for eval_finetuned.py to grade against without re-parsing.
        "gold": {**target, "placement_score": PLACEMENT_SCORE.get(placement, 3)},
    }


def load_labels(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            row = json.loads(line)
            for key in ("clip", "skill", "difficulty", "aesthetic"):
                if key not in row:
                    raise ValueError(f"{path} line {i}: missing '{key}'")
            rows.append(row)
    if not rows:
        raise ValueError(f"{path} contained no labels")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the judge SFT dataset.")
    ap.add_argument("--labels", required=True, help="JSONL of labeled clips")
    ap.add_argument("--out", default="finetune/data", help="output directory")
    ap.add_argument("--frames", type=int, default=8, help="frames per clip")
    ap.add_argument("--val-fraction", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    labels = load_labels(args.labels)
    out_dir = Path(args.out)
    frames_dir = out_dir / "frames"

    records = []
    for label in labels:
        clip = label["clip"]
        if not os.path.exists(clip):
            print(f"[prepare] WARNING: clip not found, skipping: {clip}", file=sys.stderr)
            continue
        frames = extract_frames(clip, frames_dir, args.frames)
        records.append(build_record(label, frames))
        print(f"[prepare] {clip}: {len(frames)} frames")

    if not records:
        print("[prepare] no usable clips — nothing written", file=sys.stderr)
        return 1

    random.Random(args.seed).shuffle(records)
    n_val = max(1, int(len(records) * args.val_fraction)) if len(records) > 1 else 0
    val, train = records[:n_val], records[n_val:]

    out_dir.mkdir(parents=True, exist_ok=True)
    for name, split in (("train", train), ("val", val)):
        path = out_dir / f"{name}.jsonl"
        with open(path, "w", encoding="utf-8") as fh:
            for rec in split:
                fh.write(json.dumps(rec) + "\n")
        print(f"[prepare] wrote {len(split)} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
