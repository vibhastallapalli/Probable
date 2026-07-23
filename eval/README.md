# Probable — AI Judge Evaluation Harness

Probable's judge scores football clips with a small on-device VLM (Qwen3-VL 2B
via QVAC). Small vision models are prone to **positional bias** — favoring
whichever clip is shown first rather than the better shot. The scoring pipeline
already guards against this internally (mirror checks, majority-voted placement);
this harness **measures** how well those guards hold, on your own labeled data,
and reports it with confidence intervals instead of vibes.

## What it measures

For every human-labeled pair of clips, the judge is run in **both clip orders**
— `(A, B)` and `(B, A)`. A stable verdict must flip its label when the slots
swap; if it names the same slot both times, that's positional bias, not an
opinion.

| Metric | Meaning |
|---|---|
| **Order consistency** | Share of pairs whose winner is unchanged when the two clips swap slots. The direct positional-bias measure. |
| **Positional bias rate** | `1 − order consistency`. |
| **Slot-A-first bias** | Of the pairs that flipped, how often the model just picked the first slot. |
| **Human agreement (swap-stable pairs)** | Accuracy vs your labels, on the pairs the judge is stable on. |
| **Human agreement (raw forward run)** | Same, but on the plain forward run, for comparison. |
| **Per-dimension winners** | Where matches are decided: distance / speed / technique / placement. |

Proportions are reported with a **Wilson 95% confidence interval**, which stays
honest on the small sample sizes an eval like this usually has.

## Layout

```
eval/
  metrics.js         Pure metrics core — no model, no I/O. Unit-tested.
  metrics.test.js    node:test unit tests for the metrics core.
  run-eval.js        Runner: drives the real scoring.js in both orders, writes the report.
  pairs.example.jsonl  Manifest format example.
  results/           Generated report.md + report.json (git-ignored).
```

## Run the metrics tests (no model needed)

```bash
node --test 'eval/*.test.js'
```

## Smoke-test the whole harness with the mock model (no GPU, no weights)

Requires deps installed (`npm install`) so `scoring.js` can load, but uses its
built-in mock model — no inference:

```bash
QVAC_MOCK_SCORING=1 node eval/run-eval.js --manifest eval/pairs.example.jsonl
```

## Run a real evaluation

1. Collect clip pairs and label the winner of each yourself.
2. Copy the manifest and edit it:
   ```bash
   cp eval/pairs.example.jsonl eval/pairs.jsonl
   # set clipA / clipB paths and human = A | B | tie for each line
   ```
3. Run:
   ```bash
   node eval/run-eval.js --manifest eval/pairs.jsonl --out eval/results
   ```
4. Read `eval/results/report.md`.

The manifest is JSONL — one object per line:

```json
{"id": "pair-01", "clipA": "clips/a1.mp4", "clipB": "clips/b1.mp4", "human": "B"}
```
