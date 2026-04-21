import type { Invoice, RepStats } from './models'

export function calculateStats(data: Invoice[]) {
  const byRep: Record<string, RepStats> = {}
  for (const item of data) {
    const rep = item.position.code || 'Bilinmeyen'
    if (!byRep[rep]) byRep[rep] = { total: 0, vadeli: 0, hhsat: 0, count: 0 }
    byRep[rep].total += item.netAmount
    byRep[rep].count += 1
    if (item.salesType === 'VADELISATIS') byRep[rep].vadeli += item.netAmount
    else byRep[rep].hhsat += item.netAmount
  }
  return byRep
}
