import dotenv from 'dotenv'

dotenv.config()

export const openrouter = {
  /**
   * Sends a message list to OpenRouter and returns the parsed JSON response.
   * @param {Array} messages - Chat messages in standard OpenAI format.
   * @returns {Promise<Object>} - Parsed JSON response.
   */
  async chatJSON(messages) {
    if (process.env.USE_MOCK_LLM === 'true') {
      const userMessage = messages.find(m => m.role === 'user')?.content || ''
      const lower = userMessage.toLowerCase()

      if (lower.includes('udhaar') || lower.includes('udhar')) {
        const amountMatch = lower.match(/\d+/)
        const amount = amountMatch ? parseInt(amountMatch[0], 10) : null
        let name = null
        if (lower.includes('suresh')) name = 'Suresh'
        else if (lower.includes('ramesh')) name = 'Ramesh'
        const note = lower.includes('chai biscuit') ? 'chai biscuit' : null
        return { intent: 'credit', name, amount, phone: null, note }
      }

      if (lower.includes('wapas') || lower.includes('vapas')) {
        const amountMatch = lower.match(/\d+/)
        const amount = amountMatch ? parseInt(amountMatch[0], 10) : null
        let name = null
        if (lower.includes('suresh')) name = 'Suresh'
        return { intent: 'repayment', name, amount, phone: null, note: null }
      }

      if (lower.includes('kitna baaki')) {
        let name = null
        if (lower.includes('suresh')) name = 'Suresh'
        return { intent: 'balance', name, amount: null, phone: null, note: null }
      }

      if (lower.includes('naya customer')) {
        let name = null
        if (lower.includes('mohan')) name = 'Mohan'
        const phoneMatch = lower.match(/\d{10}/)
        const phone = phoneMatch ? phoneMatch[0] : null
        return { intent: 'new_customer', name, amount: null, phone, note: null }
      }

      if (lower.includes('list') || lower.includes('help') || lower.includes('commands') || lower.includes('kya kare') || lower.includes('kya hai') || lower.includes('sab kuch') || lower.includes('menu') || lower.includes('madad') || lower.includes('batao')) {
        return { intent: 'list', name: null, amount: null, phone: null, note: null }
      }

      return { intent: 'unknown', name: null, amount: null, phone: null, note: null }
    }

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured in environment variables.')
    }

    // Abort the upstream call if it hangs longer than 15s so a stuck LLM does not block the webhook indefinitely.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    let response
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/pallav/udhaar-bot',
          'X-Title': 'Udhaar WhatsApp Bot'
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3-8b-instruct:free', // Using a completely free Llama 3 8B Instruct model
          messages: messages,
          response_format: { type: 'json_object' }
        }),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      // Avoid leaking upstream provider error bodies into our logs/responses.
      throw new Error(`OpenRouter request failed: ${response.status}`)
    }

    const data = await response.json()
    const rawContent = data.choices?.[0]?.message?.content
    if (!rawContent) {
      throw new Error('Invalid response format or empty message content received from OpenRouter.')
    }

    // Parse the inner JSON block returned by the assistant
    return JSON.parse(rawContent.trim())
  }
}
