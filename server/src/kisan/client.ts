import { Client as FtpClient } from 'basic-ftp'
import { Writable } from 'node:stream'

export type KisanReceipt = {
  id: string
  time?: string
  display_time?: string
  date_key?: string
  daily_seq?: number
  auto_no?: string
  source_file?: string
  total_val?: number
  total_qty?: number
  details?: Array<{ nominal?: number; qty?: number }>
}

type KisanReceiptInternal = KisanReceipt & { _timestampMs: number }

function formatDateTimeTr(d: Date) {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function fileIdFromName(name: string) {
  const noExt = name.replace(/\.xml$/i, '')
  const parts = noExt.split('_')
  return (parts[parts.length - 1] ?? noExt).trim()
}

function parseReceiptXml(xmlText: string, sourceFile: string): KisanReceiptInternal | null {
  const sendDateTimeMatch = /sendDateTime\s*=\s*"([^"]+)"/i.exec(xmlText)
  const rawTime = String(sendDateTimeMatch?.[1] ?? '').trim()
  const timeDate = rawTime ? new Date(rawTime) : new Date(NaN)
  const valid = Number.isFinite(timeDate.getTime())
  const displayTime = valid ? formatDateTimeTr(timeDate) : rawTime
  const dateKey = valid
    ? `${timeDate.getFullYear()}-${String(timeDate.getMonth() + 1).padStart(2, '0')}-${String(timeDate.getDate()).padStart(2, '0')}`
    : 'Unknown'

  const details: Array<{ nominal?: number; qty?: number }> = []
  let totalVal = 0
  let totalQty = 0
  const lineRegex = /<line\b[\s\S]*?<\/line>/gi
  const lines = xmlText.match(lineRegex) ?? []
  for (const line of lines) {
    const nominalText = /<nominal>\s*([^<]+)\s*<\/nominal>/i.exec(line)?.[1] ?? ''
    const qtyText = /<qty>\s*([^<]+)\s*<\/qty>/i.exec(line)?.[1] ?? ''
    const nominal = Number(nominalText)
    const qty = Number(qtyText)
    if (!Number.isFinite(nominal) || !Number.isFinite(qty)) continue
    details.push({ nominal, qty })
    totalVal += nominal * qty
    totalQty += qty
  }

  return {
    id: fileIdFromName(sourceFile),
    time: rawTime,
    display_time: displayTime,
    date_key: dateKey,
    source_file: sourceFile,
    total_val: totalVal,
    total_qty: totalQty,
    details,
    _timestampMs: valid ? timeDate.getTime() : 0,
  }
}

async function downloadTextFile(ftp: FtpClient, remoteName: string) {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      cb()
    },
  })
  await ftp.downloadTo(sink, remoteName)
  return Buffer.concat(chunks).toString('utf-8')
}

export async function fetchKisanReceiptsFromDevice(args: { ip: string; user: string; password: string; dateYmd: string }) {
  const ftp = new FtpClient(25000)
  const dayText = String(args.dateYmd ?? '').trim()
  const dayToken = /^\d{4}-\d{2}-\d{2}$/.test(dayText) ? dayText.replaceAll('-', '') : new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const ibsPath = '/media/mmcblk0p4/Newton/Application/Data/IBS/'

  try {
    await ftp.access({
      host: args.ip,
      user: args.user,
      password: args.password,
      secure: false,
    })
    await ftp.cd(ibsPath)
    const files = await ftp.list()
    const xmlFiles = files
      .map((f) => String(f.name ?? '').trim())
      .filter((f) => f.toLowerCase().endsWith('.xml') && f.includes(dayToken))
      .sort((a, b) => a.localeCompare(b))

    const receipts: KisanReceiptInternal[] = []
    for (const fileName of xmlFiles) {
      try {
        const xml = await downloadTextFile(ftp, fileName)
        const receipt = parseReceiptXml(xml, fileName)
        if (receipt?.id) receipts.push(receipt)
      } catch {
        // Tek dosya hatasi tum gunu durdurmasin.
      }
    }

    receipts.sort((a, b) => b._timestampMs - a._timestampMs)
    const groups = new Map<string, KisanReceiptInternal[]>()
    for (const r of receipts) {
      const key = String(r.date_key ?? 'Unknown') || 'Unknown'
      const arr = groups.get(key) ?? []
      arr.push(r)
      groups.set(key, arr)
    }
    for (const [dk, arr] of groups.entries()) {
      const chronological = [...arr].sort((a, b) => a._timestampMs - b._timestampMs)
      chronological.forEach((r, idx) => {
        r.daily_seq = idx + 1
        r.auto_no = dk !== 'Unknown' ? `${dk.replaceAll('-', '')}-${String(idx + 1).padStart(3, '0')}` : `UNK-${String(idx + 1).padStart(3, '0')}`
      })
    }

    return receipts.map(({ _timestampMs: _drop, ...r }) => r)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Cihazdan veri alinamadi'
    throw new Error(`Kisan cihaz baglantisi basarisiz: ${msg}`)
  } finally {
    ftp.close()
  }
}
