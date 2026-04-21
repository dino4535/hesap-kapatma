import type { Invoice, Payment } from './models'
import type { PaymentType } from './paymentTypes'
import { normalizeInvoiceSalesType, normalizePaymentType } from './paymentTypes'

export interface Allocation {
  type: PaymentType
  amount: number
}

export function invoiceTotalAmount(inv: Invoice) {
  return inv.grossAmount ?? (inv.netAmount ?? 0)
}

export function computePaymentKey(invoiceCode: string, p: Payment) {
  return `${invoiceCode}|${p.code ?? ''}|${p.issueDate ?? ''}|${p.amount}|${p.paymentFormCode ?? ''}`
}

function normalizeAllocations(allocs: Allocation[]) {
  const out: Allocation[] = []
  for (const a of allocs) {
    const amount = Number(a.amount) || 0
    if (amount <= 0) continue
    out.push({ type: a.type, amount })
  }
  const byType = new Map<PaymentType, number>()
  for (const a of out) byType.set(a.type, (byType.get(a.type) ?? 0) + a.amount)
  return Array.from(byType.entries()).map(([type, amount]) => ({ type, amount }))
}

export function deriveInvoiceAllocations(inv: Invoice): Allocation[] {
  const total = invoiceTotalAmount(inv)
  if (total <= 0) return []

  const inferred = normalizeInvoiceSalesType(inv.salesType)
  if (inferred === 'VADELI') return [{ type: 'VADELI', amount: total }]

  if (inv.payments && inv.payments.length > 0) {
    const seenTypes: PaymentType[] = []
    const amountAllocations: Allocation[] = []
    for (const p of inv.payments) {
      const t = normalizePaymentType(p.paymentFormCode, p.paymentFormDescription)
      if (!t) continue
      seenTypes.push(t)
      const amount = Number(p.amount) || 0
      if (amount <= 0) continue
      amountAllocations.push({ type: t, amount })
    }
    const uniqueTypes = Array.from(new Set(seenTypes))
    if (uniqueTypes.length === 1) return [{ type: uniqueTypes[0], amount: total }]

    const normalized = normalizeAllocations(amountAllocations)
    const normalizedSum = normalized.reduce((s, a) => s + a.amount, 0)
    if (normalizedSum > 0) {
      const factor = total / normalizedSum
      return normalizeAllocations(normalized.map((a) => ({ ...a, amount: a.amount * factor })))
    }

    return [{ type: uniqueTypes[0] ?? 'NAKIT', amount: total }]
  }

  return [{ type: inferred ?? 'NAKIT', amount: total }]
}

export function getInvoiceAllocations(inv: Invoice, overrides: Record<string, Allocation[]>) {
  const fromOverride = overrides[inv.code]
  if (fromOverride) return normalizeAllocations(fromOverride)
  return deriveInvoiceAllocations(inv)
}

export function derivePaymentAllocations(p: Payment): Allocation[] {
  const t = normalizePaymentType(p.paymentFormCode, p.paymentFormDescription) ?? 'NAKIT'
  return [{ type: t, amount: p.amount ?? 0 }]
}

export function getPaymentAllocations(paymentKey: string, p: Payment, overrides: Record<string, Allocation[]>) {
  const fromOverride = overrides[paymentKey]
  if (fromOverride) return normalizeAllocations(fromOverride)
  return derivePaymentAllocations(p)
}

export function transferAmount(allocs: Allocation[], from: PaymentType, to: PaymentType, amount: number) {
  const a = Number(amount) || 0
  if (a <= 0) return normalizeAllocations(allocs)
  if (from === to) return normalizeAllocations(allocs)

  const current = normalizeAllocations(allocs)
  const fromAmt = current.find((x) => x.type === from)?.amount ?? 0
  if (fromAmt <= 0) return current

  const move = Math.min(fromAmt, a)
  const next: Allocation[] = current
    .map((x) => (x.type === from ? { ...x, amount: x.amount - move } : x))
    .concat([{ type: to, amount: move }])
  return normalizeAllocations(next)
}

export function allocationAmountForType(allocs: Allocation[], t: PaymentType) {
  return allocs.filter((a) => a.type === t).reduce((s, a) => s + a.amount, 0)
}
