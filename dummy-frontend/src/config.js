// Local-dev defaults (public values printed by `supabase status`). Override with VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY in dummy-frontend/.env.local. Never put the service-role key in a client.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
