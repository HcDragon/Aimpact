-- Live updates in the app (RLS still applies to Realtime).
alter publication supabase_realtime add table public.alerts;
alter publication supabase_realtime add table public.sales;
