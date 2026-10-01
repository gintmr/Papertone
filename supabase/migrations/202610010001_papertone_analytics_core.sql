-- Papertone 自己的访客统计，独立 schema，
-- 与 gintmr.github.io 学术主页的 visitor_analytics 互不影响。 Run once, as the database owner.
-- Deliberately no IF NOT EXISTS / CREATE OR REPLACE: a name collision must fail
-- and roll back rather than changing an existing application's objects.
begin;

create schema papertone_analytics;
revoke all on schema papertone_analytics from public, anon, authenticated;

create table papertone_analytics.daily_totals (
  day date primary key,
  pageviews bigint not null default 0 check (pageviews >= 0),
  visitors bigint not null default 0 check (visitors >= 0)
);
create table papertone_analytics.country_daily_totals (
  day date not null,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  pageviews bigint not null default 0 check (pageviews >= 0),
  visitors bigint not null default 0 check (visitors >= 0),
  primary key (day, country_code)
);
create table papertone_analytics.daily_visitors (
  day date not null,
  visitor_hash text not null check (visitor_hash ~ '^[a-f0-9]{64}$'),
  primary key (day, visitor_hash)
);
create table papertone_analytics.recent_events (
  event_id uuid primary key,
  received_at timestamptz not null default now()
);
create index recent_events_received_at on papertone_analytics.recent_events (received_at);
create table papertone_analytics.rate_limits (
  bucket_start timestamptz not null,
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  kind text not null check (kind in ('track', 'summary')),
  requests integer not null check (requests > 0),
  primary key (bucket_start, ip_hash, kind)
);
create table papertone_analytics.maintenance (
  singleton boolean primary key default true check (singleton),
  last_cleanup timestamptz not null default '-infinity'
);
insert into papertone_analytics.maintenance (singleton) values (true);

alter table papertone_analytics.daily_totals enable row level security;
alter table papertone_analytics.country_daily_totals enable row level security;
alter table papertone_analytics.daily_visitors enable row level security;
alter table papertone_analytics.recent_events enable row level security;
alter table papertone_analytics.rate_limits enable row level security;
alter table papertone_analytics.maintenance enable row level security;
revoke all on all tables in schema papertone_analytics from public, anon, authenticated;

-- Only the Edge Function's service role can invoke these namespaced wrappers.
-- The underlying schema must NOT be added to PostgREST exposed schemas.
create function public.papertone_analytics_rate_limit(p_ip_hash text, p_kind text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
  v_limit integer;
  v_cleanup boolean;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
     or p_kind is null or p_kind not in ('track', 'summary') then
    raise exception 'Invalid rate limit input';
  end if;
  v_limit := case when p_kind = 'track' then 20 else 120 end;
  insert into papertone_analytics.rate_limits (bucket_start, ip_hash, kind, requests)
    values (date_trunc('minute', now()), p_ip_hash, p_kind, 1)
  on conflict (bucket_start, ip_hash, kind) do update
    set requests = least(papertone_analytics.rate_limits.requests + 1, v_limit + 1)
  returning requests into v_count;

  -- One caller per hour performs housekeeping. Long-term aggregate tables stay.
  update papertone_analytics.maintenance set last_cleanup = now()
    where singleton and last_cleanup < now() - interval '1 hour'
    returning true into v_cleanup;
  if coalesce(v_cleanup, false) then
    delete from papertone_analytics.rate_limits where bucket_start < now() - interval '2 hours';
    delete from papertone_analytics.recent_events where received_at < now() - interval '7 days';
    delete from papertone_analytics.daily_visitors
      where day < (now() at time zone 'UTC')::date - 1;
  end if;
  return v_count <= v_limit;
end;
$$;

create function public.papertone_analytics_track(
  p_event_id uuid, p_visitor_hash text, p_day date, p_country_code text
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
     or p_day is distinct from v_today or v_country !~ '^[A-Z]{2}$' then
    raise exception 'Invalid analytics event';
  end if;
  insert into papertone_analytics.recent_events (event_id) values (p_event_id)
    on conflict do nothing returning true into v_new_event;
  if not coalesce(v_new_event, false) then return false; end if;

  -- This primary key deduplicates across ALL allowed pages, including races.
  insert into papertone_analytics.daily_visitors (day, visitor_hash)
    values (v_today, p_visitor_hash)
    on conflict do nothing returning true into v_new_visitor;
  v_new_visitor := coalesce(v_new_visitor, false);
  insert into papertone_analytics.daily_totals (day, pageviews, visitors)
    values (v_today, 1, case when v_new_visitor then 1 else 0 end)
    on conflict (day) do update
      set pageviews = papertone_analytics.daily_totals.pageviews + 1,
          visitors = papertone_analytics.daily_totals.visitors + excluded.visitors;
  -- A visitor's first event assigns their country for that UTC day. Pageviews
  -- follow each event's lookup. An unavailable lookup remains explicitly unknown.
  insert into papertone_analytics.country_daily_totals (day, country_code, pageviews, visitors)
    values (v_today, v_country, 1, case when v_new_visitor then 1 else 0 end)
    on conflict (day, country_code) do update
      set pageviews = papertone_analytics.country_daily_totals.pageviews + 1,
          visitors = papertone_analytics.country_daily_totals.visitors + excluded.visitors;
  return true;
end;
$$;

create function public.papertone_analytics_summary()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'generatedAt', now(),
    'since', (select min(day) from papertone_analytics.daily_totals),
    'totals', (select jsonb_build_object(
      'pageviews', coalesce(sum(pageviews), 0),
      'visitorDays', coalesce(sum(visitors), 0)
    ) from papertone_analytics.daily_totals),
    'today', (select jsonb_build_object(
      'date', (now() at time zone 'UTC')::date,
      'pageviews', coalesce(sum(pageviews), 0),
      'visitors', coalesce(sum(visitors), 0)
    ) from papertone_analytics.daily_totals where day = (now() at time zone 'UTC')::date),
    'countries', coalesce((select jsonb_agg(jsonb_build_object(
      'code', nullif(country_code, 'ZZ'), 'pageviews', pageviews, 'visitorDays', visitors
    ) order by visitors desc, pageviews desc, country_code)
    from (select country_code, sum(pageviews) as pageviews, sum(visitors) as visitors
      from papertone_analytics.country_daily_totals group by country_code) as countries), '[]'::jsonb)
  );
$$;

revoke all on function public.papertone_analytics_rate_limit(text, text) from public, anon, authenticated;
revoke all on function public.papertone_analytics_track(uuid, text, date, text) from public, anon, authenticated;
revoke all on function public.papertone_analytics_summary() from public, anon, authenticated;
grant execute on function public.papertone_analytics_rate_limit(text, text) to service_role;
grant execute on function public.papertone_analytics_track(uuid, text, date, text) to service_role;
grant execute on function public.papertone_analytics_summary() to service_role;

commit;
