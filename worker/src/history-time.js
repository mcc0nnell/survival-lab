const DAY_MS=86400000;

export function utcDayStartMs(now=Date.now()){
  const ms=now instanceof Date?now.getTime():Number(now);
  if(!Number.isFinite(ms))throw new TypeError("invalid clock value");
  return Math.floor(ms/DAY_MS)*DAY_MS;
}

export function closedDailyCutoffIso(now=Date.now()){
  return new Date(utcDayStartMs(now)).toISOString();
}

export function isClosedDailyBar(observedAt,now=Date.now()){
  const observedMs=new Date(observedAt).getTime();
  return Number.isFinite(observedMs)&&observedMs<utcDayStartMs(now);
}
