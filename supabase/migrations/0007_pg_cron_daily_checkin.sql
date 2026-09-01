-- Moves the daily notification sweep from Vercel Cron onto Supabase's own
-- pg_cron, which invokes the daily-checkin Edge Function
-- (supabase/functions/daily-checkin) instead of a Vercel Cron trigger
-- calling a Vercel API route directly. That function decides who's due
-- and calls this app's /api/notifications for actual delivery.
--
-- pg_net (needed for the outbound HTTP call to the Edge Function) gets
-- the same "enable it if the environment allows" treatment pg_cron
-- already got in 0002 — neither is guaranteed available on every
-- Postgres tier, and this migration must not fail outright if so.
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net could not be created automatically (extension "pg_net" is not available) — enable it from the Supabase dashboard under Database > Extensions.';
end $$;

-- `alter database postgres set "app.settings.*"` (the previous approach
-- here) requires a superuser grant Supabase does not give out on shared/
-- free-tier projects — it fails with a permission-denied error there.
-- Vault is the still-current, still-actually-usable-on-every-tier way to
-- get a secret into a pg_cron/pg_net job body: it's a regular (encrypted)
-- table under the hood, writable via a SECURITY DEFINER function the
-- `postgres` role can already call, not a database-level GUC.
--
-- One-time manual step, run once via the Supabase SQL editor — NOT part
-- of this migration, and the actual key must never be committed to
-- version control:
--
--   select vault.create_secret('<your-service-role-key>', 'daily_checkin_service_role_key');
--
-- The project URL below is not a secret (it's already public — the same
-- value as VITE_SUPABASE_URL, baked into the browser bundle), so unlike
-- the key it's fine to commit directly. Replace the placeholder with your
-- actual project ref before applying this migration.
do $$
begin
  perform cron.schedule(
    'daily-checkin',
    '0 9 * * *',
    $cron$
    select net.http_post(
      url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/daily-checkin',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'daily_checkin_service_role_key'
        )
      ),
      body := '{}'::jsonb
    );
    $cron$
  );
exception when others then
  raise notice 'pg_cron could not schedule daily-checkin automatically (pg_cron/pg_net unavailable, or the daily_checkin_service_role_key Vault secret not yet created) — see README for the manual SQL editor steps.';
end $$;
