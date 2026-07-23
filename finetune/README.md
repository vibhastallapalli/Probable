# Probable — Fine-tuning the on-device judge (LoRA)

> **Status: pipeline, not a trained model.** This directory is a complete,
> runnable LoRA fine-tuning pipeline for the Qwen3-VL judge. It ships **no
> weights and has not been run** — a fine-tune needs your labeled goal-clips
> and a GPU. Run it yourself before claiming a fine-tuned model anywhere; until
> then, Probable uses the stock Qwen3-VL 2B through QVAC.

## Why fine-tune

The base Qwen3-VL 2B judges clips zero-shot from a rubric prompt. Fine-tuning on
your own human-scored clips teaches it *your* rubric directly — tightening score
calibration and cutting the malformed-JSON and positional-bias failures the
prompt currently has to fight. It moves the project from *using* a model to
*training* one.

## Pipeline

```
finetune/
  config.yaml          Model id, LoRA rank, batch size, frames-per-clip, paths.
  prepare_dataset.py   Clips + human scores -> frames -> SFT dataset (JSONL).
  train_lora.py        LoRA / PEFT fine-tune of Qwen3-VL on that dataset.
  eval_finetuned.py    Held-out MAE: base model vs fine-tuned, vs your labels.
  requirements.txt     Training deps (separate from the Electron app).
```

## Steps

1. **Install training deps** (ideally in a fresh venv, on a CUDA box):
   ```bash
   pip install -r finetune/requirements.txt
   ```
2. **Label clips.** Write a JSONL where each line is one clip with the scores
   *you* gave it (0–10 per criterion, plus the placement zone):
   ```json
   {"clip": "finetune/clips/a1.mp4", "skill": 8, "difficulty": 7, "aesthetic": 9, "placement": "top_center"}
   ```
   Save it as `finetune/labels.jsonl`.
3. **Build the dataset** (samples frames with ffmpeg, formats the rubric prompt
   and target JSON exactly as the runtime judge expects):
   ```bash
   python finetune/prepare_dataset.py --labels finetune/labels.jsonl --out finetune/data
   ```
4. **Train the LoRA adapter:**
   ```bash
   python finetune/train_lora.py --config finetune/config.yaml
   ```
5. **Check it actually helped** (lower MAE = closer to your judgments):
   ```bash
   python finetune/eval_finetuned.py --config finetune/config.yaml --split finetune/data/val.jsonl
   ```
6. **Deploy to QVAC.** QVAC serves GGUF, so merge the adapter and convert:
   merge LoRA into the base weights (`peft` `merge_and_unload`), then convert to
   GGUF with `llama.cpp`'s `convert_hf_to_gguf.py` and register the file with the
   QVAC model store used in `src/main/scoring.js`. See `train_lora.py` for the
   exact merge call.

## Honest scope

- The exact HF repo id for the QVAC Qwen3-VL build may differ from the default in
  `config.yaml`; match it to the weights you actually serve.
- With only a few dozen clips, expect calibration gains, not a new model — keep
  the val split honest and report MAE, not cherry-picked wins.
