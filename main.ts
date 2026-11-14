// Deep-dip recovery bot: buy a deep drawdown from the rolling 7h high, sell the recovery.
// Entry: close <= rolling 420-bar high * (1 - DIP_BPS).
// Exit: take-profit +TP_BPS over cost, stop-loss -SL_BPS under cost, or max-hold timeout.
// Deterministic: float64 math only, no clock/env/random.
import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- parameters (best on dev: +$11.66, 6 trades, 66.7% win) ----
const HIGH_BARS = 420;        // 7h rolling high window
const DIP_BPS = 350;          // buy when 3.5% below the 7h high
const TAKE_PROFIT_BPS = 140;  // +1.4% over cost
const STOP_LOSS_BPS = 150;    // -1.5% under cost
const MAX_HOLD_BARS = 480;    // exit after 8h if neither TP nor SL hit
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
const heldBars = new Map<string, number>();

function rollingHigh(): number {
  const start = Math.max(0, closes.length - HIGH_BARS);
  let hi = -Infinity;
  for (let i = start; i < closes.length; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      closes.push(Number(bar.c));
      const h = heldBars.get(bar.symbol) ?? 0;
      if (state.positions.get(bar.symbol) !== undefined) heldBars.set(bar.symbol, h + 1);
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
        const tp = (cost * BigInt(10000 + TAKE_PROFIT_BPS)) / 10000n;
        const sl = (cost * BigInt(10000 - STOP_LOSS_BPS)) / 10000n;
        const barsHeld = heldBars.get(symbol) ?? 0;
        if (value >= tp || value <= sl || barsHeld >= MAX_HOLD_BARS) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          heldBars.delete(symbol);
        }
        continue;
      }
      const hi = rollingHigh();
      const last = closes[closes.length - 1];
      if (hi > 0 && last <= (hi * (10000 - DIP_BPS)) / 10000) {
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
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
