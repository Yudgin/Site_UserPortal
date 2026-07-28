// Диалог создания ТТН Новой Почты. Сценарий берётся из выбранного шаблона:
//  • приём (incoming): клиент сдаёт кораблик у себя (адрес — «звідки»), платит клиент.
//  • возврат/новый/мелочи: сервис → клиент (адрес — «куди»), получатель = клиент; для возврата
//    по умолчанию наложенный платёж = сумма факта (снимается сервером, если уже оплачено онлайн).
// Ошибку НП показываем текстом (первый прод-вызов — доводка маппинга).
import { useEffect, useMemo, useState } from 'react'
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField, MenuItem, Alert,
  Autocomplete, CircularProgress, Typography, Box,
} from '@mui/material'
import { npTemplateService } from '@/api/npTemplateService'
import { npTtnApi } from '@/api/endpoints/npTtn'
import { searchCities, getWarehouses, type NPCity, type NPWarehouse } from '@/api/endpoints/novaposhta'
import { SIZE_LABELS, SCENARIO_LABELS, type NpTemplate } from '@/types/npTemplate'

export default function CreateTtnDialog({ open, onClose, serviceRequestId, boatOrderId, clientName, clientPhone, clientCityRef, clientCityName, clientWarehouseRef, clientWarehouseName, presetTemplateId, defaultCost, defaultCod, onCreated }: {
  open: boolean
  onClose: () => void
  serviceRequestId?: string // ТТН для сервисной заявки…
  boatOrderId?: string // …или для замовлення кораблика (рівно одне з двох)
  clientName?: string
  clientPhone?: string
  clientCityRef?: string
  clientCityName?: string
  clientWarehouseRef?: string
  clientWarehouseName?: string
  presetTemplateId?: string // предвыбранный шаблон (из центра); селект блокируется
  defaultCost?: number // оголошена вартість за замовчуванням (для замовлень — сума замовлення)
  defaultCod?: number // наложений платіж за замовчуванням (замовлення з методом 'cod', не оплачене)
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
  const [cod, setCod] = useState('') // наложений платіж, грн ('' = авто/без)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<string | null>(null)

  const tpl = useMemo(() => templates.find((t) => t.id === templateId) || null, [templates, templateId])
  const scenario = tpl?.scenario || 'incoming'
  const recipientTarget = tpl?.recipientTarget ?? (scenario === 'incoming' ? 'service' : 'client')
  const senderIsClient = tpl?.senderTarget === 'client'
  const recipientIsClient = recipientTarget === 'client'
  const needsClientAddr = senderIsClient || recipientIsClient
  const addrLabel = senderIsClient ? 'звідки надсилає' : 'куди надсилаємо'

  useEffect(() => {
    if (!open) return
    setErr(''); setDone(null)
    // Оголошена вартість = сумі замовлення (можна поправити); наложка — з методу оплати замовлення.
    if (defaultCost && defaultCost > 0) setCost(String(Math.max(1, Math.round(defaultCost))))
    setCod(defaultCod && defaultCod > 0 ? String(Math.round(defaultCod)) : '')
    // Префилл адреса клиента из заявки (если он там сохранён из формы /repair/new)
    if (clientCityRef) {
      setCity({ Ref: clientCityRef, Description: clientCityName || clientCityRef, DescriptionRu: '', Area: '', AreaDescription: '' })
      setWarehouseRef(clientWarehouseRef || '')
    } else { setCity(null); setWarehouseRef('') }
    npTemplateService.list().then((all) => {
      const act = all.filter((t) => t.active !== false)
      setTemplates(act)
      // Предвыбранный шаблон из центра (если задан и активен) — иначе прежний/первый.
      setTemplateId((id) => (presetTemplateId && act.some((t) => t.id === presetTemplateId) ? presetTemplateId : id || (act[0]?.id ?? '')))
    })
  }, [open, clientCityRef, clientCityName, clientWarehouseRef, presetTemplateId])

  useEffect(() => {
    if (cityQuery.trim().length < 2) { setCities([]); return }
    let alive = true
    const t = setTimeout(async () => { const r = await searchCities(cityQuery.trim()); if (alive) setCities(r) }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [cityQuery])

  useEffect(() => {
    setWarehouses([]); setWarehouseRef('')
    if (!city?.Ref) return
    getWarehouses(city.Ref).then(setWarehouses)
  }, [city])

  const canCreate = useMemo(
    () => !!templateId && Number(cost) > 0 && (!needsClientAddr || (!!city?.Ref && !!warehouseRef)),
    [templateId, cost, needsClientAddr, city, warehouseRef]
  )

  const create = async () => {
    if (!canCreate) return
    setBusy(true); setErr('')
    const res = await npTtnApi.create({
      ...(serviceRequestId ? { serviceRequestId } : {}), ...(boatOrderId ? { boatOrderId } : {}),
      templateId, cost: Number(cost),
      ...(cod !== '' ? { codAmount: Number(cod) || 0 } : {}),
      ...(needsClientAddr && city ? { clientCityRef: city.Ref, clientWarehouseRef: warehouseRef } : {}),
      ...(recipientIsClient ? { clientName, clientPhone } : {}),
    })
    setBusy(false)
    if (res.ok && res.data) { setDone(res.data.ttn); onCreated(res.data.ttn) }
    else setErr([res.error, ...(res.npErrors || [])].filter(Boolean).join(' · '))
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Створити ТТН Нової Пошти</DialogTitle>
      <DialogContent dividers>
        {done ? (
          <Alert severity="success">
            ТТН створено: <b>{done}</b>. Номер збережено в заявці — тепер його можна надіслати клієнту.
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {templates.length === 0 ? (
              <Alert severity="info">Немає шаблонів посилок. Створіть їх на сторінці «Шаблони посилок».</Alert>
            ) : (
              <TextField select label="Шаблон посилки" value={templateId} onChange={(e) => setTemplateId(e.target.value)} size="small" fullWidth disabled={!!presetTemplateId}>
                {templates.map((t) => <MenuItem key={t.id} value={t.id}>{SCENARIO_LABELS[t.scenario]} · {t.name} · {SIZE_LABELS[t.size]}</MenuItem>)}
              </TextField>
            )}
            <Typography variant="body2" color="text.secondary">
              {tpl ? `${SCENARIO_LABELS[scenario]}. Адреси беруться з шаблону; ${needsClientAddr ? `сторону «клієнт заявки» вкажіть нижче (${addrLabel}).` : 'обидві сторони фіксовані в шаблоні.'}${recipientIsClient && tpl.cod ? ' Накладений платіж (сума факту) додається автоматично; якщо оплачено онлайн — ні.' : ''}` : 'Оберіть шаблон.'}
            </Typography>
            {needsClientAddr && (
              <>
                <Autocomplete
                  options={cities} getOptionLabel={(o) => o.Description || ''} filterOptions={(x) => x}
                  value={city} onChange={(_, v) => setCity(v)} onInputChange={(_, v) => setCityQuery(v)}
                  isOptionEqualToValue={(a, b) => a.Ref === b.Ref}
                  renderInput={(p) => <TextField {...p} label={`Місто клієнта (${addrLabel})`} size="small" />}
                />
                <Autocomplete
                  options={(() => {
                    const cur = warehouseRef && !warehouses.some((w) => w.Ref === warehouseRef)
                      ? [{ Ref: warehouseRef, Description: clientWarehouseName || warehouseRef } as NPWarehouse] : []
                    return [...cur, ...warehouses]
                  })()}
                  getOptionLabel={(o) => o.Description || ''}
                  value={warehouses.find((w) => w.Ref === warehouseRef)
                    || (warehouseRef ? { Ref: warehouseRef, Description: clientWarehouseName || warehouseRef } as NPWarehouse : null)}
                  isOptionEqualToValue={(a, b) => a.Ref === b.Ref} disabled={!city}
                  filterOptions={(opts, state) => {
                    const q = state.inputValue.trim().toLowerCase()
                    if (!q) return opts
                    return opts.filter((w) => (w.Description || '').toLowerCase().includes(q)
                      || (/^\d+$/.test(q) && (w.Description || '').includes(`№${q}`)))
                  }}
                  onChange={(_, v) => setWarehouseRef(v?.Ref || '')}
                  renderInput={(p) => <TextField {...p} label={`Відділення клієнта (${addrLabel})`} size="small"
                    placeholder="номер або текст, напр. 30"
                    helperText={city && warehouses.length === 0 ? 'Завантаження відділень…' : undefined} />}
                />
              </>
            )}
            <TextField label="Оголошена вартість, грн" type="number" value={cost} onChange={(e) => setCost(e.target.value)} size="small" fullWidth
              helperText={defaultCost ? 'Підставлено з суми замовлення' : 'Оціночна вартість вмісту для НП'} />
            {recipientIsClient && (
              <TextField label="Наложений платіж, грн" type="number" value={cod} onChange={(e) => setCod(e.target.value)} size="small" fullWidth
                helperText={defaultCod ? 'Підставлено з суми замовлення (метод «наложений платіж»)' : 'Порожньо — авто (за шаблоном/оплатою); 0 — без наложки'} />
            )}
            {recipientIsClient && !clientPhone && <Alert severity="warning">У заявці немає телефону клієнта — отримувача НП може не вдатися створити.</Alert>}
            {err && <Alert severity="error"><Box sx={{ whiteSpace: 'pre-wrap' }}>{err}</Box></Alert>}
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
