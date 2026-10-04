import test from "node:test";
import assert from "node:assert/strict";
import {closedDailyCutoffIso,isClosedDailyBar,utcDayStartMs} from "../worker/src/history-time.js";

test("daily history cutoff is the current UTC midnight",()=>{
  const now=Date.parse("2026-10-04T18:39:00Z");
  assert.equal(utcDayStartMs(now),Date.parse("2026-10-04T00:00:00Z"));
  assert.equal(closedDailyCutoffIso(now),"2026-10-04T00:00:00.000Z");
});

test("only completed UTC daily bars are eligible for history replay",()=>{
  const now=Date.parse("2026-10-04T18:39:00Z");
  assert.equal(isClosedDailyBar("2026-10-03T00:00:00Z",now),true);
  assert.equal(isClosedDailyBar("2026-10-04T00:00:00Z",now),false);
  assert.equal(isClosedDailyBar("2026-10-04T12:00:00Z",now),false);
  assert.equal(isClosedDailyBar("not-a-date",now),false);
});
