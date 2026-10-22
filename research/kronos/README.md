# Kronos Small — offline shadow cartridge (research only)

Survival Lab now has a **separate, receipt-driven** experimental model interface.
It is intentionally not executable from the live strategy registry. It cannot
place orders and makes no claim of directional accuracy or trading profitability.

## Boundaries

1. Collect **completed** UTC daily `btc-usd-spot-1d` bars. Never include the
   forecast bar or any later price in the request's `bars`.
2. Run Python validation; optional local **TalkPipe** pipeline performs Kronos
   inference in a dedicated Python environment and emits a dated JSON receipt.
3. Use `createKronosShadow({receipts})` only in the Node replay runner.
   Receipts are matched by `as_of`, dataset, last observed close, pinned model,
   forward horizon and input metadata. Missing receipt = **flat**.
4. A matched receipt gives a max ±0.25 **paper replay** exposure using the
   fraction of individual scenarios that forecast an upward move (>=65% or <=35%).
   These thresholds are experimental, not calibrated probabilities.
5. `runDailyReplay` applies this signal to the **next** bar's return and charges
   the same transaction friction as other cartridges. No live execution path.

The receipt's SHA-256 digest records the input, but is not an authenticity
signature. Store original requests alongside receipts for independent audits.
The pretrained HF checkpoint's training provenance / normalization-leakage
history remains unresolved (upstream issue #307). Do not treat replay as
forward validation. Do not fit thresholds against the held-out evaluation set.

## On Butcher or another dedicated inference host

Current default branch work does **not** install torch or model weights.
The existing Butcher system Python has no torch; large weight downloads can
consume substantial RAM/disk. Use a separate, monitored environment with
adequate free capacity rather than installing into the web deployment.

First, validate locally without heavy dependencies:

```bash
python3 research/kronos/forecast.py --validate \
  < research/kronos/sample-request.json
```

For real predictions, install Python >=3.11, TalkPipe, and dependencies from
[shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos), then point
`PYTHONPATH` to a **reviewed and pinned** Kronos checkout. The forecast
script pins the Hugging Face `Kronos-small` model/tokenizer revisions used
by upstream regression tests; verify the actual checkpoints independently.

```bash
PYTHONPATH=/path/to/reviewed/Kronos python3 research/kronos/forecast.py --infer \
  < forecast-request.json > kronos-receipt.json
```

`--infer` invokes a real TalkPipe streaming pipeline with validation and
Kronos inference segments. No mock values are substituted when unavailable.
A request emits one receipt with 2–32 independently sampled next-day closes.

For **local paper replay**, collect a JSON array of previously generated receipts,
and a dataset object with `id: "btc-usd-spot-1d"` and `observations`:

```bash
node scripts/kronos-shadow.mjs history.json receipts.json
```

Both inputs must be local files. This command performs no database writes,
broker calls, endpoint changes or deployment. It is not included in scheduled
Neon Functions, production worker jobs, or the active consensus runner.

## Validation gates before considering even a shadow promotion

- [ ] Verify HF checkpoints were retrained after upstream data leakage fix
- [ ] Record pinned upstream commit and model artifacts, licenses and hashes
- [ ] Perform genuine inference with observed RAM, runtime and GPU/CPU demands
- [ ] Independently check forecast constraints (OHLC consistency, timestamps)
- [ ] Run rolling as-of walk-forward evaluation against random walk, buy-and-hold
      and existing cartridges, with frozen thresholds and transaction costs
- [ ] Measure directional accuracy, error, drawdown and uncertainty calibration
- [ ] Require out-of-sample improvement before allocating real money

See upstream [issue #307](https://github.com/shiyu-coder/Kronos/issues/307).
