export function formatMoney(amount: number) {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(amount)
}

function normalizeDateTimeText(value: string) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  return s.replace(/T(\d{2}:\d{2}:\d{2}):(\d{1,6})(?=(?:Z|[+-]\d{2}:?\d{2})?$)/, (_m, hms, ms) => `T${hms}.${ms}`)
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
  const d = new Date(normalizeDateTimeText(value))
  if (Number.isNaN(d.getTime())) return value
  const parts = new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const byType = new Map(parts.map((p) => [p.type, p.value] as const))
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
  const s = normalizeDateTimeText(String(value ?? '').trim())
  if (!s) return 0
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : 0
}
