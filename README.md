# Survival Lab

A deterministic, replayable arena for testing how multiple strategy agents behave under a shared survival constraint.

**Live demo:** [survival-lab.mcc0nnell.chatgpt.site](https://survival-lab.mcc0nnell.chatgpt.site)

Survival Lab keeps the compelling part of autonomous-trading experiments—the competing strategies, live tape, and risk pressure—while making the evidence inspectable. It is a paper simulation. It connects to no exchange, holds no funds, and has no withdrawal keys.

## What it does

- Runs six rule-based agents against the same synthetic market tape.
- Shows every agent's vote, confidence, and current rationale.
- Opens a paper position only when the combined vote crosses a threshold.
- Tracks equity, realized P&L, drawdown, exposure, win rate, and runway.
- Replays the same path from seed `0xA11CE` after every reset.
- Supports deliberate, visibly labeled shock injection.

## Agents

| Agent | Owns |
| --- | --- |
| KESTO | Trend |
| ORVEN | Mean reversion |
| BRAVA | Breakouts |
| MIRAX | Volatility |
| DUSKA | Funding pressure |
| NOVIA | Liquidity |

The current agents are deliberately legible rules, not language-model theater. Their purpose is to make orchestration, disagreement, and failure visible before more sophisticated models or real event cartridges are introduced.

## Run locally

No build step or dependencies are required.

```bash
python3 -m http.server 8080 --directory dist
```

Then open <http://localhost:8080>.

## Architecture

The prototype is a single static application in [`dist/index.html`](dist/index.html). It contains:

- a seeded synthetic market generator;
- six independent signal functions;
- a consensus execution rule;
- paper position and risk accounting;
- a Canvas equity/market renderer; and
- a DOM-native decision tape and agent ledger.

The intended integration boundary is event cartridges:

- **Secretariat** can provide racing events.
- **Fire Producer** can provide live sports, news, and weather events.
- **WindAnvil** can provide replay, provenance, and audit records.
- **Survival Lab** remains the visible competition and evaluation surface.

## Safety and scope

This repository is an evaluation interface and simulation, not financial software or investment advice. The displayed prices, fills, returns, and order-book depth are synthetic.

## License

Apache-2.0
