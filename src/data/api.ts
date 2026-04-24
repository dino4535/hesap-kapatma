export interface ImportResultFile {
  fileName: string
  status?: 'pending' | 'running' | 'completed' | 'failed'
  errorMessage?: string
  progressPercent?: number
  invoiceCount: number
  paymentCount: number
  depotCode?: string
  fileDate?: string
  skipped?: boolean
  skippedPositions?: string[]
  positions?: Array<{
    positionCode: string
    totalInvoices: number
    totalCollections: number
    processedInvoices: number
    processedCollections: number
    status: 'pending' | 'processing' | 'imported' | 'skipped'
    progressPercent: number
    message?: string
  }>
}

export interface ImportResult {
  ok: boolean
  files: ImportResultFile[]
  message?: string
}
export interface ImportJobStartResult {
  ok: boolean
  accepted?: boolean
  jobId?: string
  totalFiles?: number
  statusUrl?: string
  message?: string
}
export interface ImportJobState {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  totalFiles: number
  processedFiles: number
  currentFileName?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  errorMessage?: string
  files: ImportResultFile[]
}
export interface ImportJobStatusResult {
  ok: boolean
  job?: ImportJobState
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

export async function importSalesFiles(files: File[], depotMap: Record<string, string>): Promise<ImportJobStartResult> {
  const form = new FormData()
  for (const f of files) form.append('files', f, f.name)
  form.append('depotMap', JSON.stringify(depotMap ?? {}))

  const res = await fetch('/api/import', { method: 'POST', body: form })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as ImportJobStartResult
}

export async function fetchImportJobStatus(jobId: string): Promise<ImportJobStatusResult> {
  const id = String(jobId ?? '').trim()
  if (!id) return { ok: false, message: 'jobId zorunlu' }
  const res = await fetch(`/api/import/jobs/${encodeURIComponent(id)}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as ImportJobStatusResult
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
  torbaTutari?: number
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
  bankExplanation?: string
  bankReceiptDateTime?: string
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
    bankExplanation?: string
    bankReceiptDateTime?: string
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

export async function deleteDataByDateDepot(args: {
  userName: string
  date: string
  depot: string
}): Promise<{ ok: boolean; deleted?: Record<string, unknown>; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('date', args.date)
  qs.set('depot', args.depot)
  const res = await fetch(`/api/admin/data?${qs.toString()}`, {
    method: 'DELETE',
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; deleted?: Record<string, unknown> }
}

export async function deleteDataByImportFile(args: {
  userName: string
  fileName: string
}): Promise<{ ok: boolean; deleted?: Record<string, unknown>; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('fileName', args.fileName)
  const res = await fetch(`/api/admin/import-file?${qs.toString()}`, {
    method: 'DELETE',
    headers: { 'x-user': args.userName },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; deleted?: Record<string, unknown> }
}

export interface ManimDekontCandidate {
  receiptNo: string
  receiptDate: string
  amount: number
  amountDiff: number
  dayDiff: number
  direction?: string
  explanation?: string
  bankAccountId?: string
  bankAccountLabel?: string
}

export async function findManimDekont(args: {
  userName: string
  bankName: string
  date: string
  amount: number
}): Promise<{ ok: boolean; match: ManimDekontCandidate | null; candidates: ManimDekontCandidate[]; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('bankName', args.bankName)
  qs.set('date', args.date)
  qs.set('amount', String(args.amount))
  const res = await fetch(`/api/manim/dekont?${qs.toString()}`, { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, match: null, candidates: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; match: ManimDekontCandidate | null; candidates: ManimDekontCandidate[]; message?: string }
}

export interface ManimReceiptRow {
  receiptNo: string
  receiptDate: string
  amount: number
  direction?: string
  explanation?: string
  bankAccountId?: string
  bankAccountLabel?: string
}

export async function fetchManimReceipts(args: {
  userName: string
  bankName: string
  date: string
}): Promise<{ ok: boolean; receipts: ManimReceiptRow[]; message?: string }> {
  const qs = new URLSearchParams()
  qs.set('bankName', args.bankName)
  qs.set('date', args.date)
  const res = await fetch(`/api/manim/receipts?${qs.toString()}`, { headers: { 'x-user': args.userName } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, receipts: [], message: text || `HTTP ${res.status}` }
  }
  return (await res.json()) as { ok: boolean; receipts: ManimReceiptRow[]; message?: string }
}
