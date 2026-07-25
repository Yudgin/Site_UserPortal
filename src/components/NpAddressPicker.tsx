// Пикер адреса Новой Почты. Режим delivery:
//  • 'warehouse' — город (поиск) + отделение (выбор).
//  • 'address' — город (поиск) + улица (поиск) + дом + квартира (курьерская доставка).
// Возвращает NpAddress. Инициализируется из сохранённого значения. Переиспользуется в шаблонах и диалоге.
import { useEffect, useMemo, useState } from 'react'
import { Autocomplete, TextField, Stack } from '@mui/material'
import { searchCities, getWarehouses, searchStreets, type NPCity, type NPWarehouse, type NPStreet } from '@/api/endpoints/novaposhta'
import type { NpAddress } from '@/types/npTemplate'

export default function NpAddressPicker({ value, onChange, delivery = 'warehouse', label = 'Місто', warehouseLabel = 'Відділення', size = 'small' }: {
  value: NpAddress
  onChange: (v: NpAddress) => void
  delivery?: 'warehouse' | 'address'
  label?: string
  warehouseLabel?: string
  size?: 'small' | 'medium'
}) {
  const [cityQuery, setCityQuery] = useState('')
  const [cities, setCities] = useState<NPCity[]>([])
  const [warehouses, setWarehouses] = useState<NPWarehouse[]>([])
  const [streetQuery, setStreetQuery] = useState('')
  const [streets, setStreets] = useState<NPStreet[]>([])

  const currentCity = useMemo<NPCity | null>(
    () => (value.cityRef ? { Ref: value.cityRef, SettlementRef: value.settlementRef, Description: value.cityName || value.cityRef, DescriptionRu: '', Area: '', AreaDescription: '' } : null),
    [value.cityRef, value.cityName, value.settlementRef]
  )
  const currentStreet = useMemo<NPStreet | null>(
    () => (value.streetRef ? { Ref: value.streetRef, Description: value.streetName || value.streetRef } : null),
    [value.streetRef, value.streetName]
  )

  useEffect(() => {
    if (cityQuery.trim().length < 2) { setCities([]); return }
    let alive = true
    const t = setTimeout(async () => { const r = await searchCities(cityQuery.trim()); if (alive) setCities(r) }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [cityQuery])

  useEffect(() => {
    if (delivery !== 'warehouse' || !value.cityRef) { setWarehouses([]); return }
    getWarehouses(value.cityRef).then(setWarehouses)
  }, [value.cityRef, delivery])

  useEffect(() => {
    if (delivery !== 'address' || !value.settlementRef || streetQuery.trim().length < 2) { setStreets([]); return }
    let alive = true
    const t = setTimeout(async () => { const r = await searchStreets(value.settlementRef!, streetQuery.trim()); if (alive) setStreets(r) }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [streetQuery, value.settlementRef, delivery])

  const cityOptions = useMemo(() => {
    const map = new Map<string, NPCity>()
    if (currentCity) map.set(currentCity.Ref, currentCity)
    for (const c of cities) map.set(c.Ref, c)
    return [...map.values()]
  }, [cities, currentCity])

  const streetOptions = useMemo(() => {
    const map = new Map<string, NPStreet>()
    if (currentStreet) map.set(currentStreet.Ref, currentStreet)
    for (const s of streets) map.set(s.Ref, s)
    return [...map.values()]
  }, [streets, currentStreet])

  const cityField = (
    <Autocomplete
      sx={{ flex: 1 }} options={cityOptions} getOptionLabel={(o) => o.Description || ''} filterOptions={(x) => x}
      value={currentCity} isOptionEqualToValue={(a, b) => a.Ref === b.Ref}
      onChange={(_, v) => onChange({ ...value, cityRef: v?.Ref || '', cityName: v?.Description || '', settlementRef: v?.SettlementRef || '', warehouseRef: '', warehouseName: '', streetRef: '', streetName: '' })}
      onInputChange={(_, v, reason) => { if (reason === 'input') setCityQuery(v) }}
      renderInput={(p) => <TextField {...p} label={label} size={size} />}
    />
  )

  if (delivery === 'warehouse') {
    // Відділення — АВТОКОМПЛІТ з пошуком по тексту/номеру (у великих містах їх сотні:
    // набираєш «30» — бачиш «Відділення №30…», №130, №230 тощо).
    const currentWh: NPWarehouse | null = value.warehouseRef
      ? warehouses.find((w) => w.Ref === value.warehouseRef)
        || { Ref: value.warehouseRef, Description: value.warehouseName || value.warehouseRef, Number: '' } as NPWarehouse
      : null
    const whOptions = (() => {
      const map = new Map<string, NPWarehouse>()
      if (currentWh) map.set(currentWh.Ref, currentWh)
      for (const w of warehouses) map.set(w.Ref, w)
      return [...map.values()]
    })()
    return (
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {cityField}
        <Autocomplete
          sx={{ flex: 1 }} options={whOptions} getOptionLabel={(o) => o.Description || ''}
          value={currentWh} isOptionEqualToValue={(a, b) => a.Ref === b.Ref} disabled={!value.cityRef}
          filterOptions={(opts, state) => {
            const q = state.inputValue.trim().toLowerCase()
            if (!q) return opts
            // «30» знаходить і «№30», і адресу з 30; текст шукається по всій назві.
            return opts.filter((w) => (w.Description || '').toLowerCase().includes(q)
              || (/^\d+$/.test(q) && (w.Description || '').includes(`№${q}`)))
          }}
          onChange={(_, v) => onChange({ ...value, warehouseRef: v?.Ref || '', warehouseName: v?.Description || '' })}
          renderInput={(p) => <TextField {...p} label={warehouseLabel} size={size}
            placeholder="номер або текст, напр. 30" helperText={!value.cityRef ? 'Спершу оберіть місто' : undefined} />}
        />
      </Stack>
    )
  }

  // Адресная (курьерская) доставка
  return (
    <Stack spacing={2}>
      {cityField}
      <Autocomplete
        options={streetOptions} getOptionLabel={(o) => o.Description || ''} filterOptions={(x) => x}
        value={currentStreet} isOptionEqualToValue={(a, b) => a.Ref === b.Ref} disabled={!value.settlementRef}
        onChange={(_, v) => onChange({ ...value, streetRef: v?.Ref || '', streetName: v?.Description || '' })}
        onInputChange={(_, v, reason) => { if (reason === 'input') setStreetQuery(v) }}
        renderInput={(p) => <TextField {...p} label="Вулиця" size={size} helperText={!value.settlementRef ? 'Спершу оберіть місто' : undefined} />}
      />
      <Stack direction="row" spacing={2}>
        <TextField sx={{ flex: 1 }} label="Будинок" size={size} value={value.house || ''} onChange={(e) => onChange({ ...value, house: e.target.value })} />
        <TextField sx={{ flex: 1 }} label="Квартира" size={size} value={value.flat || ''} onChange={(e) => onChange({ ...value, flat: e.target.value })} />
      </Stack>
    </Stack>
  )
}
