-- The SOL/USD series the regime reads for its one-hour change (ENGINE §11); one row a minute.
create table if not exists sol_price (
  ts timestamptz primary key,
  usd double precision not null
);
create index if not exists chain_events_kind_ts on chain_events (kind, ts desc);
