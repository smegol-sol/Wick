-- Level-2 learning (ADR-0004): a rule the evaluator disabled stays disabled until the
-- operator re-enables it; the latest rule_stats row per rule carries the effective weight.
alter table rule_stats add column if not exists disabled boolean not null default false;
create index if not exists intents_rule_ts on intents (rule_id, ts desc);
create index if not exists rule_stats_rule_changed on rule_stats (rule_id, changed_at desc);
