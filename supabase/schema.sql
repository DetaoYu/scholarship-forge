create table if not exists public.student_generations (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  document_type text not null,
  title text not null,
  input_summary text not null,
  generated_content text not null,
  created_at timestamptz not null default now()
);

create index if not exists student_generations_visitor_created_idx
on public.student_generations (visitor_id, created_at desc);

alter table public.student_generations enable row level security;

create policy "service role can manage generations"
on public.student_generations
for all
using (true)
with check (true);
