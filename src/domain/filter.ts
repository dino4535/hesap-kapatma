import type { Invoice } from './models'

export interface Filters {
  rep?: string
  saleType?: string
  minAmount?: number
  maxAmount?: number
}

export function applyFilters(all: Invoice[], f: Filters) {
  const rep = f.rep ?? ''
  const type = f.saleType ?? ''
  const min = f.minAmount ?? 0
  const max = f.maxAmount ?? Number.POSITIVE_INFINITY

  return all.filter((item) => {
    if (rep && item.position.code !== rep) return false
    if (type && item.salesType !== type) return false
    if (item.netAmount < min) return false
    if (item.netAmount > max) return false
    return true
  })
}
