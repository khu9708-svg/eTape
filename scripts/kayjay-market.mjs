const base = "https://api.exchange.coinbase.com/products";
const cache = new Map();
export const coins = ["BTC", "ETH", "SOL"];
export function validateMarket(symbol, seconds) {
  return coins.includes(symbol) && [60,300,900,3600,86400].includes(seconds);
}
export function candlesForChart(rows) {
  return [...new Map(rows.filter(row => Array.isArray(row) && row.length >= 6 && row.every(Number.isFinite))
    .map(([time,low,high,open,close,volume]) => [time,{time,low,high,open,close,volume}])).values()].sort((a,b)=>a.time-b.time);
}
async function get(resource, ttl) {
  const saved = cache.get(resource);
  if (saved && Date.now()-saved.time < ttl) return saved.promise;
  const promise = fetch(base+resource, {signal:AbortSignal.timeout(7000)}).then(async response => {
    if (!response.ok) throw new Error("Market source unavailable");
    return response.json();
  });
  cache.set(resource,{time:Date.now(),promise});
  try { return await promise; } catch(error) { cache.delete(resource); throw error; }
}
export async function marketSnapshot(symbol, seconds) {
  if (!validateMarket(symbol,seconds)) throw new Error("Unsupported market");
  const start=Date.now();
  const [quotes,rawCandles,book] = await Promise.all([
    Promise.all(coins.map(async coin => {
      const stats = await get("/"+coin+"-USD/stats",10000);
      const price=Number(stats.last), open=Number(stats.open);
      return {symbol:coin,price,change24h:open ? (price/open-1)*100 : null};
    })),
    get("/"+symbol+"-USD/candles?granularity="+seconds,60000),
    get("/"+symbol+"-USD/book?level=2",4000)
  ]);
  return {source:"Coinbase Exchange",asOf:new Date().toISOString(),latencyMs:Date.now()-start,symbol,quotes,
    candles:candlesForChart(rawCandles), bids:book.bids.slice(0,8).map(([price,size])=>[Number(price),Number(size)]),
    asks:book.asks.slice(0,8).map(([price,size])=>[Number(price),Number(size)])};
}
