-- BBB ratings recorded by sales reps from bbb.org (BBB has no public API; the app never contacts BBB).
-- History is kept; the latest entry per contractor is the current rating.
create table bbb_ratings (
  id integer primary key autoincrement,
  contractor_key text not null,
  contractor_name text not null,
  rating text not null check (rating in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'NR', 'not_found')),
  accredited integer check (accredited in (0, 1)),
  profile_url text,
  recorded_by text,
  note text,
  recorded_at text not null
);
create index bbb_ratings_key on bbb_ratings (contractor_key, id);
