-- Alter transactions to support dispute flag
ALTER TABLE public.transactions 
ADD COLUMN IF NOT EXISTS is_disputed boolean not null default false;

-- Alter shopkeeper_customers to support access token
ALTER TABLE public.shopkeeper_customers 
ADD COLUMN IF NOT EXISTS access_token text unique default gen_random_uuid()::text;

-- Backfill access tokens for any existing records
UPDATE public.shopkeeper_customers 
SET access_token = gen_random_uuid()::text 
WHERE access_token IS NULL;
