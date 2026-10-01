# Strategy research map

Survival Lab is an evaluation harness, not a claim that every archived strategy belongs on the same data horizon.

The Google Drive `Summaries` research corpus contains dedicated collections for trend following, momentum, market impact, portfolio construction, abnormal returns, derivatives, anomalies, return properties, and related topics.

## Immediately relevant to the BTC live-paper harness

- **Dynamic Trading with Predictable Returns and Transaction Costs** (Gârleanu & Pedersen, 2013): separate signal horizon from trading speed; do not chase fast-decaying targets through transaction costs.
- **Machine Trading** (Chan, 2017): keep research/live paths aligned and measure realistic execution costs.
- **Volatility Weighting Applied to Momentum Strategies** (du Plessis & Hallerbach, 2017): distinguish signal normalization from portfolio-level risk scaling.
- Market-impact/execution research (Almgren, Engle, Obizhaeva/Wang and related notes): belongs in the executor/cost cartridge rather than the alpha signal.

## Separate strategy cartridges

These require their own data contracts and horizons rather than being forced onto the 1 Hz BTC tape:

- time-series momentum — **promoted to `tsmom-12m` replay cartridge**. It is bootstrapped from cached Kraken PF_XBTUSD daily futures candles, converted to 12 month-end futures returns, and volatility-scaled using the paper's 60-day-center EWMA estimator and `40% / ex-ante volatility` requested risk scale. PF_XBTUSD is an experimental application of the method, not one of the paper's original 58 instruments.
- short-term residual reversal
- pairs/statistical arbitrage
- cross-sectional momentum
- PEAD / earnings strategies
- factor/value/profitability strategies
- risk parity / portfolio-construction strategies
- universal/Kelly portfolio strategies

Each cartridge should declare its required instruments, lookback, sampling frequency, rebalance frequency, signal output, and execution assumptions. The common Survival Lab risk/execution/evidence boundary can then compare strategies without silently changing their research definitions.
