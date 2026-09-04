-- requires: timescaledb
-- Hypertables, compression, retention and the 10-second aggregate (ADR-0007).
-- Skipped, loudly, when the timescaledb extension is not installed (plain
-- Postgres in local development or CI without the image); the tables from
-- 0001 still work as ordinary tables there.
create extension if not exists timescaledb;

select create_hypertable('token_snapshots', 'ts', chunk_time_interval => interval '1 day', if_not_exists => true, migrate_data => true);
alter table token_snapshots set (timescaledb.compress, timescaledb.compress_segmentby = 'mint', timescaledb.compress_orderby = 'ts desc');
select add_compression_policy('token_snapshots', interval '2 days', if_not_exists => true);
select add_retention_policy('token_snapshots', interval '30 days', if_not_exists => true);

create materialized view if not exists token_snapshots_10s
with (timescaledb.continuous) as
select
  time_bucket('10 seconds', ts) as bucket,
  mint,
  last(price, ts) as price,
  last(mc, ts) as mc,
  last(liq, ts) as liq,
  max(vol5m) as vol5m,
  max(vol24) as vol24,
  max(tx24) as tx24,
  max(buys5m) as buys5m,
  max(sells5m) as sells5m,
  last(holders, ts) as holders,
  last(top10, ts) as top10,
  count(*) as samples
from token_snapshots
group by bucket, mint
with no data;
select add_continuous_aggregate_policy('token_snapshots_10s', start_offset => interval '3 days', end_offset => interval '1 minute', schedule_interval => interval '5 minutes', if_not_exists => true);
select add_retention_policy('token_snapshots_10s', interval '365 days', if_not_exists => true);

select create_hypertable('chain_events', 'ts', chunk_time_interval => interval '7 days', if_not_exists => true, migrate_data => true);
select create_hypertable('microstructure', 'at', chunk_time_interval => interval '1 day', if_not_exists => true, migrate_data => true);
select add_retention_policy('microstructure', interval '30 days', if_not_exists => true);
select create_hypertable('events', 'ts', chunk_time_interval => interval '1 day', if_not_exists => true, migrate_data => true);
select add_retention_policy('events', interval '90 days', if_not_exists => true);
