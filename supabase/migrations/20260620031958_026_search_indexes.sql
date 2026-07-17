-- GIN trigram indexes for fast ilike search across text fields
create extension if not exists pg_trgm;

create index if not exists tasks_title_trgm  on tasks  using gin (title  gin_trgm_ops);
create index if not exists people_name_trgm  on people using gin (name   gin_trgm_ops);
create index if not exists signals_title_trgm on signals using gin (title gin_trgm_ops);
create index if not exists notes_title_trgm  on notes  using gin (title  gin_trgm_ops);
