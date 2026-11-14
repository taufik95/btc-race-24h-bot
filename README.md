# Deep-dip recovery bot v2 for make.fun BTC race

Buys cbBTC when it falls 4.5% below its rolling 5-hour high, sells the recovery
at +2.2% over cost (stop -2.0%, max hold 8h). Long only, one position, full equity.

Dev window (24h to 2026-11-13 23:14 UTC): net PnL +$21.99, 2 trades, 100% win,
max drawdown 2% (inside the 25% race guardrail). Variant v2 of the v1 bot
(+$11.66, 6 trades, 66.7%): deeper dip, wider take-profit and stop-loss.
Only 2 trades in the dev window, so this variant is fragile and may be overfit.
Entry v2 is independent of v1; v1 stays valid regardless.
