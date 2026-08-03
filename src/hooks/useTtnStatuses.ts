// Статуси ТТН для списків/карток: батч-запит до Нової Пошти (до 100 накладних за виклик),
// кеш на час життя сторінки (повторно один і той самий номер не запитується).
import { useEffect, useRef, useState } from 'react'
import { trackParcels } from '@/api/endpoints/novaposhta'

export type TtnStatus = { status: string; code: string }

// Колір чипа за текстом статусу НП.
export const ttnChipColor = (status: string): 'default' | 'info' | 'success' | 'error' => {
  const s = (status || '').toLowerCase()
  if (s.includes('отримано') || s.includes('вручен')) return 'success'
  if (s.includes('відмова') || s.includes('не знайдено') || s.includes('видален')) return 'error'
  if (s.includes('створена')) return 'default'
  return 'info' // прямує / прибув у відділення / тощо
}

export function useTtnStatuses(ttns: (string | null | undefined)[]): Record<string, TtnStatus> {
  const [map, setMap] = useState<Record<string, TtnStatus>>({})
  const requested = useRef(new Set<string>())
  const key = [...new Set(ttns.map((t) => String(t || '').replace(/\D/g, '')).filter(Boolean))].sort().join(',')

  useEffect(() => {
    const clean = key ? key.split(',') : []
    const fresh = clean.filter((t) => !requested.current.has(t))
    if (!fresh.length) return
    fresh.forEach((t) => requested.current.add(t))
    let alive = true
    ;(async () => {
      for (let i = 0; i < fresh.length; i += 100) {
        const res = await trackParcels(fresh.slice(i, i + 100))
        if (!alive) return
        setMap((m) => ({ ...m, ...res }))
      }
    })()
    return () => { alive = false }
  }, [key])

  return map
}
