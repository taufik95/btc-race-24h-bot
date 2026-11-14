// Deep-dip recovery bot for the make.fun BTC race (cbBTC/USDC, Orca, 1m bars).
//
// Idea: BTC grinds down in slow waves. When the price falls 4.5% below its
// rolling 5-hour high, the dip is deep enough that a short-term recovery is
// likely, so buy with full equity. Sell the recovery at +2.2% over cost,
// cut the loss at -2.0%, or give up after 8h if neither triggers.
// Long only, at most one open position, full equity per trade.
// Deterministic: float64 math only, no clock/env/random.
//
// Dev window (24h to 2026-11-13 23:14 UTC): net PnL +$21.99, 2 trades,
// 100% win rate, max drawdown 2% (inside the 25% race guardrail).
// Variant v2 of the v1 "Deep-dip recovery" bot (+$11.66, 6 trades, 66.7%):
// deeper dip, wider take-profit and stop-loss. Only 2 trades in the dev
// window, so this variant is fragile and may be overfit.
import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- strategy parameters ----
const CONFIG = {
  highBars: 300,        // 5h rolling high window
  dipBps: 450,          // buy when 4.5% below the 5h high
  takeProfitBps: 220,   // +2.2% over cost
  stopLossBps: 200,     // -2.0% under cost
  maxHoldBars: 480,     // exit after 8h if neither TP nor SL hit
  maxSlippageBps: 100,
};

const closes: number[] = [];
const heldBars = new Map<string, number>();

function rollingHigh(window: number): number {
  const start = Math.max(0, closes.length - window);
  let hi = -Infinity;
  for (let i = start; i < closes.length; i++) {
    if (closes[i] > hi) hi = closes[i];
  }
  return hi;
}

function exitPrice(cost: bigint, bps: number): bigint {
  return (cost * BigInt(10000 + bps)) / 10000n;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      closes.push(Number(bar.c));
      const held = heldBars.get(bar.symbol) ?? 0;
      if (state.positions.get(bar.symbol) !== undefined) heldBars.set(bar.symbol, held + 1);
    }
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const value = state.value(symbol, held.qty);
        const cost = held.cost;
        const tp = exitPrice(cost, CONFIG.takeProfitBps);
        const sl = exitPrice(cost, -CONFIG.stopLossBps);
        const barsHeld = heldBars.get(symbol) ?? 0;
        if (value >= tp || value <= sl || barsHeld >= CONFIG.maxHoldBars) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: CONFIG.maxSlippageBps });
          heldBars.delete(symbol);
        }
        continue;
      }
      const hi = rollingHigh(CONFIG.highBars);
      const last = closes[closes.length - 1];
      if (hi > 0 && last <= (hi * (10000 - CONFIG.dipBps)) / 10000) {
        entries.push(symbol);
        heldBars.set(symbol, 0);
      }
    }
    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: CONFIG.maxSlippageBps });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
