import express from 'express'
import twilio from 'twilio'
import { supabase } from '../lib/supabase.js'
import { openrouter } from '../lib/openrouter.js'
import { analyzeRepaymentPattern } from '../services/analyzePattern.js'
import { scheduleNudge } from '../services/scheduleNudge.js'

const router = express.Router()

/**
 * Verify the X-Twilio-Signature header so only Twilio can hit our webhook.
 * Skipped only when SKIP_TWILIO_VALIDATION=true (intended for local dev / mock runs).
 */
function validateTwilioSignature(req, res, next) {
  if (process.env.SKIP_TWILIO_VALIDATION === 'true') {
    return next()
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    console.error('[TwilioAuth] TWILIO_AUTH_TOKEN is not configured — rejecting webhook request.')
    return res.status(500).type('text/xml').send(twiml('Server misconfigured.'))
  }

  const signature = req.get('X-Twilio-Signature') || ''
  // Reconstruct the public URL Twilio used. Honor X-Forwarded-* if behind a proxy (trust proxy is set in server.js).
  const protocol = req.protocol
  const host = req.get('host')
  const url = `${protocol}://${host}${req.originalUrl}`

  const isValid = twilio.validateRequest(authToken, signature, url, req.body || {})
  if (!isValid) {
    console.warn('[TwilioAuth] Invalid signature for request to', url)
    return res.status(403).type('text/xml').send(twiml('Forbidden.'))
  }
  next()
}

// Sanitize a free-text name so it cannot inject PostgREST filter operators or wildcards.
// Keeps unicode letters, spaces, hyphens, apostrophes; strips ',', '.', '*', '%', '(', ')', and control chars.
function sanitizeName(name) {
  if (typeof name !== 'string') return null
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F]/g, '') // control chars
    .replace(/[,.*%()\\\/:"`<>{}\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0 || cleaned.length > 60) return null
  return cleaned
}

// Validate a positive integer rupee amount (cap at 10,000,000 to prevent overflow / abuse).
function sanitizeAmount(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 10_000_000) return null
  return n
}

// Sanitize an optional free-text note.
function sanitizeNote(note) {
  if (typeof note !== 'string') return null
  const cleaned = note.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200)
  return cleaned.length > 0 ? cleaned : null
}

// Validate Indian 10-digit mobile numbers.
function sanitizePhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null
  const digits = String(phone).replace(/\D/g, '')
  if (!/^\d{10}$/.test(digits)) return null
  return digits
}

// Extract digits from a Twilio From value like "whatsapp:+919876543210". Returns the last 10 digits or null.
function extractPhoneFromTwilioFrom(fromVal) {
  if (typeof fromVal !== 'string') return null
  const digits = fromVal.replace(/\D/g, '')
  if (digits.length < 10) return null
  return digits.slice(-10)
}

// Sanitize a shopkeeper's full name. More permissive than customer sanitizeName
// (allows '.' for initials, longer length cap) but still strips PostgREST operators
// and control chars.
function sanitizeShopkeeperName(name) {
  if (typeof name !== 'string') return null
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[,*%()\\\/:"`<>{}\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0 || cleaned.length > 80) return null
  return cleaned
}

// Sanitize a shop name. Allows ampersand and digits (e.g. "R&R Kirana 24x7").
function sanitizeShopName(shop) {
  if (typeof shop !== 'string') return null
  const cleaned = shop
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[*%()\\\/:"`<>{}\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0 || cleaned.length > 100) return null
  return cleaned
}

// Detect a self-registration command. Accepts:
//   register <name> | <shop>
//   register <name>, <shop>
//   REGISTER  Ramesh Kumar  |  Kirana Store
// Returns { name, shopName } if matched, else null. Both fields are sanitized.
function parseRegistrationCommand(text) {
  if (typeof text !== 'string') return null
  // Anchored case-insensitive match. Separator is `|` or `,`. Everything before
  // the separator is the person's name; everything after is the shop name.
  const m = text.trim().match(/^register\s+([^|,]+)[|,]\s*(.+)$/i)
  if (!m) return null
  const name = sanitizeShopkeeperName(m[1])
  const shopName = sanitizeShopName(m[2])
  if (!name || !shopName) return null
  return { name, shopName }
}

// Detect a "list" / "help" / "commands" request so we don't waste an LLM call.
// Matches common Hindi/English synonyms: list, help, commands, features, kya kare, kya hai, etc.
function isListCommand(text) {
  if (typeof text !== 'string') return false
  const lower = text.trim().toLowerCase()
  const triggers = [
    'list', 'help', 'commands', 'features', 'menu', 'kya kare', 'kya hai', 'sab kuch',
    'kaam kya', 'kya batao', 'sab commands', 'batao', 'madad', 'kya kar sakta', 'cheatsheet'
  ]
  return triggers.some(t => lower.includes(t))
}

// Return the human-friendly feature index for the `list` command.
function handleList() {
  return `📋 Udhaar Bot — Sab Features:

1️⃣ Udhaar daalna (Credit)
   "Ramesh 100 udhaar"
   "Ramesh 75 udhaar chai biscuit"

2️⃣ Payment likhna (Repayment)
   "Ramesh 50 wapas"
   "Suresh ne 100 diya"

3️⃣ Balance dekhna (Single customer)
   "Ramesh ka kitna baaki"

4️⃣ Saara balance dekhna (All customers)
   "kitna baaki"

5️⃣ Naya customer add karna
   "naya customer Mohan 9876543210"

6️⃣ Ye list dobara dekhna
   "list" ya "help"

Kuch bhi bhejo, samajhne ki koshish karega! 😊`
}

function welcomeUnregisteredMessage() {
  return `Namaste! Aapka number register nahi hai.

Apna naam aur shop ka naam bhejein:

  register <Aapka naam> | <Shop ka naam>

Example:
  register Ramesh Kumar | Kirana Store`
}

/**
 * Self-service shopkeeper registration / profile update.
 * - If a shopkeeper row already exists for `phone`, update its name and shop_name.
 * - Otherwise insert a new row.
 * Returns the user-facing reply string.
 */
async function handleShopkeeperRegistration({ phone, name, shopName, existing }) {
  if (existing) {
    const { error: updErr } = await supabase
      .from('shopkeepers')
      .update({ name, shop_name: shopName })
      .eq('id', existing.id)
    if (updErr) {
      console.error('Supabase error updating shopkeeper in registration:', updErr)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }
    return `✓ Profile update ho gaya, ${name}!
Shop: ${shopName}`
  }

  const { error: insErr } = await supabase
    .from('shopkeepers')
    .insert({ name, phone, shop_name: shopName })
  if (insErr) {
    console.error('Supabase error inserting shopkeeper in registration:', insErr)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  return `✓ Welcome ${name}! ${shopName} ki ledger ready hai.

${handleUnknown()}`
}

// POST /whatsapp - Webhook endpoint for Twilio
router.post('/whatsapp', validateTwilioSignature, async (req, res) => {
  try {
    const fromVal = req.body.From || ''
    const bodyVal = typeof req.body.Body === 'string' ? req.body.Body.slice(0, 1000) : ''

    // Step 1 — Extract shopkeeper phone from From
    const shopkeeperPhone = extractPhoneFromTwilioFrom(fromVal)
    if (!shopkeeperPhone) {
      return res.type('text/xml').send(twiml('Invalid sender.'))
    }

    // Step 2 — Look up shopkeeper in Supabase
    const { data: shopkeeper, error: skError } = await supabase
      .from('shopkeepers')
      .select('id, name, shop_name')
      .eq('phone', shopkeeperPhone)
      .maybeSingle()

    if (skError) {
      console.error('Supabase error fetching shopkeeper:', skError)
      return res.type('text/xml').send(twiml('Kuch gadbad ho gayi. Thodi der baad try karein.'))
    }

    // Step 2a — Self-service registration / profile update via WhatsApp.
    // Detected deterministically (no LLM call) so onboarding never depends on the LLM.
    const registration = parseRegistrationCommand(bodyVal)
    if (registration) {
      const reply = await handleShopkeeperRegistration({
        phone: shopkeeperPhone,
        name: registration.name,
        shopName: registration.shopName,
        existing: shopkeeper || null
      })
      return res.type('text/xml').send(twiml(reply))
    }

    // Step 2b — List / help command (no LLM call).
    if (isListCommand(bodyVal)) {
      return res.type('text/xml').send(twiml(handleList()))
    }

    // Step 2c — Unknown number sending anything other than `register ...` or `list`:
    // welcome them and tell them how to register. No LLM call, no DB writes.
    if (!shopkeeper) {
      return res.type('text/xml').send(twiml(welcomeUnregisteredMessage()))
    }

    // Step 3 — Try local parsing first to avoid LLM latency (~1-2 seconds)
    let parsed = fallbackParseMessage(bodyVal)

    // If local parsing is not confident or missing required fields, fall back to LLM
    const needsLLM =
      parsed.intent === 'unknown' ||
      ((parsed.intent === 'credit' || parsed.intent === 'repayment') && (!parsed.name || !parsed.amount)) ||
      (parsed.intent === 'new_customer' && (!parsed.name && !parsed.phone))

    if (needsLLM) {
      console.log('[Webhook] Local parse failed or incomplete. Falling back to LLM parsing...')
      parsed = await parseMessage(bodyVal)
    } else {
      console.log(`[Webhook] Success! Parsed locally in <1ms (Intent: ${parsed.intent})`)
    }

    // Step 4 — Route to handler by intent
    let replyMessage = ''
    switch (parsed.intent) {
      case 'credit':
        replyMessage = await handleCredit(parsed, shopkeeper)
        break
      case 'repayment':
        replyMessage = await handleRepayment(parsed, shopkeeper)
        break
      case 'balance':
        replyMessage = await handleBalance(parsed, shopkeeper)
        break
      case 'new_customer':
        replyMessage = await handleNewCustomer(parsed, shopkeeper)
        break
      case 'list':
        replyMessage = handleList()
        break
      case 'unknown':
      default:
        replyMessage = handleUnknown()
        break
    }

    return res.type('text/xml').send(twiml(replyMessage))
  } catch (err) {
    console.error('[WebhookHandlerError]', err)
    return res.type('text/xml').send(twiml('Kuch gadbad ho gayi. Thodi der baad try karein.'))
  }
})

/**
 * Parses message body to extract intent, name, amount, phone, and notes.
 * @param {string} text - Raw SMS / WhatsApp message text.
 * @returns {Promise<Object>} - Decoded JSON payload from LLM.
 */
async function parseMessage(text) {
  try {
    const messages = [
      {
        role: 'system',
        content: `You parse Hindi/Hinglish WhatsApp messages from Indian shopkeepers managing customer credit.
Return ONLY a valid JSON object with exactly these keys:

{
  "intent": one of: "credit" | "repayment" | "balance" | "new_customer" | "list" | "unknown",
  "name": string or null — customer first name mentioned in message,
  "amount": number or null — rupee amount as integer, digits only,
  "phone": string or null — 10-digit Indian mobile number if present,
  "note": string or null — item or reason mentioned (e.g. "chai", "doodh"), else null
}

Classification rules:
- intent = "credit" when shopkeeper gave goods on credit: keywords like udhaar, udhar, le gaya, diya, credit, baaki daalo
- intent = "repayment" when customer paid back: keywords like wapas, vapas, paid, ne diya, chukaya, return, bheja, payment
- intent = "balance" when shopkeeper asks how much is owed: keywords like kitna, baaki, hisab, balance, total, due, bata
- intent = "new_customer" when registering a new customer: keywords like naya, new, add, jodo, customer, along with a name or phone number
- intent = "list" when user asks for help, commands, features, or what the bot can do: keywords like list, help, commands, features, menu, kya kare, kya hai, sab kuch, kya batao, madad
- intent = "unknown" for anything else

Examples:
"Ramesh 150 udhaar" → {"intent":"credit","name":"Ramesh","amount":150,"phone":null,"note":null}
"suresh ne 200 wapas diya" → {"intent":"repayment","name":"Suresh","amount":200,"phone":null,"note":null}
"Priya ka kitna baaki hai" → {"intent":"balance","name":"Priya","amount":null,"phone":null,"note":null}
"kitna baaki hai sab ka" → {"intent":"balance","name":null,"amount":null,"phone":null,"note":null}
"naya customer Mohan 9876543210" → {"intent":"new_customer","name":"Mohan","amount":null,"phone":"9876543210","note":null}
"raju 75 udhaar chai biscuit" → {"intent":"credit","name":"Raju","amount":75,"phone":null,"note":"chai biscuit"}
"list" → {"intent":"list","name":null,"amount":null,"phone":null,"note":null}
"kya kare" → {"intent":"list","name":null,"amount":null,"phone":null,"note":null}`
      },
      {
        role: 'user',
        content: text
      }
    ]

    return await openrouter.chatJSON(messages)
  } catch (error) {
    console.error('LLM parsing error, falling back to regex parsing:', error)
    return fallbackParseMessage(text)
  }
}

/**
 * Robust regex-based Hinglish parser used when LLM API is unavailable.
 */
function fallbackParseMessage(text) {
  const cleanText = text.trim()
  const lower = cleanText.toLowerCase()

  // Extract all numbers
  const numbers = cleanText.match(/\d+/g) || []

  let intent = 'unknown'
  let name = null
  let amount = null
  let phone = null
  let note = null

  // 1. Identify intent with flexible aliases
  const creditKeywords = ['udhaar', 'udhar', 'credit', 'cr', 'le gaya', 'diya', 'de diya']
  const repaymentKeywords = ['wapas', 'vapas', 'paid', 'payment', 'pay', 'dr', 'rec', 'received', 'chukaya', 'bheja']
  const balanceKeywords = ['kitna', 'baaki', 'hisab', 'balance', 'bal', 'due', 'bata']
  const newCustKeywords = ['naya', 'new', 'add', 'jodo', 'customer', 'cust']
  const listKeywords = ['list', 'help', 'commands', 'features', 'menu', 'kya kare']

  if (creditKeywords.some(kw => lower.includes(kw))) {
    intent = 'credit'
  } else if (repaymentKeywords.some(kw => lower.includes(kw))) {
    intent = 'repayment'
  } else if (balanceKeywords.some(kw => lower.includes(kw))) {
    intent = 'balance'
  } else if (newCustKeywords.some(kw => lower.includes(kw))) {
    intent = 'new_customer'
  } else if (listKeywords.some(kw => lower.includes(kw))) {
    intent = 'list'
  }

  // 2. Extract name (typically the first word, if it's alphabetic and not a command keyword)
  const words = cleanText.split(/\s+/)
  const allKeywords = [...creditKeywords, ...repaymentKeywords, ...balanceKeywords, ...newCustKeywords, ...listKeywords, 'ne', 'ko', 'ka', 'ki', 'ke']
  for (const word of words) {
    const cleanWord = word.replace(/[^a-zA-Z]/g, '')
    if (cleanWord && !allKeywords.includes(cleanWord.toLowerCase())) {
      name = cleanWord
      break
    }
  }

  // 3. Assign numbers based on intent
  if (intent === 'new_customer') {
    // Look for 10-digit number for phone
    const tenDigitMatch = cleanText.match(/\b\d{10}\b/)
    if (tenDigitMatch) {
      phone = tenDigitMatch[0]
    }
  } else {
    // Typically amount is the first number
    if (numbers.length > 0) {
      amount = parseInt(numbers[0], 10)
    }
  }

  // 4. Note extraction for credit/repayment
  if (intent === 'credit' || intent === 'repayment') {
    const amountStr = amount ? String(amount) : ''
    const indexAmount = cleanText.indexOf(amountStr)
    if (indexAmount !== -1) {
      const remaining = cleanText.slice(indexAmount + amountStr.length).trim()
      // Remove intent keyword (e.g. udhaar, wapas)
      const allIntentsKeywords = [...creditKeywords, ...repaymentKeywords]
      let cleanRemaining = remaining
      for (const kw of allIntentsKeywords) {
        const regex = new RegExp(`\\b${kw}\\b`, 'gi')
        cleanRemaining = cleanRemaining.replace(regex, '')
      }
      cleanRemaining = cleanRemaining.replace(/\s+/g, ' ').trim()
      if (cleanRemaining) {
        note = cleanRemaining
      }
    }
  }

  return {
    intent,
    name,
    amount,
    phone,
    note
  }
}


/**
 * Log goods given on credit to a customer.
 */
async function handleCredit(parsed, shopkeeper) {
  const safeName = sanitizeName(parsed.name)
  if (!safeName) {
    return 'Naam likhein. Example: Ramesh 100 udhaar'
  }
  const safeAmount = sanitizeAmount(parsed.amount)
  if (safeAmount === null) {
    return 'Amount likhein. Example: Ramesh 100 udhaar'
  }

  // Find or create customer
  let { data: customer, error: custError } = await supabase
    .from('customers')
    .select('id, name, phone, city, trust_score')
    .ilike('name', safeName)
    .maybeSingle()

  if (custError) {
    console.error('Supabase error fetching customer in handleCredit:', custError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  if (!customer) {
    const titleCasedName = titleCase(safeName)
    const { data: newCust, error: insertError } = await supabase
      .from('customers')
      .insert({
        name: titleCasedName,
        phone: null,
        city: null,
        trust_score: 50
      })
      .select()
      .single()

    if (insertError) {
      console.error('Supabase error inserting customer in handleCredit:', insertError)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }
    customer = newCust
  }

  // Find or create shopkeeper_customers row
  let { data: sc, error: scError } = await supabase
    .from('shopkeeper_customers')
    .select('id, outstanding_balance')
    .eq('shopkeeper_id', shopkeeper.id)
    .eq('customer_id', customer.id)
    .maybeSingle()

  if (scError) {
    console.error('Supabase error fetching shopkeeper_customers in handleCredit:', scError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  if (!sc) {
    const { data: newSc, error: insertScError } = await supabase
      .from('shopkeeper_customers')
      .insert({
        shopkeeper_id: shopkeeper.id,
        customer_id: customer.id,
        outstanding_balance: 0,
        status: 'active',
        last_activity_at: new Date().toISOString()
      })
      .select()
      .single()

    if (insertScError) {
      console.error('Supabase error inserting shopkeeper_customers in handleCredit:', insertScError)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }
    sc = newSc
  }

  // Insert into transactions
  const { error: txError } = await supabase
    .from('transactions')
    .insert({
      shopkeeper_customer_id: sc.id,
      type: 'credit',
      amount: safeAmount,
      note: sanitizeNote(parsed.note),
      transacted_at: new Date().toISOString()
    })

  if (txError) {
    console.error('Supabase error inserting transaction in handleCredit:', txError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  // Update outstanding balance in shopkeeper_customers
  const currentBalance = sc.outstanding_balance ? Number(sc.outstanding_balance) : 0
  const newBalance = currentBalance + safeAmount

  const { error: updateScError } = await supabase
    .from('shopkeeper_customers')
    .update({
      outstanding_balance: newBalance,
      last_activity_at: new Date().toISOString()
    })
    .eq('id', sc.id)

  if (updateScError) {
    console.error('Supabase error updating shopkeeper_customers in handleCredit:', updateScError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  // Fire-and-forget
  analyzeRepaymentPattern(sc.id).catch(console.error)

  return `✅ *Khata Updated (उधार जोड़ा गया)*\n\n👤 *Customer:* ${customer.name}\n➕ *Naya Udhaar:* ₹${safeAmount}\n🗒️ *Note:* ${parsed.note || 'N/A'}\n\n📉 *Total Baaki (Outstanding):* ₹${newBalance}`
}

/**
 * Log cash received from customer.
 */
async function handleRepayment(parsed, shopkeeper) {
  const safeName = sanitizeName(parsed.name)
  if (!safeName) {
    return 'Naam likhein. Example: Ramesh 50 wapas'
  }
  const safeAmount = sanitizeAmount(parsed.amount)
  if (safeAmount === null) {
    return 'Amount likhein. Example: Ramesh 50 wapas'
  }

  // Find customer
  const { data: customer, error: custError } = await supabase
    .from('customers')
    .select('id, name')
    .ilike('name', safeName)
    .maybeSingle()

  if (custError) {
    console.error('Supabase error fetching customer in handleRepayment:', custError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  if (!customer) {
    return `${safeName} aapke customers mein nahi hai.`
  }

  // Find shopkeeper_customers relation
  const { data: sc, error: scError } = await supabase
    .from('shopkeeper_customers')
    .select('id, outstanding_balance')
    .eq('shopkeeper_id', shopkeeper.id)
    .eq('customer_id', customer.id)
    .maybeSingle()

  if (scError) {
    console.error('Supabase error fetching shopkeeper_customers in handleRepayment:', scError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  if (!sc) {
    return `${safeName} aapke customers mein nahi hai.`
  }

  // Insert repayment transaction
  const { error: txError } = await supabase
    .from('transactions')
    .insert({
      shopkeeper_customer_id: sc.id,
      type: 'repayment',
      amount: safeAmount,
      note: sanitizeNote(parsed.note),
      transacted_at: new Date().toISOString()
    })

  if (txError) {
    console.error('Supabase error inserting transaction in handleRepayment:', txError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  // Update outstanding balance (allows negative/advance balances)
  const currentBalance = sc.outstanding_balance ? Number(sc.outstanding_balance) : 0
  const newBalance = currentBalance - safeAmount

  const { error: updateScError } = await supabase
    .from('shopkeeper_customers')
    .update({
      outstanding_balance: newBalance,
      last_activity_at: new Date().toISOString()
    })
    .eq('id', sc.id)

  if (updateScError) {
    console.error('Supabase error updating shopkeeper_customers in handleRepayment:', updateScError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  // Fire-and-forget
  analyzeRepaymentPattern(sc.id)
    .then(() => scheduleNudge(sc.id))
    .catch(console.error)

  let reply = `🙏 *Payment Received (पेमेंट मिला)*\n\n👤 *Customer:* ${customer.name}\n➖ *Amount Paid:* ₹${safeAmount}\n`
  if (parsed.note) {
    reply += `🗒️ *Note:* ${parsed.note}\n`
  }
  reply += `\n`
  if (newBalance < 0) {
    reply += `💰 *${customer.name} ka Advance (Jama):* ₹${Math.abs(newBalance)}`
  } else {
    reply += `📉 *Abhi ka Baaki:* ₹${newBalance}`
    if (newBalance === 0) {
      reply += `\n\n🎉 *Saara hisab saaf! Mubarak ho!*`
    }
  }
  return reply
}

/**
 * Report outstanding balance for specific customer or all active customers.
 */
async function handleBalance(parsed, shopkeeper) {
  const safeName = sanitizeName(parsed.name)
  // If a name was provided but failed sanitization, surface an error rather than silently listing all customers.
  if (parsed.name && !safeName) {
    return 'Naam sahi nahi hai. Example: Ramesh ka kitna baaki'
  }

  // Case A — specific customer
  if (safeName) {
    const { data: customer, error: custError } = await supabase
      .from('customers')
      .select('id, name')
      .ilike('name', safeName)
      .maybeSingle()

    if (custError) {
      console.error('Supabase error fetching customer in handleBalance:', custError)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }

    if (!customer) {
      return `${safeName} aapke customers mein nahi hai.`
    }

    const { data: sc, error: scError } = await supabase
      .from('shopkeeper_customers')
      .select('outstanding_balance')
      .eq('shopkeeper_id', shopkeeper.id)
      .eq('customer_id', customer.id)
      .maybeSingle()

    if (scError) {
      console.error('Supabase error fetching shopkeeper_customers in handleBalance:', scError)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }

    if (!sc) {
      return `${safeName} aapke customers mein nahi hai.`
    }

    const balance = sc.outstanding_balance ? Number(sc.outstanding_balance) : 0
    if (balance === 0) {
      return `📊 *${customer.name} ka Hisab*\n\n✅ Koi baaki nahi hai (All clear!).`
    }
    if (balance < 0) {
      return `📊 *${customer.name} ka Hisab*\n\n💰 *Advance (Jama):* ₹${Math.abs(balance)}\n\n_(Aap par unka ₹${Math.abs(balance)} jama hai)_`
    }

    return `📊 *${customer.name} ka Hisab*\n\n📉 *Total Baaki (Dues):* ₹${balance}`
  }

  // Case B — all customers
  const { data: records, error: recordsError } = await supabase
    .from('shopkeeper_customers')
    .select(`
      outstanding_balance,
      customers (
        name
      )
    `)
    .eq('shopkeeper_id', shopkeeper.id)
    .gt('outstanding_balance', 0)
    .order('outstanding_balance', { ascending: false })
    .limit(10)

  if (recordsError) {
    console.error('Supabase error fetching shopkeeper_customers in handleBalance Case B:', recordsError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  if (!records || records.length === 0) {
    return 'Kisi ka bhi baaki nahi! Sab saaf hai.'
  }

  let totalSum = 0
  const accountsList = []
  
  for (const record of records) {
    const bal = record.outstanding_balance ? Number(record.outstanding_balance) : 0
    totalSum += bal
    const custName = record.customers?.name || 'Unknown'
    accountsList.push(`• *${custName}* — ₹${bal}`)
  }

  return `📊 *Ledger Summary (कुल बकाया list)*\n\n${accountsList.join('\n')}\n\n━━━━━━━━━━━━━━\n💰 *Grand Total (कुल बाकी):* ₹${totalSum}`
}

/**
 * Register a new customer for the shopkeeper.
 */
async function handleNewCustomer(parsed, shopkeeper) {
  if (!parsed.name && !parsed.phone) {
    return 'Naam ya number dono mein se ek zaroori hai.\nExample: naya customer Mohan 9876543210'
  }

  // Sanitize untrusted inputs before they reach DB filters.
  const safePhone = sanitizePhone(parsed.phone)
  const safeName = sanitizeName(parsed.name)

  if (!safeName && !safePhone) {
    return 'Naam ya number sahi nahi hai. Example: naya customer Mohan 9876543210'
  }

  // Look up by phone first (most reliable identifier), then by exact-ish name match.
  // We avoid PostgREST .or() with interpolated user input to prevent filter injection.
  let existingCustomers = []
  if (safePhone) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, phone')
      .eq('phone', safePhone)
    if (error) {
      console.error('Supabase error querying customer by phone in handleNewCustomer:', error)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }
    if (data && data.length > 0) existingCustomers = data
  }

  if (existingCustomers.length === 0 && safeName) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, phone')
      .ilike('name', safeName)
    if (error) {
      console.error('Supabase error querying customer by name in handleNewCustomer:', error)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }
    if (data && data.length > 0) existingCustomers = data
  }

  if (existingCustomers && existingCustomers.length > 0) {
    const customer = existingCustomers[0]
    // Check if shopkeeper_customers link exists for this shopkeeper
    const { data: existingLink, error: linkError } = await supabase
      .from('shopkeeper_customers')
      .select('id')
      .eq('shopkeeper_id', shopkeeper.id)
      .eq('customer_id', customer.id)
      .maybeSingle()

    if (linkError) {
      console.error('Supabase error querying shopkeeper_customers in handleNewCustomer:', linkError)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }

    if (existingLink) {
      return `${customer.name} pehle se aapke customer list mein hai.`
    }

    // Create the shopkeeper_customers link
    const { error: insertLinkError } = await supabase
      .from('shopkeeper_customers')
      .insert({
        shopkeeper_id: shopkeeper.id,
        customer_id: customer.id,
        outstanding_balance: 0,
        status: 'active',
        last_activity_at: new Date().toISOString()
      })

    if (insertLinkError) {
      console.error('Supabase error creating shopkeeper_customers link in handleNewCustomer:', insertLinkError)
      return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
    }

    return `✓ ${customer.name} aapki list mein add ho gaya.`
  }

  // Customer does not exist: create customer
  const nameToInsert = safeName ? titleCase(safeName) : 'Customer'
  const { data: newCustomer, error: createError } = await supabase
    .from('customers')
    .insert({
      name: nameToInsert,
      phone: safePhone || null,
      trust_score: 50
    })
    .select()
    .single()

  if (createError) {
    console.error('Supabase error creating new customer in handleNewCustomer:', createError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  // Link customer to shopkeeper
  const { error: insertScError } = await supabase
    .from('shopkeeper_customers')
    .insert({
      shopkeeper_id: shopkeeper.id,
      customer_id: newCustomer.id,
      outstanding_balance: 0,
      status: 'active',
      last_activity_at: new Date().toISOString()
    })

  if (insertScError) {
    console.error('Supabase error creating shopkeeper_customers link for new customer in handleNewCustomer:', insertScError)
    return 'Kuch gadbad ho gayi. Thodi der baad try karein.'
  }

  return `👤 *Naya Customer Registered!*\n\n👤 *Name:* ${newCustomer.name}\n📞 *Phone:* ${newCustomer.phone || 'N/A'}\n\nAb aap inka udhaar register kar sakte hain.\n👉 *Example:* "${newCustomer.name} 100 udhaar"`
}

/**
 * Handle unknown message formats with helpful instructions.
 */
function handleUnknown() {
  return `Samajh nahi aaya. Yeh try karein:

Udhaar dene ke liye:
  Ramesh 100 udhaar

Payment milne par:
  Ramesh 50 wapas

Balance dekhne ke liye:
  Ramesh ka kitna baaki
  ya sirf: kitna baaki

Naya customer add:
  naya customer Mohan 9876543210

Sab features dekhne ke liye:
  list`
}

/**
 * Helper utility to title-case a string.
 */
function titleCase(str) {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

/**
 * Wraps text response in TwiML format and XML-escapes special characters.
 */
function twiml(message) {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
}

export default router
