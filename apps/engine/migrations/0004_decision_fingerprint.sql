-- Decision fingerprint (roadmap Phase 2): the rules-file hash, the code version
-- and the price source next to the stored features, so any intent can be
-- reproduced after the rules change. The TTL moves onto the row so a rules
-- change does not re-time intents already written.
alter table intents add column if not exists rules_hash text;
alter table intents add column if not exists code_version text;
alter table intents add column if not exists price_source text;
alter table intents add column if not exists ttl_ms integer;
