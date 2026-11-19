alter table public.items
  add column brand text not null default '' check (length(brand) <= 100),
  add column model text not null default '' check (length(model) <= 100);
alter table public.items alter column sale_price drop not null;
