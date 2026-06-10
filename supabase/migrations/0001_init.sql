-- =====================================================================
-- Udhaar Bot — initial schema
-- =====================================================================
-- Tables:
--   shopkeepers           one row per registered shopkeeper (WhatsApp sender)
--   customers             cross-shop customer identity
--   shopkeeper_customers  per-shopkeeper relationship + outstanding_balance
--   transactions          credit / repayment events on a relationship
--   nudges                queued repayment reminders
--   repayment_patterns    summary metrics per relationship (1:1)
-- =====================================================================

-- Required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- shopkeepers
-- ---------------------------------------------------------------------
create table if not exists public.shopkeepers (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    phone       text not null,
    shop_name   text,
    created_at  timestamptz not null default now(),
    constraint shopkeepers_phone_format check (phone ~ '^[0-9]{10}$'),
    constraint shopkeepers_phone_unique unique (phone)
);

-- ---------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------
create table if not exists public.customers (
    id           uuid primary key default gen_random_uuid(),
    name         text not null,
    phone        text,
    city         text,
    trust_score  int  not null default 50,
    created_at   timestamptz not null default now(),
    constraint customers_trust_range check (trust_score between 0 and 100),
    constraint customers_phone_format check (phone is null or phone ~ '^[0-9]{10}$')
);

-- A phone, when present, must be unique across customers
create unique index if not exists customers_phone_unique
    on public.customers(phone)
    where phone is not null;

-- ---------------------------------------------------------------------
-- shopkeeper_customers
-- ---------------------------------------------------------------------
create table if not exists public.shopkeeper_customers (
    id                   uuid primary key default gen_random_uuid(),
    shopkeeper_id        uuid not null references public.shopkeepers(id) on delete cascade,
    customer_id          uuid not null references public.customers(id)   on delete cascade,
    outstanding_balance  numeric(12, 2) not null default 0,
    status               text not null default 'active',
    last_activity_at     timestamptz not null default now(),
    created_at           timestamptz not null default now(),
    constraint shopkeeper_customers_status_valid check (status in ('active', 'archived', 'blocked')),
    constraint shopkeeper_customers_pair_unique unique (shopkeeper_id, customer_id)
);

create index if not exists shopkeeper_customers_shopkeeper_idx
    on public.shopkeeper_customers (shopkeeper_id);

-- Powers handleBalance "Case B" (top open accounts per shopkeeper)
create index if not exists shopkeeper_customers_balance_idx
    on public.shopkeeper_customers (shopkeeper_id, outstanding_balance desc)
    where outstanding_balance > 0;

-- ---------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------
create table if not exists public.transactions (
    id                       uuid primary key default gen_random_uuid(),
    shopkeeper_customer_id   uuid not null references public.shopkeeper_customers(id) on delete cascade,
    type                     text not null,
    amount                   numeric(12, 2) not null,
    note                     text,
    transacted_at            timestamptz not null default now(),
    created_at               timestamptz not null default now(),
    constraint transactions_type_valid check (type in ('credit', 'repayment')),
    constraint transactions_amount_positive check (amount > 0)
);

-- analyzeRepaymentPattern walks transactions oldest-first per relationship
create index if not exists transactions_sc_time_idx
    on public.transactions (shopkeeper_customer_id, transacted_at);

-- ---------------------------------------------------------------------
-- nudges
-- ---------------------------------------------------------------------
create table if not exists public.nudges (
    id                       uuid primary key default gen_random_uuid(),
    shopkeeper_customer_id   uuid not null references public.shopkeeper_customers(id) on delete cascade,
    send_at                  timestamptz not null,
    status                   text not null default 'pending',
    message                  text,
    sent_at                  timestamptz,
    created_at               timestamptz not null default now(),
    constraint nudges_status_valid check (status in ('pending', 'sent', 'failed', 'cancelled'))
);

-- Worker pulls pending nudges in send_at order
create index if not exists nudges_pending_sendat_idx
    on public.nudges (status, send_at)
    where status = 'pending';

-- At most one pending nudge per relationship (matches scheduleNudge upsert semantics)
create unique index if not exists nudges_one_pending_per_sc
    on public.nudges (shopkeeper_customer_id)
    where status = 'pending';

-- ---------------------------------------------------------------------
-- repayment_patterns (1:1 with shopkeeper_customers)
-- ---------------------------------------------------------------------
create table if not exists public.repayment_patterns (
    id                       uuid primary key default gen_random_uuid(),
    shopkeeper_customer_id   uuid not null unique references public.shopkeeper_customers(id) on delete cascade,
    credit_count             int  not null default 0,
    repayment_count          int  not null default 0,
    total_credit             numeric(14, 2) not null default 0,
    total_repayment          numeric(14, 2) not null default 0,
    avg_repayment_days       numeric(8, 2),
    on_time_rate             numeric(4, 2),
    last_analyzed_at         timestamptz not null default now(),
    created_at               timestamptz not null default now(),
    constraint rp_on_time_rate_range check (on_time_rate is null or (on_time_rate between 0 and 1)),
    constraint rp_avg_days_nonneg    check (avg_repayment_days is null or avg_repayment_days >= 0)
);

-- =====================================================================
-- Row Level Security
-- =====================================================================
-- The Node backend authenticates using the Supabase service_role key, which
-- bypasses RLS. We still enable RLS on every table so that the anon and
-- authenticated roles cannot read or mutate anything by default — protecting
-- the data even if a non-service key ever leaks.
--
-- If you later add Supabase Auth for shopkeepers, replace the
-- "deny all to anon/authenticated" pattern below with policies that
-- check `auth.uid()` against a `shopkeepers.user_id` column.
-- =====================================================================

alter table public.shopkeepers          enable row level security;
alter table public.customers            enable row level security;
alter table public.shopkeeper_customers enable row level security;
alter table public.transactions         enable row level security;
alter table public.nudges               enable row level security;
alter table public.repayment_patterns   enable row level security;

-- service_role bypasses RLS automatically; no policies needed for it.
-- The intentional absence of any permissive policy below means the anon
-- and authenticated roles have NO read/write access. Add scoped policies
-- here if/when you introduce shopkeeper-side auth.

-- =====================================================================
-- last_activity_at is maintained by the application layer (handleCredit /
-- handleRepayment update it explicitly after inserting a transaction). No
-- trigger is defined here to avoid a redundant double-write per transaction.
-- If you ever insert transactions out-of-band (manual SQL, data migrations),
-- remember to update shopkeeper_customers.last_activity_at yourself.
-- =====================================================================
