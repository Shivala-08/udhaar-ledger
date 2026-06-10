import { supabase } from '../lib/supabase.js'

/**
 * Analyzes the repayment pattern for a given shopkeeper-customer relationship.
 *
 * Walks the customer's transaction history (FIFO matching credits against
 * subsequent repayments) and produces summary metrics:
 *   - credit_count, repayment_count
 *   - total_credit, total_repayment
 *   - avg_repayment_days        (mean days between credit and the repayment that closes it)
 *   - on_time_rate              (fraction of paired credits repaid within ON_TIME_DAYS)
 *   - last_analyzed_at
 *
 * Persists the row in `repayment_patterns` (one row per shopkeeper_customer_id),
 * then recomputes the underlying customer's `trust_score` (0–100, clamped).
 *
 * Errors are logged and swallowed so callers (webhook handlers) can fire-and-forget.
 *
 * @param {string} shopkeeperCustomerId - UUID of the shopkeeper_customers row.
 * @returns {Promise<Object|null>} The persisted pattern row, or null on failure.
 */
const ON_TIME_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

export async function analyzeRepaymentPattern(shopkeeperCustomerId) {
  if (!shopkeeperCustomerId) return null

  // 1. Fetch the relationship to get the customer_id (needed for trust_score update)
  const { data: sc, error: scError } = await supabase
    .from('shopkeeper_customers')
    .select('id, customer_id, outstanding_balance')
    .eq('id', shopkeeperCustomerId)
    .maybeSingle()

  if (scError || !sc) {
    if (scError) console.error('[analyzePattern] failed to load shopkeeper_customers:', scError)
    return null
  }

  // 2. Fetch all transactions for this relationship, oldest first
  const { data: txs, error: txError } = await supabase
    .from('transactions')
    .select('id, type, amount, transacted_at')
    .eq('shopkeeper_customer_id', shopkeeperCustomerId)
    .order('transacted_at', { ascending: true })

  if (txError) {
    console.error('[analyzePattern] failed to load transactions:', txError)
    return null
  }

  const metrics = computeMetrics(txs || [])

  // 3. Upsert into repayment_patterns.
  // Note: the migration's UNIQUE(shopkeeper_customer_id) is the real source of truth
  // for one-row-per-relationship; the find-then-insert/update below is best-effort and
  // a concurrent caller will simply hit a unique-violation that propagates to the
  // call-site .catch().
  const patternRow = {
    shopkeeper_customer_id: shopkeeperCustomerId,
    credit_count: metrics.creditCount,
    repayment_count: metrics.repaymentCount,
    total_credit: metrics.totalCredit,
    total_repayment: metrics.totalRepayment,
    avg_repayment_days: metrics.avgRepaymentDays,
    on_time_rate: metrics.onTimeRate,
    last_analyzed_at: new Date().toISOString()
  }

  const { data: existing, error: existingErr } = await supabase
    .from('repayment_patterns')
    .select('id')
    .eq('shopkeeper_customer_id', shopkeeperCustomerId)
    .maybeSingle()

  if (existingErr) {
    console.error('[analyzePattern] failed to load existing pattern:', existingErr)
    return null
  }

  let persisted = null
  if (existing) {
    const { error: updErr } = await supabase
      .from('repayment_patterns')
      .update(patternRow)
      .eq('id', existing.id)
    if (updErr) {
      console.error('[analyzePattern] failed to update pattern:', updErr)
      return null
    }
    persisted = { id: existing.id, ...patternRow }
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('repayment_patterns')
      .insert(patternRow)
      .select()
      .single()
    if (insErr) {
      console.error('[analyzePattern] failed to insert pattern:', insErr)
      return null
    }
    persisted = inserted
  }

  // 4. Recompute trust score for the underlying customer
  const newScore = computeTrustScore(metrics)
  const { error: scoreErr } = await supabase
    .from('customers')
    .update({ trust_score: newScore })
    .eq('id', sc.customer_id)
  if (scoreErr) {
    console.error('[analyzePattern] failed to update trust_score:', scoreErr)
  }

  console.log(
    `[analyzePattern] sc=${shopkeeperCustomerId} credits=${metrics.creditCount} repayments=${metrics.repaymentCount} ` +
      `avgDays=${metrics.avgRepaymentDays ?? 'n/a'} onTime=${metrics.onTimeRate ?? 'n/a'} trust=${newScore}`
  )
  return persisted
}

/**
 * FIFO-match credits against repayments to derive per-credit settlement times.
 * Credits and repayments are matched amount-for-amount; partial repayments
 * progressively settle the oldest open credit, and a credit is considered
 * "closed" the moment its outstanding amount reaches zero.
 *
 * Pure function — exported for testability.
 */
export function computeMetrics(transactions) {
  let creditCount = 0
  let repaymentCount = 0
  let totalCredit = 0
  let totalRepayment = 0

  /** Open credits queue: { remaining, openedAt } */
  const openCredits = []
  /** Days-to-close for each fully closed credit. */
  const closedDays = []

  for (const tx of transactions) {
    const amt = Number(tx.amount) || 0
    if (amt <= 0) continue
    const at = tx.transacted_at ? new Date(tx.transacted_at).getTime() : Date.now()

    if (tx.type === 'credit') {
      creditCount++
      totalCredit += amt
      openCredits.push({ remaining: amt, openedAt: at })
    } else if (tx.type === 'repayment') {
      repaymentCount++
      totalRepayment += amt
      let remainingPayment = amt
      while (remainingPayment > 0 && openCredits.length > 0) {
        const head = openCredits[0]
        const applied = Math.min(head.remaining, remainingPayment)
        head.remaining -= applied
        remainingPayment -= applied
        if (head.remaining === 0) {
          const days = Math.max(0, (at - head.openedAt) / MS_PER_DAY)
          closedDays.push(days)
          openCredits.shift()
        }
      }
      // any leftover repayment (overpayment) is ignored for averaging purposes
    }
  }

  const avgRepaymentDays =
    closedDays.length > 0
      ? round2(closedDays.reduce((a, b) => a + b, 0) / closedDays.length)
      : null

  const onTimeRate =
    closedDays.length > 0
      ? round2(closedDays.filter(d => d <= ON_TIME_DAYS).length / closedDays.length)
      : null

  return {
    creditCount,
    repaymentCount,
    totalCredit,
    totalRepayment,
    avgRepaymentDays,
    onTimeRate
  }
}

/**
 * Map metrics → trust score in [0, 100].
 * Heuristic: start at 50, reward on-time payments and full settlement,
 * penalize a high open ratio. Pure for testability.
 */
export function computeTrustScore(metrics) {
  let score = 50

  if (metrics.onTimeRate !== null) {
    // -20 to +30 swing based on on-time rate
    score += Math.round(metrics.onTimeRate * 50 - 20)
  }

  if (metrics.totalCredit > 0) {
    const repaidRatio = Math.min(1, metrics.totalRepayment / metrics.totalCredit)
    // -15 to +20 swing based on how much of total credit has been repaid
    score += Math.round(repaidRatio * 35 - 15)
  }

  if (metrics.avgRepaymentDays !== null) {
    if (metrics.avgRepaymentDays <= ON_TIME_DAYS) score += 5
    else if (metrics.avgRepaymentDays > 30) score -= 10
  }

  if (score < 0) score = 0
  if (score > 100) score = 100
  return score
}

function round2(n) {
  return Math.round(n * 100) / 100
}
