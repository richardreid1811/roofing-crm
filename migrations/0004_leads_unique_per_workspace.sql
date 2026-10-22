-- One lead per property per workspace: unique (workspace_id, prop_id) instead of a global unique prop_id.
-- SQLite cannot drop the column-level unique on prop_id, so leads is rebuilt, keeping every row and id.
-- lead_events references leads with on delete cascade, and dropping a parent table runs an implicit
-- delete that would cascade, so events are copied aside, both tables are rebuilt, and events are restored
-- with their original ids.
-- Apply after deploying the code that inserts with a target-less "on conflict do nothing"; code from
-- before 0003 used "on conflict (prop_id)", which needs the old index.
create table leads_new (
  id text primary key,
  workspace_id text not null default 'demo' references workspaces (id),
  prop_id text not null,
  address text not null,
  latitude real,
  longitude real,
  owner_name text,
  permit_number text,
  stage text not null default 'new' check (stage in ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  assignee text,
  next_action text,
  next_action_date text,
  source text not null,
  source_run_id text not null,
  source_url text,
  signals text not null default '{}',
  created_at text not null,
  updated_at text not null
);
insert into leads_new (id, workspace_id, prop_id, address, latitude, longitude, owner_name, permit_number, stage,
                       priority, assignee, next_action, next_action_date, source, source_run_id, source_url, signals,
                       created_at, updated_at)
select id, workspace_id, prop_id, address, latitude, longitude, owner_name, permit_number, stage, priority, assignee,
       next_action, next_action_date, source, source_run_id, source_url, signals, created_at, updated_at
from leads;

create table lead_events_copy as select id, lead_id, at, kind, detail from lead_events;
drop table lead_events;
drop table leads;
alter table leads_new rename to leads;
create unique index leads_workspace_prop on leads (workspace_id, prop_id);
create index leads_workspace on leads (workspace_id, updated_at);
create index leads_stage on leads (workspace_id, stage, updated_at);

create table lead_events (
  id integer primary key autoincrement,
  lead_id text not null references leads (id) on delete cascade,
  at text not null,
  kind text not null check (kind in ('created', 'stage', 'update', 'note')),
  detail text not null
);
insert into lead_events (id, lead_id, at, kind, detail)
select id, lead_id, at, kind, detail from lead_events_copy where lead_id in (select id from leads) order by id;
drop table lead_events_copy;
create index lead_events_lead on lead_events (lead_id, id);
