// Пикер адреса Новой Почты: город (поиск) + отделение. Возвращает {cityRef, cityName,
// warehouseRef, warehouseName}. Инициализируется из сохранённого значения (показывает имя города
// без повторного поиска). Переиспользуется в шаблонах и диалоге создания ТТН.
import { useEffect, useMemo, useState } from 'react'
import { Autocomplete, TextField, MenuItem, Stack } from '@mui/material'
import { searchCities, getWarehouses, type NPCity, type NPWarehouse } from '@/api/endpoints/novaposhta'
import type { NpAddress } from '@/types/npTemplate'

export default function NpAddressPicker({ value, onChange, label = 'Місто', warehouseLabel = 'Відділення', size = 'small' }: {
  value: NpAddress
  onChange: (v: NpAddress) => void
  label?: string
  warehouseLabel?: string
  size?: 'small' | 'medium'
}) {
  const [query, setQuery] = useState('')
  const [cities, setCities] = useState<NPCity[]>([])
  const [warehouses, setWarehouses] = useState<NPWarehouse[]>([])

  // Текущий город как опция (чтобы показать сохранённое имя даже без поиска)
  const currentCity = useMemo<NPCity | null>(
    () => (value.cityRef ? { Ref: value.cityRef, Description: value.cityName || value.cityRef, DescriptionRu: '', Area: '', AreaDescription: '' } : null),
    [value.cityRef, value.cityName]
  )

  useEffect(() => {
    if (query.trim().length < 2) { setCities([]); return }
    let alive = true
    const t = setTimeout(async () => { const r = await searchCities(query.trim()); if (alive) setCities(r) }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [query])

  // Загрузка отделений выбранного города (в т.ч. при инициализации сохранённого значения)
  useEffect(() => {
    if (!value.cityRef) { setWarehouses([]); return }
    getWarehouses(value.cityRef).then(setWarehouses)
  }, [value.cityRef])

  const options = useMemo(() => {
    const map = new Map<string, NPCity>()
    if (currentCity) map.set(currentCity.Ref, currentCity)
    for (const c of cities) map.set(c.Ref, c)
    return [...map.values()]
  }, [cities, currentCity])

  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
      <Autocomplete
        sx={{ flex: 1 }} options={options} getOptionLabel={(o) => o.Description || ''} filterOptions={(x) => x}
        value={currentCity} isOptionEqualToValue={(a, b) => a.Ref === b.Ref}
        onChange={(_, v) => onChange({ cityRef: v?.Ref || '', cityName: v?.Description || '', warehouseRef: '', warehouseName: '' })}
        onInputChange={(_, v, reason) => { if (reason === 'input') setQuery(v) }}
        renderInput={(p) => <TextField {...p} label={label} size={size} />}
      />
      <TextField select sx={{ flex: 1 }} label={warehouseLabel} size={size} value={value.warehouseRef || ''} disabled={!value.cityRef}
        onChange={(e) => {
          const w = warehouses.find((x) => x.Ref === e.target.value)
          onChange({ ...value, warehouseRef: e.target.value, warehouseName: w?.Description || value.warehouseName || '' })
        }}>
        {value.warehouseRef && !warehouses.some((w) => w.Ref === value.warehouseRef) && (
          <MenuItem value={value.warehouseRef}>{value.warehouseName || value.warehouseRef}</MenuItem>
        )}
        {warehouses.map((w) => <MenuItem key={w.Ref} value={w.Ref}>{w.Description}</MenuItem>)}
      </TextField>
    </Stack>
  )
}
