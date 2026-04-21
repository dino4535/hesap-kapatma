export type PaymentType = 'HAVALE' | 'NAKIT' | 'VADETAH' | 'VADETAHHAV' | 'BANKCARD' | 'VADELI'

export const PAYMENT_TYPES: PaymentType[] = ['HAVALE', 'NAKIT', 'VADETAH', 'VADETAHHAV', 'BANKCARD', 'VADELI']

export function paymentTypeLabel(t: PaymentType) {
  switch (t) {
    case 'HAVALE':
      return 'Havale'
    case 'NAKIT':
      return 'Nakit'
    case 'VADETAH':
      return 'Vadeli Tahsilat'
    case 'VADETAHHAV':
      return 'Vadeli Tahsilat Havale'
    case 'BANKCARD':
      return 'Bankcard'
    case 'VADELI':
      return 'Vadeli'
  }
}

export function normalizePaymentType(formCode?: string, formDescription?: string): PaymentType | undefined {
  const code = (formCode ?? '').trim().toUpperCase()
  const desc = (formDescription ?? '').trim().toLowerCase()

  if (code === 'VADETAHHAV' || desc.includes('vadeli tahsilat havale')) return 'VADETAHHAV'
  if (code.startsWith('VADETAH') || desc.includes('vadeli tahsilat')) return 'VADETAH'
  if (code === 'HAVALE' || desc.includes('havale')) return 'HAVALE'
  if (code === 'CASH' || code === 'NAKIT' || desc.includes('nakit')) return 'NAKIT'
  if (code === 'BANKCARD' || code === 'CARD' || desc.includes('kart')) return 'BANKCARD'
  if (code === 'VADELI' || desc.includes('vadeli')) return 'VADELI'
  return undefined
}

export function normalizeInvoiceSalesType(salesType?: string): PaymentType | undefined {
  const s = (salesType ?? '').trim().toUpperCase()
  if (!s) return undefined
  if (s.includes('VADEL')) return 'VADELI'
  if (s.includes('HAVALE')) return 'HAVALE'
  if (s.includes('KART') || s.includes('CARD') || s.includes('BANKCARD')) return 'BANKCARD'
  if (s.includes('NAKIT') || s.includes('HHSATIS')) return 'NAKIT'
  return undefined
}
