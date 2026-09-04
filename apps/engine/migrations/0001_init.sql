-- ENGINE.md §14. Plain tables; 0002 turns the time series into hypertables.
-- Each statement runs on its own (see src/db/sql.ts).

create table if not exists tokens (
  chain text not null default 'solana',
  mint text primary key,
  symbol text not null,
  name text not null,
  creator text,
  created_at timestamptz,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  stage text not null check (stage in ('new', 'bonding', 'migrated'))
);

create table if not exists token_snapshots (
  ts timestamptz not null,
  mint text not null,
  price double precision,
  mc double precision,
  liq double precision,
  vol5m double precision,
  vol24 double precision,
  tx24 integer,
  buys5m integer,
  sells5m integer,
  holders integer,
  top10 double precision,
  source text not null,
  stats_at timestamptz
);
create index if not exists token_snapshots_mint_ts on token_snapshots (mint, ts desc);


create table if not exists chain_events (
  ts timestamptz not null,
  mint text not null,
  kind text not null,
  sig text,
  data jsonb not null default '{}'::jsonb
);
create index if not exists chain_events_mint_ts on chain_events (mint, ts desc);

create table if not exists launch_txs (
  mint text primary key,
  slot bigint not null,
  creator text not null,
  buyers jsonb not null default '[]'::jsonb,
  bundle_pct double precision,
  sniper_pct double precision,
  parsed_at timestamptz not null default now()
);

create table if not exists audits (
  mint text not null,
  at timestamptz not null,
  program text,
  mint_auth boolean,
  freeze_auth boolean,
  extensions jsonb,
  lp_state text,
  decimals integer,
  supply double precision,
  top10 double precision,
  funding_flags jsonb not null default '[]'::jsonb,
  primary key (mint, at)
);

create table if not exists supply_maps (
  mint text not null,
  at timestamptz not null,
  dev_pct double precision,
  bundle_pct double precision,
  sniper_pct double precision,
  fresh_pct double precision,
  lp_pct double precision,
  cluster_pct double precision,
  trend text,
  inputs jsonb not null default '{}'::jsonb,
  primary key (mint, at)
);

create table if not exists microstructure (
  at timestamptz not null,
  mint text not null,
  net_flow_1m double precision,
  net_flow_5m double precision,
  organic_vol_pct_5m double precision,
  depth_buy_2pct double precision,
  depth_sell_2pct double precision
);
create index if not exists microstructure_mint_at on microstructure (mint, at desc);

create table if not exists regime (
  at timestamptz primary key,
  sol_change_1h double precision,
  breadth_5m double precision,
  launches_ph double precision,
  migrations_ph double precision,
  safety_reject_rate_1h double precision,
  size_mul double precision not null,
  reason text not null
);

create table if not exists wallets (
  pk text primary key,
  label text,
  kind text not null check (kind in ('owner', 'discovered')),
  tracked_since timestamptz not null default now(),
  status text not null default 'watch',
  stats jsonb not null default '{}'::jsonb
);

create table if not exists wallet_profiles (
  wallet text primary key,
  class text not null,
  confidence double precision not null,
  stats jsonb not null default '{}'::jsonb,
  profiled_at timestamptz not null default now()
);

create table if not exists wallet_prints (
  sig text primary key,
  wallet text not null,
  ts timestamptz not null,
  seen_at timestamptz not null,
  mint text not null,
  side text not null check (side in ('buy', 'sell')),
  sol double precision not null,
  amount double precision not null
);
create index if not exists wallet_prints_wallet_ts on wallet_prints (wallet, ts desc);

create table if not exists wallet_scores (
  wallet text not null,
  window_days integer not null,
  n integer not null,
  hit_rate_30m double precision,
  med_ret_120m double precision,
  med_hold_sec double precision,
  copied_pnl_sol double precision,
  class text,
  scored_at timestamptz not null default now(),
  primary key (wallet, window_days, scored_at)
);

create table if not exists intents (
  id text primary key,
  chain text not null default 'solana',
  ts timestamptz not null,
  kind text not null,
  strategy text not null,
  rule_id text not null,
  mode text not null check (mode in ('shadow', 'suggest', 'auto')),
  mint text not null,
  side text not null check (side in ('buy', 'sell')),
  size_sol double precision not null,
  sizing jsonb,
  features jsonb not null,
  why text not null,
  status text not null default 'proposed',
  decided_by text,
  decided_at timestamptz,
  replay_run_id text
);
create index if not exists intents_ts on intents (ts desc);
create index if not exists intents_mint_ts on intents (mint, ts desc);

create table if not exists gate_results (
  intent_id text not null references intents (id),
  gate text not null,
  passed boolean not null,
  reason_code text,
  adjustment jsonb,
  ms double precision not null,
  primary key (intent_id, gate)
);

create table if not exists quotes (
  id text primary key,
  intent_id text not null references intents (id),
  ts timestamptz not null,
  in_amount numeric not null,
  out_amount numeric not null,
  impact_pct double precision,
  slippage_bps integer not null,
  route jsonb
);

create table if not exists executions (
  id text primary key,
  intent_id text not null references intents (id),
  quote_id text references quotes (id),
  wallet text not null,
  sig text,
  sent_at timestamptz,
  landed_at timestamptz,
  status text not null,
  err text,
  fee_lamports bigint,
  tip_lamports bigint,
  route text not null default 'rpc'
);
create unique index if not exists executions_one_per_intent on executions (intent_id);

create table if not exists fills (
  execution_id text primary key references executions (id),
  chain text not null default 'solana',
  mint text not null,
  side text not null,
  sol_delta double precision not null,
  token_delta double precision not null,
  quoted_price double precision,
  realized_price double precision,
  realized_slippage_pct double precision
);

create table if not exists positions (
  mint text not null,
  wallet text not null,
  opened_at timestamptz not null,
  closed_at timestamptz,
  cost_sol double precision not null,
  qty double precision not null,
  exits jsonb not null default '[]'::jsonb,
  realized_pnl_sol double precision,
  status text not null default 'open',
  primary key (mint, wallet, opened_at)
);

create table if not exists outcomes (
  intent_id text not null references intents (id),
  horizon_sec integer not null,
  ret_pct double precision,
  max_ret_pct double precision,
  min_ret_pct double precision,
  primary key (intent_id, horizon_sec)
);

create table if not exists rule_stats (
  rule_id text not null,
  window_days integer not null,
  n integer not null,
  win_rate double precision,
  expectancy double precision,
  worst_dd double precision,
  weight double precision not null,
  changed_at timestamptz not null default now(),
  change_reason text not null,
  replay_run_id text,
  primary key (rule_id, window_days, changed_at)
);

create table if not exists replay_runs (
  id text primary key,
  rules_version text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  exec_model jsonb not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb
);

create table if not exists halts (
  ts timestamptz not null,
  kind text not null,
  reason text not null,
  cleared_at timestamptz,
  cleared_by text,
  primary key (ts, kind)
);

create table if not exists tiers (
  active_tier integer not null,
  wallet_cap_sol double precision not null,
  changed_at timestamptz not null default now(),
  changed_by text not null,
  reason text not null,
  primary key (changed_at)
);

create table if not exists events (
  ts timestamptz not null,
  level text not null,
  component text not null,
  msg text not null,
  data jsonb not null default '{}'::jsonb
);
