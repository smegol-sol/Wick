-- Stream-counted trades on the microstructure row (roadmap Phase 1, features row).
-- Counts come from the log stream's Buy/Sell instruction names; unique buyers
-- wait for per-trade wallets and stay null until then.
alter table microstructure add column if not exists buys_1m integer;
alter table microstructure add column if not exists sells_1m integer;
alter table microstructure add column if not exists buys_5m integer;
alter table microstructure add column if not exists sells_5m integer;
alter table microstructure add column if not exists unique_buyers_5m integer;
