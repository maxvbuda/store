-- AutoStore AI — MVP schema
-- Paste this into the Supabase SQL editor (Project > SQL Editor > New query) and run it once.

create extension if not exists "uuid-ossp";

-- Profiles: one row per auth.users, created on signup via trigger below.
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text,
  full_name text,
  stripe_customer_id text,
  subscription_tier text default 'none', -- 'none' | 'starter' | 'growth' | 'scale'
  subscription_status text default 'inactive', -- 'inactive' | 'active' | 'past_due' | 'canceled'
  free_trial_start_date timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Stores
create table if not exists public.stores (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  platform text not null default 'other', -- 'shopify' | 'amazon' | 'etsy' | 'other'
  description text,
  website_url text,
  status text default 'active', -- 'active' | 'inactive'
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_stores_user_id on public.stores(user_id);

-- Products
create table if not exists public.products (
  id uuid default uuid_generate_v4() primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  description text,
  price numeric(10,2) not null default 0,
  currency text default 'USD',
  image_url text,
  category text,
  tags text[] default '{}',
  ai_generated_content jsonb default '{}',
  status text default 'active', -- 'active' | 'inactive'
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_products_store_id on public.products(store_id);

-- Orders
create table if not exists public.orders (
  id uuid default uuid_generate_v4() primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_name text not null,
  customer_email text,
  customer_phone text,
  total_amount numeric(10,2) not null default 0,
  currency text default 'USD',
  shipping_address jsonb,
  shipping_deadline timestamptz,
  status text default 'pending', -- 'pending' | 'processing' | 'shipped' | 'delivered'
  notes text,
  reminder_sent_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_orders_store_id on public.orders(store_id);
create index if not exists idx_orders_shipping_deadline on public.orders(shipping_deadline);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, '', '')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

drop policy if exists "stores_select_own" on public.stores;
create policy "stores_select_own" on public.stores for select using (auth.uid() = user_id);
drop policy if exists "stores_insert_own" on public.stores;
create policy "stores_insert_own" on public.stores for insert with check (auth.uid() = user_id);
drop policy if exists "stores_update_own" on public.stores;
create policy "stores_update_own" on public.stores for update using (auth.uid() = user_id);
drop policy if exists "stores_delete_own" on public.stores;
create policy "stores_delete_own" on public.stores for delete using (auth.uid() = user_id);

drop policy if exists "products_select_own" on public.products;
create policy "products_select_own" on public.products for select using (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);
drop policy if exists "products_insert_own" on public.products;
create policy "products_insert_own" on public.products for insert with check (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);
drop policy if exists "products_update_own" on public.products;
create policy "products_update_own" on public.products for update using (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);
drop policy if exists "products_delete_own" on public.products;
create policy "products_delete_own" on public.products for delete using (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);

drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own" on public.orders for select using (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);
drop policy if exists "orders_insert_own" on public.orders;
create policy "orders_insert_own" on public.orders for insert with check (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);
drop policy if exists "orders_update_own" on public.orders;
create policy "orders_update_own" on public.orders for update using (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);
drop policy if exists "orders_delete_own" on public.orders;
create policy "orders_delete_own" on public.orders for delete using (
  exists (select 1 from public.stores s where s.id = store_id and s.user_id = auth.uid())
);

-- Storage bucket for product images (public read, owner-only write).
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "product_images_public_read" on storage.objects;
create policy "product_images_public_read" on storage.objects for select using (bucket_id = 'product-images');

drop policy if exists "product_images_auth_write" on storage.objects;
create policy "product_images_auth_write" on storage.objects for insert with check (
  bucket_id = 'product-images' and auth.role() = 'authenticated'
);

drop policy if exists "product_images_owner_update" on storage.objects;
create policy "product_images_owner_update" on storage.objects for update using (
  bucket_id = 'product-images' and auth.uid()::text = owner
);

drop policy if exists "product_images_owner_delete" on storage.objects;
create policy "product_images_owner_delete" on storage.objects for delete using (
  bucket_id = 'product-images' and auth.uid()::text = owner
);
