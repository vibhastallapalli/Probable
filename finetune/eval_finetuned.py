#!/usr/bin/env python3
"""
Grade the fine-tuned judge against your human labels on a held-out split.

Reports mean absolute error (MAE) per criterion for the base model and, if a
LoRA adapter exists, for the fine-tuned model — so you can see whether the
fine-tune actually moved the judge closer to your scores. Lower MAE is better.

Run:  python finetune/eval_finetuned.py --config finetune/config.yaml \
          --split finetune/data/val.jsonl
"""

import argparse
import json
import re
from pathlib import Path

import yaml

CRITERIA = ("skill", "difficulty", "aesthetic")


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def parse_scores(text: str) -> dict | None:
    """Pull the first JSON object out of the model's reply, tolerating fences."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def load_judge(cfg: dict, adapter: str | None):
    import torch
    from transformers import AutoProcessor, AutoModelForImageTextToText

    processor = AutoProcessor.from_pretrained(cfg["base_model"], trust_remote_code=True)
    model = AutoModelForImageTextToText.from_pretrained(
        cfg["base_model"], torch_dtype=torch.bfloat16,
        device_map="auto", trust_remote_code=True,
    )
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    return model, processor


def predict(model, processor, row: dict, cfg: dict) -> dict | None:
    from PIL import Image

    images = [Image.open(p).convert("RGB") for p in row["images"]]
    user_content = [{"type": "image"} for _ in images]
    user_content.append({"type": "text", "text": row["messages"][0]["content"]})
    text = processor.apply_chat_template(
        [{"role": "user", "content": user_content}],
        tokenize=False, add_generation_prompt=True,
    )
    inputs = processor(text=[text], images=[images], return_tensors="pt").to(model.device)
    out = model.generate(**inputs, max_new_tokens=128, do_sample=False)
    reply = processor.batch_decode(out[:, inputs["input_ids"].shape[1]:],
                                   skip_special_tokens=True)[0]
    return parse_scores(reply)


def mae_over_split(model, processor, rows: list[dict], cfg: dict) -> dict:
    totals = {c: 0.0 for c in CRITERIA}
    counts = {c: 0 for c in CRITERIA}
    parsed_ok = 0
    for row in rows:
        pred = predict(model, processor, row, cfg)
        if not pred:
            continue
        parsed_ok += 1
        gold = row["gold"]
        for c in CRITERIA:
            if c in pred:
                totals[c] += abs(float(pred[c]) - float(gold[c]))
                counts[c] += 1
    mae = {c: (totals[c] / counts[c] if counts[c] else None) for c in CRITERIA}
    return {"mae": mae, "parsed_ok": parsed_ok, "n": len(rows)}


def main() -> int:
    ap = argparse.ArgumentParser(description="Grade base vs fine-tuned judge.")
    ap.add_argument("--config", default="finetune/config.yaml")
    ap.add_argument("--split", default="finetune/data/val.jsonl")
    args = ap.parse_args()

    cfg = load_config(args.config)
    rows = read_jsonl(args.split)
    print(f"[eval] {len(rows)} held-out clips from {args.split}")

    print("[eval] scoring with BASE model…")
    base_model, base_proc = load_judge(cfg, adapter=None)
    base = mae_over_split(base_model, base_proc, rows, cfg)

    adapter = cfg["output_dir"]
    tuned = None
    if Path(adapter).exists() and any(Path(adapter).glob("adapter_*")):
        print("[eval] scoring with FINE-TUNED model…")
        tuned_model, tuned_proc = load_judge(cfg, adapter=adapter)
        tuned = mae_over_split(tuned_model, tuned_proc, rows, cfg)
    else:
        print(f"[eval] no adapter at {adapter}; reporting base only.")

    print("\n=== MAE vs human labels (lower is better) ===")
    header = f"{'criterion':<12}{'base':>10}"
    if tuned:
        header += f"{'fine-tuned':>14}{'Δ':>10}"
    print(header)
    for c in CRITERIA:
        b = base["mae"][c]
        line = f"{c:<12}{(f'{b:.2f}' if b is not None else '—'):>10}"
        if tuned:
            t = tuned["mae"][c]
            delta = (b - t) if (b is not None and t is not None) else None
            line += f"{(f'{t:.2f}' if t is not None else '—'):>14}"
            line += f"{(f'{delta:+.2f}' if delta is not None else '—'):>10}"
        print(line)
    print(f"\nparsed JSON ok: base {base['parsed_ok']}/{base['n']}"
          + (f", fine-tuned {tuned['parsed_ok']}/{tuned['n']}" if tuned else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
