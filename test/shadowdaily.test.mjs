import test from "node:test";
import assert from "node:assert/strict";
import handler, { evaluateFrozenShadow, runDailyShadow, TRIGGER_NAME } from "../functions/shadowdaily.js";

function history(last = "2026-10-11", gap = null) {
  const start = Date.parse("2025-10-01T00:00:00Z");
  const end = Date.parse(last + "T00:00:00Z");
  const observations = [];
  for (let ms = start, i = 0; ms <= end; ms += 86400000, i++) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (day === gap) continue;
    const close = 100 + i * 0.2;
    observations.push({
      observed_at: new Date(ms).toISOString(),
      open: close - 0.1, high: close + 1, low: close - 1, close, volume: 1
    });
  }
  return { ok: true, product: "BTC-USD", provider: "kraken-spot", cadence: "1d", observations };
}

test("daily shadow includes only the nine genuinely post-freeze bars", () => {
  const report = evaluateFrozenShadow(history(), "2026-10-12T02:15:00Z");
  assert.equal(report.asOf, "2026-10-11");
  assert.equal(report.observations, 9);
  assert.deepEqual(report.results.map(x => x.strategy_id), ["donchian-45-10", "donchian-55-20"]);
  assert.ok(report.results.every(x => x.observations === 9));
  assert.match(report.historySha256, /^[a-f0-9]{64}$/);
});

test("daily shadow rejects a stale candle instead of publishing a false success", () => {
  assert.throws(() => evaluateFrozenShadow(history("2026-10-10"), "2026-10-12T02:15:00Z"), /stale/);
});

test("daily shadow rejects gaps in forward bars", () => {
  assert.throws(() => evaluateFrozenShadow(history("2026-10-11", "2026-10-07"), "2026-10-12T02:15:00Z"), /missing forward bars/);
});

test("daily shadow rejects unexpected history sources", () => {
  assert.throws(() => evaluateFrozenShadow({ ...history(), provider: "synthetic" }, "2026-10-12T02:15:00Z"), /unexpected spot/);
});

test("runner persists just the two research results, no trade execution", async () => {
  let persisted = null;
  const output = await runDailyShadow("2026-10-12T02:15:00Z", {
    fetchImpl: async () => ({ ok: true, json: async () => history() }),
    persist: async report => { persisted = report; }
  });
  assert.equal(output.mode, "research-only");
  assert.equal(output.strategies.length, 2);
  assert.equal(persisted.asOf, "2026-10-11");
  assert.equal(persisted.results.length, 2);
});

test("public POST cannot start research or trading", async () => {
  const response = await handler.fetch(new Request("https://neon.test/daily", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invocation_id: "fake", trigger: { name: TRIGGER_NAME, type: "schedule" } })
  }));
  assert.equal(response.status, 401);
});

test("public health response declares research-only and disabled orders", async () => {
  const response = await handler.fetch(new Request("https://neon.test/healthz"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.orders, "disabled");
  assert.equal(data.mode, "research-only");
});
