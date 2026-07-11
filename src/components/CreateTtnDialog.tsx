// Диалог создания ТТН Новой Почты на ПРИЁМ кораблика: выбираем шаблон посылки + отделение
// клиента (откуда шлёт) + оголошену вартість → создаём ТТН (от сервиса, плательщик клиент) и
// сохраняем номер на заявке. Ошибку НП показываем текстом (первый прод-вызов — доводка маппинга).
import { useEffect, useMemo, useState } from 'react'
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField, MenuItem, Alert,
  Autocomplete, CircularProgress, Typography, Box,
} from '@mui/material'
import { npTemplateService } from '@/api/npTemplateService'
import { npTtnApi } from '@/api/endpoints/npTtn'
import { searchCities, getWarehouses, type NPCity, type NPWarehouse } from '@/api/endpoints/novaposhta'
import { SIZE_LABELS, type NpTemplate } from '@/types/npTemplate'

export default function CreateTtnDialog({ open, onClose, serviceRequestId, onCreated }: {
  open: boolean
  onClose: () => void
  serviceRequestId: string
  onCreated: (ttn: string) => void
}) {
  const [templates, setTemplates] = useState<NpTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  const [cityQuery, setCityQuery] = useState('')
  const [cities, setCities] = useState<NPCity[]>([])
  const [city, setCity] = useState<NPCity | null>(null)
  const [warehouses, setWarehouses] = useState<NPWarehouse[]>([])
  const [warehouseRef, setWarehouseRef] = useState('')
  const [cost, setCost] = useState('300')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErr(''); setDone(null)
    // Приёмные шаблоны (incoming), активные
    npTemplateService.list().then((all) => {
      const inc = all.filter((t) => t.active !== false && t.scenario === 'incoming')
      setTemplates(inc)
      setTemplateId((id) => id || (inc[0]?.id ?? ''))
    })
  }, [open])

  // Поиск городов НП по вводу
  useEffect(() => {
    if (cityQuery.trim().length < 2) { setCities([]); return }
    let alive = true
    const t = setTimeout(async () => {
      const res = await searchCities(cityQuery.trim())
      if (alive) setCities(res)
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [cityQuery])

  // Отделения выбранного города
  useEffect(() => {
    setWarehouses([]); setWarehouseRef('')
    if (!city?.Ref) return
    getWarehouses(city.Ref).then(setWarehouses)
  }, [city])

  const canCreate = useMemo(() => !!templateId && !!city?.Ref && !!warehouseRef && Number(cost) > 0, [templateId, city, warehouseRef, cost])

  const create = async () => {
    if (!canCreate || !city) return
    setBusy(true); setErr('')
    const res = await npTtnApi.create({
      serviceRequestId, templateId, clientCityRef: city.Ref, clientWarehouseRef: warehouseRef, cost: Number(cost),
    })
    setBusy(false)
    if (res.ok && res.data) { setDone(res.data.ttn); onCreated(res.data.ttn) }
    else setErr([res.error, ...(res.npErrors || [])].filter(Boolean).join(' · '))
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Створити ТТН на приймання кораблика</DialogTitle>
      <DialogContent dividers>
        {done ? (
          <Alert severity="success">
            ТТН створено: <b>{done}</b>. Номер збережено в заявці — тепер його можна надіслати клієнту
            (кнопка «Повідомити про відправку» / оповіщення).
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Посилка оформлюється від сервісу; клієнт здає кораблик у своєму відділенні за цим номером
              і сплачує доставку готівкою при здачі.
            </Typography>
            {templates.length === 0 ? (
              <Alert severity="info">Немає шаблонів сценарію «приймання». Створіть їх на сторінці «Шаблони посилок».</Alert>
            ) : (
              <TextField select label="Шаблон посилки" value={templateId} onChange={(e) => setTemplateId(e.target.value)} size="small" fullWidth>
                {templates.map((t) => <MenuItem key={t.id} value={t.id}>{t.name} · {SIZE_LABELS[t.size]} · {t.weight} кг</MenuItem>)}
              </TextField>
            )}
            <Autocomplete
              options={cities} getOptionLabel={(o) => o.Description || ''} filterOptions={(x) => x}
              value={city} onChange={(_, v) => setCity(v)} onInputChange={(_, v) => setCityQuery(v)}
              isOptionEqualToValue={(a, b) => a.Ref === b.Ref}
              renderInput={(p) => <TextField {...p} label="Місто клієнта (звідки надсилає)" size="small" />}
            />
            <TextField select label="Відділення клієнта" value={warehouseRef} onChange={(e) => setWarehouseRef(e.target.value)} size="small" fullWidth
              disabled={!city} helperText={city && warehouses.length === 0 ? 'Завантаження відділень…' : undefined}>
              {warehouses.map((w) => <MenuItem key={w.Ref} value={w.Ref}>{w.Description}</MenuItem>)}
            </TextField>
            <TextField label="Оголошена вартість, грн" type="number" value={cost} onChange={(e) => setCost(e.target.value)} size="small" fullWidth
              helperText="Оціночна вартість кораблика для НП" />
            {err && (
              <Alert severity="error">
                <Box sx={{ whiteSpace: 'pre-wrap' }}>{err}</Box>
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{done ? 'Закрити' : 'Скасувати'}</Button>
        {!done && <Button variant="contained" onClick={create} disabled={!canCreate || busy} startIcon={busy ? <CircularProgress size={16} /> : undefined}>Створити ТТН</Button>}
      </DialogActions>
    </Dialog>
  )
}
