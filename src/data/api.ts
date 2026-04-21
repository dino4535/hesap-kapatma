export interface ImportResultFile {
  fileName: string
  invoiceCount: number
  paymentCount: number
  depotCode?: string
  fileDate?: string
  skipped?: boolean
  skippedPositions?: string[]
}

export interface ImportResult {
  ok: boolean
  files: ImportResultFile[]
  message?: string
}

export async function importSalesFiles(files: File[]): Promise<ImportResult> {
  const form = new FormData()
  for (const f of files) form.append('files', f, f.name)

  const res = await fetch('/api/import', { method: 'POST', body: form })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, files: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as ImportResult
}

export interface PositionRow {
  code: string
  description?: string
  invoiceCount: number
}

export async function fetchPositions(): Promise<{ ok: boolean; positions: PositionRow[]; message?: string }> {
  const res = await fetch('/api/positions')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, positions: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; positions: PositionRow[] }
}

export async function fetchPositionData(positionCode: string): Promise<{
  ok: boolean
  positionCode: string
  invoices: unknown[]
  collections: unknown[]
  invoiceAllocations: Record<string, unknown>
  paymentAllocations: Record<string, unknown>
  message?: string
}> {
  const res = await fetch(`/api/positions/${encodeURIComponent(positionCode)}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      positionCode,
      invoices: [],
      collections: [],
      invoiceAllocations: {},
      paymentAllocations: {},
      message: text || `HTTP ${res.status}`,
    }
  }
  return (await res.json()) as {
    ok: boolean
    positionCode: string
    invoices: unknown[]
    collections: unknown[]
    invoiceAllocations: Record<string, unknown>
    paymentAllocations: Record<string, unknown>
  }
}

export async function saveInvoiceAllocationsSql(args: {
  userName: string
  invoiceCode: string
  allocations: unknown[]
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/allocations/invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ invoiceCode: args.invoiceCode, allocations: args.allocations }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export async function savePaymentAllocationsSql(args: {
  userName: string
  paymentKey: string
  allocations: unknown[]
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/allocations/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ paymentKey: args.paymentKey, allocations: args.allocations }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}
