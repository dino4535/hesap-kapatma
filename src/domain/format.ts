export function formatMoney(amount: number) {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(amount)
}

function normalizeDateTimeText(value: string) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  return s.replace(/T(\d{2}:\d{2}:\d{2}):(\d{1,6})(?=(?:Z|[+-]\d{2}:?\d{2})?$)/, (_m, hms, ms) => `T${hms}.${ms}`)
}

function extractIsoParts(value: string) {
  const s = normalizeDateTimeText(value)
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(s)
  if (!m) return null
  const yyyy = Number(m[1])
  const mm = Number(m[2])
  const dd = Number(m[3])
  const hh = Number(m[4])
  const mi = Number(m[5])
  const ss = Number(m[6])
  const msRaw = String(m[7] ?? '')
  const ms = msRaw ? Number(msRaw.slice(0, 3).padEnd(3, '0')) : 0
  if (![yyyy, mm, dd, hh, mi, ss, ms].every(Number.isFinite)) return null
  return { yyyy, mm, dd, hh, mi, ss, ms }
}

export function formatDateTr(value?: string) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}.${mm}.${yyyy}`
}

export function formatDateTimeTr(value?: string) {
  if (!value) return '-'
  const iso = extractIsoParts(value)
  if (iso) {
    const dd = String(iso.dd).padStart(2, '0')
    const mm = String(iso.mm).padStart(2, '0')
    const yyyy = String(iso.yyyy)
    const hh = String(iso.hh).padStart(2, '0')
    const mi = String(iso.mi).padStart(2, '0')
    const ss = String(iso.ss).padStart(2, '0')
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`
  }
  const d = new Date(normalizeDateTimeText(value))
  if (Number.isNaN(d.getTime())) return value
  const fmtParts = new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const byType = new Map(fmtParts.map((p) => [p.type, p.value] as const))
  const dd = byType.get('day') ?? ''
  const mm = byType.get('month') ?? ''
  const yyyy = byType.get('year') ?? ''
  const hh = byType.get('hour') ?? ''
  const min = byType.get('minute') ?? ''
  const ss = byType.get('second') ?? ''
  if (!dd || !mm || !yyyy) return d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
  return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`
}

export function dateTimeToMs(value?: string) {
  const s = String(value ?? '').trim()
  if (!s) return 0
  const parts = extractIsoParts(s)
  if (parts) return Date.UTC(parts.yyyy, parts.mm - 1, parts.dd, parts.hh, parts.mi, parts.ss, parts.ms)
  const t = new Date(normalizeDateTimeText(s)).getTime()
  return Number.isFinite(t) ? t : 0
}
