-- The executor records what a position was opened at (ENGINE §6 exits: take
-- profit from entry, liquidity down from entry) and which intent opened it.
alter table positions add column if not exists entry_price_usd double precision;
alter table positions add column if not exists entry_liq_usd double precision;
alter table positions add column if not exists intent_id text;
