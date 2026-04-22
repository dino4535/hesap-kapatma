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
  mutabakatStatus?: 'DRAFT' | 'COMPLETED' | null
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

export type MutabakatMode = 'NAKIT' | 'BANKA' | 'KARMA'

export interface MutabakatAdjustment {
  id: string
  type: 'ACIK' | 'HATALI_TAHSILAT' | 'DIGER'
  description?: string
  amount: number
}

export interface MutabakatRecord {
  sourceFileDate: string
  depotCode: string
  positionCode: string
  mode: MutabakatMode
  torbaTutari: number
  enteredAmount: number
  adjustmentAmount: number
  diffAmount: number
  cashJson?: unknown
  bankName?: string
  bankDepositAmount?: number
  dekontNo?: string
  adjustments?: MutabakatAdjustment[]
  status: 'DRAFT' | 'COMPLETED'
  updatedAt?: string
  updatedBy?: string
  completedAt?: string
  completedBy?: string
}

export async function fetchMutabakat(args: {
  date: string
  depot: string
  position: string
}): Promise<{ ok: boolean; record: MutabakatRecord | null; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('date', args.date)
  qs.set('depot', args.depot)
  qs.set('position', args.position)
  const res = await fetch(`/api/mutabakat?${qs.toString()}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, record: null, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; record: MutabakatRecord | null }
}

export async function saveMutabakat(args: {
  userName: string
  record: {
    sourceFileDate: string
    depotCode: string
    positionCode: string
    mode: MutabakatMode
    torbaTutari: number
    enteredAmount: number
    bankName?: string
    bankDepositAmount?: number
    dekontNo?: string
    cashJson?: unknown
    adjustments?: MutabakatAdjustment[]
  }
}): Promise<{ ok: boolean; record?: MutabakatRecord; message?: string }> {
  const res = await fetch('/api/mutabakat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify(args.record),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; record: MutabakatRecord }
}

export async function completeMutabakat(args: {
  userName: string
  sourceFileDate: string
  depotCode: string
  positionCode: string
}): Promise<{ ok: boolean; record?: MutabakatRecord; message?: string }> {
  const res = await fetch('/api/mutabakat/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({
      sourceFileDate: args.sourceFileDate,
      depotCode: args.depotCode,
      positionCode: args.positionCode,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; record: MutabakatRecord }
}

export interface PositionRepresentativeRow {
  positionCode: string
  representativeName: string
  updatedAt?: string
  updatedBy?: string
}

export async function fetchPositionRepresentatives(args: {
  userName: string
}): Promise<{ ok: boolean; mappings: PositionRepresentativeRow[]; message?: string }> {
  const res = await fetch('/api/position-representatives', {
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, mappings: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; mappings: PositionRepresentativeRow[] }
}

export async function savePositionRepresentative(args: {
  userName: string
  positionCode: string
  representativeName: string
}): Promise<{ ok: boolean; mapping?: PositionRepresentativeRow; message?: string }> {
  const res = await fetch('/api/position-representatives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ positionCode: args.positionCode, representativeName: args.representativeName }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; mapping: PositionRepresentativeRow }
}

export async function deletePositionRepresentative(args: {
  userName: string
  positionCode: string
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/position-representatives/${encodeURIComponent(args.positionCode)}`, {
    method: 'DELETE',
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}

export interface UserRow {
  userName: string
  isAdmin: boolean
  isActive: boolean
  createdAt?: string
}

export async function fetchUsers(args: {
  userName: string
}): Promise<{ ok: boolean; users: UserRow[]; message?: string }> {
  const res = await fetch('/api/users', {
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, users: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; users: UserRow[] }
}

export async function createUserAsAdmin(args: {
  userName: string
  newUserName: string
  password: string
  isAdmin: boolean
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': args.userName },
    body: JSON.stringify({ userName: args.newUserName, password: args.password, isAdmin: args.isAdmin }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean }
}
