-- Extensions used across the app.
create extension if not exists vector   with schema extensions;  -- product / listing embeddings
create extension if not exists pg_trgm  with schema extensions;  -- fuzzy name matching (no AI needed)
create extension if not exists pg_cron;                          -- nightly / daily jobs
create extension if not exists pg_net   with schema extensions;  -- cron -> Edge Function calls
