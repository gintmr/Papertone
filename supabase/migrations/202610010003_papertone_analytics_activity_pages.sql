-- Add numbered activity pages. No visit rows, counters or old RPCs are changed.
-- Apply after 202609110002, before deploying the updated Edge Function.
begin;

create function public.papertone_analytics_activity_page(
  p_page integer, p_snapshot text default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_snapshot bigint;
  v_latest bigint;
  v_total bigint;
  v_pages bigint;
  v_page integer;
  v_records jsonb;
begin
  if p_page is null or p_page < 1 or p_page > 1000000 then
    raise exception 'Invalid activity page';
  end if;
  if p_snapshot is not null then
    if p_snapshot !~ '^[1-9][0-9]{0,18}$'
       or length(p_snapshot) = 19 and p_snapshot collate "C" > '9223372036854775807' collate "C" then
      raise exception 'Invalid activity snapshot';
    end if;
    v_snapshot := p_snapshot::bigint;
  end if;

  select max(id) into v_latest from papertone_analytics.visit_records;
  -- A fresh request captures the current maximum ID. Also bound a caller's
  -- future-looking value, so reusing the returned snapshot excludes new rows.
  v_snapshot := least(coalesce(v_snapshot, v_latest), v_latest);
  select count(*) into v_total from papertone_analytics.visit_records
    where id <= v_snapshot;
  if v_total = 0 then
    return jsonb_build_object(
      'version', 2, 'records', '[]'::jsonb, 'page', 1, 'pageSize', 20,
      'totalRecords', 0, 'totalPages', 0, 'snapshot', null
    );
  end if;

  v_pages := (v_total + 19) / 20;
  v_page := least(p_page::bigint, v_pages)::integer;
  select coalesce(jsonb_agg(jsonb_build_object(
    'visitedAt', visited_at, 'countryCode', country_code, 'path', path
  ) order by id desc), '[]'::jsonb) into v_records
  from (
    select id, visited_at, country_code, path
    from papertone_analytics.visit_records where id <= v_snapshot
    order by id desc limit 20 offset ((v_page::bigint - 1) * 20)
  ) as records;

  return jsonb_build_object(
    'version', 2, 'records', v_records, 'page', v_page, 'pageSize', 20,
    'totalRecords', v_total, 'totalPages', v_pages, 'snapshot', v_snapshot::text
  );
end;
$$;

revoke all on function public.papertone_analytics_activity_page(integer, text) from public, anon, authenticated;
grant execute on function public.papertone_analytics_activity_page(integer, text) to service_role;

commit;
