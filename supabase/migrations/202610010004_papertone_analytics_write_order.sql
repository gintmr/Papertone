-- Serialize history ID allocation through commit so numbered-page snapshots
-- cannot gain a lower-ID row from a transaction that commits late.
begin;

-- Drain existing collectors before replacing their implementation.
lock table papertone_analytics.visit_records in share row exclusive mode;

create or replace function public.papertone_analytics_track_v2(
  p_event_id uuid, p_visitor_hash text, p_day date, p_country_code text, p_path text
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_new_event boolean;
  v_new_visitor boolean;
  v_country text := coalesce(p_country_code, 'ZZ');
  v_today date := (now() at time zone 'UTC')::date;
begin
  if p_event_id is null or p_visitor_hash is null or p_visitor_hash !~ '^[a-f0-9]{64}$'
     or p_day is distinct from v_today or v_country !~ '^[A-Z]{2}$'
     or (p_path is not null and p_path not in ('/Papertone/')) then
    raise exception 'Invalid analytics event';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('gjofwuihpzjfqeaysuuy:papertone_analytics'),
    pg_catalog.hashtext('history-write-order')
  );
  insert into papertone_analytics.recent_events (event_id) values (p_event_id)
    on conflict do nothing returning true into v_new_event;
  if not coalesce(v_new_event, false) then return false; end if;

  insert into papertone_analytics.visit_records (event_id, country_code, path)
    values (p_event_id, nullif(v_country, 'ZZ'), p_path);

  insert into papertone_analytics.daily_visitors (day, visitor_hash)
    values (v_today, p_visitor_hash)
    on conflict do nothing returning true into v_new_visitor;
  v_new_visitor := coalesce(v_new_visitor, false);
  insert into papertone_analytics.daily_totals (day, pageviews, visitors)
    values (v_today, 1, case when v_new_visitor then 1 else 0 end)
    on conflict (day) do update
      set pageviews = papertone_analytics.daily_totals.pageviews + 1,
          visitors = papertone_analytics.daily_totals.visitors + excluded.visitors;
  insert into papertone_analytics.country_daily_totals (day, country_code, pageviews, visitors)
    values (v_today, v_country, 1, case when v_new_visitor then 1 else 0 end)
    on conflict (day, country_code) do update
      set pageviews = papertone_analytics.country_daily_totals.pageviews + 1,
          visitors = papertone_analytics.country_daily_totals.visitors + excluded.visitors;
  return true;
end;
$$;

-- CREATE OR REPLACE preserves the existing service-only ACL and owner.
commit;
