# Udhaar Ledger Bot (उधार लेजर बॉट)

A WhatsApp-first micro-credit ledger application for Indian shopkeepers to manage customer credit (`udhaar`) and repayments (`wapas`) seamlessly on WhatsApp.

---

## 📱 Shopkeeper WhatsApp Guide (लेजर गाइड)

Namaste! This section explains how to use **Udhaar Bot** on WhatsApp to manage your shop's ledger (खाता) efficiently.

### 1. Onboarding & Shop Registration (पंजीकरण)
Before logging transactions, you must register your shop profile. Send a message in the following format:
* **Format:** `register <Your Name> | <Shop Name>`
* **Examples:**
  * `register Ramesh Kumar | Kirana Store`
  * `register Sunil Gupta, Gupta General Store` *(comma also works as a separator)*

### 2. Recording Credit / Udhaar (उधार देना)
When a customer buys items on credit, send a message mentioning their **Name**, **Amount**, and **udhaar** (along with optional items/notes).
* **Format:** `<Customer Name> <Amount> udhaar [Optional Note]`
* **Examples:**
  * `Ramesh 100 udhaar`
  * `Suresh 150 udhaar chai biscuit` (aliases: `cr`, `udhar`, `credit`, `le gaya`, `diya`, `de diya` also work!)

### 3. Recording Payments / Repayments (पैसे वापस मिलना)
When a customer returns money to clear their dues, send a message mentioning their **Name**, **Amount**, and **wapas**.
* **Format:** `<Customer Name> <Amount> wapas`
* **Examples:**
  * `Ramesh 50 wapas`
  * `Suresh ne 200 wapas diya` (aliases: `dr`, `pay`, `payment`, `paid`, `rec`, `received`, `vapas` also work!)

### 4. Checking Balances / Hisab (बैलेंस देखना)
You can check how much a specific customer owes you, or get a list of all outstanding balances.
* **Specific Customer:** `<Customer Name> ka kitna baaki` (e.g. `Ramesh ka kitna baaki` or `Ramesh bal`)
* **All Accounts Summary:** `kitna baaki` or `hisab` (lists top 10 open accounts sorted by outstanding balance and shows the total grand sum).

### 5. Adding New Customers (नया कस्टमर जोड़ना)
You can explicitly add a customer to your database with their phone number to keep track of their details.
* **Format:** `naya customer <Customer Name> <10-digit Phone Number>`
* **Example:** `naya customer Mohan 9876543210`

---

## 👥 Customer WhatsApp Guide (ग्राहक गाइड)

If your phone number is registered by a shopkeeper, you can interact with the bot directly on WhatsApp:
* **Auto-Notifications:** Every time a shopkeeper logs a credit for you, you will receive an automatic WhatsApp notification with the credit amount, your current total balance, and a read-only PWA ledger link.
* **Check Balance (`HISAB`):** Send `HISAB` to see a summary of all active shop balances and their respective ledger links.
* **Raise a Dispute (`GALAT <Amount>`):** If you notice a wrong entry, send `GALAT <Amount>` (e.g. `GALAT 150`). This will:
  1. Flag the last matching credit transaction as disputed in the database.
  2. Send an alert warning to the shopkeeper's phone.

---

## 🛠️ Developer Setup & Technical Documentation

This backend is built on Node.js + Express and integrates with Supabase for the database, OpenRouter (Llama 3 8B) for natural language parsing, and Twilio for incoming WhatsApp webhook messages.

### Technical Stack
* **Runtime:** Node.js (ES Modules)
* **Web Framework:** Express.js
* **Database:** Supabase (PostgreSQL)
* **NLU / Parsing:** OpenRouter API (`meta-llama/llama-3-8b-instruct:free`) with local regex fallback.
* **SMS Gateway:** Twilio WhatsApp Sandbox

### Core Design Implementations

#### 1. Regex-First Latency Optimization
To achieve extremely low response latencies, incoming messages are first evaluated locally by a regex-based parser in [routes/webhook.js](routes/webhook.js).
* If a standard command (like `<Name> <Amount> udhaar`) matches, it bypasses the LLM call entirely, responding in **<1ms**.
* If the message is unstructured, conversational, or fails local parsing, it falls back to the OpenRouter LLM API to identify the intent and parameters.

#### 2. Advance & Overpayment Support (Negative Balances)
Outstanding balances in the `shopkeeper_customers` table can be negative (representing an advance deposit or overpayment by a customer). 
* When a customer pays back more than their debt, their balance becomes negative (e.g. `-100`).
* Future credit logs add to this value directly, adjusting it back to zero or positive.
* The system displays negative balances to the shopkeeper as `jama (advance)` instead of raw negative numbers.

### Getting Started (Local Development)

#### Step 1: Environment Variables
Create a `.env` file in the root directory based on the `.env.example` file:
```env
PORT=3000
SUPABASE_URL=https://<your-project-id>.supabase.co
SUPABASE_KEY=<your-service-role-key>
OPENROUTER_API_KEY=<your-openrouter-key>
SKIP_TWILIO_VALIDATION=true
PUBLIC_APP_URL=http://localhost:3000
```
*(Setting `SKIP_TWILIO_VALIDATION=true` enables local webhook testing via curl/ngrok without signature mismatches)*.

#### Step 2: Database Schema & Migration
Apply the migrations schemas located in [supabase/migrations/](supabase/migrations/).

1. Run the initial schema migration `0001_init.sql`.
2. Run the second migration `0002_add_disputes_and_tokens.sql` to support disputes and access tokens:
```sql
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS is_disputed boolean not null default false;
ALTER TABLE public.shopkeeper_customers ADD COLUMN IF NOT EXISTS access_token text unique default gen_random_uuid()::text;
UPDATE public.shopkeeper_customers SET access_token = gen_random_uuid()::text WHERE access_token IS NULL;
```
Ensure the check constraint limiting outstanding balances to non-negative numbers is dropped:
```sql
ALTER TABLE public.shopkeeper_customers DROP CONSTRAINT IF EXISTS shopkeeper_customers_balance_nonneg;
```

#### Step 3: Run the Server
```bash
npm install
npm run dev
```

#### Step 4: Setup Webhook Tunneling (ngrok)
Expose port 3000 to the web:
```bash
ngrok http 3000
```
Update your Twilio Sandbox settings with the resulting ngrok HTTPS URL:
`https://<your-ngrok-subdomain>.ngrok-free.dev/webhook/whatsapp`

---

### Database Schema Overview
* **`shopkeepers`**: Shopkeeper metadata, keyed by their registered WhatsApp phone number.
* **`customers`**: Global customer records containing names, city, and calculated credit trust scores.
* **`shopkeeper_customers`**: Join table mapping shopkeepers to their customers, storing the `outstanding_balance`.
* **`transactions`**: Granular transaction ledger containing every credit and repayment event.
* **`nudges`**: Payment reminder triggers scheduled automatically based on transaction habits.
* **`repayment_patterns`**: Summarized pattern statistics used for trust scoring.
