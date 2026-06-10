# Udhaar Bot — Shopkeeper WhatsApp Guide (लेजर गाइड)

Namaste! This guide explains how to use **Udhaar Bot** on WhatsApp to manage your shop's ledger (खाता) efficiently.

---

## 1. Onboarding & Shop Registration (पंजीकरण)

Before logging transactions, you must register your shop profile. Send a message in the following format:

**Format:**
```text
register <Your Name> | <Shop Name>
```

**Examples:**
* `register Ramesh Kumar | Kirana Store`
* `register Sunil Gupta, Gupta General Store` *(comma also works as a separator)*

---

## 2. Recording Credit / Udhaar (उधार देना)

When a customer buys items on credit, send a message mentioning their **Name**, **Amount**, and **udhaar** (along with optional items/notes).

**Format:**
```text
<Customer Name> <Amount> udhaar [Optional Note]
```

**Examples:**
* `Ramesh 100 udhaar`
* `Suresh 150 udhaar chai biscuit`
* `Priya 500 udhaar doodh aur rashan`

---

## 3. Recording Payments / Repayments (पैसे वापस मिलना)

When a customer returns money to clear their dues, send a message mentioning their **Name**, **Amount**, and **wapas** (or similar payment keywords).

**Format:**
```text
<Customer Name> <Amount> wapas
```

**Examples:**
* `Ramesh 50 wapas`
* `Suresh ne 200 wapas diya`
* `Priya 100 payment`

---

## 4. Checking Balances / Hisab (बैलेंस देखना)

You can check how much a specific customer owes you, or get a list of all outstanding balances.

### Check Specific Customer Balance:
**Format:**
```text
<Customer Name> ka kitna baaki
```
**Examples:**
* `Ramesh ka kitna baaki`
* `Priya ka kitna due hai`

### Check All Accounts Summary:
To see a summary of all outstanding accounts and the grand total, simply send:
```text
kitna baaki
```
*or*
```text
hisab
```

---

## 5. Adding New Customers (नया कस्टमर जोड़ना)

You can explicitly add a customer to your database with their phone number to keep track of their details.

**Format:**
```text
naya customer <Customer Name> <10-digit Phone Number>
```

**Examples:**
* `naya customer Mohan 9876543210`
* `new customer Raju 9999988888`

---

## Supported Keywords Quick Reference

* **Credit (उधार):** `udhaar`, `udhar`, `le gaya`, `diya`, `credit`, `baaki daalo`
* **Repayment (पेमेंट/वापस):** `wapas`, `vapas`, `paid`, `ne diya`, `chukaya`, `return`, `bheja`, `payment`
* **Balance (हिसाब):** `kitna`, `baaki`, `hisab`, `balance`, `total`, `due`, `bata`
* **New Customer (नया ग्राहक):** `naya`, `new`, `add`, `jodo`, `customer`
