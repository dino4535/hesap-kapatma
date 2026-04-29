import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import multer from 'multer'
import mssql from 'mssql'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchKisanReceiptsFromDevice } from './kisan/client.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(moduleDir, '../.env') })
dotenv.config({ path: path.resolve(moduleDir, '../../.env') })
dotenv.config()

function readEnvMs(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

const env = {
  sqlServer: process.env.SQL_SERVER ?? '',
  sqlUser: process.env.SQL_USER ?? '',
  sqlPassword: process.env.SQL_PASSWORD ?? '',
  sqlDatabase: process.env.SQL_DATABASE ?? 'HesapKapatma',
  sqlPort: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined,
  sqlTrustServerCertificate: (process.env.SQL_TRUST_SERVER_CERT ?? 'true').toLowerCase() !== 'false',
  cariSqlServer: process.env.CARI_SQL_SERVER ?? process.env.DINO_SQL_SERVER ?? '192.168.12.192',
  cariSqlUser: process.env.CARI_SQL_USER ?? process.env.DINO_SQL_USER ?? process.env.SQL_USER ?? '',
  cariSqlPassword: process.env.CARI_SQL_PASSWORD ?? process.env.DINO_SQL_PASSWORD ?? process.env.SQL_PASSWORD ?? '',
  cariSqlDatabase: process.env.CARI_SQL_DATABASE ?? process.env.DINO_SQL_DATABASE ?? 'DINO2026',
  cariSqlPort: process.env.CARI_SQL_PORT ? Number(process.env.CARI_SQL_PORT) : undefined,
  cariSqlTrustServerCertificate: (process.env.CARI_SQL_TRUST_SERVER_CERT ?? process.env.SQL_TRUST_SERVER_CERT ?? 'true').toLowerCase() !== 'false',
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
  adminSecret: process.env.ADMIN_SECRET ?? '',
  manimDir: process.env.MANIM_DIR ?? '',
  manimBaseUrl: process.env.MANIM_BASE_URL ?? process.env.MANIM_API_BASE ?? '',
  manimLoginUrl: process.env.MANIM_LOGIN_URL ?? process.env.LOGIN_URL ?? '',
  manimToken: process.env.MANIM_TOKEN ?? '',
  manimAuthPath: process.env.MANIM_AUTH_PATH ?? '/auth/login',
  manimUser: process.env.MANIM_USER ?? process.env.MANIM_USERNAME ?? process.env.MANIM_EMAIL ?? '',
  manimPassword: process.env.MANIM_PASSWORD ?? '',
  manimTokenRefreshSkewSec: readEnvMs('MANIM_TOKEN_REFRESH_SKEW_SEC', 60),
  httpRequestTimeoutMs: readEnvMs('HTTP_REQUEST_TIMEOUT_MS', 15 * 60 * 1000),
  httpHeadersTimeoutMs: readEnvMs('HTTP_HEADERS_TIMEOUT_MS', 2 * 60 * 1000),
  httpKeepAliveTimeoutMs: readEnvMs('HTTP_KEEPALIVE_TIMEOUT_MS', 75 * 1000),
  importJobTtlMs: readEnvMs('IMPORT_JOB_TTL_MS', 6 * 60 * 60 * 1000),
  importUploadDir: process.env.IMPORT_UPLOAD_DIR?.trim() || path.resolve(moduleDir, '../uploads/import-jobs'),
}

const manimEnvFileCandidates = Array.from(
  new Set([
    path.resolve(moduleDir, '../.env'),
    path.resolve(moduleDir, '../.env.local'),
    path.resolve(moduleDir, '../.env.production'),
    path.resolve(moduleDir, '../.env.development'),
    path.resolve(moduleDir, '../../.env'),
    path.resolve(moduleDir, '../../.env.local'),
    path.resolve(moduleDir, '../../.env.production'),
    path.resolve(moduleDir, '../../.env.development'),
    path.resolve(moduleDir, 'server/.env'),
    path.resolve(moduleDir, 'server/.env.local'),
    path.resolve(moduleDir, 'server/.env.production'),
    path.resolve(moduleDir, 'server/.env.development'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env.production'),
    path.resolve(process.cwd(), '.env.development'),
    path.resolve(process.cwd(), 'server/.env'),
    path.resolve(process.cwd(), 'server/.env.local'),
    path.resolve(process.cwd(), 'server/.env.production'),
    path.resolve(process.cwd(), 'server/.env.development'),
  ]),
)
let manimEnvLastSyncDebug = 'sync-calismadi'

function firstNonEmpty(values: Array<unknown>) {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

async function syncManimConfigFromEnvironment() {
  const parsedFromFiles: Record<string, string> = {}
  const debugRows: string[] = []
  for (const candidate of manimEnvFileCandidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf-8')
      const parsed = dotenv.parse(raw)
      const hasUser = !!firstNonEmpty([parsed.MANIM_USER, parsed.MANIM_USERNAME, parsed.MANIM_EMAIL])
      const hasPassword = !!firstNonEmpty([parsed.MANIM_PASSWORD])
      debugRows.push(`${candidate} user=${hasUser ? '1' : '0'} pass=${hasPassword ? '1' : '0'}`)
      for (const [k, v] of Object.entries(parsed)) {
        if (!parsedFromFiles[k] && String(v ?? '').trim()) {
          parsedFromFiles[k] = String(v ?? '')
        }
      }
    } catch {
      debugRows.push(`${candidate} read=0`)
    }
  }

  const nextBaseUrl = firstNonEmpty([
    process.env.MANIM_BASE_URL,
    process.env.MANIM_API_BASE,
    parsedFromFiles.MANIM_BASE_URL,
    parsedFromFiles.MANIM_API_BASE,
    env.manimBaseUrl,
  ])
  const nextLoginUrl = firstNonEmpty([
    process.env.MANIM_LOGIN_URL,
    process.env.LOGIN_URL,
    parsedFromFiles.MANIM_LOGIN_URL,
    parsedFromFiles.LOGIN_URL,
    env.manimLoginUrl,
  ])
  const nextAuthPath = firstNonEmpty([process.env.MANIM_AUTH_PATH, parsedFromFiles.MANIM_AUTH_PATH, env.manimAuthPath, '/auth/login'])
  const nextUser = firstNonEmpty([
    process.env.MANIM_USER,
    process.env.MANIM_USERNAME,
    process.env.MANIM_EMAIL,
    parsedFromFiles.MANIM_USER,
    parsedFromFiles.MANIM_USERNAME,
    parsedFromFiles.MANIM_EMAIL,
    env.manimUser,
  ])
  const nextPassword = firstNonEmpty([process.env.MANIM_PASSWORD, parsedFromFiles.MANIM_PASSWORD, env.manimPassword])
  const nextToken = firstNonEmpty([process.env.MANIM_TOKEN, parsedFromFiles.MANIM_TOKEN, env.manimToken])
  const skewRaw = firstNonEmpty([process.env.MANIM_TOKEN_REFRESH_SKEW_SEC, parsedFromFiles.MANIM_TOKEN_REFRESH_SKEW_SEC])
  const skew = Number(skewRaw)

  env.manimBaseUrl = nextBaseUrl
  env.manimLoginUrl = nextLoginUrl
  env.manimAuthPath = nextAuthPath
  env.manimUser = nextUser
  env.manimPassword = nextPassword
  env.manimToken = nextToken
  if (Number.isFinite(skew) && skew > 0) env.manimTokenRefreshSkewSec = Math.floor(skew)
  manimEnvLastSyncDebug = debugRows.join(' | ')
}

type SalesFileMeta = { fileName: string; fileDate?: string; depotCode?: string }
type ImportRuntimeState = {
  upsertedPositions: Set<string>
  upsertedCustomers: Set<string>
  upsertedProducts: Set<string>
  knownInvoices: Set<string>
}
type ImportPositionProgress = {
  positionCode: string
  totalInvoices: number
  totalCollections: number
  processedInvoices: number
  processedCollections: number
  status: 'pending' | 'processing' | 'imported' | 'skipped'
  progressPercent: number
  message?: string
}
type ImportResultFile = {
  fileName: string
  invoiceCount: number
  paymentCount: number
  depotCode?: string
  fileDate?: string
  skipped?: boolean
  skippedPositions?: string[]
  positions?: ImportPositionProgress[]
}
type QueuedImportFile = {
  fileName: string
  serverFilePath: string
  selectedDepot: string | null
  status: 'pending' | 'running' | 'completed' | 'failed'
  errorMessage?: string
  positions: ImportPositionProgress[]
}
type ImportJobStatus = 'queued' | 'running' | 'completed' | 'failed'
type ImportJob = {
  id: string
  ownerUserName: string
  status: ImportJobStatus
  files: QueuedImportFile[]
  results: ImportResultFile[]
  totalFiles: number
  processedFiles: number
  currentFileName?: string
  errorMessage?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

function sanitizeUploadFileName(fileName: string) {
  const safe = fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim()
  return safe || 'upload.json'
}

function normalizePositionCode(raw: unknown) {
  const code = (toStringOrUndef(raw) ?? '').trim()
  return code || 'UNKNOWN'
}

function buildPositionSkeleton(parsed: RawSalesFile): ImportPositionProgress[] {
  const counters = new Map<string, { invoices: number; collections: number }>()
  const invoices = Array.isArray(parsed.INVOICES) ? (parsed.INVOICES as RawInvoice[]) : []
  const collections = Array.isArray(parsed.COLLECTIONS) ? (parsed.COLLECTIONS as RawCollection[]) : []

  for (const inv of invoices) {
    const pos = normalizePositionCode(inv?.POSITION?.CODE)
    const c = counters.get(pos) ?? { invoices: 0, collections: 0 }
    c.invoices += 1
    counters.set(pos, c)
  }
  for (const col of collections) {
    const pos = normalizePositionCode(col?.POSITION?.CODE)
    const c = counters.get(pos) ?? { invoices: 0, collections: 0 }
    c.collections += 1
    counters.set(pos, c)
  }
  return Array.from(counters.entries()).map(([positionCode, c]) => ({
    positionCode,
    totalInvoices: c.invoices,
    totalCollections: c.collections,
    processedInvoices: 0,
    processedCollections: 0,
    status: 'pending',
    progressPercent: 0,
  }))
}

async function safeDeleteFile(filePath: string) {
  try {
    await fs.unlink(filePath)
  } catch (e) {
    const code = typeof e === 'object' && e ? String((e as { code?: unknown }).code ?? '') : ''
    if (code !== 'ENOENT') throw e
  }
}

function normalizeIpText(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

function normalizeDeviceCredentials(input: { ip?: unknown; user?: unknown; password?: unknown }) {
  const ip = normalizeIpText(input.ip)
  const user = String(input.user ?? '').trim()
  const password = String(input.password ?? '').trim()
  return { ip, user, password }
}

function buildCounterId(args: { rawId?: unknown; transactionDateTime?: unknown }) {
  const rawId = String(args.rawId ?? '').trim()
  const time = String(args.transactionDateTime ?? '').trim()
  if (time) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.:](\d{1,6}))?/.exec(time)
    if (m) {
      const ms = String(m[7] ?? '000').slice(0, 3).padEnd(3, '0')
      return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}${ms}`
    }
  }
  const digits = rawId.replace(/\D+/g, '')
  return digits || rawId
}

function buildReceiptIdVariants(args: { rawId?: unknown; transactionDateTime?: unknown }) {
  const out = new Set<string>()
  const rawId = String(args.rawId ?? '').trim()
  const canonical = buildCounterId(args).trim()
  if (canonical) out.add(canonical)
  if (rawId) out.add(rawId)
  const rawDigits = rawId.replace(/\D+/g, '').trim()
  if (rawDigits) out.add(rawDigits)
  return out
}

function mapReceiptBanknotes(details: Array<{ nominal?: number; qty?: number }> | undefined) {
  const out: Record<string, number> = { '200': 0, '100': 0, '50': 0, '20': 0, '10': 0, '5': 0, '1': 0 }
  for (const d of details ?? []) {
    const nominal = Number(d?.nominal ?? 0)
    const qty = Number(d?.qty ?? 0)
    if (!Number.isFinite(nominal) || !Number.isFinite(qty)) continue
    const key = String(Math.round(nominal))
    if (!(key in out)) continue
    out[key] += qty
  }
  return out
}

function parseSalesFileName(fileName: string): SalesFileMeta {
  const base = fileName.replace(/\.json$/i, '')
  const m = /^(\d{8})_([A-Z0-9]+)_SALES$/i.exec(base)
  if (!m) return { fileName }
  const y = m[1].slice(0, 4)
  const mo = m[1].slice(4, 6)
  const d = m[1].slice(6, 8)
  return {
    fileName,
    fileDate: `${y}-${mo}-${d}`,
    depotCode: m[2].toUpperCase(),
  }
}

function normalizeDepotCode(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null

  const upper = raw.toUpperCase()
  const upperTr = raw.toLocaleUpperCase('tr-TR')

  const normalized = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()

  const n = normalized(raw)
  if (upper === 'DIST2F' || upperTr === 'DIST2F') return 'DIST2F'
  if (upper === 'DIST28' || upperTr === 'DIST28') return 'DIST28'
  if (upper === 'DIST2K' || upperTr === 'DIST2K') return 'DIST2K'

  if (upper === 'MANISA' || upperTr === 'MANİSA' || n === 'MANISA') return 'DIST2F'
  if (upper === 'SALIHLI' || upperTr === 'SALİHLİ' || n === 'SALIHLI') return 'DIST28'
  if (upper === 'IZMIR' || upperTr === 'İZMİR' || n === 'IZMIR') return 'DIST2K'

  return upperTr || upper || null
}

type RawSalesFile = { INVOICES?: unknown; COLLECTIONS?: unknown; Id?: unknown; RowCount?: unknown; ModDate?: unknown }
type RawInvoice = {
  CODE?: unknown
  ISEDOS?: unknown
  LEGALNUMBER?: unknown
  STATUS?: unknown
  SALESTYPE?: unknown
  ISSUEDATE?: unknown
  DUEDATE?: unknown
  CREDITDAYS?: unknown
  NETAMOUNT?: unknown
  GROSSAMOUNT?: unknown
  OUTSTANDINGAMOUNT?: unknown
  TAXAMOUNT?: unknown
  TOTAL_DISCOUNT?: unknown
  CUSTOMER?: {
    CODE?: unknown
    REGISTEREDNAME?: unknown
    TAXNUMBER?: unknown
    LICENSENUMBER?: unknown
  }
  POSITION?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  PAYMENTS?: unknown
  DETAILS?: unknown
  RETURNGOODS?: unknown
}

type RawInvoicePayment = {
  CODE?: unknown
  ISSUEDATE?: unknown
  AMOUNT?: unknown
  PAYMENTFORM?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  PAYMENT_FORM?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
}

type RawInvoiceDetailProduct = {
  SEQUENCE?: unknown
  CODE?: unknown
  DESCRIPTION?: unknown
}

type RawInvoiceDetail = {
  PRODUCT?: RawInvoiceDetailProduct
  QUANTITY?: unknown
  NETAMOUNT?: unknown
  GROSSAMOUNT?: unknown
  PRICE?: unknown
  AVAILABILITY?: unknown
}

type RawCollection = {
  POSITION?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  CODE?: unknown
  INVOICE_CODE?: unknown
  ISSUEDATE?: unknown
  AMOUNT?: unknown
  PAYMENTFORM?: {
    CODE?: unknown
    DESCRIPTION?: unknown
  }
  CUSTOMER?: {
    CODE?: unknown
    REGISTEREDNAME?: unknown
    TAXNUMBER?: unknown
    LICENSENUMBER?: unknown
  }
}

const toStringOrUndef = (v: unknown) => (typeof v === 'string' ? v : undefined)
const toNumberOrUndef = (v: unknown) => (typeof v === 'number' ? v : undefined)

function toNumberFlexible(v: unknown) {
  const n = toNumberOrUndef(v)
  if (typeof n === 'number') return n
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined

  // Normalize localized values like "1.234,56", "1,234.56", "1 234,56", "₺1.234,56"
  const normalized = s
    .replace(/[\s\u00A0\u202F]/g, '')
    .replace(/[^\d,.\-+]/g, '')
  if (!normalized) return undefined

  const lastComma = normalized.lastIndexOf(',')
  const lastDot = normalized.lastIndexOf('.')
  let canonical = normalized
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      canonical = normalized.replaceAll('.', '').replace(',', '.')
    } else {
      canonical = normalized.replaceAll(',', '')
    }
  } else if (lastComma >= 0) {
    canonical = normalized.replaceAll('.', '').replace(',', '.')
  } else if (lastDot >= 0) {
    const dotCount = (normalized.match(/\./g) ?? []).length
    canonical = dotCount > 1 ? normalized.replaceAll('.', '') : normalized
  }

  const parsed = Number(canonical)
  return Number.isFinite(parsed) ? parsed : undefined
}

function safeDate(value?: string) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  if (y < 1 || y > 9999) return null
  return d
}

function computePaymentKey(invoiceCode: string, p: { code?: string; issueDate?: string; amount: number; formCode?: string }) {
  return `${invoiceCode}|${p.code ?? ''}|${p.issueDate ?? ''}|${p.amount}|${p.formCode ?? ''}`
}

function computeInvoicePaymentKey(invoiceCode: string, p: { code?: string; issueDate?: string; amount: number; formCode?: string }) {
  return `INV|${computePaymentKey(invoiceCode, p)}`
}

function normalizeManimMatch(value: string) {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll('ı', 'i')
    .replaceAll('İ', 'i')
    .replaceAll('ş', 's')
    .replaceAll('ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('ö', 'o')
    .replaceAll('ç', 'c')
    .replace(/[^a-z0-9]+/g, '')
}

function manimBankMatchers(bankName: string) {
  const n = normalizeManimMatch(bankName)
  if (!n) return []
  if (n.includes('ziraat')) return ['ziraat']
  if (n.includes('isbankasi') || n.includes('isbank')) return ['isbankasi', 'isbank']
  if (n.includes('garanti')) return ['garanti']
  if (n.includes('yapikredi') || n.includes('ykb')) return ['yapikredi', 'ykb']
  if (n.includes('akbank')) return ['akbank']
  if (n.includes('vakifbank') || n.includes('vakif')) return ['vakifbank', 'vakif']
  if (n.includes('halkbank') || n.includes('halk')) return ['halkbank', 'halk']
  if (n.includes('qnb') || n.includes('finans')) return ['qnb', 'finans']
  if (n.includes('denizbank') || n.includes('deniz')) return ['denizbank', 'deniz']
  return [n]
}

function getManimDir() {
  const fromEnv = env.manimDir.trim()
  if (fromEnv) return fromEnv
  return path.resolve(process.cwd(), '..', '..', 'Manim')
}

type ManimAccount = { id: string; label: string }

async function loadManimAccounts(): Promise<ManimAccount[]> {
  const manimDir = getManimDir()
  const statePath = path.join(manimDir, 'sync_state.json')
  try {
    const raw = await fs.readFile(statePath, 'utf-8')
    const parsed = JSON.parse(raw) as { accounts?: Record<string, { label?: unknown }> }
    const accounts = parsed?.accounts ?? {}
    return Object.entries(accounts)
      .map(([id, v]) => ({ id: String(id), label: String(v?.label ?? '').trim() }))
      .filter((x) => x.id && x.label)
  } catch {
    return []
  }
}

type ManimReceiptCandidate = {
  receiptNo: string
  receiptDate: string
  amount: number
  direction?: string
  explanation?: string
  correspondentCode?: string
  correspondentLabel?: string
  bankAccountId?: string
  bankAccountLabel?: string
}

function manimIsoDay(d: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function manimIstanbulUtcRange(isoDay: string) {
  const [yRaw, mRaw, dRaw] = isoDay.split('-')
  const y = Number(yRaw)
  const m = Number(mRaw)
  const d = Number(dRaw)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return { startIso: `${isoDay}T00:00:00.000Z`, endIso: `${isoDay}T23:59:59.999Z` }
  }
  // Turkey is UTC+3 year-round. Convert local-day boundaries to UTC.
  const start = new Date(Date.UTC(y, m - 1, d, -3, 0, 0, 0))
  const end = new Date(Date.UTC(y, m - 1, d, 20, 59, 59, 999))
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

function manimAbsDiff(a: number, b: number) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0))
}

async function loadManimReceipts(accountId: string): Promise<ManimReceiptCandidate[]> {
  const manimDir = getManimDir()
  const filePath = path.join(manimDir, 'hesap_hareketleri', `${accountId}.json`)
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const rows = JSON.parse(raw) as unknown
    if (!Array.isArray(rows)) return []
    return rows
      .map((r) => {
        const obj = r as any
        const receiptNo = String(obj?.receiptNo ?? '').trim()
        const receiptDate = String(obj?.receiptDate ?? '').trim()
        const amount = typeof obj?.receiptAmount === 'number' ? obj.receiptAmount : toNumberFlexible(obj?.receiptAmount) ?? 0
        const direction = typeof obj?.direction === 'string' ? obj.direction : undefined
        const explanation = typeof obj?.explanation === 'string' ? obj.explanation : undefined
        const correspondentCode =
          String(
            obj?.correspondentCode ??
              obj?.correspondent?.code ??
              obj?.correspondent?.erpCode ??
              '',
          ).trim() || undefined
        const correspondentLabel = String(obj?.correspondent?.label ?? '').trim() || undefined
        const bankAccountId = typeof obj?.bankAccount?._id === 'string' ? obj.bankAccount._id : accountId
        const bankAccountLabel = typeof obj?.bankAccount?.label === 'string' ? obj.bankAccount.label : undefined
        if (!receiptNo || !receiptDate || !Number.isFinite(amount)) return null
        const candidate: ManimReceiptCandidate = {
          receiptNo,
          receiptDate,
          amount,
          ...(direction ? { direction } : {}),
          ...(explanation ? { explanation } : {}),
          ...(correspondentCode ? { correspondentCode } : {}),
          ...(correspondentLabel ? { correspondentLabel } : {}),
          ...(bankAccountId ? { bankAccountId } : {}),
          ...(bankAccountLabel ? { bankAccountLabel } : {}),
        }
        return candidate
      })
      .filter((x): x is ManimReceiptCandidate => !!x)
  } catch {
    return []
  }
}

function hasManimRemoteConfig() {
  const hasBase = !!env.manimBaseUrl.trim()
  const hasStaticToken = !!env.manimToken.trim()
  const hasRefreshCreds = !!env.manimUser.trim() && !!env.manimPassword.trim()
  return hasBase && (hasStaticToken || hasRefreshCreds)
}

type ManimTokenState = {
  token: string
  expiresAtMs?: number
  refreshing?: Promise<string>
}

const manimTokenState: ManimTokenState = {
  token: env.manimToken.trim(),
  expiresAtMs: undefined,
}

function parseJwtExpMs(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payloadRaw = Buffer.from(parts[1], 'base64url').toString('utf-8')
    const payload = JSON.parse(payloadRaw) as { exp?: unknown }
    const expSec = typeof payload.exp === 'number' ? payload.exp : undefined
    if (!expSec || !Number.isFinite(expSec)) return undefined
    return expSec * 1000
  } catch {
    return undefined
  }
}

manimTokenState.expiresAtMs = parseJwtExpMs(manimTokenState.token)

function isManimTokenExpiredOrNear(expMs?: number) {
  if (!expMs) return false
  const skewMs = Math.max(5, env.manimTokenRefreshSkewSec) * 1000
  return Date.now() >= expMs - skewMs
}

function extractManimTokenFromAuthResponse(obj: unknown) {
  const x = obj as any
  const direct =
    (typeof x?.token === 'string' && x.token) ||
    (typeof x?.accessToken === 'string' && x.accessToken) ||
    (typeof x?.jwt === 'string' && x.jwt) ||
    (typeof x?.id_token === 'string' && x.id_token) ||
    (typeof x?.data?.token === 'string' && x.data.token) ||
    (typeof x?.data?.accessToken === 'string' && x.data.accessToken) ||
    ''
  return String(direct || '').trim()
}

async function refreshManimToken(): Promise<string> {
  await syncManimConfigFromEnvironment()
  if (!env.manimBaseUrl.trim()) throw new Error('MANIM_BASE_URL tanimli degil')

  const configuredToken = env.manimToken.trim()
  if (configuredToken) {
    const expMs = parseJwtExpMs(configuredToken)
    if (!isManimTokenExpiredOrNear(expMs)) {
      manimTokenState.token = configuredToken
      manimTokenState.expiresAtMs = expMs
      return configuredToken
    }
  }

  if (!env.manimUser.trim() || !env.manimPassword.trim()) {
    const missing: string[] = []
    if (!env.manimUser.trim()) missing.push('MANIM_USER')
    if (!env.manimPassword.trim()) missing.push('MANIM_PASSWORD')
    throw new Error(
      `Manim token suresi doldu. Otomatik yenileme icin MANIM_USER ve MANIM_PASSWORD gerekli. Eksik: ${missing.join(', ')}. EnvDebug: ${manimEnvLastSyncDebug}`,
    )
  }

  const authPaths = uniqueStrings([
    env.manimAuthPath.trim(),
    '/auth/login',
    '/auth/signin',
    '/user/login',
    '/users/login',
    '/login',
  ])
  const authUrls = uniqueStrings([
    env.manimLoginUrl.trim(),
    ...manimBaseUrlCandidates().flatMap((base) => authPaths.map((p) => combineManimUrl(base, p))),
  ])

  const payloads = [
    { email: env.manimUser, password: env.manimPassword, rememberMe: true },
    { email: env.manimUser, password: env.manimPassword },
    { userName: env.manimUser, password: env.manimPassword },
    { username: env.manimUser, password: env.manimPassword },
  ]

  let lastError = ''
  const tried: string[] = []
  for (const url of authUrls) {
    for (const body of payloads) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text().catch(() => '')
      tried.push(`${res.status} ${url}`)
      if (!res.ok) {
        lastError = text || `Manim auth HTTP ${res.status}`
        if (res.status === 404 || res.status === 405) break
        continue
      }
      const parsed = (() => {
        try {
          return text ? JSON.parse(text) : null
        } catch {
          return null
        }
      })()
      const token = extractManimTokenFromAuthResponse(parsed)
      if (!token) {
        lastError = 'Manim auth basarili fakat token donmedi'
        continue
      }
      manimTokenState.token = token
      manimTokenState.expiresAtMs = parseJwtExpMs(token)
      return token
    }
  }

  const triedText = tried.length ? ` Denenen auth URL'leri: ${tried.join(' | ')}` : ''
  throw new Error((lastError || 'Manim token yenilenemedi') + triedText)
}

async function getManimToken(forceRefresh = false): Promise<string> {
  const hasToken = !!manimTokenState.token
  const shouldRefresh = forceRefresh || !hasToken || isManimTokenExpiredOrNear(manimTokenState.expiresAtMs)
  if (!shouldRefresh) return manimTokenState.token
  if (manimTokenState.refreshing) return manimTokenState.refreshing

  manimTokenState.refreshing = refreshManimToken().finally(() => {
    manimTokenState.refreshing = undefined
  })
  return manimTokenState.refreshing
}

async function manimRemoteHeaders() {
  const token = await getManimToken(false)
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  } as const
}

function manimEncodeQuery(obj: unknown) {
  return encodeURIComponent(JSON.stringify(obj))
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const x = String(v ?? '').trim()
    if (!x || seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

function manimBaseUrlCandidates() {
  const raw = env.manimBaseUrl.trim().replace(/\/+$/, '')
  if (!raw) return []
  const hasApi = /\/api$/i.test(raw)
  const withApi = hasApi ? raw : `${raw}/api`
  const withoutApi = hasApi ? raw.replace(/\/api$/i, '') : raw
  return uniqueStrings([raw, withApi, withoutApi])
}

function combineManimUrl(base: string, endpointPath: string) {
  const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`
  return `${base.replace(/\/+$/, '')}${normalizedPath}`
}

function isManimTokenExpiredResponse(status: number, bodyText: string) {
  if (status === 401) return true
  const t = (bodyText ?? '').toLowerCase()
  return t.includes('jwtexpirederror') || t.includes('jwt expired') || t.includes('token expired')
}

async function manimFetchJson<T>(url: string): Promise<T> {
  const run = async () => {
    const headers = await manimRemoteHeaders()
    const res = await fetch(url, { headers })
    const text = await res.text().catch(() => '')
    const parsed = (() => {
      try {
        return text ? (JSON.parse(text) as T) : (null as T)
      } catch {
        return null
      }
    })()
    return { res, text, parsed }
  }

  let first = await run()
  if (!first.res.ok && isManimTokenExpiredResponse(first.res.status, first.text)) {
    await getManimToken(true)
    first = await run()
  }
  if (!first.res.ok) {
    throw new Error(first.text || `Manim HTTP ${first.res.status}`)
  }
  return first.parsed as T
}

async function manimFetchJsonWithFallback<T>(urls: string[]): Promise<T> {
  const candidates = uniqueStrings(urls)
  let last404Error = ''
  for (const url of candidates) {
    try {
      return await manimFetchJson<T>(url)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? '')
      const lower = msg.toLowerCase()
      if (lower.includes('not found') || msg.includes('404')) {
        last404Error = msg
        continue
      }
      throw e
    }
  }
  throw new Error(last404Error || 'Manim endpoint bulunamadi')
}

type ManimRemoteAccount = { _id?: string; label?: string }

async function loadManimAccountsRemote(): Promise<ManimAccount[]> {
  if (!hasManimRemoteConfig()) return []
  const endpoint = `/bankAccount/where/${manimEncodeQuery({})}`
  const urls = manimBaseUrlCandidates().map((base) => combineManimUrl(base, endpoint))
  const list = await manimFetchJsonWithFallback<ManimRemoteAccount[]>(urls)
  return (Array.isArray(list) ? list : [])
    .map((a) => ({ id: String(a?._id ?? '').trim(), label: String(a?.label ?? '').trim() }))
    .filter((x) => x.id && x.label)
}

type ManimReceiptRaw = {
  _id?: string
  receiptNo?: unknown
  receiptDate?: unknown
  receiptAmount?: unknown
  direction?: unknown
  explanation?: unknown
  correspondent?: unknown
  correspondentCode?: unknown
  bankAccount?: unknown
}

const manimReceiptCache = new Map<string, { expiresAt: number; receipts: ManimReceiptCandidate[] }>()

async function loadManimReceiptsRemote(args: {
  accountId: string
  startIso: string
  endIso: string
}): Promise<ManimReceiptCandidate[]> {
  if (!hasManimRemoteConfig()) return []

  const cacheKey = `${args.accountId}|${args.startIso}|${args.endIso}`
  const cached = manimReceiptCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.receipts

  const queryObj = {
    query: {
      bankAccount: args.accountId,
      receiptDate: { $gte: args.startIso, $lte: args.endIso },
    },
    options: { limit: 1000, skip: 0, sort: { receiptDate: -1 } },
  }

  const endpoint = `/receipt/where/${manimEncodeQuery(queryObj)}`
  const urls = manimBaseUrlCandidates().map((base) => combineManimUrl(base, endpoint))
  const rows = await manimFetchJsonWithFallback<ManimReceiptRaw[]>(urls)

  const receipts = (Array.isArray(rows) ? rows : [])
    .map((obj) => {
      const receiptNo = String(obj?.receiptNo ?? '').trim()
      const receiptDate = String(obj?.receiptDate ?? '').trim()
      const amount = typeof obj?.receiptAmount === 'number' ? (obj.receiptAmount as number) : toNumberFlexible(obj?.receiptAmount) ?? 0
      const direction = typeof obj?.direction === 'string' ? obj.direction : undefined
      const explanation = typeof obj?.explanation === 'string' ? obj.explanation : undefined
      const correspondentObj = typeof obj?.correspondent === 'object' && obj?.correspondent ? (obj.correspondent as Record<string, unknown>) : null
      const correspondentCode =
        String(
          obj?.correspondentCode ??
            (correspondentObj?.code as unknown) ??
            (correspondentObj?.erpCode as unknown) ??
            '',
        ).trim() || undefined
      const correspondentLabel = String(correspondentObj?.label ?? '').trim() || undefined
      if (!receiptNo || !receiptDate || !Number.isFinite(amount)) return null
      const candidate: ManimReceiptCandidate = {
        receiptNo,
        receiptDate,
        amount,
        ...(direction ? { direction } : {}),
        ...(explanation ? { explanation } : {}),
        ...(correspondentCode ? { correspondentCode } : {}),
        ...(correspondentLabel ? { correspondentLabel } : {}),
        bankAccountId: args.accountId,
      }
      return candidate
    })
    .filter((x): x is ManimReceiptCandidate => !!x)

  manimReceiptCache.set(cacheKey, { expiresAt: Date.now() + 2 * 60 * 1000, receipts })
  return receipts
}

let poolPromise: Promise<mssql.ConnectionPool> | null = null
let cariPoolPromise: Promise<mssql.ConnectionPool> | null = null

function getPool() {
  if (!poolPromise) {
    if (!env.sqlServer || !env.sqlUser || !env.sqlPassword || !env.sqlDatabase) {
      throw new Error('SQL bağlantı env değişkenleri eksik: SQL_SERVER, SQL_USER, SQL_PASSWORD, SQL_DATABASE')
    }
    poolPromise = new mssql.ConnectionPool({
      server: env.sqlServer,
      port: env.sqlPort,
      user: env.sqlUser,
      password: env.sqlPassword,
      database: env.sqlDatabase,
      options: {
        trustServerCertificate: env.sqlTrustServerCertificate,
      },
    }).connect()
  }
  return poolPromise
}

function getCariPool() {
  if (!cariPoolPromise) {
    if (!env.cariSqlServer || !env.cariSqlUser || !env.cariSqlPassword || !env.cariSqlDatabase) {
      throw new Error('Cari SQL bağlantı env değişkenleri eksik: CARI_SQL_SERVER, CARI_SQL_USER, CARI_SQL_PASSWORD, CARI_SQL_DATABASE')
    }
    cariPoolPromise = new mssql.ConnectionPool({
      server: env.cariSqlServer,
      port: env.cariSqlPort,
      user: env.cariSqlUser,
      password: env.cariSqlPassword,
      database: env.cariSqlDatabase,
      options: {
        trustServerCertificate: env.cariSqlTrustServerCertificate,
      },
    }).connect()
  }
  return cariPoolPromise
}

function parseYmdDateText(value: unknown) {
  const s = String(value ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return { ok: false as const, error: 'Tarih formatı YYYY-MM-DD olmalı' }
  const yyyy = Number(m[1])
  const mm = Number(m[2])
  const dd = Number(m[3])
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return { ok: false as const, error: 'Tarih formatı geçersiz' }
  const d = new Date(Date.UTC(yyyy, mm - 1, dd))
  if (Number.isNaN(d.getTime())) return { ok: false as const, error: 'Tarih formatı geçersiz' }
  return { ok: true as const, date: s }
}

function pickColumnName(colsUpper: Set<string>, candidates: string[]) {
  for (const c of candidates) {
    const u = c.toUpperCase()
    if (colsUpper.has(u)) return c
  }
  for (const col of colsUpper.values()) {
    const normalized = col.replace(/\s+/g, '').toUpperCase()
    for (const c of candidates) {
      if (normalized === c.replace(/\s+/g, '').toUpperCase()) return col
    }
  }
  return null
}

async function fetchCariBorcBakiyeleri(args: { asOfDateYmd: string; cariCodes: string[] }) {
  const pool = await getCariPool()
  const colsRes = await pool
    .request()
    .input('TableName', mssql.NVarChar(128), 'TBLCAHAR')
    .query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @TableName`)
  const colsUpper = new Set<string>((colsRes.recordset ?? []).map((r) => String((r as any).COLUMN_NAME ?? '').trim().toUpperCase()).filter(Boolean))

  const codeCol = pickColumnName(colsUpper, ['CARKOD', 'CARIKOD', 'CARI_KOD', 'CARI_KODU', 'CHKODU', 'CH_KODU', 'CARI_CODE', 'CUST_CODE'])
  const dateCol = pickColumnName(colsUpper, ['TARIH', 'TAR', 'ISLEM_TARIHI', 'ISLEMTARIHI', 'TARIHSAAT', 'TARIH_SAAT', 'DATE_', 'TRH'])
  if (!codeCol || !dateCol) {
    throw new Error('TBLCAHAR kolonları tespit edilemedi (cari kodu / tarih)')
  }

  const balanceCol = pickColumnName(colsUpper, ['BAKIYE', 'CARIBAKIYE', 'CARI_BAKIYE', 'BAK', 'NETBAKIYE', 'NET_BAKIYE'])
  const borcCol = pickColumnName(colsUpper, ['BORC', 'BORC_TUTAR', 'BORC_TUTARI', 'DEBIT', 'DB'])
  const alacakCol = pickColumnName(colsUpper, ['ALACAK', 'ALACAK_TUTAR', 'ALACAK_TUTARI', 'CREDIT', 'CR'])

  const values = args.cariCodes
    .map((x) => String(x ?? '').trim())
    .filter((x) => !!x)
    .slice(0, 800)

  if (values.length === 0) return new Map<string, number>()

  const req = pool.request()
  req.input('AsOf', mssql.Date, args.asOfDateYmd)
  const inParams: string[] = []
  values.forEach((v, idx) => {
    const name = `c${idx}`
    inParams.push(`@${name}`)
    req.input(name, mssql.NVarChar(64), v)
  })

  let query: string
  if (balanceCol) {
    query = `
;WITH base AS (
  SELECT
    CAST(${codeCol} AS NVARCHAR(64)) AS CariCode,
    CAST(${balanceCol} AS DECIMAL(18, 2)) AS Balance,
    ROW_NUMBER() OVER (PARTITION BY ${codeCol} ORDER BY ${dateCol} DESC) AS rn
  FROM dbo.TBLCAHAR WITH (NOLOCK)
  WHERE ${dateCol} <= @AsOf
    AND ${codeCol} IN (${inParams.join(', ')})
)
SELECT CariCode AS code, Balance AS balance
FROM base
WHERE rn = 1
`
  } else if (borcCol && alacakCol) {
    query = `
SELECT
  CAST(${codeCol} AS NVARCHAR(64)) AS code,
  CAST(SUM(COALESCE(${borcCol}, 0) - COALESCE(${alacakCol}, 0)) AS DECIMAL(18, 2)) AS balance
FROM dbo.TBLCAHAR WITH (NOLOCK)
WHERE ${dateCol} <= @AsOf
  AND ${codeCol} IN (${inParams.join(', ')})
GROUP BY ${codeCol}
`
  } else {
    throw new Error('TBLCAHAR kolonları tespit edilemedi (bakiye veya borç/alacak)')
  }

  const r = await req.query(query)
  const map = new Map<string, number>()
  for (const row of (r.recordset ?? []) as Array<{ code?: unknown; balance?: unknown }>) {
    const code = String(row.code ?? '').trim()
    if (!code) continue
    const bal = Number(row.balance ?? 0) || 0
    map.set(code, bal)
  }
  return map
}

async function ensureSchema(pool: mssql.ConnectionPool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.Users', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Users (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    UserName NVARCHAR(64) NOT NULL UNIQUE,
    PasswordSalt VARBINARY(16) NOT NULL,
    PasswordHash VARBINARY(32) NOT NULL,
    IsAdmin BIT NOT NULL CONSTRAINT DF_Users_IsAdmin DEFAULT (0),
    IsActive BIT NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT (1),
    CreatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF COL_LENGTH('dbo.Users', 'IsAdmin') IS NULL
BEGIN
  ALTER TABLE dbo.Users ADD IsAdmin BIT NOT NULL CONSTRAINT DF_Users_IsAdmin DEFAULT (0);
END

IF COL_LENGTH('dbo.Users', 'RoleCode') IS NULL
BEGIN
  ALTER TABLE dbo.Users ADD RoleCode NVARCHAR(32) NULL;
END

IF COL_LENGTH('dbo.Users', 'RoleCode') IS NOT NULL
BEGIN
  EXEC(N'
UPDATE dbo.Users
SET RoleCode = CASE WHEN IsAdmin = 1 THEN ''ADMIN'' ELSE ''SHEF'' END
WHERE RoleCode IS NULL OR LTRIM(RTRIM(RoleCode)) = '''';
');
END

IF COL_LENGTH('dbo.Users', 'RoleCode') IS NOT NULL
BEGIN
  EXEC(N'
UPDATE dbo.Users
SET IsAdmin = 1, RoleCode = ''ADMIN''
WHERE UserName = ''hk_admin'';
');
END

IF OBJECT_ID('dbo.UserScreenPermissions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.UserScreenPermissions (
    UserName NVARCHAR(64) NOT NULL PRIMARY KEY,
    CanMain BIT NOT NULL CONSTRAINT DF_UserScreenPermissions_CanMain DEFAULT (1),
    CanMutabakat BIT NOT NULL CONSTRAINT DF_UserScreenPermissions_CanMutabakat DEFAULT (1),
    CanBayiHavaleMatch BIT NOT NULL CONSTRAINT DF_UserScreenPermissions_CanBayiHavaleMatch DEFAULT (1),
    CanPositionRepresentative BIT NOT NULL CONSTRAINT DF_UserScreenPermissions_CanPositionRepresentative DEFAULT (1),
    CanUserAdmin BIT NOT NULL CONSTRAINT DF_UserScreenPermissions_CanUserAdmin DEFAULT (0),
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_UserScreenPermissions_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

MERGE dbo.UserScreenPermissions WITH (HOLDLOCK) AS t
USING (
  SELECT
    UserName,
    CAST(1 AS BIT) AS CanMain,
    CAST(1 AS BIT) AS CanMutabakat,
    CAST(1 AS BIT) AS CanBayiHavaleMatch,
    CAST(1 AS BIT) AS CanPositionRepresentative,
    CASE WHEN IsAdmin = 1 THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS CanUserAdmin
  FROM dbo.Users
) AS s
ON t.UserName = s.UserName
WHEN NOT MATCHED BY TARGET THEN
  INSERT (UserName, CanMain, CanMutabakat, CanBayiHavaleMatch, CanPositionRepresentative, CanUserAdmin)
  VALUES (s.UserName, s.CanMain, s.CanMutabakat, s.CanBayiHavaleMatch, s.CanPositionRepresentative, s.CanUserAdmin);

IF OBJECT_ID('dbo.AppSettings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.AppSettings (
    SettingKey NVARCHAR(64) NOT NULL PRIMARY KEY,
    SettingValue NVARCHAR(256) NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_AppSettings_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

MERGE dbo.AppSettings WITH (HOLDLOCK) AS t
USING (
  SELECT 'MutabakatDiffLimitTl' AS SettingKey, '0.01' AS SettingValue
) AS s
ON t.SettingKey = s.SettingKey
WHEN NOT MATCHED THEN
  INSERT (SettingKey, SettingValue)
  VALUES (s.SettingKey, s.SettingValue);

IF OBJECT_ID('dbo.DepotCashDeviceSettings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.DepotCashDeviceSettings (
    DepotCode NVARCHAR(32) NOT NULL PRIMARY KEY,
    DeviceIp NVARCHAR(128) NOT NULL,
    DeviceUser NVARCHAR(64) NOT NULL,
    DevicePassword NVARCHAR(128) NOT NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_DepotCashDeviceSettings_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF OBJECT_ID('dbo.MutabakatCashReceiptUsage', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.MutabakatCashReceiptUsage (
    SourceFileDate DATE NOT NULL,
    DepotCode NVARCHAR(32) NOT NULL,
    PositionCode NVARCHAR(64) NOT NULL,
    DeviceIp NVARCHAR(128) NOT NULL,
    ReceiptId NVARCHAR(64) NOT NULL,
    ReceiptDateTime DATETIME2(0) NULL,
    AutoNo NVARCHAR(64) NULL,
    SelectedBy NVARCHAR(64) NULL,
    SelectedAt DATETIME2(0) NOT NULL CONSTRAINT DF_MutabakatCashReceiptUsage_SelectedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_MutabakatCashReceiptUsage PRIMARY KEY (SourceFileDate, DepotCode, PositionCode),
    CONSTRAINT UQ_MutabakatCashReceiptUsage_DeviceReceipt UNIQUE (DeviceIp, ReceiptId)
  );
END

IF OBJECT_ID('dbo.MutabakatCashReceiptUsage', 'U') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
     FROM sys.key_constraints
     WHERE [name] = 'UQ_MutabakatCashReceiptUsage_DeviceReceipt'
       AND [parent_object_id] = OBJECT_ID('dbo.MutabakatCashReceiptUsage')
   )
BEGIN
  ALTER TABLE dbo.MutabakatCashReceiptUsage
    ADD CONSTRAINT UQ_MutabakatCashReceiptUsage_DeviceReceipt UNIQUE (DeviceIp, ReceiptId);
END

IF OBJECT_ID('dbo.MutabakatCashReceiptUsageItems', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.MutabakatCashReceiptUsageItems (
    SourceFileDate DATE NOT NULL,
    DepotCode NVARCHAR(32) NOT NULL,
    PositionCode NVARCHAR(64) NOT NULL,
    DeviceIp NVARCHAR(128) NOT NULL,
    ReceiptId NVARCHAR(64) NOT NULL,
    ReceiptDateTime DATETIME2(0) NULL,
    AutoNo NVARCHAR(64) NULL,
    SelectedBy NVARCHAR(64) NULL,
    SelectedAt DATETIME2(0) NOT NULL CONSTRAINT DF_MutabakatCashReceiptUsageItems_SelectedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_MutabakatCashReceiptUsageItems PRIMARY KEY (SourceFileDate, DepotCode, PositionCode, DeviceIp, ReceiptId),
    CONSTRAINT UQ_MutabakatCashReceiptUsageItems_DeviceReceipt UNIQUE (DeviceIp, ReceiptId)
  );
END

IF OBJECT_ID('dbo.MutabakatCashReceiptUsageItems', 'U') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
     FROM sys.key_constraints
     WHERE [name] = 'UQ_MutabakatCashReceiptUsageItems_DeviceReceipt'
       AND [parent_object_id] = OBJECT_ID('dbo.MutabakatCashReceiptUsageItems')
   )
BEGIN
  ALTER TABLE dbo.MutabakatCashReceiptUsageItems
    ADD CONSTRAINT UQ_MutabakatCashReceiptUsageItems_DeviceReceipt UNIQUE (DeviceIp, ReceiptId);
END

IF OBJECT_ID('dbo.UiEventLog', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.UiEventLog (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    CreatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_UiEventLog_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UserName NVARCHAR(64) NULL,
    EventType NVARCHAR(16) NOT NULL,
    Message NVARCHAR(1024) NOT NULL,
    ContextJson NVARCHAR(MAX) NULL
  );
END

IF OBJECT_ID('dbo.ImportFiles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ImportFiles (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    FileName NVARCHAR(260) NOT NULL UNIQUE,
    FileDate DATE NULL,
    DepotCode NVARCHAR(32) NULL,
    DepotCodeParsed NVARCHAR(32) NULL,
    DepotCodeSelected NVARCHAR(32) NULL,
    ImportedAt DATETIME2(0) NOT NULL CONSTRAINT DF_ImportFiles_ImportedAt DEFAULT (SYSUTCDATETIME()),
    InvoiceCount INT NOT NULL,
    PaymentCount INT NOT NULL
  );
END

IF COL_LENGTH('dbo.ImportFiles', 'DepotCodeParsed') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD DepotCodeParsed NVARCHAR(32) NULL;
END

IF COL_LENGTH('dbo.ImportFiles', 'DepotCodeSelected') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD DepotCodeSelected NVARCHAR(32) NULL;
END

IF COL_LENGTH('dbo.ImportFiles', 'JsonId') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD JsonId NVARCHAR(64) NULL;
END

IF COL_LENGTH('dbo.ImportFiles', 'JsonId') IS NOT NULL
   AND EXISTS (
     SELECT 1
     FROM sys.columns c
     JOIN sys.types t ON t.user_type_id = c.user_type_id
     WHERE c.object_id = OBJECT_ID('dbo.ImportFiles')
       AND c.name = 'JsonId'
       AND t.name NOT IN ('nvarchar')
   )
BEGIN
  IF COL_LENGTH('dbo.ImportFiles', 'JsonId2') IS NULL
  BEGIN
    EXEC(N'ALTER TABLE dbo.ImportFiles ADD JsonId2 NVARCHAR(64) NULL;');
  END

  EXEC(N'UPDATE dbo.ImportFiles SET JsonId2 = CONVERT(NVARCHAR(64), JsonId) WHERE JsonId IS NOT NULL;');

  EXEC(N'ALTER TABLE dbo.ImportFiles DROP COLUMN JsonId;');
  EXEC sp_rename 'dbo.ImportFiles.JsonId2', 'JsonId', 'COLUMN';
END

IF COL_LENGTH('dbo.ImportFiles', 'JsonRowCount') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD JsonRowCount INT NULL;
END

IF COL_LENGTH('dbo.ImportFiles', 'JsonModDate') IS NULL
BEGIN
  ALTER TABLE dbo.ImportFiles ADD JsonModDate DATETIME2(0) NULL;
END

IF OBJECT_ID('dbo.InvoiceAllocations', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.InvoiceAllocations (
    InvoiceCode NVARCHAR(64) NOT NULL PRIMARY KEY,
    AllocationsJson NVARCHAR(MAX) NOT NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_InvoiceAllocations_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF OBJECT_ID('dbo.InvoiceAllocations', 'U') IS NOT NULL
   AND EXISTS (
     SELECT 1
     FROM sys.foreign_keys
     WHERE name = 'FK_InvoiceAllocations_Invoices'
       AND parent_object_id = OBJECT_ID('dbo.InvoiceAllocations')
   )
BEGIN
  ALTER TABLE dbo.InvoiceAllocations DROP CONSTRAINT FK_InvoiceAllocations_Invoices;
END

IF OBJECT_ID('dbo.PaymentAllocations', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PaymentAllocations (
    PaymentKey NVARCHAR(300) NOT NULL PRIMARY KEY,
    AllocationsJson NVARCHAR(MAX) NOT NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_PaymentAllocations_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF OBJECT_ID('dbo.AllocationEdits', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.AllocationEdits (
    Id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EntityType NVARCHAR(16) NOT NULL,
    EntityKey NVARCHAR(300) NOT NULL,
    FromJson NVARCHAR(MAX) NULL,
    ToJson NVARCHAR(MAX) NOT NULL,
    ChangedBy NVARCHAR(64) NULL,
    ChangedAt DATETIME2(0) NOT NULL CONSTRAINT DF_AllocationEdits_ChangedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF OBJECT_ID('dbo.Mutabakat', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Mutabakat (
    SourceFileDate DATE NOT NULL,
    DepotCode NVARCHAR(32) NOT NULL,
    PositionCode NVARCHAR(64) NOT NULL,
    Mode NVARCHAR(8) NOT NULL,
    TorbaTutari DECIMAL(18,4) NOT NULL,
    EnteredAmount DECIMAL(18,4) NOT NULL,
    AdjustmentAmount DECIMAL(18,4) NOT NULL,
    DiffAmount DECIMAL(18,4) NOT NULL,
    CashJson NVARCHAR(MAX) NULL,
    BankName NVARCHAR(64) NULL,
    BankDepositAmount DECIMAL(18,4) NULL,
    DekontNo NVARCHAR(64) NULL,
    AdjustmentsJson NVARCHAR(MAX) NULL,
    Status NVARCHAR(16) NOT NULL CONSTRAINT DF_Mutabakat_Status DEFAULT ('DRAFT'),
    CreatedBy NVARCHAR(64) NULL,
    CreatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_Mutabakat_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_Mutabakat_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    CompletedBy NVARCHAR(64) NULL,
    CompletedAt DATETIME2(0) NULL,
    CONSTRAINT PK_Mutabakat PRIMARY KEY (SourceFileDate, DepotCode, PositionCode)
  );
END

IF COL_LENGTH('dbo.Mutabakat', 'BankReceiptDateTime') IS NULL
BEGIN
  ALTER TABLE dbo.Mutabakat ADD BankReceiptDateTime DATETIME2(0) NULL;
END
IF COL_LENGTH('dbo.Mutabakat', 'BankExplanation') IS NULL
BEGIN
  ALTER TABLE dbo.Mutabakat ADD BankExplanation NVARCHAR(512) NULL;
END

IF OBJECT_ID('dbo.PositionRepresentativeMap', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PositionRepresentativeMap (
    PositionCode NVARCHAR(64) NOT NULL PRIMARY KEY,
    RepresentativeName NVARCHAR(128) NOT NULL,
    PhoneNumber NVARCHAR(32) NULL,
    UpdatedBy NVARCHAR(64) NULL,
    UpdatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_PositionRepresentativeMap_UpdatedAt DEFAULT (SYSUTCDATETIME())
  );
END

IF COL_LENGTH('dbo.PositionRepresentativeMap', 'PhoneNumber') IS NULL
BEGIN
  ALTER TABLE dbo.PositionRepresentativeMap ADD PhoneNumber NVARCHAR(32) NULL;
END

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'dist2k')
BEGIN
  EXEC('CREATE SCHEMA dist2k');
END

IF OBJECT_ID('dist2k.DIM_POSITION', 'U') IS NULL
BEGIN
  CREATE TABLE dist2k.DIM_POSITION (
    position_code NVARCHAR(20) NOT NULL,
    description NVARCHAR(100) NOT NULL,
    CONSTRAINT PK_DIM_POSITION PRIMARY KEY (position_code)
  );
END

IF OBJECT_ID('dist2k.DIM_CUSTOMER', 'U') IS NULL
BEGIN
  CREATE TABLE dist2k.DIM_CUSTOMER (
    customer_code NVARCHAR(30) NOT NULL,
    registered_name NVARCHAR(200) NOT NULL,
    tax_number NVARCHAR(20) NULL,
    license_number NVARCHAR(30) NULL,
    CONSTRAINT PK_DIM_CUSTOMER PRIMARY KEY (customer_code)
  );
END

IF OBJECT_ID('dist2k.DIM_PRODUCT', 'U') IS NULL
BEGIN
  CREATE TABLE dist2k.DIM_PRODUCT (
    product_code NVARCHAR(20) NOT NULL,
    sequence_no INT NOT NULL,
    description NVARCHAR(100) NOT NULL,
    CONSTRAINT PK_DIM_PRODUCT PRIMARY KEY (product_code)
  );
END

IF OBJECT_ID('dist2k.FACT_INVOICE', 'U') IS NULL
BEGIN
  CREATE TABLE dist2k.FACT_INVOICE (
    invoice_code NVARCHAR(60) NOT NULL,
    is_edos BIT NOT NULL CONSTRAINT DF_FACT_INVOICE_is_edos DEFAULT (0),
    legal_number NVARCHAR(64) NOT NULL,
    status CHAR(1) NOT NULL,
    sales_type NVARCHAR(20) NOT NULL,
    issue_date DATETIME2(0) NOT NULL,
    due_date DATETIME2(0) NULL,
    credit_days INT NOT NULL CONSTRAINT DF_FACT_INVOICE_credit_days DEFAULT (0),
    net_amount DECIMAL(18,4) NOT NULL CONSTRAINT DF_FACT_INVOICE_net_amount DEFAULT (0),
    outstanding_amount DECIMAL(18,4) NOT NULL CONSTRAINT DF_FACT_INVOICE_outstanding_amount DEFAULT (0),
    tax_amount DECIMAL(18,4) NOT NULL CONSTRAINT DF_FACT_INVOICE_tax_amount DEFAULT (0),
    total_discount DECIMAL(18,4) NOT NULL CONSTRAINT DF_FACT_INVOICE_total_discount DEFAULT (0),
    customer_code NVARCHAR(30) NOT NULL,
    position_code NVARCHAR(20) NOT NULL,
    source_file_name NVARCHAR(260) NULL,
    source_file_date DATE NULL,
    source_depot_code NVARCHAR(32) NULL,
    CONSTRAINT PK_FACT_INVOICE PRIMARY KEY (invoice_code),
    CONSTRAINT FK_INV_CUSTOMER FOREIGN KEY (customer_code) REFERENCES dist2k.DIM_CUSTOMER(customer_code),
    CONSTRAINT FK_INV_POSITION FOREIGN KEY (position_code) REFERENCES dist2k.DIM_POSITION(position_code)
  );
END

IF OBJECT_ID('dist2k.FACT_INVOICE', 'U') IS NOT NULL
   AND COL_LENGTH('dist2k.FACT_INVOICE', 'legal_number') IS NOT NULL
   AND COL_LENGTH('dist2k.FACT_INVOICE', 'legal_number') < 128
BEGIN
  ALTER TABLE dist2k.FACT_INVOICE ALTER COLUMN legal_number NVARCHAR(64) NOT NULL;
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_INV_CUSTOMER' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE'))
  CREATE INDEX IX_INV_CUSTOMER ON dist2k.FACT_INVOICE (customer_code);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_INV_POSITION' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE'))
  CREATE INDEX IX_INV_POSITION ON dist2k.FACT_INVOICE (position_code);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_INV_ISSUEDATE' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE'))
  CREATE INDEX IX_INV_ISSUEDATE ON dist2k.FACT_INVOICE (issue_date);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_INV_STATUS' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE'))
  CREATE INDEX IX_INV_STATUS ON dist2k.FACT_INVOICE (status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_INV_SOURCE_DATASET' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE'))
  CREATE INDEX IX_INV_SOURCE_DATASET ON dist2k.FACT_INVOICE (source_file_date, source_depot_code, position_code);

IF OBJECT_ID('dist2k.FACT_INVOICE_LINE', 'U') IS NULL
BEGIN
  CREATE TABLE dist2k.FACT_INVOICE_LINE (
    line_id BIGINT NOT NULL IDENTITY(1,1),
    invoice_code NVARCHAR(60) NOT NULL,
    line_no INT NOT NULL,
    product_code NVARCHAR(20) NOT NULL,
    quantity FLOAT NOT NULL CONSTRAINT DF_FACT_INVOICE_LINE_quantity DEFAULT (0),
    net_amount DECIMAL(18,4) NOT NULL CONSTRAINT DF_FACT_INVOICE_LINE_net_amount DEFAULT (0),
    gross_amount DECIMAL(18,4) NOT NULL CONSTRAINT DF_FACT_INVOICE_LINE_gross_amount DEFAULT (0),
    price DECIMAL(18,4) NOT NULL CONSTRAINT DF_FACT_INVOICE_LINE_price DEFAULT (0),
    availability BIT NOT NULL CONSTRAINT DF_FACT_INVOICE_LINE_availability DEFAULT (1),
    CONSTRAINT PK_FACT_INVOICE_LINE PRIMARY KEY (line_id),
    CONSTRAINT UQ_FACT_INVOICE_LINE UNIQUE (invoice_code, line_no),
    CONSTRAINT FK_LINE_INVOICE FOREIGN KEY (invoice_code) REFERENCES dist2k.FACT_INVOICE(invoice_code),
    CONSTRAINT FK_LINE_PRODUCT FOREIGN KEY (product_code) REFERENCES dist2k.DIM_PRODUCT(product_code)
  );
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LINE_INVOICE' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE_LINE'))
  CREATE INDEX IX_LINE_INVOICE ON dist2k.FACT_INVOICE_LINE (invoice_code);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LINE_PRODUCT' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE_LINE'))
  CREATE INDEX IX_LINE_PRODUCT ON dist2k.FACT_INVOICE_LINE (product_code);

IF OBJECT_ID('dist2k.FACT_INVOICE_PAYMENT', 'U') IS NULL
BEGIN
  CREATE TABLE dist2k.FACT_INVOICE_PAYMENT (
    payment_code NVARCHAR(300) NOT NULL,
    invoice_code NVARCHAR(60) NOT NULL,
    issue_date DATETIME2(0) NULL,
    amount DECIMAL(18,4) NOT NULL,
    paymentform_code NVARCHAR(20) NULL,
    paymentform_desc NVARCHAR(50) NULL,
    source_file_name NVARCHAR(260) NULL,
    source_file_date DATE NULL,
    source_depot_code NVARCHAR(32) NULL,
    position_code NVARCHAR(20) NULL,
    customer_code NVARCHAR(30) NULL,
    CONSTRAINT PK_FACT_INVOICE_PAYMENT PRIMARY KEY (payment_code),
    CONSTRAINT FK_PAY_INVOICE FOREIGN KEY (invoice_code) REFERENCES dist2k.FACT_INVOICE(invoice_code)
  );
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FACT_INVOICE_PAYMENT_INVOICE' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE_PAYMENT'))
  CREATE INDEX IX_FACT_INVOICE_PAYMENT_INVOICE ON dist2k.FACT_INVOICE_PAYMENT (invoice_code);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FACT_INVOICE_PAYMENT_DATASET' AND object_id = OBJECT_ID('dist2k.FACT_INVOICE_PAYMENT'))
  CREATE INDEX IX_FACT_INVOICE_PAYMENT_DATASET ON dist2k.FACT_INVOICE_PAYMENT (source_file_date, source_depot_code, position_code);

IF OBJECT_ID('dist2k.FACT_COLLECTION', 'U') IS NULL
BEGIN
  CREATE TABLE dist2k.FACT_COLLECTION (
    collection_code NVARCHAR(300) NOT NULL,
    invoice_code NVARCHAR(60) NULL,
    position_code NVARCHAR(20) NOT NULL,
    customer_code NVARCHAR(30) NOT NULL,
    issue_date DATETIME2(0) NULL,
    amount DECIMAL(18,4) NOT NULL,
    paymentform_code NVARCHAR(20) NULL,
    paymentform_desc NVARCHAR(50) NULL,
    source_file_name NVARCHAR(260) NULL,
    source_file_date DATE NULL,
    source_depot_code NVARCHAR(32) NULL,
    CONSTRAINT PK_FACT_COLLECTION PRIMARY KEY (collection_code),
    CONSTRAINT FK_COLL_POSITION FOREIGN KEY (position_code) REFERENCES dist2k.DIM_POSITION(position_code),
    CONSTRAINT FK_COLL_CUSTOMER FOREIGN KEY (customer_code) REFERENCES dist2k.DIM_CUSTOMER(customer_code)
  );
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_COLL_INVOICE' AND object_id = OBJECT_ID('dist2k.FACT_COLLECTION'))
  CREATE INDEX IX_COLL_INVOICE ON dist2k.FACT_COLLECTION (invoice_code);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_COLL_CUSTOMER' AND object_id = OBJECT_ID('dist2k.FACT_COLLECTION'))
  CREATE INDEX IX_COLL_CUSTOMER ON dist2k.FACT_COLLECTION (customer_code);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_COLL_DATE' AND object_id = OBJECT_ID('dist2k.FACT_COLLECTION'))
  CREATE INDEX IX_COLL_DATE ON dist2k.FACT_COLLECTION (issue_date);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_COLL_DATASET' AND object_id = OBJECT_ID('dist2k.FACT_COLLECTION'))
  CREATE INDEX IX_COLL_DATASET ON dist2k.FACT_COLLECTION (source_file_date, source_depot_code, position_code);
`)
}

async function ensureImportFilesJsonColumns(pool: mssql.ConnectionPool) {
  const r = await pool.request().query(`
SELECT
  COL_LENGTH('dbo.ImportFiles', 'JsonId') AS JsonIdLen,
  COL_LENGTH('dbo.ImportFiles', 'JsonRowCount') AS JsonRowCountLen,
  COL_LENGTH('dbo.ImportFiles', 'JsonModDate') AS JsonModDateLen
`)
  const row = (r.recordset?.[0] ?? {}) as { JsonIdLen?: unknown; JsonRowCountLen?: unknown; JsonModDateLen?: unknown }
  const needsJsonId = row.JsonIdLen == null
  const needsRowCount = row.JsonRowCountLen == null
  const needsModDate = row.JsonModDateLen == null
  if (!needsJsonId && !needsRowCount && !needsModDate) return

  const parts: string[] = []
  if (needsJsonId) parts.push("ALTER TABLE dbo.ImportFiles ADD JsonId NVARCHAR(64) NULL;")
  if (needsRowCount) parts.push('ALTER TABLE dbo.ImportFiles ADD JsonRowCount INT NULL;')
  if (needsModDate) parts.push('ALTER TABLE dbo.ImportFiles ADD JsonModDate DATETIME2(0) NULL;')
  await pool.request().batch(parts.join('\n'))
}


function hashPassword(password: string, salt: Buffer) {
  return crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256')
}

type RoleCode = 'ADMIN' | 'PLAN_MUHASEBE' | 'SHEF'
type ScreenPermissions = {
  canMain: boolean
  canMutabakat: boolean
  canBayiHavaleMatch: boolean
  canPositionRepresentative: boolean
  canUserAdmin: boolean
}

function normalizeRoleCode(value: string): RoleCode {
  const v = value.trim().toUpperCase()
  if (v === 'ADMIN') return 'ADMIN'
  if (v === 'PLAN_MUHASEBE') return 'PLAN_MUHASEBE'
  return 'SHEF'
}

function defaultPermissionsForRole(roleCode: RoleCode): ScreenPermissions {
  if (roleCode === 'ADMIN') {
    return { canMain: true, canMutabakat: true, canBayiHavaleMatch: true, canPositionRepresentative: true, canUserAdmin: true }
  }
  return { canMain: true, canMutabakat: true, canBayiHavaleMatch: true, canPositionRepresentative: true, canUserAdmin: false }
}

const MUTABAKAT_DIFF_LIMIT_SETTING_KEY = 'MutabakatDiffLimitTl'
const DEFAULT_MUTABAKAT_DIFF_LIMIT_TL = 0.01

function normalizeMutabakatDiffLimitTl(value: unknown, fallback = DEFAULT_MUTABAKAT_DIFF_LIMIT_TL) {
  const raw = toNumberFlexible(value) ?? toNumberOrUndef(value)
  if (raw == null || !Number.isFinite(raw)) return fallback
  const clamped = Math.max(0, raw)
  return Math.round(clamped * 100) / 100
}

function normalizePermissions(input: unknown, fallback: ScreenPermissions): ScreenPermissions {
  const obj = (input && typeof input === 'object' ? input : null) as Record<string, unknown> | null
  if (!obj) return fallback
  return {
    canMain: typeof obj.canMain === 'boolean' ? obj.canMain : fallback.canMain,
    canMutabakat: typeof obj.canMutabakat === 'boolean' ? obj.canMutabakat : fallback.canMutabakat,
    canBayiHavaleMatch: typeof obj.canBayiHavaleMatch === 'boolean' ? obj.canBayiHavaleMatch : fallback.canBayiHavaleMatch,
    canPositionRepresentative: typeof obj.canPositionRepresentative === 'boolean' ? obj.canPositionRepresentative : fallback.canPositionRepresentative,
    canUserAdmin: typeof obj.canUserAdmin === 'boolean' ? obj.canUserAdmin : fallback.canUserAdmin,
  }
}

async function upsertUserPermissions(
  pool: mssql.ConnectionPool,
  userName: string,
  permissions: ScreenPermissions,
  actorUserName: string | null,
) {
  await pool
    .request()
    .input('UserName', mssql.NVarChar(64), userName)
    .input('CanMain', mssql.Bit, permissions.canMain)
    .input('CanMutabakat', mssql.Bit, permissions.canMutabakat)
    .input('CanBayiHavaleMatch', mssql.Bit, permissions.canBayiHavaleMatch)
    .input('CanPositionRepresentative', mssql.Bit, permissions.canPositionRepresentative)
    .input('CanUserAdmin', mssql.Bit, permissions.canUserAdmin)
    .input('UpdatedBy', mssql.NVarChar(64), actorUserName)
    .query(`
MERGE dbo.UserScreenPermissions WITH (HOLDLOCK) AS t
USING (SELECT
  @UserName AS UserName,
  @CanMain AS CanMain,
  @CanMutabakat AS CanMutabakat,
  @CanBayiHavaleMatch AS CanBayiHavaleMatch,
  @CanPositionRepresentative AS CanPositionRepresentative,
  @CanUserAdmin AS CanUserAdmin,
  @UpdatedBy AS UpdatedBy
) AS s
ON t.UserName = s.UserName
WHEN MATCHED THEN
  UPDATE SET
    CanMain = s.CanMain,
    CanMutabakat = s.CanMutabakat,
    CanBayiHavaleMatch = s.CanBayiHavaleMatch,
    CanPositionRepresentative = s.CanPositionRepresentative,
    CanUserAdmin = s.CanUserAdmin,
    UpdatedBy = s.UpdatedBy,
    UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (UserName, CanMain, CanMutabakat, CanBayiHavaleMatch, CanPositionRepresentative, CanUserAdmin, UpdatedBy)
  VALUES (s.UserName, s.CanMain, s.CanMutabakat, s.CanBayiHavaleMatch, s.CanPositionRepresentative, s.CanUserAdmin, s.UpdatedBy);
`)
}

async function verifyUser(pool: mssql.ConnectionPool, userName: string, password: string) {
  const r = await pool
    .request()
    .input('UserName', mssql.NVarChar(64), userName)
    .query(`
SELECT TOP 1
  u.UserName,
  u.PasswordSalt,
  u.PasswordHash,
  u.IsActive,
  u.IsAdmin,
  u.RoleCode,
  p.CanMain,
  p.CanMutabakat,
  p.CanBayiHavaleMatch,
  p.CanPositionRepresentative,
  p.CanUserAdmin
FROM dbo.Users u
LEFT JOIN dbo.UserScreenPermissions p ON p.UserName = u.UserName
WHERE u.UserName = @UserName
`)

  const row = r.recordset?.[0] as
    | {
        UserName: string
        PasswordSalt: Buffer
        PasswordHash: Buffer
        IsActive: boolean
        IsAdmin: boolean
        RoleCode: string | null
        CanMain: boolean | null
        CanMutabakat: boolean | null
        CanBayiHavaleMatch: boolean | null
        CanPositionRepresentative: boolean | null
        CanUserAdmin: boolean | null
      }
    | undefined

  if (!row || !row.IsActive) return null
  const computed = hashPassword(password, row.PasswordSalt)
  if (!crypto.timingSafeEqual(computed, row.PasswordHash)) return null
  const roleCode = normalizeRoleCode(String(row.RoleCode ?? (row.IsAdmin ? 'ADMIN' : 'SHEF')))
  const defaults = defaultPermissionsForRole(roleCode)
  const permissions = {
    canMain: row.CanMain == null ? defaults.canMain : Boolean(row.CanMain),
    canMutabakat: row.CanMutabakat == null ? defaults.canMutabakat : Boolean(row.CanMutabakat),
    canBayiHavaleMatch: row.CanBayiHavaleMatch == null ? defaults.canBayiHavaleMatch : Boolean(row.CanBayiHavaleMatch),
    canPositionRepresentative: row.CanPositionRepresentative == null ? defaults.canPositionRepresentative : Boolean(row.CanPositionRepresentative),
    canUserAdmin: row.CanUserAdmin == null ? defaults.canUserAdmin : Boolean(row.CanUserAdmin),
  }
  return { userName: row.UserName, roleCode, isAdmin: roleCode === 'ADMIN', permissions }
}

async function createUser(
  pool: mssql.ConnectionPool,
  userName: string,
  password: string,
  roleCode: RoleCode,
  permissions: ScreenPermissions,
  actorUserName: string | null,
) {
  const salt = crypto.randomBytes(16)
  const hash = hashPassword(password, salt)
  await pool
    .request()
    .input('UserName', mssql.NVarChar(64), userName)
    .input('PasswordSalt', mssql.VarBinary(16), salt)
    .input('PasswordHash', mssql.VarBinary(32), hash)
    .input('IsAdmin', mssql.Bit, roleCode === 'ADMIN')
    .input('RoleCode', mssql.NVarChar(32), roleCode)
    .query('INSERT INTO dbo.Users (UserName, PasswordSalt, PasswordHash, IsAdmin, RoleCode) VALUES (@UserName, @PasswordSalt, @PasswordHash, @IsAdmin, @RoleCode)')
  await upsertUserPermissions(pool, userName, permissions, actorUserName)
}

async function ensureDist2kPosition(pool: mssql.ConnectionPool, state: ImportRuntimeState, positionCode: string, positionDescription: string) {
  if (state.upsertedPositions.has(positionCode)) return
  await pool
    .request()
    .input('PositionCode', mssql.NVarChar(20), positionCode)
    .input('Description', mssql.NVarChar(100), positionDescription)
    .query(`
MERGE dist2k.DIM_POSITION WITH (HOLDLOCK) AS t
USING (SELECT @PositionCode AS position_code, @Description AS description) AS s
ON t.position_code = s.position_code
WHEN MATCHED THEN UPDATE SET description = s.description
WHEN NOT MATCHED THEN INSERT (position_code, description) VALUES (s.position_code, s.description);
`)
  state.upsertedPositions.add(positionCode)
}

async function ensureDist2kCustomer(
  pool: mssql.ConnectionPool,
  state: ImportRuntimeState,
  customerCode: string,
  customerName: string,
  customerTaxNumber: string | null,
  customerLicenseNumber: string | null,
) {
  if (state.upsertedCustomers.has(customerCode)) return
  await pool
    .request()
    .input('CustomerCode', mssql.NVarChar(30), customerCode)
    .input('RegisteredName', mssql.NVarChar(200), customerName)
    .input('TaxNumber', mssql.NVarChar(20), customerTaxNumber ? customerTaxNumber.slice(0, 20) : null)
    .input('LicenseNumber', mssql.NVarChar(30), customerLicenseNumber ? customerLicenseNumber.slice(0, 30) : null)
    .query(`
MERGE dist2k.DIM_CUSTOMER WITH (HOLDLOCK) AS t
USING (
  SELECT @CustomerCode AS customer_code, @RegisteredName AS registered_name, @TaxNumber AS tax_number, @LicenseNumber AS license_number
) AS s
ON t.customer_code = s.customer_code
WHEN MATCHED THEN UPDATE SET
  registered_name = s.registered_name,
  tax_number = s.tax_number,
  license_number = s.license_number
WHEN NOT MATCHED THEN
  INSERT (customer_code, registered_name, tax_number, license_number)
  VALUES (s.customer_code, s.registered_name, s.tax_number, s.license_number);
`)
  state.upsertedCustomers.add(customerCode)
}

async function ensureDist2kProduct(
  pool: mssql.ConnectionPool,
  state: ImportRuntimeState,
  productCode: string,
  productSequence: number,
  productDescription: string,
) {
  if (state.upsertedProducts.has(productCode)) return
  await pool
    .request()
    .input('ProductCode', mssql.NVarChar(20), productCode)
    .input('SequenceNo', mssql.Int, productSequence)
    .input('Description', mssql.NVarChar(100), productDescription)
    .query(`
MERGE dist2k.DIM_PRODUCT WITH (HOLDLOCK) AS t
USING (SELECT @ProductCode AS product_code, @SequenceNo AS sequence_no, @Description AS description) AS s
ON t.product_code = s.product_code
WHEN MATCHED THEN UPDATE SET
  sequence_no = CASE WHEN s.sequence_no > t.sequence_no THEN s.sequence_no ELSE t.sequence_no END,
  description = CASE WHEN NULLIF(LTRIM(RTRIM(s.description)), '') IS NULL THEN t.description ELSE s.description END
WHEN NOT MATCHED THEN INSERT (product_code, sequence_no, description) VALUES (s.product_code, s.sequence_no, s.description);
`)
  state.upsertedProducts.add(productCode)
}

async function upsertDist2kInvoice(pool: mssql.ConnectionPool, state: ImportRuntimeState, inv: RawInvoice, source: SalesFileMeta) {
  const invoiceCode = (toStringOrUndef(inv.CODE) ?? '').trim()
  if (!invoiceCode) return { paymentCount: 0 }

  const customerCode = ((toStringOrUndef(inv.CUSTOMER?.CODE) ?? '').trim() || 'UNKNOWN').slice(0, 30)
  const customerName = ((toStringOrUndef(inv.CUSTOMER?.REGISTEREDNAME) ?? '').trim() || 'Unknown Customer').slice(0, 200)
  const customerTaxNumber = (toStringOrUndef(inv.CUSTOMER?.TAXNUMBER) ?? '').trim() || null
  const customerLicenseNumber = (toStringOrUndef(inv.CUSTOMER?.LICENSENUMBER) ?? '').trim() || null

  const positionCode = ((toStringOrUndef(inv.POSITION?.CODE) ?? '').trim() || 'UNKNOWN').slice(0, 20)
  const positionDescription = ((toStringOrUndef(inv.POSITION?.DESCRIPTION) ?? '').trim() || 'Unknown Position').slice(0, 100)

  await ensureDist2kPosition(pool, state, positionCode, positionDescription)
  await ensureDist2kCustomer(pool, state, customerCode, customerName, customerTaxNumber, customerLicenseNumber)

  const legalNumber = ((toStringOrUndef(inv.LEGALNUMBER) ?? '').trim() || invoiceCode).slice(0, 64)
  const status = ((toStringOrUndef(inv.STATUS) ?? '').trim() || 'I').slice(0, 1)
  const salesType = ((toStringOrUndef(inv.SALESTYPE) ?? '').trim() || 'UNKNOWN').slice(0, 20)
  const issueDate = safeDate(toStringOrUndef(inv.ISSUEDATE) ?? undefined) ?? safeDate(toStringOrUndef(inv.DUEDATE) ?? undefined) ?? new Date('1900-01-01T00:00:00Z')
  const dueDate = safeDate(toStringOrUndef(inv.DUEDATE) ?? undefined)
  const creditDays = toNumberOrUndef(inv.CREDITDAYS) ?? 0
  const netAmount = toNumberFlexible(inv.NETAMOUNT) ?? toNumberOrUndef(inv.NETAMOUNT) ?? 0
  const outstandingAmount = toNumberFlexible(inv.OUTSTANDINGAMOUNT) ?? toNumberOrUndef(inv.OUTSTANDINGAMOUNT) ?? 0
  const taxAmount = toNumberFlexible(inv.TAXAMOUNT) ?? toNumberOrUndef(inv.TAXAMOUNT) ?? 0
  const totalDiscount = toNumberFlexible(inv.TOTAL_DISCOUNT) ?? toNumberOrUndef(inv.TOTAL_DISCOUNT) ?? 0
  const isEdosRaw = toNumberOrUndef(inv.ISEDOS)
  const isEdos = typeof isEdosRaw === 'number' ? isEdosRaw !== 0 : false

  await pool
    .request()
    .input('InvoiceCode', mssql.NVarChar(60), invoiceCode.slice(0, 60))
    .input('IsEdos', mssql.Bit, isEdos)
    .input('LegalNumber', mssql.NVarChar(64), legalNumber)
    .input('Status', mssql.NVarChar(1), status)
    .input('SalesType', mssql.NVarChar(20), salesType)
    .input('IssueDate', mssql.DateTime2(0), issueDate)
    .input('DueDate', mssql.DateTime2(0), dueDate)
    .input('CreditDays', mssql.Int, creditDays)
    .input('NetAmount', mssql.Decimal(18, 4), netAmount)
    .input('OutstandingAmount', mssql.Decimal(18, 4), outstandingAmount)
    .input('TaxAmount', mssql.Decimal(18, 4), taxAmount)
    .input('TotalDiscount', mssql.Decimal(18, 4), totalDiscount)
    .input('CustomerCode', mssql.NVarChar(30), customerCode)
    .input('PositionCode', mssql.NVarChar(20), positionCode)
    .input('SourceFileName', mssql.NVarChar(260), source.fileName)
    .input('SourceFileDate', mssql.Date, source.fileDate ? new Date(source.fileDate) : null)
    .input('SourceDepotCode', mssql.NVarChar(32), source.depotCode ?? null)
    .query(`
MERGE dist2k.FACT_INVOICE WITH (HOLDLOCK) AS t
USING (SELECT
  @InvoiceCode AS invoice_code,
  @IsEdos AS is_edos,
  @LegalNumber AS legal_number,
  @Status AS status,
  @SalesType AS sales_type,
  @IssueDate AS issue_date,
  @DueDate AS due_date,
  @CreditDays AS credit_days,
  @NetAmount AS net_amount,
  @OutstandingAmount AS outstanding_amount,
  @TaxAmount AS tax_amount,
  @TotalDiscount AS total_discount,
  @CustomerCode AS customer_code,
  @PositionCode AS position_code,
  @SourceFileName AS source_file_name,
  @SourceFileDate AS source_file_date,
  @SourceDepotCode AS source_depot_code
) AS s
ON t.invoice_code = s.invoice_code
WHEN MATCHED THEN UPDATE SET
  is_edos = s.is_edos,
  legal_number = s.legal_number,
  status = s.status,
  sales_type = s.sales_type,
  issue_date = s.issue_date,
  due_date = s.due_date,
  credit_days = s.credit_days,
  net_amount = s.net_amount,
  outstanding_amount = s.outstanding_amount,
  tax_amount = s.tax_amount,
  total_discount = s.total_discount,
  customer_code = s.customer_code,
  position_code = s.position_code,
  source_file_name = s.source_file_name,
  source_file_date = s.source_file_date,
  source_depot_code = s.source_depot_code
WHEN NOT MATCHED THEN INSERT (
  invoice_code, is_edos, legal_number, status, sales_type, issue_date, due_date, credit_days,
  net_amount, outstanding_amount, tax_amount, total_discount, customer_code, position_code,
  source_file_name, source_file_date, source_depot_code
)
VALUES (
  s.invoice_code, s.is_edos, s.legal_number, s.status, s.sales_type, s.issue_date, s.due_date, s.credit_days,
  s.net_amount, s.outstanding_amount, s.tax_amount, s.total_discount, s.customer_code, s.position_code,
  s.source_file_name, s.source_file_date, s.source_depot_code
);
`)
  state.knownInvoices.add(invoiceCode.slice(0, 60))

  await pool.request().input('InvoiceCode', mssql.NVarChar(60), invoiceCode.slice(0, 60)).query('DELETE FROM dist2k.FACT_INVOICE_LINE WHERE invoice_code = @InvoiceCode')
  const invoiceLineRows: Array<{
    lineNo: number
    productCode: string
    quantity: number
    netAmount: number
    grossAmount: number
    price: number
    availability: boolean
  }> = []
  let lineNo = 1
  for (const d of Array.isArray(inv.DETAILS) ? (inv.DETAILS as RawInvoiceDetail[]) : []) {
    if (!d || typeof d !== 'object') continue
    const product = (d.PRODUCT ?? {}) as RawInvoiceDetailProduct
    const productCode = ((toStringOrUndef(product.CODE) ?? '').trim() || 'UNKNOWN_PRODUCT').slice(0, 20)
    const productDescription = ((toStringOrUndef(product.DESCRIPTION) ?? '').trim() || 'Unknown Product').slice(0, 100)
    const productSequence = toNumberOrUndef(product.SEQUENCE) ?? 0

    await ensureDist2kProduct(pool, state, productCode, productSequence, productDescription)
    invoiceLineRows.push({
      lineNo,
      productCode,
      quantity: toNumberFlexible(d.QUANTITY) ?? 0,
      netAmount: toNumberFlexible(d.NETAMOUNT) ?? 0,
      grossAmount: toNumberFlexible(d.GROSSAMOUNT) ?? 0,
      price: toNumberFlexible(d.PRICE) ?? 0,
      availability: (toNumberOrUndef(d.AVAILABILITY) ?? 1) !== 0,
    })
    lineNo += 1
  }
  if (invoiceLineRows.length > 0) {
    const lineTable = new mssql.Table('dist2k.FACT_INVOICE_LINE')
    lineTable.create = false
    lineTable.columns.add('invoice_code', mssql.NVarChar(60), { nullable: false })
    lineTable.columns.add('line_no', mssql.Int, { nullable: false })
    lineTable.columns.add('product_code', mssql.NVarChar(20), { nullable: false })
    lineTable.columns.add('quantity', mssql.Float, { nullable: false })
    lineTable.columns.add('net_amount', mssql.Decimal(18, 4), { nullable: false })
    lineTable.columns.add('gross_amount', mssql.Decimal(18, 4), { nullable: false })
    lineTable.columns.add('price', mssql.Decimal(18, 4), { nullable: false })
    lineTable.columns.add('availability', mssql.Bit, { nullable: false })
    for (const row of invoiceLineRows) {
      lineTable.rows.add(invoiceCode.slice(0, 60), row.lineNo, row.productCode, row.quantity, row.netAmount, row.grossAmount, row.price, row.availability)
    }
    await pool.request().bulk(lineTable)
  }

  await pool.request().input('InvoiceCode', mssql.NVarChar(60), invoiceCode.slice(0, 60)).query('DELETE FROM dist2k.FACT_INVOICE_PAYMENT WHERE invoice_code = @InvoiceCode')
  const paymentRows: Array<{
    paymentCode: string
    issueDate: Date | null
    amount: number
    paymentFormCode: string | null
    paymentFormDesc: string | null
  }> = []
  for (const raw of Array.isArray(inv.PAYMENTS) ? (inv.PAYMENTS as RawInvoicePayment[]) : []) {
    if (!raw || typeof raw !== 'object') continue
    const pCode = toStringOrUndef(raw.CODE)
    const pIssueDate = toStringOrUndef(raw.ISSUEDATE)
    const pAmount = toNumberFlexible(raw.AMOUNT) ?? 0
    if (pAmount <= 0) continue

    const form = (raw.PAYMENTFORM ?? raw.PAYMENT_FORM) as { CODE?: unknown; DESCRIPTION?: unknown } | undefined
    const rawFormCode = toStringOrUndef(form?.CODE)
    const rawFormDesc = toStringOrUndef(form?.DESCRIPTION)
    const isVadeli = !rawFormDesc || !rawFormDesc.trim()
    const formCode = isVadeli ? 'VADELI' : rawFormCode
    const formDesc = isVadeli ? 'Vadeli Ödeme' : rawFormDesc
    const paymentCode = computeInvoicePaymentKey(invoiceCode, { code: pCode ?? undefined, issueDate: pIssueDate ?? undefined, amount: pAmount, formCode }).slice(0, 300)

    paymentRows.push({
      paymentCode,
      issueDate: safeDate(pIssueDate ?? undefined),
      amount: pAmount,
      paymentFormCode: formCode ? formCode.slice(0, 20) : null,
      paymentFormDesc: formDesc ? formDesc.slice(0, 50) : null,
    })
  }
  if (paymentRows.length > 0) {
    const payTable = new mssql.Table('dist2k.FACT_INVOICE_PAYMENT')
    payTable.create = false
    payTable.columns.add('payment_code', mssql.NVarChar(300), { nullable: false })
    payTable.columns.add('invoice_code', mssql.NVarChar(60), { nullable: false })
    payTable.columns.add('issue_date', mssql.DateTime2(0), { nullable: true })
    payTable.columns.add('amount', mssql.Decimal(18, 4), { nullable: false })
    payTable.columns.add('paymentform_code', mssql.NVarChar(20), { nullable: true })
    payTable.columns.add('paymentform_desc', mssql.NVarChar(50), { nullable: true })
    payTable.columns.add('source_file_name', mssql.NVarChar(260), { nullable: true })
    payTable.columns.add('source_file_date', mssql.Date, { nullable: true })
    payTable.columns.add('source_depot_code', mssql.NVarChar(32), { nullable: true })
    payTable.columns.add('position_code', mssql.NVarChar(20), { nullable: true })
    payTable.columns.add('customer_code', mssql.NVarChar(30), { nullable: true })
    for (const row of paymentRows) {
      payTable.rows.add(
        row.paymentCode,
        invoiceCode.slice(0, 60),
        row.issueDate,
        row.amount,
        row.paymentFormCode,
        row.paymentFormDesc,
        source.fileName,
        source.fileDate ? new Date(source.fileDate) : null,
        source.depotCode ?? null,
        positionCode,
        customerCode,
      )
    }
    await pool.request().bulk(payTable)
  }
  const paymentCount = paymentRows.length

  return { paymentCount }
}

async function upsertDist2kCollection(pool: mssql.ConnectionPool, state: ImportRuntimeState, c: RawCollection, source: SalesFileMeta) {
  const invoiceCode = (toStringOrUndef(c.INVOICE_CODE) ?? '').trim()
  if (!invoiceCode) return false

  const customerCode = ((toStringOrUndef(c.CUSTOMER?.CODE) ?? '').trim() || 'UNKNOWN').slice(0, 30)
  const customerName = ((toStringOrUndef(c.CUSTOMER?.REGISTEREDNAME) ?? '').trim() || 'Unknown Customer').slice(0, 200)
  const customerTaxNumber = (toStringOrUndef(c.CUSTOMER?.TAXNUMBER) ?? '').trim() || null
  const customerLicenseNumber = (toStringOrUndef(c.CUSTOMER?.LICENSENUMBER) ?? '').trim() || null
  const positionCode = ((toStringOrUndef(c.POSITION?.CODE) ?? '').trim() || 'UNKNOWN').slice(0, 20)
  const positionDescription = ((toStringOrUndef(c.POSITION?.DESCRIPTION) ?? '').trim() || 'Unknown Position').slice(0, 100)

  await ensureDist2kPosition(pool, state, positionCode, positionDescription)
  await ensureDist2kCustomer(pool, state, customerCode, customerName, customerTaxNumber, customerLicenseNumber)

  const invoiceCodeNormalized = invoiceCode.slice(0, 60)

  const code = toStringOrUndef(c.CODE)
  const issueDate = toStringOrUndef(c.ISSUEDATE)
  const amount = toNumberFlexible(c.AMOUNT) ?? toNumberOrUndef(c.AMOUNT) ?? 0
  const formCode = toStringOrUndef(c.PAYMENTFORM?.CODE)
  const formDesc = toStringOrUndef(c.PAYMENTFORM?.DESCRIPTION)
  if (amount <= 0) return false
  const collectionCode = computePaymentKey(invoiceCode, { code: code ?? undefined, issueDate: issueDate ?? undefined, amount, formCode }).slice(0, 300)

  await pool
    .request()
    .input('CollectionCode', mssql.NVarChar(300), collectionCode)
    .input('InvoiceCode', mssql.NVarChar(60), invoiceCodeNormalized)
    .input('PositionCode', mssql.NVarChar(20), positionCode)
    .input('CustomerCode', mssql.NVarChar(30), customerCode)
    .input('IssueDate', mssql.DateTime2(0), safeDate(issueDate ?? undefined))
    .input('Amount', mssql.Decimal(18, 4), amount)
    .input('PaymentFormCode', mssql.NVarChar(20), formCode ? formCode.slice(0, 20) : null)
    .input('PaymentFormDesc', mssql.NVarChar(50), formDesc ? formDesc.slice(0, 50) : null)
    .input('SourceFileName', mssql.NVarChar(260), source.fileName)
    .input('SourceFileDate', mssql.Date, source.fileDate ? new Date(source.fileDate) : null)
    .input('SourceDepotCode', mssql.NVarChar(32), source.depotCode ?? null)
    .query(`
MERGE dist2k.FACT_COLLECTION WITH (HOLDLOCK) AS t
USING (SELECT
  @CollectionCode AS collection_code,
  @InvoiceCode AS invoice_code,
  @PositionCode AS position_code,
  @CustomerCode AS customer_code,
  @IssueDate AS issue_date,
  @Amount AS amount,
  @PaymentFormCode AS paymentform_code,
  @PaymentFormDesc AS paymentform_desc,
  @SourceFileName AS source_file_name,
  @SourceFileDate AS source_file_date,
  @SourceDepotCode AS source_depot_code
) AS s
ON t.collection_code = s.collection_code
WHEN MATCHED THEN UPDATE SET
  invoice_code = s.invoice_code,
  position_code = s.position_code,
  customer_code = s.customer_code,
  issue_date = s.issue_date,
  amount = s.amount,
  paymentform_code = s.paymentform_code,
  paymentform_desc = s.paymentform_desc,
  source_file_name = s.source_file_name,
  source_file_date = s.source_file_date,
  source_depot_code = s.source_depot_code
WHEN NOT MATCHED THEN INSERT (
  collection_code, invoice_code, position_code, customer_code, issue_date, amount,
  paymentform_code, paymentform_desc, source_file_name, source_file_date, source_depot_code
)
VALUES (
  s.collection_code, s.invoice_code, s.position_code, s.customer_code, s.issue_date, s.amount,
  s.paymentform_code, s.paymentform_desc, s.source_file_name, s.source_file_date, s.source_depot_code
);
`)

  return true
}

async function importFile(
  pool: mssql.ConnectionPool,
  fileName: string,
  content: string,
  selectedDepotCode: string | null,
  onPositionProgress?: (positions: ImportPositionProgress[]) => void,
) {
  const parsedMeta = parseSalesFileName(fileName)
  const parsedDepotCode = normalizeDepotCode(parsedMeta.depotCode)
  const depotCodeSelected = normalizeDepotCode(selectedDepotCode)
  if (!depotCodeSelected) {
    throw new Error(`${fileName}: Depo seçimi zorunlu`)
  }
  if (parsedDepotCode && depotCodeSelected !== parsedDepotCode) {
    throw new Error(`${fileName}: Depo uyuşmuyor (dosya: ${parsedDepotCode}, seçilen: ${depotCodeSelected})`)
  }
  const meta: SalesFileMeta = { ...parsedMeta, depotCode: depotCodeSelected }

  const existing = await pool
    .request()
    .input('FileName', mssql.NVarChar(260), meta.fileName)
    .query('SELECT TOP 1 FileName, FileDate, DepotCode, InvoiceCount, PaymentCount FROM dbo.ImportFiles WHERE FileName = @FileName')
  const existingRow = existing.recordset?.[0] as
    | { FileName: string; FileDate: Date | null; DepotCode: string | null; InvoiceCount: number; PaymentCount: number }
    | undefined

  const parsed = JSON.parse(content) as RawSalesFile
  if (!parsed || !Array.isArray(parsed.INVOICES)) {
    throw new Error(`${fileName}: Geçersiz JSON formatı (INVOICES array bekleniyor)`)
  }

  const invoices = parsed.INVOICES as RawInvoice[]
  const collections = Array.isArray(parsed.COLLECTIONS) ? (parsed.COLLECTIONS as RawCollection[]) : []

  const positionGroups = new Map<string, { invoices: RawInvoice[]; collections: RawCollection[] }>()
  for (const inv of invoices) {
    const pos = normalizePositionCode(inv.POSITION?.CODE)
    const g = positionGroups.get(pos) ?? { invoices: [], collections: [] }
    g.invoices.push(inv)
    positionGroups.set(pos, g)
  }
  for (const c of collections) {
    const pos = normalizePositionCode(c.POSITION?.CODE)
    const g = positionGroups.get(pos) ?? { invoices: [], collections: [] }
    g.collections.push(c)
    positionGroups.set(pos, g)
  }

  let skippedPositions: string[] = []
  if (meta.fileDate) {
    const r = await pool
      .request()
      .input('SourceFileDate', mssql.Date, new Date(meta.fileDate))
      .input('SourceDepotCode', mssql.NVarChar(32), meta.depotCode ?? null)
      .query(
        `
SELECT DISTINCT PositionCode
FROM (
  SELECT i.position_code AS PositionCode
  FROM dist2k.FACT_INVOICE i
  WHERE i.source_file_date = @SourceFileDate
    AND (@SourceDepotCode IS NULL OR i.source_depot_code = @SourceDepotCode)
) x
WHERE x.PositionCode IS NOT NULL AND LTRIM(RTRIM(x.PositionCode)) <> ''
`,
      )
    skippedPositions = (r.recordset ?? [])
      .map((x) => String((x as { PositionCode: string }).PositionCode ?? '').trim())
      .filter((x) => !!x)
  }
  const skipPosSet = new Set(skippedPositions)
  const positionProgress: ImportPositionProgress[] = Array.from(positionGroups.entries()).map(([positionCode, group]) => ({
    positionCode,
    totalInvoices: group.invoices.length,
    totalCollections: group.collections.length,
    processedInvoices: 0,
    processedCollections: 0,
    status: skipPosSet.has(positionCode) ? ('skipped' as const) : ('pending' as const),
    progressPercent: skipPosSet.has(positionCode) ? 100 : 0,
    message: skipPosSet.has(positionCode) ? 'Aynı tarih/depo verisi mevcut, atlandı' : undefined,
  }))
  const updateProgress = () => {
    if (!onPositionProgress) return
    onPositionProgress(positionProgress.map((x) => ({ ...x })))
  }
  updateProgress()

  if (positionProgress.length === 0) {
    throw new Error(`${fileName}: İşlenecek pozisyon bulunamadı`)
  }

  const state: ImportRuntimeState = {
    upsertedPositions: new Set<string>(),
    upsertedCustomers: new Set<string>(),
    upsertedProducts: new Set<string>(),
    knownInvoices: new Set<string>(),
  }

  let paymentCount = 0
  let invoiceCount = 0

  for (const p of positionProgress) {
    if (p.status === 'skipped') continue
    p.status = 'processing'
    p.message = undefined
    updateProgress()

    const group = positionGroups.get(p.positionCode) ?? { invoices: [], collections: [] }

    for (const inv of group.invoices) {
      const r = await upsertDist2kInvoice(pool, state, inv, meta)
      paymentCount += r.paymentCount
      invoiceCount += 1
      p.processedInvoices += 1
      const done = p.processedInvoices + p.processedCollections
      const total = p.totalInvoices + p.totalCollections
      p.progressPercent = total > 0 ? Math.round((done * 100) / total) : 100
      updateProgress()
    }

    for (const c of group.collections) {
      const inserted = await upsertDist2kCollection(pool, state, c, meta)
      if (inserted) paymentCount += 1
      p.processedCollections += 1
      const done = p.processedInvoices + p.processedCollections
      const total = p.totalInvoices + p.totalCollections
      p.progressPercent = total > 0 ? Math.round((done * 100) / total) : 100
      updateProgress()
    }
    p.status = 'imported'
    p.progressPercent = 100
    updateProgress()
  }

  const jsonId = toStringOrUndef(parsed.Id) ?? null
  const jsonRowCount = toNumberOrUndef(parsed.RowCount) ?? null
  const jsonModDate = safeDate(toStringOrUndef(parsed.ModDate) ?? undefined)

  await ensureImportFilesJsonColumns(pool)

  await pool
    .request()
    .input('FileName', mssql.NVarChar(260), meta.fileName)
    .input('FileDate', mssql.Date, meta.fileDate ? new Date(meta.fileDate) : null)
    .input('DepotCode', mssql.NVarChar(32), meta.depotCode ?? null)
    .input('DepotCodeParsed', mssql.NVarChar(32), parsedDepotCode)
    .input('DepotCodeSelected', mssql.NVarChar(32), depotCodeSelected)
    .input('InvoiceCount', mssql.Int, invoiceCount)
    .input('PaymentCount', mssql.Int, paymentCount)
    .input('JsonId', mssql.NVarChar(64), jsonId)
    .input('JsonRowCount', mssql.Int, jsonRowCount)
    .input('JsonModDate', mssql.DateTime2(0), jsonModDate)
    .query(`
MERGE dbo.ImportFiles WITH (HOLDLOCK) AS t
USING (SELECT
  @FileName AS FileName,
  @FileDate AS FileDate,
  @DepotCode AS DepotCode,
  @DepotCodeParsed AS DepotCodeParsed,
  @DepotCodeSelected AS DepotCodeSelected,
  @InvoiceCount AS InvoiceCount,
  @PaymentCount AS PaymentCount,
  @JsonId AS JsonId,
  @JsonRowCount AS JsonRowCount,
  @JsonModDate AS JsonModDate
) AS s
ON t.FileName = s.FileName
WHEN MATCHED THEN UPDATE SET
  FileDate = s.FileDate,
  DepotCode = s.DepotCode,
  DepotCodeParsed = s.DepotCodeParsed,
  DepotCodeSelected = s.DepotCodeSelected,
  InvoiceCount = s.InvoiceCount,
  PaymentCount = s.PaymentCount,
  JsonId = s.JsonId,
  JsonRowCount = s.JsonRowCount,
  JsonModDate = s.JsonModDate
WHEN NOT MATCHED THEN INSERT (FileName, FileDate, DepotCode, DepotCodeParsed, DepotCodeSelected, InvoiceCount, PaymentCount, JsonId, JsonRowCount, JsonModDate)
VALUES (s.FileName, s.FileDate, s.DepotCode, s.DepotCodeParsed, s.DepotCodeSelected, s.InvoiceCount, s.PaymentCount, s.JsonId, s.JsonRowCount, s.JsonModDate);
`)

  return {
    fileName: existingRow?.FileName ?? meta.fileName,
    fileDate: meta.fileDate ?? (existingRow?.FileDate ? existingRow.FileDate.toISOString().slice(0, 10) : undefined),
    depotCode: meta.depotCode ?? (existingRow?.DepotCode ?? undefined),
    invoiceCount,
    paymentCount,
    skipped: false,
    skippedPositions,
    positions: positionProgress.map((x) => ({ ...x })),
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

async function requireActiveUser(pool: mssql.ConnectionPool, userName: string) {
  const r = await pool
    .request()
    .input('UserName', mssql.NVarChar(64), userName)
    .query('SELECT TOP 1 IsActive, IsAdmin, RoleCode FROM dbo.Users WHERE UserName = @UserName')
  const row = r.recordset?.[0] as { IsActive: boolean; IsAdmin: boolean; RoleCode: string | null } | undefined
  const roleCode = normalizeRoleCode(String(row?.RoleCode ?? (row?.IsAdmin ? 'ADMIN' : 'SHEF')))
  return { active: !!row?.IsActive, isAdmin: roleCode === 'ADMIN', roleCode }
}

async function requireAdminUser(pool: mssql.ConnectionPool, userName: string) {
  const r = await requireActiveUser(pool, userName)
  return r.active && r.isAdmin
}

async function getMutabakatDiffLimitTl(pool: mssql.ConnectionPool) {
  const r = await pool
    .request()
    .input('SettingKey', mssql.NVarChar(64), MUTABAKAT_DIFF_LIMIT_SETTING_KEY)
    .query('SELECT TOP 1 SettingValue FROM dbo.AppSettings WHERE SettingKey = @SettingKey')
  const row = r.recordset?.[0] as { SettingValue?: unknown } | undefined
  return normalizeMutabakatDiffLimitTl(row?.SettingValue, DEFAULT_MUTABAKAT_DIFF_LIMIT_TL)
}

async function upsertMutabakatDiffLimitTl(pool: mssql.ConnectionPool, value: number, updatedBy: string) {
  const normalized = normalizeMutabakatDiffLimitTl(value, DEFAULT_MUTABAKAT_DIFF_LIMIT_TL)
  await pool
    .request()
    .input('SettingKey', mssql.NVarChar(64), MUTABAKAT_DIFF_LIMIT_SETTING_KEY)
    .input('SettingValue', mssql.NVarChar(256), String(normalized))
    .input('UpdatedBy', mssql.NVarChar(64), updatedBy)
    .query(`
MERGE dbo.AppSettings WITH (HOLDLOCK) AS t
USING (SELECT @SettingKey AS SettingKey, @SettingValue AS SettingValue, @UpdatedBy AS UpdatedBy) AS s
ON t.SettingKey = s.SettingKey
WHEN MATCHED THEN
  UPDATE SET SettingValue = s.SettingValue, UpdatedBy = s.UpdatedBy, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (SettingKey, SettingValue, UpdatedBy)
  VALUES (s.SettingKey, s.SettingValue, s.UpdatedBy);
`)
  return normalized
}

app.get('/api/settings/cash-devices', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }
    const rr = await pool.request().query(`
SELECT DepotCode, DeviceIp, DeviceUser, UpdatedBy, UpdatedAt
FROM dbo.DepotCashDeviceSettings
ORDER BY DepotCode
`)
    const settings = (rr.recordset ?? []).map((row: any) => ({
      depotCode: String(row.DepotCode ?? '').trim(),
      deviceIp: String(row.DeviceIp ?? '').trim(),
      deviceUser: String(row.DeviceUser ?? '').trim(),
      updatedBy: row.UpdatedBy ? String(row.UpdatedBy) : undefined,
      updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
    }))
    res.json({ ok: true, settings })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.put('/api/settings/cash-devices', async (req, res) => {
  try {
    const actor = String(req.header('x-user') ?? '').trim()
    if (!actor) {
      res.status(401).send('Yetkisiz')
      return
    }
    const depotCode = normalizeDepotCode(req.body?.depotCode)
    const creds = normalizeDeviceCredentials({ ip: req.body?.deviceIp, user: req.body?.deviceUser, password: req.body?.devicePassword })
    if (!depotCode || !creds.ip || !creds.user || !creds.password) {
      res.status(400).send('Eksik alan')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await requireAdminUser(pool, actor)
    if (!ok) {
      res.status(403).send('Yetkisiz')
      return
    }
    await pool
      .request()
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('DeviceIp', mssql.NVarChar(128), creds.ip)
      .input('DeviceUser', mssql.NVarChar(64), creds.user)
      .input('DevicePassword', mssql.NVarChar(128), creds.password)
      .input('UpdatedBy', mssql.NVarChar(64), actor)
      .query(`
MERGE dbo.DepotCashDeviceSettings WITH (HOLDLOCK) AS t
USING (SELECT @DepotCode AS DepotCode, @DeviceIp AS DeviceIp, @DeviceUser AS DeviceUser, @DevicePassword AS DevicePassword, @UpdatedBy AS UpdatedBy) AS s
ON t.DepotCode = s.DepotCode
WHEN MATCHED THEN
  UPDATE SET DeviceIp = s.DeviceIp, DeviceUser = s.DeviceUser, DevicePassword = s.DevicePassword, UpdatedBy = s.UpdatedBy, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (DepotCode, DeviceIp, DeviceUser, DevicePassword, UpdatedBy)
  VALUES (s.DepotCode, s.DeviceIp, s.DeviceUser, s.DevicePassword, s.UpdatedBy);
`)
    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/settings/cash-devices/test', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const creds = normalizeDeviceCredentials({ ip: req.body?.deviceIp, user: req.body?.deviceUser, password: req.body?.devicePassword })
    if (!creds.ip || !creds.user || !creds.password) {
      res.status(400).send('Eksik alan')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }
    const today = new Date().toISOString().slice(0, 10)
    const receipts = await fetchKisanReceiptsFromDevice({ ip: creds.ip, user: creds.user, password: creds.password, dateYmd: today })
    res.json({ ok: true, count: receipts.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Baglanti test edilemedi'
    res.status(500).send(msg)
  }
})

app.get('/api/cash-counts/receipts', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const parsedDate = parseQueryDate(req.query.date)
    const dateText = parsedDate.ok && parsedDate.date ? parsedDate.date.toISOString().slice(0, 10) : ''
    const depotCode = normalizeDepotCode(req.query.depot)
    const positionCode = String(req.query.position ?? '').trim()
    if (!dateText || !depotCode || !positionCode) {
      res.status(400).send('Tarih, depo ve pozisyon zorunlu')
      return
    }
    const excludeParsed = parseQueryDate(req.query.excludeSourceFileDate)
    const excludeDate = excludeParsed.ok && excludeParsed.date ? excludeParsed.date : parsedDate.date!
    const excludeDepot = normalizeDepotCode(req.query.excludeDepot) || depotCode
    const excludePosition = String(req.query.excludePosition ?? '').trim() || positionCode

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const deviceRes = await pool
      .request()
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .query('SELECT TOP 1 DeviceIp, DeviceUser, DevicePassword FROM dbo.DepotCashDeviceSettings WHERE DepotCode = @DepotCode')
    const drow = deviceRes.recordset?.[0] as { DeviceIp?: unknown; DeviceUser?: unknown; DevicePassword?: unknown } | undefined
    const creds = normalizeDeviceCredentials({ ip: drow?.DeviceIp, user: drow?.DeviceUser, password: drow?.DevicePassword })
    if (!creds.ip || !creds.user || !creds.password) {
      res.status(400).send('Bu depo icin cihaz ayari bulunamadi')
      return
    }

    const rawReceipts = await fetchKisanReceiptsFromDevice({ ip: creds.ip, user: creds.user, password: creds.password, dateYmd: dateText })
    const usedRes = await pool
      .request()
      .input('DeviceIp', mssql.NVarChar(128), creds.ip)
      .input('SourceFileDate', mssql.Date, excludeDate)
      .input('DepotCode', mssql.NVarChar(32), excludeDepot)
      .input('PositionCode', mssql.NVarChar(64), excludePosition)
      .query(`
SELECT ReceiptId, ReceiptDateTime
FROM dbo.MutabakatCashReceiptUsageItems
WHERE DeviceIp = @DeviceIp
  AND NOT (SourceFileDate = @SourceFileDate AND DepotCode = @DepotCode AND PositionCode = @PositionCode)
`)
    const usedIds = new Set<string>()
    for (const r of usedRes.recordset ?? []) {
      const receiptId = String((r as any)?.ReceiptId ?? '').trim()
      const receiptDate = (r as any)?.ReceiptDateTime
      const receiptDateIso = receiptDate instanceof Date ? receiptDate.toISOString() : String(receiptDate ?? '').trim()
      const variants = buildReceiptIdVariants({ rawId: receiptId, transactionDateTime: receiptDateIso })
      for (const v of variants) usedIds.add(v)
    }
    const receipts = rawReceipts
      .filter((r) => {
        const variants = buildReceiptIdVariants({ rawId: r.id, transactionDateTime: r.time })
        if (variants.size === 0) return false
        const receiptDateKey = String(r.date_key ?? '').trim()
        // XML tarih parse edilemezse date_key bos/Unknown gelebilir.
        // Dosya adi zaten istenen gun (dateText) ile filtrelendigi icin bu durumda fişi eleme.
        if (receiptDateKey && receiptDateKey !== 'Unknown' && receiptDateKey !== dateText) return false
        for (const v of variants) {
          if (usedIds.has(v)) return false
        }
        return true
      })
      .map((r) => ({
        counterId: buildCounterId({ rawId: r.id, transactionDateTime: r.time }),
        receiptId: buildCounterId({ rawId: r.id, transactionDateTime: r.time }),
        deviceIp: creds.ip,
        transactionDateTime: String(r.time ?? '').trim(),
        displayTime: String(r.display_time ?? '').trim(),
        autoNo: String(r.auto_no ?? '').trim(),
        sequenceNo: Number(r.daily_seq ?? 0) || 0,
        totalAmount: Number(r.total_val ?? 0) || 0,
        totalQty: Number(r.total_qty ?? 0) || 0,
        banknoteCounts: mapReceiptBanknotes(r.details),
      }))
    res.json({ ok: true, receipts })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/settings/mutabakat', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }
    const diffLimitTl = await getMutabakatDiffLimitTl(pool)
    res.json({ ok: true, settings: { diffLimitTl } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.put('/api/settings/mutabakat', async (req, res) => {
  try {
    const actor = String(req.header('x-user') ?? '').trim()
    if (!actor) {
      res.status(401).send('Yetkisiz')
      return
    }
    const diffLimitRaw = toNumberFlexible(req.body?.diffLimitTl) ?? toNumberOrUndef(req.body?.diffLimitTl)
    if (diffLimitRaw == null || !Number.isFinite(diffLimitRaw) || diffLimitRaw < 0) {
      res.status(400).send('Geçersiz limit')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await requireAdminUser(pool, actor)
    if (!ok) {
      res.status(403).send('Yetkisiz')
      return
    }

    const diffLimitTl = await upsertMutabakatDiffLimitTl(pool, diffLimitRaw, actor)
    res.json({ ok: true, settings: { diffLimitTl } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const userName = String(req.body?.userName ?? '').trim()
    const password = String(req.body?.password ?? '')
    if (!userName || !password) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const info = await verifyUser(pool, userName, password)
    if (!info) {
      res.status(401).send('Hatalı kullanıcı adı/şifre')
      return
    }
    res.json({ ok: true, userName: info.userName, isAdmin: info.isAdmin, roleCode: info.roleCode, permissions: info.permissions })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/ui-events', async (req, res) => {
  try {
    const actor = String(req.header('x-user') ?? '').trim() || null
    const eventType = String(req.body?.type ?? '').trim().toLowerCase()
    const message = String(req.body?.message ?? '').trim()
    const context = req.body?.context
    if ((eventType !== 'success' && eventType !== 'error' && eventType !== 'info') || !message) {
      res.status(400).send('Eksik alan')
      return
    }
    const contextJson =
      context && typeof context === 'object'
        ? (() => {
            try {
              const s = JSON.stringify(context)
              return s.length > 10000 ? s.slice(0, 10000) : s
            } catch {
              return null
            }
          })()
        : null

    const pool = await getPool()
    await ensureSchema(pool)
    await pool
      .request()
      .input('UserName', mssql.NVarChar(64), actor)
      .input('EventType', mssql.NVarChar(16), eventType)
      .input('Message', mssql.NVarChar(1024), message.slice(0, 1024))
      .input('ContextJson', mssql.NVarChar(mssql.MAX), contextJson)
      .query('INSERT INTO dbo.UiEventLog (UserName, EventType, Message, ContextJson) VALUES (@UserName, @EventType, @Message, @ContextJson)')
    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/users', async (req, res) => {
  try {
    const secret = String(req.header('x-admin-secret') ?? '')
    const isSecretOk = !!env.adminSecret && secret === env.adminSecret
    const actor = String(req.header('x-user') ?? '').trim()

    const userName = String(req.body?.userName ?? '').trim()
    const password = String(req.body?.password ?? '')
    const roleCode = normalizeRoleCode(String(req.body?.roleCode ?? (Boolean(req.body?.isAdmin) ? 'ADMIN' : 'SHEF')))
    const permissions = normalizePermissions(req.body?.permissions, defaultPermissionsForRole(roleCode))
    if (!userName || !password) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)

    if (!isSecretOk) {
      if (!actor) {
        res.status(401).send('Yetkisiz')
        return
      }
      const ok = await requireAdminUser(pool, actor)
      if (!ok) {
        res.status(403).send('Yetkisiz')
        return
      }
    }

    await createUser(pool, userName, password, roleCode, permissions, actor || null)
    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/users', async (req, res) => {
  try {
    const secret = String(req.header('x-admin-secret') ?? '')
    const isSecretOk = !!env.adminSecret && secret === env.adminSecret
    const actor = String(req.header('x-user') ?? '').trim()

    const pool = await getPool()
    await ensureSchema(pool)

    if (!isSecretOk) {
      if (!actor) {
        res.status(401).send('Yetkisiz')
        return
      }
      const ok = await requireAdminUser(pool, actor)
      if (!ok) {
        res.status(403).send('Yetkisiz')
        return
      }
    }

    const r = await pool.request().query(`
SELECT
  u.UserName,
  u.IsAdmin,
  u.IsActive,
  u.RoleCode,
  u.CreatedAt,
  p.CanMain,
  p.CanMutabakat,
  p.CanBayiHavaleMatch,
  p.CanPositionRepresentative,
  p.CanUserAdmin
FROM dbo.Users u
LEFT JOIN dbo.UserScreenPermissions p ON p.UserName = u.UserName
ORDER BY u.UserName
`)
    const users = (r.recordset ?? []).map((row) => {
      const roleCode = normalizeRoleCode(String(row.RoleCode ?? (row.IsAdmin ? 'ADMIN' : 'SHEF')))
      const defaults = defaultPermissionsForRole(roleCode)
      return {
        userName: String(row.UserName ?? ''),
        roleCode,
        isAdmin: roleCode === 'ADMIN',
        isActive: Boolean(row.IsActive),
        createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : undefined,
        permissions: {
          canMain: row.CanMain == null ? defaults.canMain : Boolean(row.CanMain),
          canMutabakat: row.CanMutabakat == null ? defaults.canMutabakat : Boolean(row.CanMutabakat),
          canBayiHavaleMatch: row.CanBayiHavaleMatch == null ? defaults.canBayiHavaleMatch : Boolean(row.CanBayiHavaleMatch),
          canPositionRepresentative: row.CanPositionRepresentative == null ? defaults.canPositionRepresentative : Boolean(row.CanPositionRepresentative),
          canUserAdmin: row.CanUserAdmin == null ? defaults.canUserAdmin : Boolean(row.CanUserAdmin),
        },
      }
    })
    res.json({ ok: true, users })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.put('/api/users/:userName', async (req, res) => {
  try {
    const actor = String(req.header('x-user') ?? '').trim()
    if (!actor) {
      res.status(401).send('Yetkisiz')
      return
    }
    const targetUserName = String(req.params.userName ?? '').trim()
    if (!targetUserName) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await requireAdminUser(pool, actor)
    if (!ok) {
      res.status(403).send('Yetkisiz')
      return
    }

    const roleCode = normalizeRoleCode(String(req.body?.roleCode ?? 'SHEF'))
    const permissions = normalizePermissions(req.body?.permissions, defaultPermissionsForRole(roleCode))
    const isActiveRaw = req.body?.isActive
    const isActive = typeof isActiveRaw === 'boolean' ? isActiveRaw : true

    await pool
      .request()
      .input('UserName', mssql.NVarChar(64), targetUserName)
      .input('IsAdmin', mssql.Bit, roleCode === 'ADMIN')
      .input('RoleCode', mssql.NVarChar(32), roleCode)
      .input('IsActive', mssql.Bit, isActive)
      .query(`
UPDATE dbo.Users
SET
  IsAdmin = @IsAdmin,
  RoleCode = @RoleCode,
  IsActive = @IsActive
WHERE UserName = @UserName
`)

    await upsertUserPermissions(pool, targetUserName, permissions, actor)
    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.delete('/api/users/:userName', async (req, res) => {
  try {
    const actor = String(req.header('x-user') ?? '').trim()
    if (!actor) {
      res.status(401).send('Yetkisiz')
      return
    }
    const targetUserName = String(req.params.userName ?? '').trim()
    if (!targetUserName) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await requireAdminUser(pool, actor)
    if (!ok) {
      res.status(403).send('Yetkisiz')
      return
    }
    if (targetUserName.toLowerCase() === actor.toLowerCase()) {
      res.status(400).send('Kendi kullanıcınızı silemezsiniz')
      return
    }
    if (targetUserName.toLowerCase() === 'hk_admin') {
      res.status(400).send('hk_admin kullanıcısı silinemez')
      return
    }

    const userRow = await pool
      .request()
      .input('UserName', mssql.NVarChar(64), targetUserName)
      .query('SELECT TOP 1 IsAdmin, RoleCode FROM dbo.Users WHERE UserName = @UserName')
    const user = userRow.recordset?.[0] as { IsAdmin?: boolean; RoleCode?: string | null } | undefined
    if (!user) {
      res.status(404).send('Kullanıcı bulunamadı')
      return
    }
    const roleCode = normalizeRoleCode(String(user.RoleCode ?? (user.IsAdmin ? 'ADMIN' : 'SHEF')))
    if (roleCode === 'ADMIN') {
      const adminCountResult = await pool
        .request()
        .query(
          "SELECT COUNT(1) AS Cnt FROM dbo.Users WHERE IsActive = 1 AND (RoleCode = 'ADMIN' OR (RoleCode IS NULL AND IsAdmin = 1))",
        )
      const adminCount = Number((adminCountResult.recordset?.[0] as { Cnt?: unknown } | undefined)?.Cnt ?? 0)
      if (adminCount <= 1) {
        res.status(400).send('Son admin kullanıcı silinemez')
        return
      }
    }

    await pool.request().input('UserName', mssql.NVarChar(64), targetUserName).query(`
DELETE FROM dbo.UserScreenPermissions WHERE UserName = @UserName;
DELETE FROM dbo.Users WHERE UserName = @UserName;
`)
    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

async function cleanupDatabase(pool: mssql.ConnectionPool) {
  const deletedCounts: Record<string, number> = {}

  const deleteInOrder = [
    'dist2k.FACT_INVOICE_PAYMENT',
    'dist2k.FACT_INVOICE_LINE',
    'dist2k.FACT_COLLECTION',
    'dist2k.FACT_INVOICE',
    'dist2k.DIM_PRODUCT',
    'dist2k.DIM_CUSTOMER',
    'dist2k.DIM_POSITION',
    'dbo.InvoiceAllocations',
    'dbo.PaymentAllocations',
    'dbo.AllocationEdits',
    'dbo.Mutabakat',
    'dbo.PositionRepresentativeMap',
    'dbo.ImportFiles',
  ]

  for (const fullName of deleteInOrder) {
    const r = await pool.request().query(`DECLARE @c INT; DELETE FROM ${fullName}; SET @c = @@ROWCOUNT; SELECT @c AS c;`)
    const c = Number((r.recordset?.[0] as { c?: unknown } | undefined)?.c ?? 0)
    deletedCounts[fullName] = c
  }

  const keepTables = new Set([
    'Users',
    'ImportFiles',
    'InvoiceAllocations',
    'PaymentAllocations',
    'AllocationEdits',
    'Mutabakat',
    'PositionRepresentativeMap',
  ])

  const toDropRes = await pool.request().query(`
SELECT t.name AS TableName
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name = 'dbo'
  AND t.name NOT IN (${Array.from(keepTables)
    .map((x) => `'${x.replaceAll("'", "''")}'`)
    .join(', ')});
`)

  const dropTables = (toDropRes.recordset ?? [])
    .map((x) => String((x as { TableName?: unknown }).TableName ?? '').trim())
    .filter((x) => !!x)

  for (const tableName of dropTables) {
    const safe = tableName.replaceAll(']', ']]')
    await pool.request().batch(`
DECLARE @t SYSNAME = N'${safe}';
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql = @sql + N'ALTER TABLE [dbo].[' + OBJECT_NAME(fk.parent_object_id) + N'] DROP CONSTRAINT [' + fk.name + N'];' + CHAR(10)
FROM sys.foreign_keys fk
WHERE fk.parent_object_id = OBJECT_ID(N'[dbo].[' + @t + N']')
   OR fk.referenced_object_id = OBJECT_ID(N'[dbo].[' + @t + N']');
IF (@sql <> N'') EXEC sp_executesql @sql;
EXEC(N'DROP TABLE [dbo].[' + @t + N']');
`)
  }

  return { deletedCounts, droppedTables: dropTables }
}

app.post('/api/admin/cleanup', async (req, res) => {
  try {
    const secret = String(req.header('x-admin-secret') ?? '')
    if (!env.adminSecret || secret !== env.adminSecret) {
      res.status(403).send('Yetkisiz')
      return
    }

    const confirm = String(req.query.confirm ?? '').trim().toUpperCase()
    if (confirm !== 'YES') {
      res.status(400).send('Onay gerekli: ?confirm=YES')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)

    const r = await cleanupDatabase(pool)
    res.json({ ok: true, ...r })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/admin/rebuild-dist2k', async (req, res) => {
  try {
    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await isAdminAuthorized(req, pool)
    if (!ok) {
      res.status(403).send('Yetkisiz')
      return
    }
    res.status(410).json({
      ok: false,
      message: 'Bu endpoint devre disi. Dist2k artik birincil veri kaynagi olarak dogrudan import edilmektedir.',
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

async function isAdminAuthorized(req: express.Request, pool: mssql.ConnectionPool) {
  const secret = String(req.header('x-admin-secret') ?? '')
  if (env.adminSecret && secret === env.adminSecret) return true
  const actor = String(req.header('x-user') ?? '').trim()
  if (!actor) return false
  return await requireAdminUser(pool, actor)
}

app.delete('/api/admin/data', async (req, res) => {
  try {
    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok) {
      res.status(400).send(parsedDate.error)
      return
    }
    const depot = typeof req.query.depot === 'string' ? req.query.depot.trim() : ''
    if (!parsedDate.date || !depot) {
      res.status(400).send('date ve depot zorunlu')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await isAdminAuthorized(req, pool)
    if (!ok) {
      res.status(403).send('Yetkisiz')
      return
    }

    const r = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depot)
      .query(
        `
BEGIN TRAN;

DECLARE @Inv TABLE (Code NVARCHAR(64) PRIMARY KEY);
INSERT INTO @Inv (Code)
SELECT i.invoice_code
FROM dist2k.FACT_INVOICE i
WHERE i.source_file_date = @SourceFileDate
  AND i.source_depot_code = @DepotCode;

DECLARE @Pay TABLE (PaymentKey NVARCHAR(300) PRIMARY KEY);
INSERT INTO @Pay (PaymentKey)
SELECT c.collection_code
FROM dist2k.FACT_COLLECTION c
WHERE c.source_file_date = @SourceFileDate
  AND c.source_depot_code = @DepotCode;

DECLARE @cPaymentAlloc INT = 0;
DECLARE @cInvoiceAlloc INT = 0;
DECLARE @cInvoiceDetails INT = 0;
DECLARE @cPayments INT = 0;
DECLARE @cCollections INT = 0;
DECLARE @cInvoices INT = 0;
DECLARE @cEdits INT = 0;
DECLARE @cMutabakat INT = 0;
DECLARE @cImportFiles INT = 0;

DELETE pa FROM dbo.PaymentAllocations pa JOIN @Pay k ON k.PaymentKey = pa.PaymentKey;
SET @cPaymentAlloc = @@ROWCOUNT;

DELETE ia FROM dbo.InvoiceAllocations ia JOIN @Inv i ON i.Code = ia.InvoiceCode;
SET @cInvoiceAlloc = @@ROWCOUNT;

DELETE d FROM dist2k.FACT_INVOICE_LINE d JOIN @Inv i ON i.Code = d.invoice_code;
SET @cInvoiceDetails = @@ROWCOUNT;

DELETE ip FROM dist2k.FACT_INVOICE_PAYMENT ip JOIN @Inv i ON i.Code = ip.invoice_code;
SET @cPayments = @@ROWCOUNT;

DELETE c FROM dist2k.FACT_COLLECTION c
WHERE c.source_file_date = @SourceFileDate
  AND c.source_depot_code = @DepotCode;
SET @cCollections = @@ROWCOUNT;

DELETE i FROM dist2k.FACT_INVOICE i
WHERE i.source_file_date = @SourceFileDate
  AND i.source_depot_code = @DepotCode;
SET @cInvoices = @@ROWCOUNT;

DELETE e
FROM dbo.AllocationEdits e
WHERE (e.EntityType = 'invoice' AND EXISTS (SELECT 1 FROM @Inv i WHERE i.Code = e.EntityKey))
   OR (e.EntityType = 'payment' AND EXISTS (SELECT 1 FROM @Pay p WHERE p.PaymentKey = e.EntityKey));
SET @cEdits = @@ROWCOUNT;

DELETE FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode;
SET @cMutabakat = @@ROWCOUNT;

DELETE FROM dbo.ImportFiles
WHERE FileDate = @SourceFileDate
  AND DepotCode = @DepotCode;
SET @cImportFiles = @@ROWCOUNT;

COMMIT;

SELECT
  @cInvoices AS invoicesDeleted,
  @cPayments AS paymentsDeleted,
  @cCollections AS collectionsDeleted,
  @cInvoiceDetails AS invoiceDetailsDeleted,
  @cInvoiceAlloc AS invoiceAllocationsDeleted,
  @cPaymentAlloc AS paymentAllocationsDeleted,
  @cEdits AS allocationEditsDeleted,
  @cMutabakat AS mutabakatDeleted,
  @cImportFiles AS importFilesDeleted;
`,
      )

    res.json({ ok: true, deleted: r.recordset?.[0] ?? {} })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.delete('/api/admin/import-file', async (req, res) => {
  try {
    const fileName = typeof req.query.fileName === 'string' ? req.query.fileName.trim() : ''
    if (!fileName) {
      res.status(400).send('fileName zorunlu')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const ok = await isAdminAuthorized(req, pool)
    if (!ok) {
      res.status(403).send('Yetkisiz')
      return
    }

    const r = await pool
      .request()
      .input('FileName', mssql.NVarChar(260), fileName)
      .query(
        `
BEGIN TRAN;

DECLARE @Inv TABLE (Code NVARCHAR(64) PRIMARY KEY);
INSERT INTO @Inv (Code)
SELECT i.invoice_code
FROM dist2k.FACT_INVOICE i
WHERE i.source_file_name = @FileName;

DECLARE @Dataset TABLE (SourceFileDate DATE NOT NULL, SourceDepotCode NVARCHAR(32) NOT NULL, PRIMARY KEY (SourceFileDate, SourceDepotCode));
INSERT INTO @Dataset (SourceFileDate, SourceDepotCode)
SELECT DISTINCT i.source_file_date, i.source_depot_code
FROM dist2k.FACT_INVOICE i
WHERE i.source_file_name = @FileName
  AND i.source_file_date IS NOT NULL
  AND i.source_depot_code IS NOT NULL
UNION
SELECT DISTINCT c.source_file_date, c.source_depot_code
FROM dist2k.FACT_COLLECTION c
WHERE c.source_file_name = @FileName
  AND c.source_file_date IS NOT NULL
  AND c.source_depot_code IS NOT NULL;

DECLARE @Pay TABLE (PaymentKey NVARCHAR(300) PRIMARY KEY);
INSERT INTO @Pay (PaymentKey)
SELECT DISTINCT c.collection_code
FROM dist2k.FACT_COLLECTION c
LEFT JOIN @Inv i ON i.Code = c.invoice_code
WHERE c.source_file_name = @FileName OR i.Code IS NOT NULL;

DECLARE @Col TABLE (PaymentKey NVARCHAR(300) PRIMARY KEY);
INSERT INTO @Col (PaymentKey)
SELECT DISTINCT c.collection_code
FROM dist2k.FACT_COLLECTION c
LEFT JOIN @Inv i ON i.Code = c.invoice_code
WHERE c.source_file_name = @FileName OR i.Code IS NOT NULL;

DECLARE @cPaymentAlloc INT = 0;
DECLARE @cInvoiceAlloc INT = 0;
DECLARE @cInvoiceDetails INT = 0;
DECLARE @cPayments INT = 0;
DECLARE @cCollections INT = 0;
DECLARE @cInvoices INT = 0;
DECLARE @cEdits INT = 0;
DECLARE @cMutabakat INT = 0;
DECLARE @cImportFiles INT = 0;

DELETE pa FROM dbo.PaymentAllocations pa JOIN @Pay k ON k.PaymentKey = pa.PaymentKey;
SET @cPaymentAlloc = @@ROWCOUNT;

DELETE ia FROM dbo.InvoiceAllocations ia JOIN @Inv i ON i.Code = ia.InvoiceCode;
SET @cInvoiceAlloc = @@ROWCOUNT;

DELETE d FROM dist2k.FACT_INVOICE_LINE d JOIN @Inv i ON i.Code = d.invoice_code;
SET @cInvoiceDetails = @@ROWCOUNT;

DELETE ip FROM dist2k.FACT_INVOICE_PAYMENT ip WHERE EXISTS (SELECT 1 FROM @Inv i WHERE i.Code = ip.invoice_code);
SET @cPayments = @@ROWCOUNT;

DELETE c FROM dist2k.FACT_COLLECTION c WHERE EXISTS (SELECT 1 FROM @Col k WHERE k.PaymentKey = c.collection_code);
SET @cCollections = @@ROWCOUNT;

DELETE i FROM dist2k.FACT_INVOICE i JOIN @Inv x ON x.Code = i.invoice_code;
SET @cInvoices = @@ROWCOUNT;

DELETE e
FROM dbo.AllocationEdits e
WHERE (e.EntityType = 'invoice' AND EXISTS (SELECT 1 FROM @Inv i WHERE i.Code = e.EntityKey))
   OR (e.EntityType = 'payment' AND EXISTS (SELECT 1 FROM @Pay p WHERE p.PaymentKey = e.EntityKey));
SET @cEdits = @@ROWCOUNT;

DELETE m
FROM dbo.Mutabakat m
JOIN @Dataset d ON d.SourceFileDate = m.SourceFileDate AND d.SourceDepotCode = m.DepotCode;
SET @cMutabakat = @@ROWCOUNT;

DELETE FROM dbo.ImportFiles WHERE FileName = @FileName;
SET @cImportFiles = @@ROWCOUNT;

COMMIT;

SELECT
  @cInvoices AS invoicesDeleted,
  @cPayments AS paymentsDeleted,
  @cCollections AS collectionsDeleted,
  @cInvoiceDetails AS invoiceDetailsDeleted,
  @cInvoiceAlloc AS invoiceAllocationsDeleted,
  @cPaymentAlloc AS paymentAllocationsDeleted,
  @cEdits AS allocationEditsDeleted,
  @cMutabakat AS mutabakatDeleted,
  @cImportFiles AS importFilesDeleted;
`,
      )

    res.json({ ok: true, deleted: r.recordset?.[0] ?? {} })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/position-representatives', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const r = await pool.request().query(
      `
SELECT
  PositionCode,
  RepresentativeName,
  PhoneNumber,
  UpdatedBy,
  UpdatedAt
FROM dbo.PositionRepresentativeMap
ORDER BY PositionCode
`,
    )
    const mappings = (r.recordset ?? []).map((row) => ({
      positionCode: String(row.PositionCode ?? ''),
      representativeName: String(row.RepresentativeName ?? ''),
      phoneNumber: String(row.PhoneNumber ?? ''),
      updatedBy: row.UpdatedBy ?? undefined,
      updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
    }))
    res.json({ ok: true, mappings })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/position-representatives', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const positionCode = String(req.body?.positionCode ?? '').trim()
    const representativeName = String(req.body?.representativeName ?? '').trim()
    const phoneNumber = String(req.body?.phoneNumber ?? '').trim()
    if (!positionCode || !representativeName || !phoneNumber) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('RepresentativeName', mssql.NVarChar(128), representativeName)
      .input('PhoneNumber', mssql.NVarChar(32), phoneNumber)
      .input('UserName', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.PositionRepresentativeMap WITH (HOLDLOCK) AS t
USING (SELECT
  @PositionCode AS PositionCode,
  @RepresentativeName AS RepresentativeName,
  @PhoneNumber AS PhoneNumber,
  @UserName AS UserName
) AS s
ON t.PositionCode = s.PositionCode
WHEN MATCHED THEN
  UPDATE SET
    RepresentativeName = s.RepresentativeName,
    PhoneNumber = s.PhoneNumber,
    UpdatedBy = s.UserName,
    UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (PositionCode, RepresentativeName, PhoneNumber, UpdatedBy)
  VALUES (s.PositionCode, s.RepresentativeName, s.PhoneNumber, s.UserName);
`,
      )

    const readBack = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1 PositionCode, RepresentativeName, PhoneNumber, UpdatedBy, UpdatedAt
FROM dbo.PositionRepresentativeMap
WHERE PositionCode = @PositionCode
`,
      )
    const row = readBack.recordset?.[0] as
      | { PositionCode: string; RepresentativeName: string; PhoneNumber: string | null; UpdatedBy: string | null; UpdatedAt: Date }
      | undefined
    if (!row) {
      res.status(500).send('Kayıt okunamadı')
      return
    }
    res.json({
      ok: true,
      mapping: {
        positionCode: String(row.PositionCode ?? ''),
        representativeName: String(row.RepresentativeName ?? ''),
        phoneNumber: String(row.PhoneNumber ?? ''),
        updatedBy: row.UpdatedBy ?? undefined,
        updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.delete('/api/position-representatives/:positionCode', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const positionCode = String(req.params.positionCode ?? '').trim()
    if (!positionCode) {
      res.status(400).send('Eksik alan')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }
    await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query('DELETE FROM dbo.PositionRepresentativeMap WHERE PositionCode = @PositionCode')
    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

fsSync.mkdirSync(env.importUploadDir, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, env.importUploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.json'
      const base = path.basename(file.originalname || 'upload', ext)
      const safeBase = sanitizeUploadFileName(base).slice(0, 120)
      cb(null, `${Date.now()}-${crypto.randomUUID()}-${safeBase}${ext}`)
    },
  }),
  limits: { files: 20, fileSize: 300 * 1024 * 1024 },
})

const importJobs = new Map<string, ImportJob>()
let importJobQueue: Promise<void> = Promise.resolve()

function pruneImportJobs() {
  const now = Date.now()
  for (const [jobId, job] of importJobs.entries()) {
    if (job.status === 'queued' || job.status === 'running') continue
    const endTime = job.finishedAt ? new Date(job.finishedAt).getTime() : new Date(job.createdAt).getTime()
    if (Number.isFinite(endTime) && now - endTime > env.importJobTtlMs) {
      importJobs.delete(jobId)
    }
  }
}

function enqueueImportJob(files: QueuedImportFile[], ownerUserName: string) {
  pruneImportJobs()
  const jobId = crypto.randomUUID()
  const job: ImportJob = {
    id: jobId,
    ownerUserName,
    status: 'queued',
    files,
    results: [],
    totalFiles: files.length,
    processedFiles: 0,
    createdAt: new Date().toISOString(),
  }
  importJobs.set(jobId, job)
  importJobQueue = importJobQueue
    .then(async () => {
      const current = importJobs.get(jobId)
      if (!current) return
      current.status = 'running'
      current.startedAt = new Date().toISOString()
      const pool = await getPool()
      await ensureSchema(pool)
      for (const f of current.files) {
        current.currentFileName = f.fileName
        f.status = 'running'
        try {
          const content = await fs.readFile(f.serverFilePath, 'utf8')
          const result = await importFile(pool, f.fileName, content, f.selectedDepot, (positions) => {
            f.positions = positions
          })
          f.positions = result.positions ?? f.positions
          f.status = 'completed'
          f.errorMessage = undefined
          current.results.push(result)
          current.processedFiles += 1
          await safeDeleteFile(f.serverFilePath)
        } catch (e) {
          await safeDeleteFile(f.serverFilePath)
          f.status = 'failed'
          f.errorMessage = e instanceof Error ? e.message : 'Import sırasında hata oluştu'
          current.status = 'failed'
          current.errorMessage = f.errorMessage
          current.finishedAt = new Date().toISOString()
          current.currentFileName = undefined
          return
        }
      }
      current.status = 'completed'
      current.finishedAt = new Date().toISOString()
      current.currentFileName = undefined
    })
    .catch((e) => {
      const current = importJobs.get(jobId)
      if (!current) return
      current.status = 'failed'
      current.errorMessage = e instanceof Error ? e.message : 'Import kuyruğunda beklenmeyen hata'
      current.finishedAt = new Date().toISOString()
      current.currentFileName = undefined
    })
    .finally(() => {
      pruneImportJobs()
    })
  return job
}

app.post('/api/import', upload.array('files'), async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      await Promise.all(((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => safeDeleteFile(f.path)))
      res.status(401).send('Yetkisiz')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      await Promise.all(((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => safeDeleteFile(f.path)))
      res.status(401).send('Yetkisiz')
      return
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      res.status(400).send('Dosya bulunamadı (files)')
      return
    }

    const depotMapRaw = typeof (req as any).body?.depotMap === 'string' ? String((req as any).body.depotMap) : ''
    let depotMap: Record<string, string> = {}
    if (depotMapRaw.trim()) {
      try {
        const parsed = JSON.parse(depotMapRaw) as Record<string, unknown>
        depotMap = Object.fromEntries(
          Object.entries(parsed ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : String(v ?? '')]),
        )
      } catch {
        await Promise.all(files.map((f) => safeDeleteFile(f.path)))
        res.status(400).send('Geçersiz depotMap')
        return
      }
    }

    for (const f of files) {
      if (!f.originalname.toLowerCase().endsWith('.json')) {
        await Promise.all(files.map((x) => safeDeleteFile(x.path)))
        res.status(400).send(`${f.originalname}: Sadece .json dosyaları yüklenebilir`)
        return
      }
    }

    const queuedFiles: QueuedImportFile[] = []
    for (const f of files) {
      const content = await fs.readFile(f.path, 'utf8')
      let parsed: RawSalesFile
      try {
        parsed = JSON.parse(content) as RawSalesFile
      } catch {
        await Promise.all(files.map((x) => safeDeleteFile(x.path)))
        res.status(400).send(`${f.originalname}: Geçersiz JSON`)
        return
      }
      if (!parsed || !Array.isArray(parsed.INVOICES)) {
        await Promise.all(files.map((x) => safeDeleteFile(x.path)))
        res.status(400).send(`${f.originalname}: Geçersiz JSON formatı (INVOICES array bekleniyor)`)
        return
      }
      queuedFiles.push({
        fileName: f.originalname,
        serverFilePath: f.path,
        selectedDepot: normalizeDepotCode(depotMap[f.originalname] ?? null),
        status: 'pending',
        positions: buildPositionSkeleton(parsed),
      })
    }

    const job = enqueueImportJob(
      queuedFiles,
      userName,
    )
    res.status(202).json({
      ok: true,
      accepted: true,
      jobId: job.id,
      totalFiles: job.totalFiles,
      statusUrl: `/api/import/jobs/${encodeURIComponent(job.id)}`,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/import/jobs/:jobId', (req, res) => {
  ;(async () => {
    try {
      const userName = String(req.header('x-user') ?? '').trim()
      if (!userName) {
        res.status(401).send('Yetkisiz')
        return
      }
      const pool = await getPool()
      await ensureSchema(pool)
      const active = await requireActiveUser(pool, userName)
      if (!active.active) {
        res.status(401).send('Yetkisiz')
        return
      }

      pruneImportJobs()
      const jobId = String(req.params.jobId ?? '').trim()
      if (!jobId) {
        res.status(400).send('jobId zorunlu')
        return
      }
      const job = importJobs.get(jobId)
      if (!job) {
        res.status(404).send('Import job bulunamadı')
        return
      }
      if (!active.isAdmin && job.ownerUserName !== userName) {
        res.status(403).send('Bu import job için yetkiniz yok')
        return
      }
      res.json({
        ok: true,
        job: {
          id: job.id,
          status: job.status,
          totalFiles: job.totalFiles,
          processedFiles: job.processedFiles,
          currentFileName: job.currentFileName,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          errorMessage: job.errorMessage,
          files: job.files.map((f) => {
            const done = f.positions.reduce((s, x) => s + x.processedInvoices + x.processedCollections, 0)
            const total = f.positions.reduce((s, x) => s + x.totalInvoices + x.totalCollections, 0)
            const progressPercent = total > 0 ? Math.round((done * 100) / total) : 0
            const result = job.results.find((r) => r.fileName === f.fileName)
            return {
              fileName: f.fileName,
              status: f.status,
              errorMessage: f.errorMessage,
              progressPercent,
              positions: f.positions,
              invoiceCount: result?.invoiceCount ?? 0,
              paymentCount: result?.paymentCount ?? 0,
              depotCode: result?.depotCode,
              fileDate: result?.fileDate,
              skipped: result?.skipped ?? false,
              skippedPositions: result?.skippedPositions ?? [],
            }
          }),
        },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
      res.status(500).send(msg)
    }
  })()
})

app.get('/api/import-files', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }
    const r = await pool.request().query(`
SELECT
  FileName AS fileName,
  FileDate AS fileDate,
  DepotCode AS depotCode,
  ImportedAt AS importedAt,
  InvoiceCount AS invoiceCount,
  PaymentCount AS paymentCount
FROM dbo.ImportFiles
ORDER BY FileDate DESC, ImportedAt DESC
`)
    const files = (r.recordset ?? []).map((row) => ({
      fileName: String(row.fileName ?? ''),
      fileDate: row.fileDate ? new Date(row.fileDate).toISOString().slice(0, 10) : undefined,
      depotCode: row.depotCode ?? undefined,
      importedAt: row.importedAt ? new Date(row.importedAt).toISOString() : undefined,
      invoiceCount: Number(row.invoiceCount ?? 0),
      paymentCount: Number(row.paymentCount ?? 0),
    }))
    res.json({ ok: true, files })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

function parseQueryDate(value: unknown) {
  if (typeof value !== 'string') return { ok: true as const, date: null as Date | null }
  const s = value.trim()
  if (!s) return { ok: true as const, date: null as Date | null }
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return { ok: false as const, error: 'Geçersiz tarih formatı (YYYY-MM-DD bekleniyor)' }
  return { ok: true as const, date: d }
}

app.get('/api/manim/dekont', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }

    const bankName = String(req.query.bankName ?? '').trim()
    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }
    const amount = toNumberFlexible(req.query.amount) ?? 0
    if (!bankName || !Number.isFinite(amount) || amount <= 0) {
      res.status(400).send('bankName, date, amount zorunlu')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const matchers = manimBankMatchers(bankName)
    if (matchers.length === 0) {
      res.json({ ok: true, match: null, candidates: [] })
      return
    }

    const accounts = hasManimRemoteConfig() ? await loadManimAccountsRemote() : await loadManimAccounts()
    const matchedAccounts = accounts.filter((a) => {
      const lab = normalizeManimMatch(a.label)
      return matchers.some((m) => lab.includes(m))
    })

    if (matchedAccounts.length === 0) {
      res.json({ ok: true, match: null, candidates: [], message: 'Manim hesap bulunamadı' })
      return
    }

    const targetDay = manimIsoDay(parsedDate.date)
    const targets = new Set([targetDay])

    const { startIso, endIso } = manimIstanbulUtcRange(targetDay)

    const scored: Array<ManimReceiptCandidate & { dayDiff: number; amountDiff: number; directionPenalty: number; timeScore: number }> = []

    for (const acc of matchedAccounts) {
      const receipts = hasManimRemoteConfig()
        ? await loadManimReceiptsRemote({ accountId: acc.id, startIso, endIso })
        : await loadManimReceipts(acc.id)
      for (const r of receipts) {
        const dt = new Date(r.receiptDate)
        if (Number.isNaN(dt.getTime())) continue
        const day = manimIsoDay(dt)
        if (!targets.has(day)) continue
        const amountDiff = manimAbsDiff(r.amount, amount)
        const dayDiff = 0
        const directionPenalty = (r.direction ?? '').toLowerCase() === 'in' ? 0 : 1
        scored.push({
          ...r,
          bankAccountId: r.bankAccountId ?? acc.id,
          bankAccountLabel: r.bankAccountLabel ?? acc.label,
          dayDiff,
          amountDiff,
          directionPenalty,
          timeScore: dt.getTime(),
        })
      }
    }

    scored.sort((a, b) => {
      if (a.amountDiff !== b.amountDiff) return a.amountDiff - b.amountDiff
      if (a.dayDiff !== b.dayDiff) return a.dayDiff - b.dayDiff
      if (a.directionPenalty !== b.directionPenalty) return a.directionPenalty - b.directionPenalty
      return b.timeScore - a.timeScore
    })

    const top = scored.slice(0, 10)

    const exact =
      top.find((x) => x.amountDiff <= 0.01 && x.dayDiff === 0) ??
      top.find((x) => x.amountDiff <= 0.01) ??
      null

    const candidates = top.map((x) => ({
      receiptNo: x.receiptNo,
      receiptDate: x.receiptDate,
      amount: x.amount,
      amountDiff: x.amountDiff,
      dayDiff: x.dayDiff,
      direction: x.direction,
      explanation: x.explanation,
      bankAccountId: x.bankAccountId,
      bankAccountLabel: x.bankAccountLabel,
    }))

    res.json({
      ok: true,
      match: exact
        ? {
            receiptNo: exact.receiptNo,
            receiptDate: exact.receiptDate,
            amount: exact.amount,
            amountDiff: exact.amountDiff,
            dayDiff: exact.dayDiff,
            direction: exact.direction,
            explanation: exact.explanation,
            bankAccountId: exact.bankAccountId,
            bankAccountLabel: exact.bankAccountLabel,
          }
        : null,
      candidates,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/manim/receipts', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }

    const bankName = String(req.query.bankName ?? '').trim()
    const allBanksRaw = String(req.query.allBanks ?? '').trim().toLowerCase()
    const allBanks = allBanksRaw === '1' || allBanksRaw === 'true'
    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }
    if (!allBanks && !bankName) {
      res.status(400).send('date zorunlu, bankName veya allBanks=1 gönderin')
      return
    }
    const includePreviousDayRaw = String(req.query.includePreviousDay ?? '').trim().toLowerCase()
    const includePreviousDay = includePreviousDayRaw === '1' || includePreviousDayRaw === 'true'
    const untilNowRaw = String(req.query.untilNow ?? '').trim().toLowerCase()
    const untilNow = untilNowRaw === '1' || untilNowRaw === 'true'
    const limitRaw = Number(req.query.limit)
    const limit = Number.isFinite(limitRaw) ? Math.min(5000, Math.max(1, Math.trunc(limitRaw))) : 200

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const matchers = allBanks ? [] : manimBankMatchers(bankName)
    if (!allBanks && matchers.length === 0) {
      res.json({ ok: true, receipts: [] })
      return
    }

    const accounts = hasManimRemoteConfig() ? await loadManimAccountsRemote() : await loadManimAccounts()
    const matchedAccounts = allBanks
      ? accounts
      : accounts.filter((a) => {
          const lab = normalizeManimMatch(a.label)
          return matchers.some((m) => lab.includes(m))
        })

    if (matchedAccounts.length === 0) {
      res.json({ ok: true, receipts: [] })
      return
    }

    const targetDay = manimIsoDay(parsedDate.date)
    const targets = new Set([targetDay])
    let startIso: string
    let endIso: string
    if (includePreviousDay) {
      const prev = new Date(parsedDate.date.getTime())
      prev.setUTCDate(prev.getUTCDate() - 1)
      const prevDay = manimIsoDay(prev)
      targets.add(prevDay)
      startIso = manimIstanbulUtcRange(prevDay).startIso
      endIso = manimIstanbulUtcRange(targetDay).endIso
    } else {
      const range = manimIstanbulUtcRange(targetDay)
      startIso = range.startIso
      endIso = range.endIso
    }
    if (untilNow) {
      const candidateEndMs = new Date(endIso).getTime()
      if (Number.isFinite(candidateEndMs)) {
        endIso = new Date(Math.min(candidateEndMs, Date.now())).toISOString()
      }
    }
    const startMs = new Date(startIso).getTime()
    const endMs = new Date(endIso).getTime()

    const dedupe = new Map<string, ManimReceiptCandidate & { timeScore: number }>()

    for (const acc of matchedAccounts) {
      const receipts = hasManimRemoteConfig()
        ? await loadManimReceiptsRemote({ accountId: acc.id, startIso, endIso })
        : await loadManimReceipts(acc.id)
      for (const r of receipts) {
        const dt = new Date(r.receiptDate)
        if (Number.isNaN(dt.getTime())) continue
        const ts = dt.getTime()
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && (ts < startMs || ts > endMs)) continue
        const day = manimIsoDay(dt)
        if (!targets.has(day)) continue
        const row: ManimReceiptCandidate & { timeScore: number } = {
          ...r,
          bankAccountId: r.bankAccountId ?? acc.id,
          bankAccountLabel: r.bankAccountLabel ?? acc.label,
          timeScore: ts,
        }
        const key = `${row.bankAccountId ?? ''}|${row.receiptNo}|${row.receiptDate}|${row.amount}`
        if (!dedupe.has(key)) dedupe.set(key, row)
      }
    }

    const list = [...dedupe.values()]
    list.sort((a, b) => b.timeScore - a.timeScore)

    res.json({
      ok: true,
      receipts: list.slice(0, limit).map((x) => ({
        receiptNo: x.receiptNo,
        receiptDate: x.receiptDate,
        amount: x.amount,
        direction: x.direction,
        explanation: x.explanation,
        correspondentCode: x.correspondentCode,
        correspondentLabel: x.correspondentLabel,
        bankAccountId: x.bankAccountId,
        bankAccountLabel: x.bankAccountLabel,
      })),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/cari-balances', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }

    const parsedAsOf = parseYmdDateText(req.body?.asOfDate)
    if (!parsedAsOf.ok) {
      res.status(400).send(parsedAsOf.error)
      return
    }

    const rawCodes = Array.isArray(req.body?.codes) ? (req.body.codes as unknown[]) : []
    const codes = rawCodes
      .map((x) => String(x ?? '').trim())
      .filter((x) => !!x)
      .slice(0, 800)

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const map = await fetchCariBorcBakiyeleri({ asOfDateYmd: parsedAsOf.date, cariCodes: codes })
    const balances = codes.map((code) => ({ code, balance: map.get(code) ?? 0 }))
    res.json({ ok: true, balances })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/positions', async (req, res) => {
  try {
    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok) {
      res.status(400).send(parsedDate.error)
      return
    }
    const depot = typeof req.query.depot === 'string' ? req.query.depot.trim() : ''
    const sourceFileDate = parsedDate.date
    const sourceDepotCode = depot || null

    const pool = await getPool()
    await ensureSchema(pool)
    const r = await pool
      .request()
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(`
;WITH base AS (
  SELECT
    i.position_code AS code,
    MAX(dp.description) AS description,
    COUNT(1) AS invoiceCount,
    MAX(m.Status) AS mutabakatStatus
  FROM dist2k.FACT_INVOICE i
  LEFT JOIN dist2k.DIM_POSITION dp
    ON dp.position_code = i.position_code
  LEFT JOIN dbo.Mutabakat m
    ON m.PositionCode = i.position_code
    AND @SourceFileDate IS NOT NULL AND m.SourceFileDate = @SourceFileDate
    AND @SourceDepotCode IS NOT NULL AND m.DepotCode = @SourceDepotCode
  WHERE i.position_code IS NOT NULL AND LTRIM(RTRIM(i.position_code)) <> ''
    AND (@SourceFileDate IS NULL OR i.source_file_date = @SourceFileDate)
    AND (@SourceDepotCode IS NULL OR i.source_depot_code = @SourceDepotCode)
  GROUP BY i.position_code
),
nakit_by_pos AS (
  SELECT
    p.position_code,
    SUM(p.amount) AS nakitTutari
  FROM dist2k.FACT_INVOICE_PAYMENT p
  WHERE p.position_code IS NOT NULL AND LTRIM(RTRIM(p.position_code)) <> ''
    AND (@SourceFileDate IS NULL OR p.source_file_date = @SourceFileDate)
    AND (@SourceDepotCode IS NULL OR p.source_depot_code = @SourceDepotCode)
    AND (
      UPPER(LTRIM(RTRIM(ISNULL(p.paymentform_code, '')))) IN ('CASH', 'NAKIT')
      OR LOWER(LTRIM(RTRIM(ISNULL(p.paymentform_desc, '')))) LIKE '%nakit%'
    )
  GROUP BY p.position_code
),
vadetah_by_pos AS (
  SELECT
    c.position_code,
    SUM(c.amount) AS vadeliTahsilatTutari
  FROM dist2k.FACT_COLLECTION c
  WHERE c.position_code IS NOT NULL AND LTRIM(RTRIM(c.position_code)) <> ''
    AND (@SourceFileDate IS NULL OR c.source_file_date = @SourceFileDate)
    AND (@SourceDepotCode IS NULL OR c.source_depot_code = @SourceDepotCode)
    AND (
      UPPER(LTRIM(RTRIM(ISNULL(c.paymentform_code, '')))) = 'VADETAH'
      OR LOWER(LTRIM(RTRIM(ISNULL(c.paymentform_desc, '')))) = 'vadeli tahsilat'
    )
  GROUP BY c.position_code
)
SELECT
  b.code,
  b.description,
  b.invoiceCount,
  b.mutabakatStatus,
  CAST(ISNULL(n.nakitTutari, 0) + ISNULL(v.vadeliTahsilatTutari, 0) AS DECIMAL(18, 2)) AS torbaTutari
FROM base b
LEFT JOIN nakit_by_pos n ON n.position_code = b.code
LEFT JOIN vadetah_by_pos v ON v.position_code = b.code
ORDER BY b.code
`)
    res.json({ ok: true, positions: r.recordset ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/positions/:code', async (req, res) => {
  try {
    const positionCode = String(req.params.code ?? '').trim()
    if (!positionCode) {
      res.status(400).send('Eksik pozisyon kodu')
      return
    }

    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok) {
      res.status(400).send(parsedDate.error)
      return
    }
    const depot = typeof req.query.depot === 'string' ? req.query.depot.trim() : ''
    const sourceFileDate = parsedDate.date
    const sourceDepotCode = depot || null

    const pool = await getPool()
    await ensureSchema(pool)

    const invRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT
  i.invoice_code AS Code,
  i.is_edos AS IsEdos,
  CAST(NULL AS INT) AS ReturnGoodsCount,
  i.legal_number AS LegalNumber,
  i.status AS Status,
  i.sales_type AS SalesType,
  i.issue_date AS IssueDate,
  i.due_date AS DueDate,
  i.credit_days AS CreditDays,
  i.net_amount AS NetAmount,
  CAST(NULL AS DECIMAL(18,4)) AS GrossAmount,
  i.outstanding_amount AS OutstandingAmount,
  i.tax_amount AS TaxAmount,
  i.total_discount AS TotalDiscount,
  i.customer_code AS CustomerCode,
  c.registered_name AS CustomerName,
  c.tax_number AS CustomerTaxNumber,
  c.license_number AS CustomerLicenseNumber,
  i.position_code AS PositionCode,
  p.description AS PositionDescription,
  i.source_file_name AS SourceFileName,
  i.source_file_date AS SourceFileDate,
  i.source_depot_code AS SourceDepotCode
FROM dist2k.FACT_INVOICE i
LEFT JOIN dist2k.DIM_CUSTOMER c ON c.customer_code = i.customer_code
LEFT JOIN dist2k.DIM_POSITION p ON p.position_code = i.position_code
WHERE i.position_code = @PositionCode
  AND (@SourceFileDate IS NULL OR i.source_file_date = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.source_depot_code = @SourceDepotCode)
ORDER BY i.invoice_code
`,
      )

    const detailRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT
  d.invoice_code AS InvoiceCode,
  d.line_no AS LineNumber,
  pr.sequence_no AS ProductSequence,
  d.product_code AS ProductCode,
  pr.description AS ProductDescription,
  d.quantity AS Quantity,
  d.net_amount AS NetAmount,
  d.gross_amount AS GrossAmount,
  d.price AS Price,
  d.availability AS Availability
FROM dist2k.FACT_INVOICE_LINE d
JOIN dist2k.FACT_INVOICE i ON i.invoice_code = d.invoice_code
LEFT JOIN dist2k.DIM_PRODUCT pr ON pr.product_code = d.product_code
WHERE i.position_code = @PositionCode
  AND (@SourceFileDate IS NULL OR i.source_file_date = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.source_depot_code = @SourceDepotCode)
ORDER BY d.invoice_code, d.line_no
`,
      )

    const payRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT
  c.collection_code AS PaymentKey,
  c.invoice_code AS InvoiceCode,
  c.collection_code AS Code,
  c.issue_date AS IssueDate,
  c.amount AS Amount,
  c.paymentform_code AS PaymentFormCode,
  c.paymentform_desc AS PaymentFormDescription,
  c.customer_code AS CustomerCode,
  cu.registered_name AS CustomerName,
  cu.tax_number AS CustomerTaxNumber,
  cu.license_number AS CustomerLicenseNumber,
  c.position_code AS PositionCode,
  p.description AS PositionDescription,
  c.source_file_name AS SourceFileName,
  c.source_file_date AS SourceFileDate,
  c.source_depot_code AS SourceDepotCode
FROM dist2k.FACT_COLLECTION c
LEFT JOIN dist2k.DIM_CUSTOMER cu ON cu.customer_code = c.customer_code
LEFT JOIN dist2k.DIM_POSITION p ON p.position_code = c.position_code
WHERE c.position_code = @PositionCode
  AND (@SourceFileDate IS NULL OR c.source_file_date = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR c.source_depot_code = @SourceDepotCode)
ORDER BY c.collection_code
`,
      )

    const invPayRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT
  p.invoice_code AS InvoiceCode,
  p.payment_code AS Code,
  p.issue_date AS IssueDate,
  p.amount AS Amount,
  p.paymentform_code AS PaymentFormCode,
  p.paymentform_desc AS PaymentFormDescription
FROM dist2k.FACT_INVOICE_PAYMENT p
JOIN dist2k.FACT_INVOICE i ON i.invoice_code = p.invoice_code
WHERE i.position_code = @PositionCode
  AND (@SourceFileDate IS NULL OR i.source_file_date = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.source_depot_code = @SourceDepotCode)
ORDER BY p.payment_code
`,
      )

    const invAllocRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT ia.InvoiceCode, ia.AllocationsJson
FROM dbo.InvoiceAllocations ia
JOIN dist2k.FACT_INVOICE i ON i.invoice_code = ia.InvoiceCode
WHERE i.position_code = @PositionCode
  AND (@SourceFileDate IS NULL OR i.source_file_date = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR i.source_depot_code = @SourceDepotCode)
`,
      )

    const payAllocRes = await pool
      .request()
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('SourceFileDate', mssql.Date, sourceFileDate)
      .input('SourceDepotCode', mssql.NVarChar(32), sourceDepotCode)
      .query(
        `
SELECT pa.PaymentKey, pa.AllocationsJson
FROM dbo.PaymentAllocations pa
JOIN dist2k.FACT_COLLECTION c ON c.collection_code = pa.PaymentKey
WHERE c.position_code = @PositionCode
  AND (@SourceFileDate IS NULL OR c.source_file_date = @SourceFileDate)
  AND (@SourceDepotCode IS NULL OR c.source_depot_code = @SourceDepotCode)
`,
      )

    const invoices = (invRes.recordset ?? []).map((row) => ({
      code: String(row.Code),
      isEdos: row.IsEdos != null ? Boolean(row.IsEdos) : undefined,
      returnGoodsCount: typeof row.ReturnGoodsCount === 'number' ? row.ReturnGoodsCount : undefined,
      legalNumber: row.LegalNumber ?? undefined,
      status: row.Status ?? undefined,
      salesType: String(row.SalesType ?? ''),
      issueDate: row.IssueDate ? new Date(row.IssueDate).toISOString() : undefined,
      dueDate: row.DueDate ? new Date(row.DueDate).toISOString() : undefined,
      creditDays: typeof row.CreditDays === 'number' ? row.CreditDays : undefined,
      netAmount: Number(row.NetAmount ?? 0),
      grossAmount: row.GrossAmount != null ? Number(row.GrossAmount) : undefined,
      outstandingAmount: row.OutstandingAmount != null ? Number(row.OutstandingAmount) : undefined,
      taxAmount: row.TaxAmount != null ? Number(row.TaxAmount) : undefined,
      totalDiscount: row.TotalDiscount != null ? Number(row.TotalDiscount) : undefined,
      customer: {
        code: row.CustomerCode ?? undefined,
        registeredName: String(row.CustomerName ?? ''),
        taxNumber: row.CustomerTaxNumber ?? undefined,
        licenseNumber: row.CustomerLicenseNumber ?? undefined,
      },
      position: {
        code: String(row.PositionCode ?? ''),
        description: row.PositionDescription ?? undefined,
      },
      payments: [] as Array<{
        code?: string
        issueDate?: string
        amount: number
        paymentFormCode?: string
        paymentFormDescription?: string
      }>,
      details: [] as Array<{
        product: { sequence?: number; code?: string; description?: string }
        quantity?: number
        netAmount?: number
        grossAmount?: number
        price?: number
        availability?: number
      }>,
      source: row.SourceFileName
        ? {
            fileName: String(row.SourceFileName),
            fileDate: row.SourceFileDate ? new Date(row.SourceFileDate).toISOString().slice(0, 10) : undefined,
            depotCode: row.SourceDepotCode ?? undefined,
          }
        : undefined,
    }))

    const collections = (payRes.recordset ?? []).map((row) => ({
      paymentKey: String(row.PaymentKey),
      invoiceCode: row.InvoiceCode ?? undefined,
      code: row.Code ?? undefined,
      issueDate: row.IssueDate ? new Date(row.IssueDate).toISOString() : undefined,
      amount: Number(row.Amount ?? 0),
      paymentFormCode: row.PaymentFormCode ?? undefined,
      paymentFormDescription: row.PaymentFormDescription ?? undefined,
      customer: {
        code: row.CustomerCode ?? undefined,
        registeredName: String(row.CustomerName ?? ''),
        taxNumber: row.CustomerTaxNumber ?? undefined,
        licenseNumber: row.CustomerLicenseNumber ?? undefined,
      },
      position: {
        code: String(row.PositionCode ?? ''),
        description: row.PositionDescription ?? undefined,
      },
      source: row.SourceFileName
        ? {
            fileName: String(row.SourceFileName),
            fileDate: row.SourceFileDate ? new Date(row.SourceFileDate).toISOString().slice(0, 10) : undefined,
            depotCode: row.SourceDepotCode ?? undefined,
          }
        : undefined,
    }))

    const paymentsByInvoiceCode = new Map<
      string,
      Array<{ code?: string; issueDate?: string; amount: number; paymentFormCode?: string; paymentFormDescription?: string }>
    >()
    for (const row of invPayRes.recordset ?? []) {
      const invoiceCode = String(row.InvoiceCode ?? '').trim()
      if (!invoiceCode) continue
      const arr = paymentsByInvoiceCode.get(invoiceCode) ?? []
      arr.push({
        code: row.Code ?? undefined,
        issueDate: row.IssueDate ? new Date(row.IssueDate).toISOString() : undefined,
        amount: Number(row.Amount ?? 0),
        paymentFormCode: row.PaymentFormCode ?? undefined,
        paymentFormDescription: row.PaymentFormDescription ?? undefined,
      })
      paymentsByInvoiceCode.set(invoiceCode, arr)
    }

    for (const inv of invoices) {
      inv.payments = paymentsByInvoiceCode.get(inv.code) ?? []
    }

    const detailsByInvoiceCode = new Map<string, Array<{
      product: { sequence?: number; code?: string; description?: string }
      quantity?: number
      netAmount?: number
      grossAmount?: number
      price?: number
      availability?: number
    }>>()
    for (const row of detailRes.recordset ?? []) {
      const invoiceCode = String(row.InvoiceCode ?? '').trim()
      if (!invoiceCode) continue
      const arr = detailsByInvoiceCode.get(invoiceCode) ?? []
      arr.push({
        product: {
          sequence: typeof row.ProductSequence === 'number' ? row.ProductSequence : row.ProductSequence != null ? Number(row.ProductSequence) : undefined,
          code: row.ProductCode ?? undefined,
          description: row.ProductDescription ?? undefined,
        },
        quantity: row.Quantity != null ? Number(row.Quantity) : undefined,
        netAmount: row.NetAmount != null ? Number(row.NetAmount) : undefined,
        grossAmount: row.GrossAmount != null ? Number(row.GrossAmount) : undefined,
        price: row.Price != null ? Number(row.Price) : undefined,
        availability: row.Availability != null ? Number(row.Availability) : undefined,
      })
      detailsByInvoiceCode.set(invoiceCode, arr)
    }

    for (const inv of invoices) {
      inv.details = detailsByInvoiceCode.get(inv.code) ?? []
    }

    const invoiceAllocations: Record<string, unknown> = {}
    for (const row of invAllocRes.recordset ?? []) {
      const code = String(row.InvoiceCode)
      const raw = String(row.AllocationsJson ?? '')
      if (!raw) continue
      try {
        invoiceAllocations[code] = JSON.parse(raw)
      } catch {
        invoiceAllocations[code] = []
      }
    }

    const paymentAllocations: Record<string, unknown> = {}
    for (const row of payAllocRes.recordset ?? []) {
      const key = String(row.PaymentKey)
      const raw = String(row.AllocationsJson ?? '')
      if (!raw) continue
      try {
        paymentAllocations[key] = JSON.parse(raw)
      } catch {
        paymentAllocations[key] = []
      }
    }

    res.json({
      ok: true,
      positionCode,
      invoices,
      collections,
      invoiceAllocations,
      paymentAllocations,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/mutabakat', async (req, res) => {
  try {
    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }
    const depot = typeof req.query.depot === 'string' ? req.query.depot.trim() : ''
    const position = typeof req.query.position === 'string' ? req.query.position.trim() : ''
    if (!depot || !position) {
      res.status(400).send('Depo ve pozisyon zorunlu')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const r = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depot)
      .input('PositionCode', mssql.NVarChar(64), position)
      .query(
        `
SELECT TOP 1
  SourceFileDate,
  DepotCode,
  PositionCode,
  Mode,
  TorbaTutari,
  EnteredAmount,
  AdjustmentAmount,
  DiffAmount,
  CashJson,
  BankName,
  BankDepositAmount,
  DekontNo,
  BankExplanation,
  BankReceiptDateTime,
  AdjustmentsJson,
  Status,
  UpdatedBy,
  UpdatedAt,
  CompletedBy,
  CompletedAt
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const row = r.recordset?.[0] as
      | {
          SourceFileDate: Date
          DepotCode: string
          PositionCode: string
          Mode: string
          TorbaTutari: unknown
          EnteredAmount: unknown
          AdjustmentAmount: unknown
          DiffAmount: unknown
          CashJson: string | null
          BankName: string | null
          BankDepositAmount: unknown
          DekontNo: string | null
          BankExplanation: string | null
          BankReceiptDateTime: Date | null
          AdjustmentsJson: string | null
          Status: string
          UpdatedBy: string | null
          UpdatedAt: Date | null
          CompletedBy: string | null
          CompletedAt: Date | null
        }
      | undefined

    if (!row) {
      res.json({ ok: true, record: null })
      return
    }

    let cashJson: unknown = undefined
    if (row.CashJson) {
      try {
        cashJson = JSON.parse(row.CashJson)
      } catch {
        cashJson = undefined
      }
    }
    let adjustments: unknown = undefined
    if (row.AdjustmentsJson) {
      try {
        adjustments = JSON.parse(row.AdjustmentsJson)
      } catch {
        adjustments = undefined
      }
    }

    res.json({
      ok: true,
      record: {
        sourceFileDate: row.SourceFileDate.toISOString().slice(0, 10),
        depotCode: row.DepotCode,
        positionCode: row.PositionCode,
        mode: row.Mode,
        torbaTutari: Number(row.TorbaTutari ?? 0),
        enteredAmount: Number(row.EnteredAmount ?? 0),
        adjustmentAmount: Number(row.AdjustmentAmount ?? 0),
        diffAmount: Number(row.DiffAmount ?? 0),
        cashJson,
        bankName: row.BankName ?? undefined,
        bankDepositAmount: row.BankDepositAmount != null ? Number(row.BankDepositAmount) : undefined,
        dekontNo: row.DekontNo ?? undefined,
        bankExplanation: row.BankExplanation ?? undefined,
        bankReceiptDateTime: row.BankReceiptDateTime ? new Date(row.BankReceiptDateTime).toISOString() : undefined,
        adjustments: Array.isArray(adjustments) ? adjustments : undefined,
        status: row.Status,
        updatedBy: row.UpdatedBy ?? undefined,
        updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
        completedBy: row.CompletedBy ?? undefined,
        completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : undefined,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/mutabakat', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }

    const parsedDate = parseQueryDate(req.body?.sourceFileDate)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }

    const depotCode = String(req.body?.depotCode ?? '').trim()
    const positionCode = String(req.body?.positionCode ?? '').trim()
    const mode = String(req.body?.mode ?? '').trim().toUpperCase()
    if (!depotCode || !positionCode || (mode !== 'NAKIT' && mode !== 'BANKA' && mode !== 'KARMA')) {
      res.status(400).send('Eksik alan')
      return
    }

    const torbaTutari = toNumberFlexible(req.body?.torbaTutari) ?? toNumberOrUndef(req.body?.torbaTutari) ?? null
    const enteredAmount = toNumberFlexible(req.body?.enteredAmount) ?? toNumberOrUndef(req.body?.enteredAmount) ?? null
    if (torbaTutari == null || enteredAmount == null) {
      res.status(400).send('Tutar zorunlu')
      return
    }

    const adjustments = req.body?.adjustments
    const adjustmentsJson = Array.isArray(adjustments) ? JSON.stringify(adjustments) : null
    const adjustmentAmount = Array.isArray(adjustments)
      ? adjustments.reduce((s: number, a: any) => s + (toNumberFlexible(a?.amount) ?? toNumberOrUndef(a?.amount) ?? 0), 0)
      : 0
    const diffAmount = enteredAmount + adjustmentAmount - torbaTutari

    const cashJson = req.body?.cashJson
    const cashJsonStr = cashJson != null ? JSON.stringify(cashJson) : null
    const rawCounterSelections: Array<{ deviceIp?: unknown; receiptId?: unknown; transactionDateTime?: unknown; autoNo?: unknown }> = []
    if (cashJson && typeof cashJson === 'object') {
      const list = (cashJson as any).counterSelections
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object') rawCounterSelections.push(item)
        }
      }
      const single = (cashJson as any).counterSelection
      if (single && typeof single === 'object') rawCounterSelections.push(single)
    }
    const cashCounterSelections = rawCounterSelections
      .map((s) => {
        const rawReceiptId = String(s?.receiptId ?? '').trim()
        const transactionDateTime = typeof s?.transactionDateTime === 'string' ? s.transactionDateTime : ''
        const receiptId = buildCounterId({ rawId: rawReceiptId, transactionDateTime })
        const deviceIp = normalizeIpText(s?.deviceIp)
        const autoNo = String(s?.autoNo ?? '').trim() || null
        const receiptDateTime = safeDate(transactionDateTime)
        return { deviceIp, receiptId, rawReceiptId, transactionDateTime, autoNo, receiptDateTime }
      })
      .filter((x) => !!x.receiptId)
    const bankName = String(req.body?.bankName ?? '').trim() || null
    const bankDepositAmount = toNumberFlexible(req.body?.bankDepositAmount) ?? toNumberOrUndef(req.body?.bankDepositAmount) ?? null
    const dekontNo = String(req.body?.dekontNo ?? '').trim() || null
    const bankExplanation = String(req.body?.bankExplanation ?? '').trim() || null
    const bankReceiptDateTime = safeDate(typeof req.body?.bankReceiptDateTime === 'string' ? req.body.bankReceiptDateTime : '')

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    if ((mode === 'NAKIT' || mode === 'KARMA') && cashCounterSelections.length > 0 && cashCounterSelections.some((x) => !x.deviceIp)) {
      const ipRes = await pool
        .request()
        .input('DepotCode', mssql.NVarChar(32), depotCode)
        .query('SELECT TOP 1 DeviceIp FROM dbo.DepotCashDeviceSettings WHERE DepotCode = @DepotCode')
      const ip = (ipRes.recordset?.[0] as { DeviceIp?: unknown } | undefined)?.DeviceIp
      const depotDeviceIp = normalizeIpText(ip)
      if (depotDeviceIp) {
        for (const sel of cashCounterSelections) {
          if (!sel.deviceIp) sel.deviceIp = depotDeviceIp
        }
      }
    }

    const existing = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1 Status
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )
    const existingStatus = (existing.recordset?.[0]?.Status as string | undefined) ?? null
    if (existingStatus === 'COMPLETED') {
      res.status(409).send('Mutabakat tamamlanmış')
      return
    }

    if ((mode === 'NAKIT' || mode === 'KARMA') && cashCounterSelections.length > 0) {
      const deviceIps = Array.from(new Set(cashCounterSelections.map((x) => x.deviceIp).filter(Boolean)))
      for (const deviceIp of deviceIps) {
        const usedCheck = await pool
          .request()
          .input('DeviceIp', mssql.NVarChar(128), deviceIp)
          .input('SourceFileDate', mssql.Date, parsedDate.date)
          .input('DepotCode', mssql.NVarChar(32), depotCode)
          .input('PositionCode', mssql.NVarChar(64), positionCode)
          .query(`
SELECT ReceiptId, ReceiptDateTime
FROM dbo.MutabakatCashReceiptUsageItems
WHERE DeviceIp = @DeviceIp
  AND NOT (SourceFileDate = @SourceFileDate AND DepotCode = @DepotCode AND PositionCode = @PositionCode)
`)
        const usedIds = new Set<string>()
        for (const row of usedCheck.recordset ?? []) {
          const receiptId = String((row as any)?.ReceiptId ?? '').trim()
          const dt = (row as any)?.ReceiptDateTime
          const dtIso = dt instanceof Date ? dt.toISOString() : String(dt ?? '').trim()
          const variants = buildReceiptIdVariants({ rawId: receiptId, transactionDateTime: dtIso })
          for (const v of variants) usedIds.add(v)
        }
        const selectionsForIp = cashCounterSelections.filter((x) => x.deviceIp === deviceIp)
        for (const sel of selectionsForIp) {
          const selectedVariants = buildReceiptIdVariants({
            rawId: sel.rawReceiptId || sel.receiptId,
            transactionDateTime: sel.receiptDateTime ? sel.receiptDateTime.toISOString() : sel.transactionDateTime,
          })
          for (const v of selectedVariants) {
            if (usedIds.has(v)) {
              res.status(409).send('Secilen sayim daha once kullanilmis')
              return
            }
          }
        }
      }
    }

    await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('Mode', mssql.NVarChar(8), mode)
      .input('TorbaTutari', mssql.Decimal(18, 4), torbaTutari)
      .input('EnteredAmount', mssql.Decimal(18, 4), enteredAmount)
      .input('AdjustmentAmount', mssql.Decimal(18, 4), adjustmentAmount)
      .input('DiffAmount', mssql.Decimal(18, 4), diffAmount)
      .input('CashJson', mssql.NVarChar(mssql.MAX), cashJsonStr)
      .input('BankName', mssql.NVarChar(64), bankName)
      .input('BankDepositAmount', mssql.Decimal(18, 4), bankDepositAmount)
      .input('DekontNo', mssql.NVarChar(64), dekontNo)
      .input('BankExplanation', mssql.NVarChar(512), bankExplanation)
      .input('BankReceiptDateTime', mssql.DateTime2(0), bankReceiptDateTime)
      .input('AdjustmentsJson', mssql.NVarChar(mssql.MAX), adjustmentsJson)
      .input('UserName', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.Mutabakat WITH (HOLDLOCK) AS t
USING (SELECT
  @SourceFileDate AS SourceFileDate,
  @DepotCode AS DepotCode,
  @PositionCode AS PositionCode,
  @Mode AS Mode,
  @TorbaTutari AS TorbaTutari,
  @EnteredAmount AS EnteredAmount,
  @AdjustmentAmount AS AdjustmentAmount,
  @DiffAmount AS DiffAmount,
  @CashJson AS CashJson,
  @BankName AS BankName,
  @BankDepositAmount AS BankDepositAmount,
  @DekontNo AS DekontNo,
  @BankExplanation AS BankExplanation,
  @BankReceiptDateTime AS BankReceiptDateTime,
  @AdjustmentsJson AS AdjustmentsJson,
  @UserName AS UserName
) AS s
ON t.SourceFileDate = s.SourceFileDate AND t.DepotCode = s.DepotCode AND t.PositionCode = s.PositionCode
WHEN MATCHED THEN
  UPDATE SET
    Mode = s.Mode,
    TorbaTutari = s.TorbaTutari,
    EnteredAmount = s.EnteredAmount,
    AdjustmentAmount = s.AdjustmentAmount,
    DiffAmount = s.DiffAmount,
    CashJson = s.CashJson,
    BankName = s.BankName,
    BankDepositAmount = s.BankDepositAmount,
    DekontNo = s.DekontNo,
    BankExplanation = s.BankExplanation,
    BankReceiptDateTime = s.BankReceiptDateTime,
    AdjustmentsJson = s.AdjustmentsJson,
    UpdatedBy = s.UserName,
    UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (
    SourceFileDate, DepotCode, PositionCode, Mode,
    TorbaTutari, EnteredAmount, AdjustmentAmount, DiffAmount,
    CashJson, BankName, BankDepositAmount, DekontNo, BankExplanation, BankReceiptDateTime, AdjustmentsJson,
    CreatedBy, UpdatedBy
  )
  VALUES (
    s.SourceFileDate, s.DepotCode, s.PositionCode, s.Mode,
    s.TorbaTutari, s.EnteredAmount, s.AdjustmentAmount, s.DiffAmount,
    s.CashJson, s.BankName, s.BankDepositAmount, s.DekontNo, s.BankExplanation, s.BankReceiptDateTime, s.AdjustmentsJson,
    s.UserName, s.UserName
  );
`,
      )

    await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
DELETE FROM dbo.MutabakatCashReceiptUsageItems
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    if (mode !== 'BANKA' && cashCounterSelections.length > 0) {
      for (const sel of cashCounterSelections) {
        if (!sel.deviceIp || !sel.receiptId) continue
        await pool
          .request()
          .input('SourceFileDate', mssql.Date, parsedDate.date)
          .input('DepotCode', mssql.NVarChar(32), depotCode)
          .input('PositionCode', mssql.NVarChar(64), positionCode)
          .input('DeviceIp', mssql.NVarChar(128), sel.deviceIp)
          .input('ReceiptId', mssql.NVarChar(64), sel.receiptId)
          .input('ReceiptDateTime', mssql.DateTime2(0), sel.receiptDateTime)
          .input('AutoNo', mssql.NVarChar(64), sel.autoNo)
          .input('SelectedBy', mssql.NVarChar(64), userName)
          .query(
            `
INSERT INTO dbo.MutabakatCashReceiptUsageItems (SourceFileDate, DepotCode, PositionCode, DeviceIp, ReceiptId, ReceiptDateTime, AutoNo, SelectedBy)
VALUES (@SourceFileDate, @DepotCode, @PositionCode, @DeviceIp, @ReceiptId, @ReceiptDateTime, @AutoNo, @SelectedBy)
`,
          )
      }
    }

    const readBack = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1
  SourceFileDate,
  DepotCode,
  PositionCode,
  Mode,
  TorbaTutari,
  EnteredAmount,
  AdjustmentAmount,
  DiffAmount,
  CashJson,
  BankName,
  BankDepositAmount,
  DekontNo,
  BankExplanation,
  BankReceiptDateTime,
  AdjustmentsJson,
  Status,
  UpdatedBy,
  UpdatedAt,
  CompletedBy,
  CompletedAt
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const row = readBack.recordset?.[0] as any
    let outCash: unknown = undefined
    if (row?.CashJson) {
      try {
        outCash = JSON.parse(String(row.CashJson))
      } catch {
        outCash = undefined
      }
    }
    let outAdj: unknown = undefined
    if (row?.AdjustmentsJson) {
      try {
        outAdj = JSON.parse(String(row.AdjustmentsJson))
      } catch {
        outAdj = undefined
      }
    }

    res.json({
      ok: true,
      record: {
        sourceFileDate: new Date(row.SourceFileDate).toISOString().slice(0, 10),
        depotCode: String(row.DepotCode),
        positionCode: String(row.PositionCode),
        mode: String(row.Mode),
        torbaTutari: Number(row.TorbaTutari ?? 0),
        enteredAmount: Number(row.EnteredAmount ?? 0),
        adjustmentAmount: Number(row.AdjustmentAmount ?? 0),
        diffAmount: Number(row.DiffAmount ?? 0),
        cashJson: outCash,
        bankName: row.BankName ?? undefined,
        bankDepositAmount: row.BankDepositAmount != null ? Number(row.BankDepositAmount) : undefined,
        dekontNo: row.DekontNo ?? undefined,
        bankExplanation: row.BankExplanation ?? undefined,
        bankReceiptDateTime: row.BankReceiptDateTime ? new Date(row.BankReceiptDateTime).toISOString() : undefined,
        adjustments: Array.isArray(outAdj) ? outAdj : undefined,
        status: String(row.Status),
        updatedBy: row.UpdatedBy ?? undefined,
        updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
        completedBy: row.CompletedBy ?? undefined,
        completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : undefined,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/mutabakat/complete', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }
    const parsedDate = parseQueryDate(req.body?.sourceFileDate)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }
    const depotCode = String(req.body?.depotCode ?? '').trim()
    const positionCode = String(req.body?.positionCode ?? '').trim()
    if (!depotCode || !positionCode) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const current = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1 DiffAmount, Status
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const row = current.recordset?.[0] as { DiffAmount: unknown; Status: string } | undefined
    if (!row) {
      res.status(404).send('Mutabakat kaydı bulunamadı')
      return
    }
    if (row.Status === 'COMPLETED') {
      res.status(409).send('Mutabakat zaten tamamlanmış')
      return
    }
    const diff = Number(row.DiffAmount ?? 0)
    const diffLimitTl = await getMutabakatDiffLimitTl(pool)
    if (Math.abs(diff) > diffLimitTl + 1e-9) {
      res.status(400).send(`Fark izinli limit dışında (±${diffLimitTl})`)
      return
    }

    await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .input('UserName', mssql.NVarChar(64), userName)
      .query(
        `
UPDATE dbo.Mutabakat
SET Status = 'COMPLETED',
    CompletedBy = @UserName,
    CompletedAt = SYSUTCDATETIME(),
    UpdatedBy = @UserName,
    UpdatedAt = SYSUTCDATETIME()
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const readBack = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .input('PositionCode', mssql.NVarChar(64), positionCode)
      .query(
        `
SELECT TOP 1
  SourceFileDate,
  DepotCode,
  PositionCode,
  Mode,
  TorbaTutari,
  EnteredAmount,
  AdjustmentAmount,
  DiffAmount,
  CashJson,
  BankName,
  BankDepositAmount,
  DekontNo,
  BankExplanation,
  BankReceiptDateTime,
  AdjustmentsJson,
  Status,
  UpdatedBy,
  UpdatedAt,
  CompletedBy,
  CompletedAt
FROM dbo.Mutabakat
WHERE SourceFileDate = @SourceFileDate
  AND DepotCode = @DepotCode
  AND PositionCode = @PositionCode
`,
      )

    const rrow = readBack.recordset?.[0] as any
    let outCash: unknown = undefined
    if (rrow?.CashJson) {
      try {
        outCash = JSON.parse(String(rrow.CashJson))
      } catch {
        outCash = undefined
      }
    }
    let outAdj: unknown = undefined
    if (rrow?.AdjustmentsJson) {
      try {
        outAdj = JSON.parse(String(rrow.AdjustmentsJson))
      } catch {
        outAdj = undefined
      }
    }

    res.json({
      ok: true,
      record: {
        sourceFileDate: new Date(rrow.SourceFileDate).toISOString().slice(0, 10),
        depotCode: String(rrow.DepotCode),
        positionCode: String(rrow.PositionCode),
        mode: String(rrow.Mode),
        torbaTutari: Number(rrow.TorbaTutari ?? 0),
        enteredAmount: Number(rrow.EnteredAmount ?? 0),
        adjustmentAmount: Number(rrow.AdjustmentAmount ?? 0),
        diffAmount: Number(rrow.DiffAmount ?? 0),
        cashJson: outCash,
        bankName: rrow.BankName ?? undefined,
        bankDepositAmount: rrow.BankDepositAmount != null ? Number(rrow.BankDepositAmount) : undefined,
        dekontNo: rrow.DekontNo ?? undefined,
        bankExplanation: rrow.BankExplanation ?? undefined,
        bankReceiptDateTime: rrow.BankReceiptDateTime ? new Date(rrow.BankReceiptDateTime).toISOString() : undefined,
        adjustments: Array.isArray(outAdj) ? outAdj : undefined,
        status: String(rrow.Status),
        updatedBy: rrow.UpdatedBy ?? undefined,
        updatedAt: rrow.UpdatedAt ? new Date(rrow.UpdatedAt).toISOString() : undefined,
        completedBy: rrow.CompletedBy ?? undefined,
        completedAt: rrow.CompletedAt ? new Date(rrow.CompletedAt).toISOString() : undefined,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/reports/end-of-day', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    if (!userName) {
      res.status(401).send('Yetkisiz')
      return
    }

    const parsedDate = parseQueryDate(req.query.date)
    if (!parsedDate.ok || !parsedDate.date) {
      res.status(400).send(parsedDate.ok ? 'Tarih zorunlu' : parsedDate.error)
      return
    }
    const depotCode = String(req.query.depot ?? '').trim()
    if (!depotCode) {
      res.status(400).send('Depo zorunlu')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const mutabakatRes = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .query(`
SELECT
  m.PositionCode,
  m.BankName,
  m.BankDepositAmount,
  m.CashJson,
  m.AdjustmentsJson,
  m.UpdatedBy,
  m.UpdatedAt,
  r.RepresentativeName
FROM dbo.Mutabakat m
LEFT JOIN dbo.PositionRepresentativeMap r ON r.PositionCode = m.PositionCode
WHERE m.SourceFileDate = @SourceFileDate
  AND m.DepotCode = @DepotCode
  AND m.Status = 'COMPLETED'
`)

    const invoiceEditRes = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .query(`
SELECT TOP 5000
  e.ChangedAt,
  e.ChangedBy,
  e.EntityKey AS InvoiceCode,
  e.FromJson,
  e.ToJson,
  i.position_code AS PositionCode,
  cu.registered_name AS CustomerName,
  r.RepresentativeName
FROM dbo.AllocationEdits e
JOIN dist2k.FACT_INVOICE i ON i.invoice_code = e.EntityKey
LEFT JOIN dist2k.DIM_CUSTOMER cu ON cu.customer_code = i.customer_code
LEFT JOIN dbo.PositionRepresentativeMap r ON r.PositionCode = i.position_code
WHERE e.EntityType = 'invoice'
  AND i.source_file_date = @SourceFileDate
  AND i.source_depot_code = @DepotCode
ORDER BY e.ChangedAt DESC
`)

    const paymentEditRes = await pool
      .request()
      .input('SourceFileDate', mssql.Date, parsedDate.date)
      .input('DepotCode', mssql.NVarChar(32), depotCode)
      .query(`
SELECT TOP 5000
  e.ChangedAt,
  e.ChangedBy,
  e.EntityKey AS PaymentKey,
  e.FromJson,
  e.ToJson,
  c.position_code AS PositionCode,
  c.invoice_code AS InvoiceCode,
  cu.registered_name AS CustomerName,
  r.RepresentativeName
FROM dbo.AllocationEdits e
JOIN dist2k.FACT_COLLECTION c ON c.collection_code = e.EntityKey
LEFT JOIN dist2k.DIM_CUSTOMER cu ON cu.customer_code = c.customer_code
LEFT JOIN dbo.PositionRepresentativeMap r ON r.PositionCode = c.position_code
WHERE e.EntityType = 'payment'
  AND c.source_file_date = @SourceFileDate
  AND c.source_depot_code = @DepotCode
ORDER BY e.ChangedAt DESC
`)

    const bankTotals = new Map<string, { bankName: string; totalAmount: number; recordCount: number }>()
    const cashByPositionMap = new Map<string, { positionCode: string; representativeName: string; denominationTotals: Record<string, number>; totalCash: number }>()
    const cashOverallMap = new Map<string, number>()
    const adjustmentRows: Array<{
      positionCode: string
      representativeName: string
      type: string
      description: string
      amount: number
      updatedAt?: string
      updatedBy?: string
    }> = []
    const denoms = ['200', '100', '50', '20', '10', '5', '1']

    for (const row of mutabakatRes.recordset ?? []) {
      const bankName = String(row.BankName ?? '').trim() || '-'
      const bankAmount = Number(row.BankDepositAmount ?? 0) || 0
      if (bankAmount > 0) {
        const prev = bankTotals.get(bankName) ?? { bankName, totalAmount: 0, recordCount: 0 }
        prev.totalAmount += bankAmount
        prev.recordCount += 1
        bankTotals.set(bankName, prev)
      }

      const positionCode = String(row.PositionCode ?? '').trim()
      const representativeName = String(row.RepresentativeName ?? '').trim() || '-'
      const key = `${positionCode}|${representativeName}`
      const pos = cashByPositionMap.get(key) ?? {
        positionCode,
        representativeName,
        denominationTotals: { '200': 0, '100': 0, '50': 0, '20': 0, '10': 0, '5': 0, '1': 0 },
        totalCash: 0,
      }
      let banknoteCounts: Record<string, unknown> = {}
      if (row.CashJson) {
        try {
          const parsed = JSON.parse(String(row.CashJson)) as { banknoteCounts?: Record<string, unknown> }
          if (parsed && parsed.banknoteCounts && typeof parsed.banknoteCounts === 'object') banknoteCounts = parsed.banknoteCounts
        } catch {}
      }
      for (const d of denoms) {
        const entered = Number(banknoteCounts[d] ?? 0) || 0
        if (entered <= 0) continue
        const lineTotal = d === '1' ? entered : Number(d) * entered
        pos.denominationTotals[d] = (pos.denominationTotals[d] ?? 0) + lineTotal
        pos.totalCash += lineTotal
        cashOverallMap.set(d, (cashOverallMap.get(d) ?? 0) + lineTotal)
      }
      cashByPositionMap.set(key, pos)

      let adjustments: Array<{ type?: unknown; description?: unknown; amount?: unknown }> = []
      if (row.AdjustmentsJson) {
        try {
          const parsed = JSON.parse(String(row.AdjustmentsJson))
          if (Array.isArray(parsed)) adjustments = parsed as Array<{ type?: unknown; description?: unknown; amount?: unknown }>
        } catch {}
      }
      for (const a of adjustments) {
        const amount = Number(a?.amount ?? 0) || 0
        if (amount === 0) continue
        adjustmentRows.push({
          positionCode,
          representativeName,
          type: String(a?.type ?? ''),
          description: String(a?.description ?? '').trim(),
          amount,
          updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
          updatedBy: row.UpdatedBy ? String(row.UpdatedBy) : undefined,
        })
      }
    }

    const bankTotalsRows = Array.from(bankTotals.values()).sort((a, b) => b.totalAmount - a.totalAmount)
    const totalBankDeposit = bankTotalsRows.reduce((s, x) => s + x.totalAmount, 0)
    const cashByPositionRows = Array.from(cashByPositionMap.values()).sort((a, b) => {
      const repCmp = a.representativeName.localeCompare(b.representativeName, 'tr', { sensitivity: 'base' })
      if (repCmp !== 0) return repCmp
      return a.positionCode.localeCompare(b.positionCode, 'tr', { sensitivity: 'base' })
    })
    const cashOverallRows = denoms.map((d) => ({ denomination: d, amount: cashOverallMap.get(d) ?? 0 })).filter((x) => x.amount > 0)

    const invoiceAllocationChanges = (invoiceEditRes.recordset ?? []).map((row) => ({
      changedAt: row.ChangedAt ? new Date(row.ChangedAt).toISOString() : undefined,
      changedBy: row.ChangedBy ? String(row.ChangedBy) : undefined,
      positionCode: String(row.PositionCode ?? ''),
      representativeName: String(row.RepresentativeName ?? '').trim() || '-',
      invoiceCode: String(row.InvoiceCode ?? ''),
      customerName: String(row.CustomerName ?? '').trim() || '-',
      fromJson: row.FromJson != null ? String(row.FromJson) : undefined,
      toJson: row.ToJson != null ? String(row.ToJson) : undefined,
    }))

    const paymentAllocationChanges = (paymentEditRes.recordset ?? []).map((row) => ({
      changedAt: row.ChangedAt ? new Date(row.ChangedAt).toISOString() : undefined,
      changedBy: row.ChangedBy ? String(row.ChangedBy) : undefined,
      positionCode: String(row.PositionCode ?? ''),
      representativeName: String(row.RepresentativeName ?? '').trim() || '-',
      paymentKey: String(row.PaymentKey ?? ''),
      invoiceCode: String(row.InvoiceCode ?? ''),
      customerName: String(row.CustomerName ?? '').trim() || '-',
      fromJson: row.FromJson != null ? String(row.FromJson) : undefined,
      toJson: row.ToJson != null ? String(row.ToJson) : undefined,
    }))

    res.json({
      ok: true,
      report: {
        date: parsedDate.date.toISOString().slice(0, 10),
        depotCode,
        completedMutabakatCount: (mutabakatRes.recordset ?? []).length,
        totalBankDeposit,
        bankTotals: bankTotalsRows,
        cashByPosition: cashByPositionRows,
        cashOverall: cashOverallRows,
        invoiceAllocationChanges,
        paymentAllocationChanges,
        adjustments: adjustmentRows.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))),
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/allocations/invoice', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    const invoiceCode = String(req.body?.invoiceCode ?? '').trim()
    const allocations = req.body?.allocations
    if (!userName || !invoiceCode || !Array.isArray(allocations)) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const nextJson = JSON.stringify(allocations)
    const currentRes = await pool
      .request()
      .input('InvoiceCode', mssql.NVarChar(64), invoiceCode)
      .query('SELECT TOP 1 AllocationsJson FROM dbo.InvoiceAllocations WHERE InvoiceCode = @InvoiceCode')
    const fromJson = (currentRes.recordset?.[0]?.AllocationsJson as string | undefined) ?? null

    await pool
      .request()
      .input('InvoiceCode', mssql.NVarChar(64), invoiceCode)
      .input('AllocationsJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('UpdatedBy', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.InvoiceAllocations WITH (HOLDLOCK) AS t
USING (SELECT @InvoiceCode AS InvoiceCode, @AllocationsJson AS AllocationsJson, @UpdatedBy AS UpdatedBy) AS s
ON t.InvoiceCode = s.InvoiceCode
WHEN MATCHED THEN UPDATE SET AllocationsJson = s.AllocationsJson, UpdatedBy = s.UpdatedBy, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (InvoiceCode, AllocationsJson, UpdatedBy) VALUES (s.InvoiceCode, s.AllocationsJson, s.UpdatedBy);
`,
      )

    await pool
      .request()
      .input('EntityType', mssql.NVarChar(16), 'invoice')
      .input('EntityKey', mssql.NVarChar(300), invoiceCode)
      .input('FromJson', mssql.NVarChar(mssql.MAX), fromJson)
      .input('ToJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('ChangedBy', mssql.NVarChar(64), userName)
      .query(
        `
INSERT INTO dbo.AllocationEdits (EntityType, EntityKey, FromJson, ToJson, ChangedBy)
VALUES (@EntityType, @EntityKey, @FromJson, @ToJson, @ChangedBy);
`,
      )

    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.post('/api/allocations/payment', async (req, res) => {
  try {
    const userName = String(req.header('x-user') ?? '').trim()
    const paymentKey = String(req.body?.paymentKey ?? '').trim()
    const allocations = req.body?.allocations
    if (!userName || !paymentKey || !Array.isArray(allocations)) {
      res.status(400).send('Eksik alan')
      return
    }

    const pool = await getPool()
    await ensureSchema(pool)
    const active = await requireActiveUser(pool, userName)
    if (!active.active) {
      res.status(401).send('Yetkisiz')
      return
    }

    const nextJson = JSON.stringify(allocations)
    const currentRes = await pool
      .request()
      .input('PaymentKey', mssql.NVarChar(300), paymentKey)
      .query('SELECT TOP 1 AllocationsJson FROM dbo.PaymentAllocations WHERE PaymentKey = @PaymentKey')
    const fromJson = (currentRes.recordset?.[0]?.AllocationsJson as string | undefined) ?? null

    await pool
      .request()
      .input('PaymentKey', mssql.NVarChar(300), paymentKey)
      .input('AllocationsJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('UpdatedBy', mssql.NVarChar(64), userName)
      .query(
        `
MERGE dbo.PaymentAllocations WITH (HOLDLOCK) AS t
USING (SELECT @PaymentKey AS PaymentKey, @AllocationsJson AS AllocationsJson, @UpdatedBy AS UpdatedBy) AS s
ON t.PaymentKey = s.PaymentKey
WHEN MATCHED THEN UPDATE SET AllocationsJson = s.AllocationsJson, UpdatedBy = s.UpdatedBy, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (PaymentKey, AllocationsJson, UpdatedBy) VALUES (s.PaymentKey, s.AllocationsJson, s.UpdatedBy);
`,
      )

    await pool
      .request()
      .input('EntityType', mssql.NVarChar(16), 'payment')
      .input('EntityKey', mssql.NVarChar(300), paymentKey)
      .input('FromJson', mssql.NVarChar(mssql.MAX), fromJson)
      .input('ToJson', mssql.NVarChar(mssql.MAX), nextJson)
      .input('ChangedBy', mssql.NVarChar(64), userName)
      .query(
        `
INSERT INTO dbo.AllocationEdits (EntityType, EntityKey, FromJson, ToJson, ChangedBy)
VALUES (@EntityType, @EntityKey, @FromJson, @ToJson, @ChangedBy);
`,
      )

    res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

app.get('/api/edits', async (req, res) => {
  try {
    const entityType = String(req.query.type ?? '').trim()
    const entityKey = String(req.query.key ?? '').trim()
    const changedBy = String(req.query.user ?? '').trim()

    const pool = await getPool()
    await ensureSchema(pool)

    const r = await pool
      .request()
      .input('EntityType', mssql.NVarChar(16), entityType || null)
      .input('EntityKey', mssql.NVarChar(300), entityKey || null)
      .input('ChangedBy', mssql.NVarChar(64), changedBy || null)
      .query(
        `
SELECT TOP 500
  Id, EntityType, EntityKey, FromJson, ToJson, ChangedBy, ChangedAt
FROM dbo.AllocationEdits
WHERE (@EntityType IS NULL OR EntityType = @EntityType)
  AND (@EntityKey IS NULL OR EntityKey = @EntityKey)
  AND (@ChangedBy IS NULL OR ChangedBy = @ChangedBy)
ORDER BY Id DESC
`,
      )

    res.json({ ok: true, edits: r.recordset ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Bilinmeyen hata'
    res.status(500).send(msg)
  }
})

const server = http.createServer(app)
server.requestTimeout = env.httpRequestTimeoutMs
server.headersTimeout = env.httpHeadersTimeoutMs
server.keepAliveTimeout = env.httpKeepAliveTimeoutMs

server.listen(env.port, () => {
  process.stdout.write(`API listening on http://localhost:${env.port}\n`)
})
