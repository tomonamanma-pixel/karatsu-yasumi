-- 唐津店 休み希望。合言葉はアプリの関数の中だけで照合する。
create table if not exists public.app_store (
  id int primary key default 1 check (id = 1),
  data jsonb not null
);

alter table public.app_store enable row level security;

revoke all on table public.app_store from public, anon, authenticated;

create or replace function public.app_api(action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  store jsonb;
  staff jsonb;
  requests jsonb;
  submissions jsonb;
  settings jsonb;
  next_json jsonb;
  write_ok boolean := true;
  err text := null;
  name text;
  dt text;
  comment text;
  month text;
  expected text;
  given text;
  sid text;
  person jsonb;
  day date;
  deadline date;
  i int;
  idx int;
  dir int;
  n int;
  notice text;
  has_row boolean;
begin
  if payload is null then
    payload := '{}'::jsonb;
  end if;

  select data into store from public.app_store where id = 1 for update;
  if store is null then
    return jsonb_build_object('error', '保存できませんでした。もう一度押してください。');
  end if;

  staff := coalesce(store->'staff', '[]'::jsonb);
  requests := coalesce(store->'requests', '[]'::jsonb);
  submissions := coalesce(store->'submissions', '[]'::jsonb);
  settings := coalesce(store->'settings', '{}'::jsonb);

  expected := coalesce(settings->>'code', '');
  given := coalesce(payload->>'code', '');
  if action in ('unlock', 'staff', 'staff/update', 'staff/remove', 'staff/move', 'settings') then
    if expected <> '' and given <> expected then
      return jsonb_build_object('error', '合言葉が違います。');
    end if;
  end if;

  if action = 'state' or action = 'info' or action = 'unlock' then
    write_ok := false;

  elsif action = 'staff' then
    name := left(btrim(regexp_replace(coalesce(payload->>'name', ''), '[\x00-\x1F]', '', 'g')), 16);
    if name = '' then
      err := '名前を入れてください。';
    elsif exists (select 1 from jsonb_array_elements(staff) s where s->>'name' = name) then
      err := '同じ名前がいます。区別できるように入れてください。';
    elsif jsonb_array_length(staff) >= 40 then
      err := '名前は40人までです。';
    else
      staff := staff || jsonb_build_array(jsonb_build_object(
        'id', substr(md5(random()::text || clock_timestamp()::text), 1, 12),
        'name', name
      ));
    end if;

  elsif action in ('staff/update', 'staff/remove', 'staff/move') then
    sid := payload->>'id';
    idx := null;
    for i in 0 .. jsonb_array_length(staff) - 1 loop
      if staff->i->>'id' = sid then
        idx := i;
        exit;
      end if;
    end loop;
    if idx is null then
      err := 'その名前は見当たりません。';
    elsif action = 'staff/update' then
      name := left(btrim(regexp_replace(coalesce(payload->>'name', ''), '[\x00-\x1F]', '', 'g')), 16);
      if name = '' then
        err := '名前を入れてください。';
      elsif exists (
        select 1 from jsonb_array_elements(staff) with ordinality s
        where s.value->>'name' = name and (s.ordinality - 1) <> idx
      ) then
        err := '同じ名前がいます。区別できるように入れてください。';
      else
        staff := jsonb_set(staff, array[idx::text, 'name'], to_jsonb(name));
      end if;
    elsif action = 'staff/remove' then
      select coalesce(jsonb_agg(s.value order by s.ordinality), '[]'::jsonb) into next_json
      from jsonb_array_elements(staff) with ordinality s
      where (s.ordinality - 1) <> idx;
      staff := next_json;
      select coalesce(jsonb_agg(r), '[]'::jsonb) into next_json
      from jsonb_array_elements(requests) r
      where r->>'staffId' is distinct from sid;
      requests := next_json;
      select coalesce(jsonb_agg(s), '[]'::jsonb) into next_json
      from jsonb_array_elements(submissions) s
      where s->>'staffId' is distinct from sid;
      submissions := next_json;
    else
      dir := case when coalesce((payload->>'dir')::numeric, 1) < 0 then -1 else 1 end;
      if idx + dir >= 0 and idx + dir < jsonb_array_length(staff) then
        person := staff->idx;
        staff := jsonb_set(staff, array[idx::text], staff->(idx + dir));
        staff := jsonb_set(staff, array[(idx + dir)::text], person);
      end if;
    end if;

  elsif action = 'entry' or action = 'request' then
    if action = 'entry' then
      name := left(btrim(regexp_replace(coalesce(payload->>'name', ''), '[\x00-\x1F]', '', 'g')), 16);
      if name = '' then
        err := '名前を入れてください。';
      end if;
    end if;
    dt := coalesce(payload->>'date', '');
    if err is null and dt !~ '^\d{4}-\d{2}-\d{2}$' then
      err := '日付が正しくありません。';
    end if;
    if err is null then
      begin
        day := dt::date;
        if to_char(day, 'YYYY-MM-DD') <> dt then
          err := '日付が正しくありません。';
        end if;
      exception when others then
        err := '日付が正しくありません。';
      end;
    end if;
    if err is null then
      deadline := day + (6 - extract(dow from day)::int) - 21;
      if deadline < (now() at time zone 'Asia/Tokyo')::date then
        err := 'この週は締め切りを過ぎているので、入れられません。';
      end if;
    end if;

    if err is null and action = 'request' then
      sid := payload->>'staffId';
      if not exists (select 1 from jsonb_array_elements(staff) s where s->>'id' = sid) then
        err := '名前を選び直してください。';
      end if;
    end if;

    if err is null and action = 'entry' then
      sid := null;
      for i in 0 .. jsonb_array_length(staff) - 1 loop
        if staff->i->>'name' = name then
          sid := staff->i->>'id';
          exit;
        end if;
      end loop;
      if sid is null then
        if coalesce(payload->>'on', 'true') = 'false' then
          err := 'その名前の希望はありません。';
        elsif jsonb_array_length(staff) >= 40 then
          err := '名前は40人までです。';
        else
          sid := substr(md5(random()::text || clock_timestamp()::text), 1, 12);
          staff := staff || jsonb_build_array(jsonb_build_object('id', sid, 'name', name));
        end if;
      end if;
    end if;

    if err is null then
      comment := left(btrim(regexp_replace(coalesce(payload->>'comment', ''), '[\x00-\x1F]', '', 'g')), 80);
      select coalesce(jsonb_agg(r), '[]'::jsonb) into next_json
      from jsonb_array_elements(requests) r
      where not (r->>'staffId' = sid and r->>'date' = dt);
      requests := next_json;
      if coalesce(payload->>'on', 'true') <> 'false' then
        if action = 'entry' then
          requests := requests || jsonb_build_array(jsonb_build_object(
            'staffId', sid, 'date', dt, 'comment', comment
          ));
        else
          requests := requests || jsonb_build_array(jsonb_build_object(
            'staffId', sid, 'date', dt
          ));
        end if;
        month := left(dt, 7);
        has_row := exists (
          select 1 from jsonb_array_elements(submissions) s
          where s->>'staffId' = sid and s->>'month' = month
        );
        if not has_row then
          submissions := submissions || jsonb_build_array(jsonb_build_object('staffId', sid, 'month', month));
        end if;
      end if;
      select coalesce(jsonb_agg(r order by r->>'date', r->>'staffId'), '[]'::jsonb) into next_json
      from jsonb_array_elements(requests) r;
      requests := next_json;
    end if;

  elsif action = 'none' then
    sid := payload->>'staffId';
    month := coalesce(payload->>'month', '');
    if not exists (select 1 from jsonb_array_elements(staff) s where s->>'id' = sid) then
      err := '名前を選び直してください。';
    elsif month !~ '^\d{4}-\d{2}$' then
      err := '月が正しくありません。';
    elsif coalesce(payload->>'on', 'false') = 'true'
      and exists (
        select 1 from jsonb_array_elements(requests) r
        where r->>'staffId' = sid and r->>'date' like month || '%'
      ) then
      err := '希望の日が残っています。先に取り消してください。';
    else
      select coalesce(jsonb_agg(s), '[]'::jsonb) into next_json
      from jsonb_array_elements(submissions) s
      where not (s->>'staffId' = sid and s->>'month' = month);
      submissions := next_json;
      if coalesce(payload->>'on', 'false') = 'true' then
        submissions := submissions || jsonb_build_array(jsonb_build_object('staffId', sid, 'month', month));
      end if;
    end if;

  elsif action = 'settings' then
    if payload ? 'warnAt' and (payload->>'warnAt') ~ '^-?\d+(\.\d+)?$' then
      n := least(6, greatest(1, round((payload->>'warnAt')::numeric)::int));
      settings := jsonb_set(settings, '{warnAt}', to_jsonb(n), true);
    end if;
    if payload ? 'notice' and jsonb_typeof(payload->'notice') = 'string' then
      notice := left(btrim(regexp_replace(payload->>'notice', '[\x00-\x08]', '', 'g')), 120);
      settings := jsonb_set(settings, '{notice}', to_jsonb(notice), true);
    end if;
    if payload->'clearCode' = 'true'::jsonb then
      settings := jsonb_set(settings, '{code}', to_jsonb(''::text), true);
    end if;
    if payload ? 'newCode' and btrim(coalesce(payload->>'newCode', '')) <> '' then
      settings := jsonb_set(settings, '{code}', to_jsonb(left(btrim(payload->>'newCode'), 20)), true);
    end if;

  else
    err := '見つかりません。';
  end if;

  if err is not null then
    return jsonb_build_object('error', err);
  end if;

  if write_ok then
    store := jsonb_build_object(
      'staff', staff,
      'requests', requests,
      'submissions', submissions,
      'settings', settings,
      'savedAt', to_jsonb(now())
    );
    update public.app_store set data = store where id = 1;
  end if;

  if action = 'info' then
    return jsonb_build_object('urls', '[]'::jsonb, 'local', '');
  end if;
  if action = 'unlock' then
    return jsonb_build_object('ok', true);
  end if;

  return jsonb_build_object(
    'staff', staff,
    'requests', requests,
    'submissions', submissions,
    'settings', jsonb_build_object(
      'warnAt', coalesce((settings->>'warnAt')::int, 2),
      'notice', coalesce(settings->>'notice', ''),
      'codeSet', coalesce(settings->>'code', '') <> ''
    ),
    'savedAt', coalesce(store->>'savedAt', now()::text)
  );
end;
$fn$;

revoke all on function public.app_api(text, jsonb) from public;
grant execute on function public.app_api(text, jsonb) to anon, authenticated;
