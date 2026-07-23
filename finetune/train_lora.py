#!/usr/bin/env python3
"""
LoRA / QLoRA fine-tune of the Qwen3-VL judge on the SFT dataset produced by
prepare_dataset.py.

Run:  python finetune/train_lora.py --config finetune/config.yaml

Requires the training deps in requirements.txt and a CUDA GPU. It writes a LoRA
adapter to `output_dir`; see merge_and_export() for turning it into GGUF weights
QVAC can serve.

The exact processor / model class names track the Qwen3-VL HF release — if the
build you serve differs, adjust `load_model_and_processor()` to match. Everything
else (data collation, LoRA config, training loop) is model-agnostic.
"""

import argparse
import json
from pathlib import Path

import yaml


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def read_jsonl(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_model_and_processor(cfg: dict):
    """Load the base VLM (optionally 4-bit) and its processor."""
    import torch
    from transformers import (
        AutoProcessor,
        AutoModelForImageTextToText,
        BitsAndBytesConfig,
    )

    quant = None
    if cfg.get("load_in_4bit", True):
        quant = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    processor = AutoProcessor.from_pretrained(cfg["base_model"], trust_remote_code=True)
    model = AutoModelForImageTextToText.from_pretrained(
        cfg["base_model"],
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True,
    )
    return model, processor


def attach_lora(model, cfg: dict):
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    if cfg.get("load_in_4bit", True):
        model = prepare_model_for_kbit_training(model)

    lora = LoraConfig(
        r=cfg["lora_r"],
        lora_alpha=cfg["lora_alpha"],
        lora_dropout=cfg["lora_dropout"],
        target_modules=cfg["target_modules"],
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    return model


def build_collator(processor, cfg: dict):
    """
    Turn dataset rows (images + chat messages) into model tensors, masking the
    prompt so loss is only taken on the assistant's JSON answer.
    """
    from PIL import Image

    def collate(batch: list[dict]):
        texts, image_lists = [], []
        for row in batch:
            images = [Image.open(p).convert("RGB") for p in row["images"]]
            # Prepend the image placeholders the chat template expects.
            user_content = [{"type": "image"} for _ in images]
            user_content.append({"type": "text", "text": row["messages"][0]["content"]})
            messages = [
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": row["messages"][1]["content"]},
            ]
            text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
            texts.append(text)
            image_lists.append(images)

        inputs = processor(
            text=texts,
            images=image_lists,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=cfg["max_seq_len"],
        )
        labels = inputs["input_ids"].clone()
        labels[labels == processor.tokenizer.pad_token_id] = -100
        inputs["labels"] = labels
        return inputs

    return collate


def train(cfg: dict):
    from transformers import Trainer, TrainingArguments

    model, processor = load_model_and_processor(cfg)
    model = attach_lora(model, cfg)

    train_rows = read_jsonl(cfg["train_file"])
    val_path = cfg.get("val_file")
    val_rows = read_jsonl(val_path) if val_path and Path(val_path).exists() else None

    args = TrainingArguments(
        output_dir=cfg["output_dir"],
        num_train_epochs=cfg["epochs"],
        per_device_train_batch_size=cfg["batch_size"],
        gradient_accumulation_steps=cfg["grad_accum"],
        learning_rate=float(cfg["learning_rate"]),
        warmup_ratio=cfg["warmup_ratio"],
        logging_steps=5,
        save_strategy="epoch",
        eval_strategy="epoch" if val_rows else "no",
        bf16=True,
        seed=cfg["seed"],
        report_to=[],
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_rows,
        eval_dataset=val_rows,
        data_collator=build_collator(processor, cfg),
    )
    trainer.train()

    out = Path(cfg["output_dir"])
    model.save_pretrained(out)
    processor.save_pretrained(out)
    print(f"[train] LoRA adapter saved to {out}")
    print("[train] to serve on QVAC: merge_and_export(), then convert to GGUF "
          "with llama.cpp convert_hf_to_gguf.py (see README).")


def merge_and_export(cfg: dict):
    """
    Merge the LoRA adapter back into the base weights and save a full model
    ready for GGUF conversion. Run after training when you want to deploy.
    """
    import torch
    from peft import PeftModel
    from transformers import AutoModelForImageTextToText, AutoProcessor

    base = AutoModelForImageTextToText.from_pretrained(
        cfg["base_model"], torch_dtype=torch.bfloat16, trust_remote_code=True,
    )
    merged = PeftModel.from_pretrained(base, cfg["output_dir"]).merge_and_unload()
    dst = Path(cfg["output_dir"]) / "merged"
    merged.save_pretrained(dst)
    AutoProcessor.from_pretrained(cfg["base_model"], trust_remote_code=True).save_pretrained(dst)
    print(f"[merge] merged model saved to {dst}")


def main() -> int:
    ap = argparse.ArgumentParser(description="LoRA fine-tune the Probable judge.")
    ap.add_argument("--config", default="finetune/config.yaml")
    ap.add_argument("--merge", action="store_true",
                    help="skip training; merge an existing adapter for GGUF export")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.merge:
        merge_and_export(cfg)
    else:
        train(cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
