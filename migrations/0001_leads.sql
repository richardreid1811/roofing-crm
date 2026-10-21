-- CRM lead records. One active lead per TCAD property; evidence captured at creation in `signals`.
create table leads (
  id text primary key,
  prop_id text not null unique,
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
create index leads_stage on leads (stage, updated_at);

-- Activity timeline: creation, stage changes, edits and notes.
create table lead_events (
  id integer primary key autoincrement,
  lead_id text not null references leads (id) on delete cascade,
  at text not null,
  kind text not null check (kind in ('created', 'stage', 'update', 'note')),
  detail text not null
);
create index lead_events_lead on lead_events (lead_id, id);
