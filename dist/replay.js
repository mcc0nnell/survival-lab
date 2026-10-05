function asTime(value){
  const t=new Date(value).getTime();
  return Number.isFinite(t)?t:null;
}

export function buildReplayModel({spotDataset,tournamentData}={}){
  if(!spotDataset?.id||!Array.isArray(spotDataset.observations))return {frames:[],results:[]};
  const results=(tournamentData?.results||[])
    .filter(r=>r?.dataset===spotDataset.id&&Array.isArray(r.curve)&&r.curve.length)
    .map(r=>({...r,curve:r.curve.slice().sort((a,b)=>asTime(a.at)-asTime(b.at))}));
  if(!results.length)return {frames:[],results:[]};
  const starts=results.map(r=>asTime(r.curve[0]?.at)).filter(Number.isFinite);
  const ends=results.map(r=>asTime(r.curve.at(-1)?.at)).filter(Number.isFinite);
  if(!starts.length||!ends.length)return {frames:[],results};
  const start=Math.max(...starts),end=Math.min(...ends);
  const rows=spotDataset.observations.slice()
    .filter(row=>{const t=asTime(row.observed_at);return t!==null&&t>=start&&t<=end})
    .sort((a,b)=>asTime(a.observed_at)-asTime(b.observed_at));
  const cursors=new Map(results.map(r=>[r.id,0]));
  const latest=new Map(results.map(r=>[r.id,Number(r.curve[0]?.equity)||1]));
  const frames=[];
  for(const row of rows){
    const t=asTime(row.observed_at);
    const equities={};
    for(const result of results){
      let i=cursors.get(result.id)||0;
      while(i+1<result.curve.length&&asTime(result.curve[i+1].at)<=t)i++;
      cursors.set(result.id,i);
      const value=Number(result.curve[i]?.equity);
      if(Number.isFinite(value))latest.set(result.id,value);
      equities[result.id]=latest.get(result.id)??1;
    }
    const open=Number(row.open),high=Number(row.high),low=Number(row.low),close=Number(row.close);
    if(![open,high,low,close].every(Number.isFinite))continue;
    frames.push({at:row.observed_at,open,high,low,close,volume:Number(row.volume)||0,equities});
  }
  return {
    dataset_id:spotDataset.id,
    start_at:frames[0]?.at||null,
    end_at:frames.at(-1)?.at||null,
    frames,
    results
  };
}

export function replaySnapshot(model,index){
  const frames=model?.frames||[];
  if(!frames.length)return null;
  const i=Math.max(0,Math.min(frames.length-1,Math.trunc(Number(index)||0)));
  return {index:i,total:frames.length,frame:frames[i]};
}
