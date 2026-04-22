import { describe, expect, it } from 'vitest'
import { calculateStats } from './stats'
import type { Invoice } from './models'

describe('calculateStats', () => {
  it('gruplar ve toplamları üretir', () => {
    const data: Invoice[] = [
      {
        code: 'A',
        salesType: 'VADELISATIS',
        netAmount: 10,
        customer: { registeredName: 'X' },
        position: { code: 'R1' },
        payments: [],
      },
      {
        code: 'B',
        salesType: 'HHSATIS',
        netAmount: 5,
        customer: { registeredName: 'Y' },
        position: { code: 'R1' },
        payments: [],
      },
      {
        code: 'C',
        salesType: 'VADELISATIS',
        netAmount: 7,
        customer: { registeredName: 'Z' },
        position: { code: 'R2' },
        payments: [],
      },
    ]

    const stats = calculateStats(data)
    expect(stats.R1.total).toBe(15)
    expect(stats.R1.vadeli).toBe(10)
    expect(stats.R1.hhsat).toBe(5)
    expect(stats.R2.total).toBe(7)
    expect(stats.R2.vadeli).toBe(7)
  })
})

