-- mirror-follow (ENGINE §9): every copy of a followed wallet's print is an `events` row
-- (component decision, msg copy, data.wallet / data.intentId / data.gapMs). The wallet
-- panel and the daily demotion read the last copies per wallet through this index.
create index if not exists events_copy_wallet_ts on events ((data ->> 'wallet'), ts desc)
  where component = 'decision' and msg = 'copy';
