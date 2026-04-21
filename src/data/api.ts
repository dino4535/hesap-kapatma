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

export interface ImportFileRow {
  fileName: string
  fileDate?: string
  depotCode?: string
  importedAt?: string
  invoiceCount: number
  paymentCount: number
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

export async function fetchImportFiles(): Promise<{ ok: boolean; files: ImportFileRow[]; message?: string }> {
  const res = await fetch('/api/import-files')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, files: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; files: ImportFileRow[] }
}

export interface PositionRow {
  code: string
  description?: string
  invoiceCount: number
}

export async function fetchPositions(args?: {
  date?: string | null
  depot?: string | null
}): Promise<{ ok: boolean; positions: PositionRow[]; message?: string }> {
  const qs = new URLSearchParams()
  if (args?.date) qs.set('date', args.date)
  if (args?.depot) qs.set('depot', args.depot)
  const url = qs.toString() ? `/api/positions?${qs.toString()}` : '/api/positions'
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, positions: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; positions: PositionRow[] }
}

export async function fetchPositionData(
  positionCode: string,
  args?: { date?: string | null; depot?: string | null },
): Promise<{
  ok: boolean
  positionCode: string
  invoices: unknown[]
  collections: unknown[]
  invoiceAllocations: Record<string, unknown>
  paymentAllocations: Record<string, unknown>
  message?: string
}> {
  const qs = new URLSearchParams()
  if (args?.date) qs.set('date', args.date)
  if (args?.depot) qs.set('depot', args.depot)
  const url = qs.toString()
    ? `/api/positions/${encodeURIComponent(positionCode)}?${qs.toString()}`
    : `/api/positions/${encodeURIComponent(positionCode)}`
  const res = await fetch(url)
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
