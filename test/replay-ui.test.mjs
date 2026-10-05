import test from "node:test";
import assert from "node:assert/strict";
import {buildReplayModel,replaySnapshot} from "../dist/replay.js";

const row=(day,close)=>({
  observed_at:`2026-01-0${day}T00:00:00Z`,
  open:close-1,high:close+2,low:close-2,close,volume:1
});

test("replay model aligns spot curves to completed market bars and carries equity forward",()=>{
  const spotDataset={id:"spot",observations:[row(1,100),row(2,101),row(3,99),row(4,103)]};
  const tournamentData={results:[
    {id:"a",name:"A",dataset:"spot",curve:[
      {at:"2026-01-01T00:00:00Z",equity:1},
      {at:"2026-01-02T00:00:00Z",equity:1.1},
      {at:"2026-01-04T00:00:00Z",equity:1.2}
    ]},
    {id:"b",name:"B",dataset:"spot",curve:[
      {at:"2026-01-01T00:00:00Z",equity:1},
      {at:"2026-01-03T00:00:00Z",equity:.9},
      {at:"2026-01-04T00:00:00Z",equity:1.05}
    ]},
    {id:"futures",name:"Futures",dataset:"other",curve:[
      {at:"2026-01-01T00:00:00Z",equity:1}
    ]}
  ]};
  const model=buildReplayModel({spotDataset,tournamentData});
  assert.equal(model.frames.length,4);
  assert.deepEqual(model.results.map(r=>r.id),["a","b"]);
  assert.equal(model.frames[2].equities.a,1.1);
  assert.equal(model.frames[2].equities.b,.9);
  assert.equal(model.frames[3].close,103);
});

test("replay snapshot clamps timeline indexes",()=>{
  const model={frames:[{at:"a"},{at:"b"}]};
  assert.equal(replaySnapshot(model,-10).index,0);
  assert.equal(replaySnapshot(model,99).index,1);
});
