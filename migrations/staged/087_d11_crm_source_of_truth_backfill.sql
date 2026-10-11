-- Run repeatedly, in autocommit mode, after migration 087 Expand.
-- Each invocation updates at most 500 rows per relation and writes one audit row.
-- Stop only when every numeric value under "remaining" is zero.
select public.crm_d11_backfill_batch(500);
