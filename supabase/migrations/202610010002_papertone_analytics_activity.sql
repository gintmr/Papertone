-- Add minimized, paginated visit history without changing aggregate counts.
-- Apply after 202609110001, before deploying the updated Edge Function.
begin;

-- Serialize the historical snapshot against the existing collector's writes.
lock table papertone_analytics.recent_events in share row exclusive mode;

create table papertone_analytics.visit_records (
  id bigint generated always as identity primary key,
  event_id uuid not null,
  visited_at timestamptz not null default now(),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  path text check (path is null or path in ('/Papertone/'))
);
alter table papertone_analytics.visit_records enable row level security;
revoke all on papertone_analytics.visit_records from public, anon, authenticated;
revoke all on sequence papertone_analytics.visit_records_id_seq from public, anon, authenticated;

-- The old retry table has timestamps, but no country or path. Preserve only
-- facts that were actually recorded; older expired events cannot be recovered.
insert into papertone_analytics.visit_records (event_id, visited_at)
  select event_id, received_at from papertone_analytics.recent_events
  order by received_at, event_id;

create function public.papertone_analytics_track_v2(
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

-- Keep old deployed collectors working during the migration-first rollout.
-- They lack a page-path argument, so that field remains explicitly unknown.
create or replace function public.papertone_analytics_track(
  p_event_id uuid, p_visitor_hash text, p_day date, p_country_code text
)
returns boolean
language sql security definer set search_path = ''
as $$
  select public.papertone_analytics_track_v2(p_event_id, p_visitor_hash, p_day, p_country_code, null);
$$;

create function public.papertone_analytics_activity(p_before text default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_before bigint;
  v_result jsonb;
begin
  if p_before is not null then
    if p_before !~ '^[1-9][0-9]{0,18}$'
       or length(p_before) = 19 and p_before collate "C" > '9223372036854775807' collate "C" then
      raise exception 'Invalid activity cursor';
    end if;
    v_before := p_before::bigint;
  end if;

  -- One look-ahead row makes end-of-list explicit without an unbounded count.
  -- Cursor values remain decimal strings: bigint can exceed JS safe integers.
  with candidates as materialized (
    select id, visited_at, country_code, path
    from papertone_analytics.visit_records
    where v_before is null or id < v_before
    order by id desc limit 26
  ), page as (
    select * from candidates order by id desc limit 25
  )
  select jsonb_build_object(
    'version', 1,
    'records', coalesce((select jsonb_agg(jsonb_build_object(
      'visitedAt', visited_at, 'countryCode', country_code, 'path', path
    ) order by id desc) from page), '[]'::jsonb),
    'nextCursor', case when (select count(*) from candidates) > 25
      then (select min(id)::text from page) else null end
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.papertone_analytics_track_v2(uuid, text, date, text, text) from public, anon, authenticated;
revoke all on function public.papertone_analytics_activity(text) from public, anon, authenticated;
revoke all on function public.papertone_analytics_track(uuid, text, date, text) from public, anon, authenticated;
grant execute on function public.papertone_analytics_track_v2(uuid, text, date, text, text) to service_role;
grant execute on function public.papertone_analytics_activity(text) to service_role;
grant execute on function public.papertone_analytics_track(uuid, text, date, text) to service_role;

commit;
