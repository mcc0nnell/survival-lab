#!/usr/bin/env python3
"""Kronos inference -> bounded, auditable, RESEARCH-ONLY daily shadow receipts.

--validate uses Python stdlib. --infer explicitly requires TalkPipe, torch,
pandas, and a checkout of shiyu-coder/Kronos on PYTHONPATH.
This module never touches accounts, exchanges, secrets, orders, or databases.
"""
import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone

MODEL = "NeoQuasar/Kronos-small"
TOKENIZER = "NeoQuasar/Kronos-Tokenizer-base"
MODEL_REV = "901c26c1332695a2a8f243eb2f37243a37bea320"
TOKENIZER_REV = "0e0117387f39004a9016484a186a908917e22426"
DATASET = "btc-usd-spot-1d"


def parse_utc(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("timestamps must be UTC ISO strings ending Z")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo != timezone.utc:
        raise ValueError("timestamps must be UTC")
    return dt


def validate_request(request):
    if not isinstance(request, dict) or request.get("schema_version") != 1:
        raise ValueError("unsupported forecast request")
    if request.get("dataset_id") != DATASET:
        raise ValueError("only BTC-USD spot daily dataset supported")
    bars = request.get("bars")
    if not isinstance(bars, list) or not 2 <= len(bars) <= 512:
        raise ValueError("need 2..512 historical daily OHLCV bars")
    timestamps = []
    for bar in bars:
        if not isinstance(bar, dict):
            raise ValueError("invalid bar")
        numbers = [bar.get(c) for c in ("open", "high", "low", "close", "volume")]
        if any(not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x) for x in numbers):
            raise ValueError("non-finite or non-numeric OHLCV")
        o, h, l, c, v = numbers
        if min(o, h, l, c) <= 0 or v < 0 or not l <= min(o, c) <= max(o, c) <= h:
            raise ValueError("invalid OHLCV bounds")
        timestamps.append(parse_utc(bar.get("observed_at")))
    if any(b - a != timedelta(days=1) for a, b in zip(timestamps, timestamps[1:])):
        raise ValueError("daily bars must be consecutive and strictly ordered")
    if parse_utc(request.get("as_of")) != timestamps[-1]:
        raise ValueError("as_of must equal final observed bar timestamp")
    if parse_utc(request.get("forecast_for")) != timestamps[-1] + timedelta(days=1):
        raise ValueError("forecast must target next UTC daily bar")
    if request.get("model_id", MODEL) != MODEL:
        raise ValueError("only pinned Kronos-small is supported")
    seed = request.get("seed", 123)
    count = request.get("scenario_count", 8)
    temperature = request.get("temperature", 1.0)
    top_p = request.get("top_p", 0.9)
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2_147_483_647:
        raise ValueError("invalid seed")
    if not isinstance(count, int) or isinstance(count, bool) or not 2 <= count <= 32:
        raise ValueError("scenario_count must be 2..32")
    if not isinstance(temperature, (int, float)) or not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("invalid temperature")
    if not isinstance(top_p, (int, float)) or not math.isfinite(top_p) or not 0 < top_p <= 1:
        raise ValueError("invalid top_p")
    digest = hashlib.sha256(json.dumps(bars, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    return {"request": request, "digest": digest, "count": count, "seed": seed,
            "temperature": float(temperature), "top_p": float(top_p)}


def infer_forecast(validated):
    # Import lazily: validation/testing should never download checkpoints.
    try:
        import pandas as pd
        import torch
        from model import Kronos, KronosTokenizer, KronosPredictor
    except ImportError as exc:
        raise RuntimeError("install Kronos upstream dependencies and expose its checkout on PYTHONPATH") from exc
    request = validated["request"]
    tokenizer = KronosTokenizer.from_pretrained(TOKENIZER, revision=TOKENIZER_REV)
    model = Kronos.from_pretrained(MODEL, revision=MODEL_REV)
    tokenizer.eval()
    model.eval()
    predictor = KronosPredictor(model, tokenizer, max_context=512)
    bars = request["bars"]
    df = pd.DataFrame(bars)[["open", "high", "low", "close", "volume"]]
    x_time = pd.to_datetime(pd.Series([b["observed_at"] for b in bars]), utc=True)
    y_time = pd.to_datetime(pd.Series([request["forecast_for"]]), utc=True)
    scenarios = []
    with torch.no_grad():
        for i in range(validated["count"]):
            torch.manual_seed(validated["seed"] + i)
            forecast = predictor.predict(df, x_time, y_time, pred_len=1,
                                         T=validated["temperature"], top_p=validated["top_p"],
                                         sample_count=1, verbose=False)
            close = float(forecast.iloc[0]["close"])
            if not math.isfinite(close) or close <= 0:
                raise ValueError("model emitted non-positive or non-finite price")
            scenarios.append(close)
    return {
        "schema_version": 1, "source": "kronos-inference", "dataset_id": DATASET,
        "model_id": MODEL, "model_revision": MODEL_REV,
        "tokenizer_revision": TOKENIZER_REV,
        "as_of": request["as_of"], "input_last_at": bars[-1]["observed_at"],
        "forecast_for": request["forecast_for"],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "input_count": len(bars), "input_close": bars[-1]["close"],
        "input_digest": validated["digest"], "scenario_closes": scenarios,
        "seed": validated["seed"], "temperature": validated["temperature"],
        "top_p": validated["top_p"],
        "validation_status": "UNVERIFIED_CHECKPOINT_HISTORY",
        "execution_allowed": False,
    }


def talkpipe_infer(request):
    """Actually compose validation and inference as TalkPipe streaming segments."""
    try:
        from talkpipe.pipe import core
    except ImportError as exc:
        raise RuntimeError("install talkpipe for --infer") from exc

    @core.source()
    def one_request(value):
        yield value

    @core.segment()
    def bounded(items):
        for value in items:
            yield validate_request(value)

    @core.segment()
    def forecast(items):
        for value in items:
            yield infer_forecast(value)

    out = (one_request(value=request) | bounded() | forecast()).as_function(single_out=False)()
    if len(out) != 1:
        raise RuntimeError("TalkPipe must emit exactly one forecast receipt")
    return out[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--validate", action="store_true")
    modes.add_argument("--infer", action="store_true")
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin)
        if args.validate:
            result = validate_request(request)
            print(json.dumps({"valid": True, "input_digest": result["digest"],
                              "input_count": len(request["bars"]), "inference_performed": False}))
        else:
            print(json.dumps(talkpipe_infer(request), allow_nan=False))
    except (ValueError, TypeError, RuntimeError, KeyError) as exc:
        print("Kronos forecast rejected: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
