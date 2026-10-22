-- Private workspaces (capability links) and the durable write-rate limiter.
-- Additive and backward-compatible with the code deployed before it: existing leads, and inserts that do
-- not name a workspace, belong to the public 'demo' workspace. The per-workspace unique index follows in 0004.
create table workspaces (
  id text primary key,
  name text not null,
  created_at text not null,
  -- SHA-256 (hex) of the secret key, which is shown once and never stored. Null for the public demo.
  key_hash text unique
);
insert into workspaces (id, name, created_at, key_hash)
values ('demo', 'Demo workspace (public)', '2026-10-22T00:00:00.000Z', null);

alter table leads add column workspace_id text not null default 'demo';
create index leads_workspace on leads (workspace_id, updated_at);

-- Fixed-window counters for write routes: one row per client key and window (epoch seconds).
create table rate_limits (
  key text not null,
  window_start integer not null,
  count integer not null,
  primary key (key, window_start)
) without rowid;
create index rate_limits_window on rate_limits (window_start);
