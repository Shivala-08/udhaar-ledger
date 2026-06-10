import express from 'express'
import dotenv from 'dotenv'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import repaymentsRouter from './routes/repayments.js'
import webhookRouter from './routes/webhook.js'
import ledgerRouter from './routes/ledger.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

// Trust the first hop proxy (needed for correct client IPs behind load balancers / Twilio)
app.set('trust proxy', 1)

// Security headers with custom CSP to support inline styles and Google Fonts on the PWA ledger
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"]
    }
  }
}))

// Body parsers with size caps (prevents memory abuse from oversized payloads)
app.use(express.urlencoded({ extended: true, limit: '32kb' }))
app.use(express.json({ limit: '32kb' }))

// Rate limiters
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages/min per IP — generous for legitimate Twilio traffic
  standardHeaders: true,
  legacyHeaders: false,
  // Return TwiML so Twilio renders the rate-limit response correctly.
  handler: (req, res) => {
    res.status(429).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Too many requests. Thodi der baad try karein.</Message></Response>'
    )
  }
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
})

// Mount routes
app.use('/api/repayments', apiLimiter, repaymentsRouter)
app.use('/webhook', webhookLimiter, webhookRouter)
app.use('/c', apiLimiter, ledgerRouter)

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[ServerError]', err)
  res.status(500).json({ error: 'Internal Server Error' })
})

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})

export default app
