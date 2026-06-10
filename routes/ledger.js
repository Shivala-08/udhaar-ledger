import express from 'express'
import { supabase } from '../lib/supabase.js'

const router = express.Router()

router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params

    // 1. Fetch relationship details by token
    const { data: sc, error: scError } = await supabase
      .from('shopkeeper_customers')
      .select(`
        id,
        outstanding_balance,
        customer_id,
        shopkeeper_id,
        customers (
          name,
          phone,
          trust_score
        ),
        shopkeepers (
          name,
          shop_name
        )
      `)
      .eq('access_token', token)
      .maybeSingle()

    if (scError) {
      console.error('[LedgerRouter] Error fetching relationship:', scError)
      return res.status(500).send(renderErrorPage('Kuch gadbad ho gayi. Kripya thodi der baad try karein.'))
    }

    if (!sc) {
      return res.status(404).send(renderErrorPage('Link galat hai ya expired hai. Kripya shopkeeper se naya link mangein.'))
    }

    // 2. Load transactions
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('id, type, amount, note, is_disputed, transacted_at')
      .eq('shopkeeper_customer_id', sc.id)
      .order('transacted_at', { ascending: false })

    if (txError) {
      console.error('[LedgerRouter] Error fetching transactions:', txError)
      return res.status(500).send(renderErrorPage('Error loading transactions.'))
    }

    // 3. Render HTML
    const html = renderLedgerPage({
      customerName: sc.customers?.name || 'Customer',
      shopName: sc.shopkeepers?.shop_name || 'Kirana Store',
      shopkeeperName: sc.shopkeepers?.name || 'Shopkeeper',
      balance: Number(sc.outstanding_balance) || 0,
      trustScore: Number(sc.customers?.trust_score) || 50,
      transactions: transactions || []
    })

    res.type('html').send(html)
  } catch (err) {
    console.error('[LedgerRouterError]', err)
    res.status(500).send(renderErrorPage('Internal Server Error'))
  }
})

function renderLedgerPage({ customerName, shopName, shopkeeperName, balance, trustScore, transactions }) {
  const isAdvance = balance < 0
  const absBalance = Math.abs(balance)

  // Map transactions to HTML rows
  const txRows = transactions.map(tx => {
    const isCredit = tx.type === 'credit'
    const dateStr = new Date(tx.transacted_at).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    
    let badgeClass = isCredit ? 'badge-credit' : 'badge-repayment'
    let badgeText = isCredit ? 'Udhaar' : 'Wapas'
    let amtSign = isCredit ? '+' : '-'
    let amtClass = isCredit ? 'amount-credit' : 'amount-repayment'

    let disputeBadge = ''
    if (tx.is_disputed) {
      disputeBadge = `<span class="badge badge-dispute">⚠️ Disputed</span>`
    }

    return `
      <div class="tx-card">
        <div class="tx-header">
          <div class="tx-type-group">
            <span class="badge ${badgeClass}">${badgeText}</span>
            ${disputeBadge}
          </div>
          <span class="${amtClass}">${amtSign} ₹${Number(tx.amount)}</span>
        </div>
        <div class="tx-details">
          <span class="tx-note">${tx.note || '<i>No note</i>'}</span>
          <span class="tx-date">${dateStr}</span>
        </div>
      </div>
    `
  }).join('')

  // Determine trust score visual classification
  let scoreClass = 'score-neutral'
  let scoreText = 'Average'
  if (trustScore >= 75) {
    scoreClass = 'score-good'
    scoreText = 'Excellent'
  } else if (trustScore < 40) {
    scoreClass = 'score-bad'
    scoreText = 'Needs Improvement'
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ledger — ${shopName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(17, 24, 39, 0.8);
      --card-highlight: rgba(31, 41, 55, 0.5);
      --border: rgba(255, 255, 255, 0.08);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #4f46e5;
      --primary-gradient: linear-gradient(135deg, #4f46e5, #6366f1);
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(79, 70, 229, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.1) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      padding: 16px;
    }

    .container {
      width: 100%;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    header {
      text-align: center;
      margin-top: 10px;
    }

    header h1 {
      font-size: 26px;
      font-weight: 700;
      background: linear-gradient(to right, #f3f4f6, #9ca3af);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 4px;
    }

    header p {
      font-size: 14px;
      color: var(--text-muted);
    }

    /* Balance Dashboard */
    .balance-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 24px;
      text-align: center;
      position: relative;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }

    .balance-label {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .balance-amount {
      font-size: 44px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      justify-content: center;
      align-items: baseline;
      gap: 4px;
    }

    .balance-amount.advance {
      color: var(--success);
    }

    .balance-amount.due {
      color: var(--danger);
    }

    .balance-amount span {
      font-size: 20px;
      font-weight: 500;
    }

    .balance-status-pill {
      display: inline-flex;
      align-items: center;
      padding: 6px 14px;
      border-radius: 100px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
    }

    .balance-status-pill.advance {
      color: var(--success);
      background: rgba(16, 185, 129, 0.08);
      border-color: rgba(16, 185, 129, 0.2);
    }

    .balance-status-pill.due {
      color: var(--danger);
      background: rgba(239, 68, 68, 0.08);
      border-color: rgba(239, 68, 68, 0.2);
    }

    /* Trust Score Widget */
    .trust-widget {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 18px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .trust-info h3 {
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 2px;
    }

    .trust-info p {
      font-size: 16px;
      font-weight: 600;
    }

    .trust-bar-container {
      flex-grow: 1;
      max-width: 150px;
      height: 8px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      overflow: hidden;
      position: relative;
    }

    .trust-bar {
      height: 100%;
      border-radius: 10px;
    }

    .score-good {
      color: var(--success);
      background: var(--success);
    }

    .score-neutral {
      color: var(--primary);
      background: var(--primary);
    }

    .score-bad {
      color: var(--danger);
      background: var(--danger);
    }

    .trust-percentage {
      font-size: 16px;
      font-weight: 700;
      min-width: 45px;
      text-align: right;
    }

    /* Transactions Section */
    .section-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--text);
      margin: 10px 0 2px 4px;
    }

    .tx-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .tx-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }

    .tx-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.15);
      background: var(--card-highlight);
    }

    .tx-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .tx-type-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge-credit {
      background: rgba(239, 68, 68, 0.1);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .badge-repayment {
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }

    .badge-dispute {
      background: rgba(245, 158, 11, 0.1);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.2);
    }

    .amount-credit {
      font-size: 18px;
      font-weight: 700;
      color: #ff6b6b;
    }

    .amount-repayment {
      font-size: 18px;
      font-weight: 700;
      color: #4ed9a5;
    }

    .tx-details {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 13px;
    }

    .tx-note {
      color: var(--text);
      max-width: 70%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tx-date {
      color: var(--text-muted);
      font-size: 12px;
    }

    .no-transactions {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 18px;
    }

    /* Footer */
    footer {
      text-align: center;
      padding: 20px 0;
      color: var(--text-muted);
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${shopName}</h1>
      <p>Shopkeeper: ${shopkeeperName}</p>
    </header>

    <!-- Balance Dashboard -->
    <div class="balance-card">
      <div class="balance-label">${isAdvance ? 'Aapka Jama (Advance)' : 'Aapka Kul Baaki (Dues)'}</div>
      <div class="balance-amount ${isAdvance ? 'advance' : 'due'}">
        <span>₹</span>${absBalance}
      </div>
      <div class="balance-status-pill ${isAdvance ? 'advance' : 'due'}">
        ${isAdvance ? '✓ Up-to-date (No Dues)' : '⚠️ Payment Pending'}
      </div>
    </div>

    <!-- Trust Score -->
    <div class="trust-widget">
      <div class="trust-info">
        <h3>Credit Trust Score</h3>
        <p class="${scoreClass}">${scoreText}</p>
      </div>
      <div class="trust-bar-container">
        <div class="trust-bar ${scoreClass}" style="width: ${trustScore}%"></div>
      </div>
      <div class="trust-percentage ${scoreClass}">${trustScore}%</div>
    </div>

    <!-- Ledger Feed -->
    <h2 class="section-title">Ledger Transactions</h2>
    <div class="tx-list">
      ${txRows || '<div class="no-transactions">Koi transactions nahi mile.</div>'}
    </div>

    <footer>
      <p>Powered by Udhaar Bot (WhatsApp Ledger)</p>
      <p>Dispute raise karne ke liye send: <b>GALAT &lt;amount&gt;</b> to WhatsApp</p>
    </footer>
  </div>
</body>
</html>
  `
}

function renderErrorPage(message) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error — Udhaar Bot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Outfit', sans-serif;
      background-color: #0b0f19;
      color: #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      padding: 20px;
      text-align: center;
    }
    .card {
      background: rgba(17, 24, 39, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 30px;
      max-width: 400px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    h1 {
      color: #ef4444;
      font-size: 24px;
      margin-bottom: 16px;
    }
    p {
      color: #9ca3af;
      font-size: 15px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ Link Invalid</h1>
    <p>${message}</p>
  </div>
</body>
</html>
  `
}

export default router
