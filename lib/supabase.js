import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

class MockSupabase {
  constructor() {
    this.tables = {
      shopkeepers: [
        { id: 'sk-uuid-1', name: 'Ramesh Kumar', phone: '9876543210', shop_name: 'Kirana Store' }
      ],
      customers: [
        { id: 'c-uuid-1', name: 'Suresh', phone: '9999988888', city: 'Delhi', trust_score: 50 }
      ],
      shopkeeper_customers: [
        { id: 'sc-uuid-1', shopkeeper_id: 'sk-uuid-1', customer_id: 'c-uuid-1', outstanding_balance: 100, status: 'active', last_activity_at: new Date().toISOString(), access_token: 'mock-token-suresh' }
      ],
      transactions: [],
      nudges: [],
      repayment_patterns: []
    }
  }

  from(tableName) {
    const tableData = this.tables[tableName] || []
    const self = this
    
    const builder = {
      _tableName: tableName,
      _data: [...tableData],
      _orderBy: null,
      _limit: null,

      select(fields) {
        return this
      },

      eq(field, value) {
        this._data = this._data.filter(row => row[field] === value)
        return this
      },

      ilike(field, value) {
        this._data = this._data.filter(row => {
          if (!row[field]) return false
          return row[field].toLowerCase() === value.toLowerCase()
        })
        return this
      },

      gt(field, value) {
        this._data = this._data.filter(row => Number(row[field]) > Number(value))
        return this
      },

      or(orExpression) {
        const conditions = orExpression.split(',')
        this._data = this._data.filter(row => {
          return conditions.some(cond => {
            const [field, op, val] = cond.split('.')
            if (op === 'eq') {
              return String(row[field]) === String(val)
            }
            if (op === 'ilike') {
              return row[field] && row[field].toLowerCase() === val.toLowerCase()
            }
            return false
          })
        })
        return this
      },

      order(field, { ascending } = { ascending: true }) {
        this._orderBy = { field, ascending }
        return this
      },

      limit(n) {
        this._limit = n
        return this
      },

      async single() {
        const sorted = this._getSortedAndLimited()
        if (sorted.length === 0) {
          return { data: null, error: { code: 'PGRST116', message: 'Not Found' } }
        }
        return { data: sorted[0], error: null }
      },

      async maybeSingle() {
        const sorted = this._getSortedAndLimited()
        if (sorted.length === 0) {
          return { data: null, error: null }
        }
        return { data: sorted[0], error: null }
      },

      async then(resolve) {
        const sorted = this._getSortedAndLimited()
        resolve({ data: sorted, error: null })
      },

      _getSortedAndLimited() {
        let result = [...this._data]
        if (tableName === 'shopkeeper_customers') {
          result = result.map(row => {
            const customer = self.tables.customers.find(c => c.id === row.customer_id)
            return {
              ...row,
              customers: customer ? { name: customer.name } : null
            }
          })
        }
        if (this._orderBy) {
          const { field, ascending } = this._orderBy
          result.sort((a, b) => {
            let valA = a[field]
            let valB = b[field]
            if (typeof valA === 'string' && !isNaN(valA)) valA = Number(valA)
            if (typeof valB === 'string' && !isNaN(valB)) valB = Number(valB)
            if (valA < valB) return ascending ? -1 : 1
            if (valA > valB) return ascending ? 1 : -1
            return 0
          })
        }
        if (this._limit !== null) {
          result = result.slice(0, this._limit)
        }
        return result
      },

      insert(rowOrRows) {
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]
        const inserted = rows.map(r => {
          let defaults = {}
          if (tableName === 'shopkeeper_customers') {
            defaults.access_token = `mock-token-${Math.random().toString(36).substr(2, 9)}`
          } else if (tableName === 'transactions') {
            defaults.is_disputed = false
          }
          const newRow = { id: `inserted-uuid-${Math.random().toString(36).substr(2, 9)}`, ...defaults, ...r }
          tableData.push(newRow)
          return newRow
        })
        
        const insertBuilder = {
          select() {
            return this
          },
          async single() {
            return { data: inserted[0], error: null }
          },
          async then(resolve) {
            resolve({ data: inserted, error: null })
          }
        }
        return insertBuilder
      },

      update(values) {
        const matched = this._data
        matched.forEach(row => {
          const dbRow = tableData.find(r => r.id === row.id)
          if (dbRow) {
            Object.assign(dbRow, values)
          }
        })

        const updateBuilder = {
          eq(field, value) {
            return this
          },
          async then(resolve) {
            resolve({ data: matched, error: null })
          }
        }
        return updateBuilder
      }
    }
    return builder
  }
}

function createRealClient() {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_KEY
  if (!supabaseUrl || !supabaseKey) {
    // Fail fast instead of silently running against placeholder credentials
    throw new Error('SUPABASE_URL and SUPABASE_KEY must be configured (or set USE_MOCK_DB=true for local development).')
  }
  return createClient(supabaseUrl, supabaseKey)
}

export const supabase = process.env.USE_MOCK_DB === 'true'
  ? new MockSupabase()
  : createRealClient()
