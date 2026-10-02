# Survival Lab

Survival Lab is a transparent paper-trading arena for comparing strategy cartridges through one shared risk, execution, and evidence boundary. The production dashboard is deployed at `https://trader.mcc0nnell.org`.

The default dashboard consumes public BTC-USD market data and performs **paper execution only**. It has no exchange credentials, no deposit path, no withdrawal path, and no live-order adapter.

## Modes

- Default: public Coinbase BTC-USD top-of-book plus latest trade observations.
- `?feed=synthetic`: deterministic seeded tape for regression testing, replay, speed controls, and shock injection.

A live-feed failure does not silently fall back to synthetic prices. Live mode uses the Coinbase Exchange WebSocket ticker. Market visuals update continuously from genuine ticker messages, while strategy/risk evaluation samples the latest quote at approximately 1 Hz.

## Authority boundary

```
market observation
  -> strategy cartridge
       observe()
       target() -> normalized target exposure / portfolio weights
       explain()
  -> risk gate
  -> executor
  -> evidence log
```

Strategies never receive execution authority. Each cartridge declares its universe, sampling cadence, rebalance cadence, output type, and research identity, then emits a normalized target through the common contract. The risk gate enforces stale-quote rejection, one position at a time, maximum exposure and notional, order-rate limits, drawdown halt, and cumulative-loss halt. Paper fills include observed spread, configurable slippage, and fees. Consensus Six is the first active cartridge; its reversal exits require a 30-second minimum hold, opposite consensus magnitude of at least 0.30, and three consecutive confirmations. Take-profit, stop-loss, and kill-switch exits remain immediate.

## Active cartridge

`consensus-six` wraps the original six transparent agents behind the cartridge contract. The dashboard still renders their individual explanations, but the executor sees only the cartridge target.

## Replay cartridges

History-backed cartridges are bootstrapped through the same Neon-backed history plane and remain research/replay contestants rather than live executors:

- `tsmom-12m` — 12-month time-series momentum on Kraken PF_XBTUSD futures.
- `btc-buy-hold` — constant-long BTC-USD benchmark.
- `sma-50-200` — dual moving-average trend signal.
- `donchian-55-20` — 55-day breakout entries with 20-day opposite-channel exits, using prior bars only.
- `rsi-14-reversion` — Wilder-smoothed RSI threshold mean reversion.

## Agents

| Agent | Owns |
| --- | --- |
| KESTO | Trend |
| ORVEN | Mean reversion |
| BRAVA | Breakout |
| MIRAX | Volatility |
| DUSKA | Observed order flow |
| NOVIA | Top-of-book liquidity imbalance |

## Historical data plane

Strategy cartridges declare machine-readable history contracts. The browser asks the evidence Worker for normalized datasets; the Worker reads/writes the Neon `market_history` cache and owns vendor-specific adapters.

Current datasets:

- `btc-usd-spot-1d`: Kraken spot BTC/USD normalized to `BTC-USD`, daily OHLCV.
- `kraken-pf-xbtusd-1d`: Kraken PF_XBTUSD perpetual-futures daily OHLCV.

`tsmom-12m` consumes the futures dataset through a dedicated adapter. The adapter forms month-end futures returns and estimates ex-ante annualized volatility from exponentially weighted daily returns with a 60-day center of mass before passing 12 monthly observations to the cartridge. It is a replay/research contestant; Consensus Six remains the live paper executor.

## Autonomous paper runner

Production live-paper execution is owned by Neon, not by the browser. `neon.ts` declares a scheduled `trader` Function that fires every minute. Each invocation opens the Coinbase BTC-USD ticker for an 18-second window, samples at approximately 1 Hz, runs the existing `consensus-six` cartridge through the common risk/execution gate, and atomically persists evidence plus the resumable account/position/history snapshot into `survival_events`. An advisory lock and `scheduled_at` idempotency check prevent overlapping or replayed invocations from double-executing.

`trader.mcc0nnell.org` remains the Cloudflare-hosted viewer and live market visualization. In production live mode it reads the authoritative account state from the Neon-backed ledger and does not execute paper orders locally. `?feed=synthetic` remains a browser-local deterministic executor for regression and shock testing. The default duty cycle can be tuned with `TRADER_WINDOW_MS` and `TRADER_SAMPLE_MS`.

Set `SURVIVAL_DATABASE_URL` to the pooled connection string for the `survival_lab` database, then deploy the Neon runtime and schedule from the linked project with `npm run deploy:neon`. The explicit database binding is required because the branch contains multiple databases and the branch-default `DATABASE_URL` is not Survival Lab.

## Evidence

Every autonomous strategy-sampled market observation, cartridge target, risk decision, fill, run boundary, and feed error enters a SHA-256 hash chain and is written directly by the scheduled Neon runner. Browser sessions keep only a bounded local evidence copy; production browser event ingestion is disabled so stale or pre-deploy tabs cannot contaminate the authoritative ledger.

The evidence Worker exposes a sanitized read-only `/api/ledger` view for the dashboard, so recent run summaries, strategy/evidence events, and the latest authoritative runner account state are visible on Trader without exposing database credentials or arbitrary SQL. The Neon connection remains a Cloudflare Worker secret.

`schema.sql` defines both the Neon event store and the normalized `market_history` cache. `worker/` is the server-side read/history boundary: it exposes the sanitized ledger and hydrates allowlisted daily history datasets into Neon. `POST /api/events` returns `410` in production; autonomous evidence goes directly from the Neon Function to Postgres.

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
