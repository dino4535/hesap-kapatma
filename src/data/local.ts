import type { Collection, Invoice } from '../domain/models'
import type { Allocation } from '../domain/allocations'

const SESSION_KEY = 'hesapKapatmaCurrentUser'
const INVOICES_KEY = 'hesapKapatmaInvoices'
const COLLECTIONS_KEY = 'hesapKapatmaCollections'
const INVOICE_ALLOC_KEY = 'hesapKapatmaInvoiceAllocations'
const PAYMENT_ALLOC_KEY = 'hesapKapatmaPaymentAllocations'

const userKey = (base: string, userId: string) => `${base}:${userId}`

export function loadSessionUser() {
  try {
    const v = localStorage.getItem(SESSION_KEY)
    return v && v.trim() ? v : null
  } catch {
    return null
  }
}

export function saveSessionUser(userId: string) {
  localStorage.setItem(SESSION_KEY, userId)
}

export function clearSessionUser() {
  localStorage.removeItem(SESSION_KEY)
}

export function loadInvoicesFromLocalStorage(userId: string): Invoice[] {
  try {
    const raw = localStorage.getItem(userKey(INVOICES_KEY, userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as Invoice[]
  } catch {
    return []
  }
}

export function saveInvoicesToLocalStorage(userId: string, invoices: Invoice[]) {
  const existing = loadInvoicesFromLocalStorage(userId)
  const byCode = new Map(existing.map((i) => [i.code, i]))
  for (const inv of invoices) {
    if (!byCode.has(inv.code)) byCode.set(inv.code, inv)
  }
  const merged = Array.from(byCode.values())
  localStorage.setItem(userKey(INVOICES_KEY, userId), JSON.stringify(merged))
}

export function loadCollectionsFromLocalStorage(userId: string): Collection[] {
  try {
    const raw = localStorage.getItem(userKey(COLLECTIONS_KEY, userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as Collection[]
  } catch {
    return []
  }
}

export function saveCollectionsToLocalStorage(userId: string, collections: Collection[]) {
  const existing = loadCollectionsFromLocalStorage(userId)
  const byKey = new Map(
    existing.map((c) => [`${c.invoiceCode ?? ''}|${c.code ?? ''}|${c.issueDate ?? ''}|${c.amount}|${c.paymentFormCode ?? ''}`, c]),
  )
  for (const c of collections) {
    const k = `${c.invoiceCode ?? ''}|${c.code ?? ''}|${c.issueDate ?? ''}|${c.amount}|${c.paymentFormCode ?? ''}`
    if (!byKey.has(k)) byKey.set(k, c)
  }
  const merged = Array.from(byKey.values())
  localStorage.setItem(userKey(COLLECTIONS_KEY, userId), JSON.stringify(merged))
}

export function loadInvoiceAllocations(userId: string): Record<string, Allocation[]> {
  try {
    const raw = localStorage.getItem(userKey(INVOICE_ALLOC_KEY, userId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, Allocation[]>
  } catch {
    return {}
  }
}

export function saveInvoiceAllocations(userId: string, value: Record<string, Allocation[]>) {
  localStorage.setItem(userKey(INVOICE_ALLOC_KEY, userId), JSON.stringify(value))
}

export function loadPaymentAllocations(userId: string): Record<string, Allocation[]> {
  try {
    const raw = localStorage.getItem(userKey(PAYMENT_ALLOC_KEY, userId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, Allocation[]>
  } catch {
    return {}
  }
}

export function savePaymentAllocations(userId: string, value: Record<string, Allocation[]>) {
  localStorage.setItem(userKey(PAYMENT_ALLOC_KEY, userId), JSON.stringify(value))
}
