import { supabase } from '../lib/supabase.js'

/**
 * Schedule a repayment-reminder nudge for a shopkeeper-customer relationship.
 *
 * Rules:
 *   - If outstanding_balance is 0, do nothing (and clear any existing pending nudge).
 *   - send_at is computed from the customer's avg_repayment_days (if known) clamped
 *     to [MIN_DAYS, MAX_DAYS]; otherwise we default to DEFAULT_DAYS days from now.
 *   - Only one *pending* nudge is kept per shopkeeper_customer; if one already exists
 *     we update its send_at, otherwise we insert a new pending row.
 *
 * Errors are logged and swallowed so callers can fire-and-forget.
 *
 * @param {string} shopkeeperCustomerId - UUID of the shopkeeper_customers row.
 * @returns {Promise<Object|null>} The scheduled nudge row, or null if no nudge was scheduled.
 */
const DEFAULT_DAYS = 3
const MIN_DAYS = 1
const MAX_DAYS = 14
const MS_PER_DAY = 24 * 60 * 60 * 1000

export async function scheduleNudge(shopkeeperCustomerId) {
  if (!shopkeeperCustomerId) return null

  // 1. Load relationship — need balance + customer name for the message
  const { data: sc, error: scError } = await supabase
    .from('shopkeeper_customers')
    .select('id, customer_id, outstanding_balance, status')
    .eq('id', shopkeeperCustomerId)
    .maybeSingle()

  if (scError) {
    console.error('[scheduleNudge] failed to load shopkeeper_customers:', scError)
    return null
  }
  if (!sc) {
    console.warn('[scheduleNudge] no shopkeeper_customers row for id:', shopkeeperCustomerId)
    return null
  }

  const balance = Number(sc.outstanding_balance) || 0

  // 2. Nothing owed → cancel any pending nudge and return
  if (balance <= 0) {
    const { data: pending, error: pendingErr } = await supabase
      .from('nudges')
      .select('id')
      .eq('shopkeeper_customer_id', shopkeeperCustomerId)
      .eq('status', 'pending')
      .maybeSingle()
    if (!pendingErr && pending) {
      await supabase
        .from('nudges')
        .update({ status: 'cancelled' })
        .eq('id', pending.id)
    }
    console.log(`[scheduleNudge] sc=${shopkeeperCustomerId} balance=0; no nudge scheduled.`)
    return null
  }

  // 3. Decide when to nudge — prefer pattern-based scheduling
  let daysAhead = DEFAULT_DAYS
  const { data: pattern, error: patternErr } = await supabase
    .from('repayment_patterns')
    .select('avg_repayment_days')
    .eq('shopkeeper_customer_id', shopkeeperCustomerId)
    .maybeSingle()
  if (patternErr) {
    // Non-fatal; just fall back to DEFAULT_DAYS
    console.warn('[scheduleNudge] could not load pattern, using default delay:', patternErr)
  } else if (pattern && pattern.avg_repayment_days != null) {
    const avg = Number(pattern.avg_repayment_days)
    if (Number.isFinite(avg) && avg > 0) {
      daysAhead = clamp(Math.round(avg), MIN_DAYS, MAX_DAYS)
    }
  }
  const sendAt = new Date(Date.now() + daysAhead * MS_PER_DAY).toISOString()

  // 4. Look up customer name for the message body
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('name')
    .eq('id', sc.customer_id)
    .maybeSingle()
  if (custErr) {
    console.warn('[scheduleNudge] could not load customer name, continuing:', custErr)
  }
  const name = customer?.name || 'Customer'
  const message = `Namaste! ${name} ka ₹${balance} baaki hai. Yaad dilana zaroori hai.`

  // 5. Upsert one pending nudge per relationship.
  // Note: the migration's partial unique index `nudges_one_pending_per_sc` is the real
  // source of truth for at-most-one-pending; the find-then-insert/update below is best-
  // effort and a concurrent caller will simply hit a unique-violation that propagates
  // to the call-site .catch().
  const { data: existing, error: existingErr } = await supabase
    .from('nudges')
    .select('id')
    .eq('shopkeeper_customer_id', shopkeeperCustomerId)
    .eq('status', 'pending')
    .maybeSingle()

  if (existingErr) {
    console.error('[scheduleNudge] failed to check existing pending nudge:', existingErr)
    return null
  }

  if (existing) {
    const { error: updErr } = await supabase
      .from('nudges')
      .update({ send_at: sendAt, message })
      .eq('id', existing.id)
    if (updErr) {
      console.error('[scheduleNudge] failed to update pending nudge:', updErr)
      return null
    }
    console.log(`[scheduleNudge] sc=${shopkeeperCustomerId} updated pending nudge for ${sendAt}`)
    return { id: existing.id, shopkeeper_customer_id: shopkeeperCustomerId, send_at: sendAt, status: 'pending', message }
  }

  const { data: inserted, error: insErr } = await supabase
    .from('nudges')
    .insert({
      shopkeeper_customer_id: shopkeeperCustomerId,
      send_at: sendAt,
      status: 'pending',
      message,
      created_at: new Date().toISOString()
    })
    .select()
    .single()

  if (insErr) {
    console.error('[scheduleNudge] failed to insert nudge:', insErr)
    return null
  }

  console.log(`[scheduleNudge] sc=${shopkeeperCustomerId} scheduled nudge for ${sendAt} (${daysAhead}d)`)
  return inserted
}

function clamp(n, lo, hi) {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}
