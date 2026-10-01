# Survival Lab

Survival Lab is a transparent paper-trading arena for comparing six rule-based strategy agents under one shared risk budget. The production dashboard is deployed at `https://trader.mcc0nnell.org`.

The default dashboard consumes public BTC-USD market data and performs **paper execution only**. It has no exchange credentials, no deposit path, no withdrawal path, and no live-order adapter.

## Modes

- Default: public Coinbase BTC-USD top-of-book plus latest trade observations.
- `?feed=synthetic`: deterministic seeded tape for regression testing, replay, speed controls, and shock injection.

A live-feed failure does not silently fall back to synthetic prices.

## Authority boundary

```
market observation
  -> six agents
  -> consensus intent
  -> risk gate
  -> paper executor
  -> evidence log
```

Agents never receive execution authority. The risk gate enforces stale-quote rejection, one position at a time, maximum exposure and notional, order-rate limits, drawdown halt, and cumulative-loss halt. Paper fills include observed spread, configurable slippage, and fees.

## Agents

| Agent | Owns |
| --- | --- |
| KESTO | Trend |
| ORVEN | Mean reversion |
| BRAVA | Breakout |
| MIRAX | Volatility |
| DUSKA | Observed order flow |
| NOVIA | Top-of-book liquidity imbalance |

## Evidence

Every market observation, consensus, risk decision, fill, run boundary, and feed error enters a SHA-256 hash chain.

The browser retains a bounded local copy if remote ingestion is unavailable. The deployed evidence endpoint is `survival-lab-evidence.stokoe.workers.dev/api/events`; its Neon connection is a Cloudflare Worker secret, so database credentials never enter the browser.

`schema.sql` defines the Neon event store. `worker/` contains the server-side ingestion boundary. It accepts bounded evidence batches and de-duplicates them by `(run_id, seq)`.

## Run and test

```bash
python3 -m http.server 8080 --directory dist
npm test
npm run smoke:live
```

Open <http://localhost:8080>. Add `?feed=synthetic` for deterministic mode.

## Deployment

```bash
npm run deploy:trader
npm run deploy:evidence
```

The production frontend is a Cloudflare Worker static-assets deployment on `trader.mcc0nnell.org`. The evidence Worker accepts browser writes only from that origin and persists them to the existing Neon `survival_lab` database.

## Scope

This is experimental evaluation software, not a broker. A future broker adapter belongs below the same risk gate and should consume explicit authorized intents rather than agent output directly.

Apache-2.0
