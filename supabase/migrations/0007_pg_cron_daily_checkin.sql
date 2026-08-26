-- Moves the daily notification sweep from Vercel Cron onto Supabase's own
-- pg_cron, which invokes the daily-checkin Edge Function
-- (supabase/functions/daily-checkin) instead of a Vercel Cron trigger
-- calling a Vercel API route directly. That function decides who's due
-- and calls this app's /api/send-notification for actual delivery.
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

-- One-time manual step, run once via the Supabase SQL editor — NOT part
-- of this migration, and the actual values must never be committed to
-- version control:
--
--   alter database postgres set "app.settings.project_url" to 'https://<your-project-ref>.supabase.co';
--   alter database postgres set "app.settings.service_role_key" to '<your-service-role-key>';
--
-- This migration only *references* those settings by name below; without
-- them having been set first, the schedule call either fails harmlessly
-- (caught below) or fires with an empty URL/key and the Edge Function's
-- own auth check rejects it.
do $$
begin
  perform cron.schedule(
    'daily-checkin',
    '0 9 * * *',
    $cron$
    select net.http_post(
      url := current_setting('app.settings.project_url', true) || '/functions/v1/daily-checkin',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := '{}'::jsonb
    );
    $cron$
  );
exception when others then
  raise notice 'pg_cron could not schedule daily-checkin automatically (pg_cron/pg_net unavailable, or app.settings.project_url/service_role_key not yet configured) — see README for the manual SQL editor steps.';
end $$;
