// Імпорт історії з 1С6 (файли .mxl «Продажи» і «Ремонты»). Формат розпізнається автоматично:
//  • Продажи → boatOrders (статус «Завершено», дата продажу з документа; моделі/сумки/кольори
//    можуть створюватися в каталозі автоматично; сумісність сумки = модель рядка).
//  • Ремонты → serviceRequests. Статус за логікою власника: є ТТН «від нас» → done;
//    вхідна ТТН отримана → in_work; вхідної нема або «Номер не знайдено» → new.
// Повторний імпорт того ж файлу не дублює: id = bo-1c6-<номер> / sr-1c6-<номер>.
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip,
  Table, TableBody, TableCell, TableHead, TableRow, FormControlLabel, Switch,
} from '@mui/material'
import { Home as HomeIcon, UploadFile as UploadIcon, Sailing as BoatIcon } from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { db, auth } from '@/api/firebase'
import { writeBatch, doc } from 'firebase/firestore'
import { parseMxl, mxlPhone, mxlTtn, mxlDate, mxlCleanName, type MxlTable } from '@/utils/mxl'
import { boatModelService, boatOptionService } from '@/api/boatCatalogService'
import { boatOrderService } from '@/api/boatOrderService'
import { serviceRequestService } from '@/api/serviceRequestService'
import type { BoatModel, BoatOption } from '@/types/boats'
import { secureId } from '@/utils/id'

const COLOR_FIX: Record<string, string> = { yellou: 'yellow' }

export default function BoatImportPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [table, setTable] = useState<MxlTable | null>(null)
  const [err, setErr] = useState('')
  const [createMissing, setCreateMissing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<string[]>([])

  const col = useMemo(() => {
    const h = table?.header || []
    return (name: string) => h.indexOf(name)
  }, [table])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ заборонено.</Alert>
      </Container>
    )
  }

  const onFile = async (f: File | null) => {
    setErr(''); setTable(null); setResult([])
    if (!f) return
    setFileName(f.name)
    try {
      const text = await f.text()
      setTable(parseMxl(text))
    } catch (e: any) {
      setErr(e?.message || 'Не вдалося розібрати файл')
    }
  }

  // Пакетная запись документов (writeBatch, чанки по 400).
  const batchWrite = async (collection: string, docs: { id: string; data: Record<string, unknown> }[]) => {
    if (!db) throw new Error('Firestore не ініціалізовано')
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400)
      const b = writeBatch(db)
      for (const d of chunk) b.set(doc(db, collection, d.id), d.data, { merge: true })
      await b.commit()
      setProgress(`Записано ${Math.min(i + 400, docs.length)}/${docs.length}…`)
    }
  }

  const importSales = async (t: MxlTable) => {
    const now = new Date().toISOString()
    const uid = auth?.currentUser?.uid || null
    const c = col
    let models = await boatModelService.list()
    let options = await boatOptionService.list()
    const existing = new Set((await boatOrderService.list()).map((o) => o.id))

    const modelByName = new Map(models.map((m) => [m.name.toLowerCase(), m]))
    const bagByName = new Map(options.filter((o) => o.kind === 'bag').map((o) => [o.name.toLowerCase(), o]))
    let createdModels = 0
    let createdBags = 0
    const touchedModels = new Map<string, BoatModel>() // id → модель с дополненными кольорами

    const ensureModel = async (name: string): Promise<BoatModel | null> => {
      const key = name.toLowerCase()
      const found = modelByName.get(key)
      if (found) return found
      if (!createMissing) return null
      const m: BoatModel = { id: secureId(16), name, colors: [], rows: [], active: true, createdAt: now, updatedAt: now }
      await boatModelService.save(m)
      modelByName.set(key, m); createdModels++
      return m
    }
    const ensureBag = async (name: string, modelId: string | null): Promise<BoatOption | null> => {
      const key = name.toLowerCase()
      const found = bagByName.get(key)
      if (found) {
        // Дополнить сумісність, якщо в опції явний список і моделі там немає.
        if (modelId && found.compatibleModelIds?.length && !found.compatibleModelIds.includes(modelId)) {
          found.compatibleModelIds = [...found.compatibleModelIds, modelId]
          await boatOptionService.save(found)
        }
        return found
      }
      if (!createMissing) return null
      const o: BoatOption = {
        id: secureId(16), kind: 'bag', name, price: 0,
        compatibleModelIds: modelId ? [modelId] : [], active: true, createdAt: now, updatedAt: now,
      }
      await boatOptionService.save(o)
      bagByName.set(key, o); createdBags++
      return o
    }

    const docs: { id: string; data: Record<string, unknown> }[] = []
    let created = 0, updated = 0, skipped = 0
    for (const r of t.rows) {
      const num = (r[c('Номер')] || '').trim()
      if (!num) { skipped++; continue }
      const modelName = (r[c('Модель')] || '').trim()
      const model = modelName ? await ensureModel(modelName) : null
      const rawColor = (r[c('Цвет')] || '').trim().toLowerCase()
      const color = rawColor ? (COLOR_FIX[rawColor] || rawColor) : null
      if (model && color && !(touchedModels.get(model.id) || model).colors.includes(color)) {
        const m = touchedModels.get(model.id) || { ...model, colors: [...model.colors] }
        m.colors.push(color)
        touchedModels.set(model.id, m)
      }
      const bagName = (r[c('Сумка')] || '').trim()
      const bag = bagName ? await ensureBag(bagName, model?.id || null) : null
      const soldISO = mxlDate(r[c('Дата')])
      const fio = (r[c('ФИО')] || '').trim() || mxlCleanName(r[c('Клиент')] || '')
      const id = `bo-1c6-${num}`
      existing.has(id) ? updated++ : created++
      docs.push({
        id,
        data: {
          id,
          clientName: fio,
          clientPhone: mxlPhone(r[c('Основний телефон')] || '') || mxlPhone(r[c('Клиент')] || ''),
          note: (r[c('Клиент')] || '').trim() || null,
          modelId: model?.id || null, rowId: null, color,
          bagOptionId: bag?.id || null, echoOptionId: null,
          needDepthGauge: (r[c('Глубиномер')] || '').trim() === 'Так',
          serialNumber: (r[c('Кораблик')] || '').trim() || null,
          accessories: [], lines: [], total: 0,
          status: 'done',
          statusHistory: [{ status: 'done', at: soldISO || now }],
          ttn: mxlTtn(r[c('ТТН')] || '') || null,
          soldAt: soldISO ? soldISO.slice(0, 10) : null,
          importedFrom: '1c6',
          createdAt: soldISO || now, updatedAt: now, createdBy: uid,
        },
      })
    }
    // Дополненные кольори моделей — одним заходом.
    for (const m of touchedModels.values()) await boatModelService.save(m)
    await batchWrite('boatOrders', docs)
    return [
      `Продажі: створено ${created}, оновлено ${updated}${skipped ? `, пропущено без номера ${skipped}` : ''}.`,
      ...(createdModels ? [`Створено моделей у каталозі: ${createdModels}.`] : []),
      ...(createdBags ? [`Створено сумок у каталозі: ${createdBags}.`] : []),
      ...(touchedModels.size ? [`Доповнено кольори у ${touchedModels.size} моделях.`] : []),
    ]
  }

  const importRepairs = async (t: MxlTable) => {
    const now = new Date().toISOString()
    const uid = auth?.currentUser?.uid || null
    const c = col
    const existing = new Set((await serviceRequestService.list(5000)).map((r) => r.id))
    const docs: { id: string; data: Record<string, unknown> }[] = []
    let created = 0, updated = 0, byStatus = { new: 0, in_work: 0, done: 0 }
    for (const r of t.rows) {
      const num = (r[c('Номер')] || '').trim()
      if (!num) continue
      const ttnIn = mxlTtn(r[c('ТТН к нам')] || '')
      const stIn = (r[c('Статус')] || '').trim()
      const ttnOut = mxlTtn(r[c('ТТН1 от нас')] || '')
      // Логіка власника: є ТТН від нас → виконано; вхідну отримали → в роботі; інакше клієнт не відправив.
      const status = ttnOut ? 'done' : ttnIn && stIn !== 'Номер не знайдено' ? 'in_work' : 'new'
      byStatus[status]++
      const center = (r[c('Сервисный центр')] || '').trim()
      const master = (r[c('Специалист')] || '').trim()
      const dateISO = mxlDate(r[c('Дата')])
      const id = `sr-1c6-${num}`
      existing.has(id) ? updated++ : created++
      docs.push({
        id,
        data: {
          id,
          sessionId: null,
          externalRequestId: num, // пошук заявки за номером ремонту 1С6
          clientName: mxlCleanName(r[c('Найменування')] || ''),
          clientPhone: mxlPhone(r[c('Основний телефон')] || '') || mxlPhone(r[c('Найменування')] || ''),
          complaint: [`Ремонт з 1С6 №${num}`, center && `СЦ: ${center}`, master && `Спеціаліст: ${master}`]
            .filter(Boolean).join(' · '),
          status,
          waybillNumber: ttnIn || null,
          returnTtn: ttnOut || null,
          importedFrom: '1c6',
          createdAt: dateISO || now, updatedAt: now, createdBy: uid,
        },
      })
    }
    await batchWrite('serviceRequests', docs)
    return [
      `Ремонти: створено ${created}, оновлено ${updated}.`,
      `Статуси: виконано ${byStatus.done}, в роботі ${byStatus.in_work}, нові (клієнт не відправив) ${byStatus.new}.`,
    ]
  }

  const runImport = async () => {
    if (!table) return
    setBusy(true); setErr(''); setResult([]); setProgress('Підготовка…')
    try {
      const lines = table.kind === 'sales' ? await importSales(table) : await importRepairs(table)
      setResult(lines)
    } catch (e: any) {
      setErr(e?.message || 'Помилка імпорту')
    }
    setProgress(''); setBusy(false)
  }

  const preview = table?.rows.slice(0, 8) || []

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <BoatIcon color="primary" />
        <Typography variant="h5" sx={{ flexGrow: 1 }}>Імпорт з 1С6 (.mxl)</Typography>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Головна</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Приймаються вигрузки «Продажи» (у картотеку корабликів) та «Ремонты» (у заявки) —
        формат розпізнається автоматично. Повторний імпорт того ж файлу оновлює записи, не дублює.
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <input ref={fileRef} type="file" accept=".mxl,.txt" hidden onChange={(e) => onFile(e.target.files?.[0] || null)} />
          <Button variant="contained" startIcon={<UploadIcon />} onClick={() => fileRef.current?.click()} disabled={busy}>
            Обрати файл .mxl
          </Button>
          {fileName && <Chip label={fileName} size="small" />}
          {table && (
            <Chip color="info" size="small"
              label={`${table.kind === 'sales' ? 'Продажі' : 'Ремонти'}: ${table.rows.length} рядків`} />
          )}
        </Stack>
        {table?.kind === 'sales' && (
          <FormControlLabel sx={{ mt: 1 }}
            control={<Switch checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />}
            label="Створювати відсутні моделі/сумки/кольори в каталозі" />
        )}
        {err && <Alert severity="error" sx={{ mt: 2 }}>{err}</Alert>}
      </Paper>

      {table && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Попередній перегляд (перші {preview.length} з {table.rows.length})</Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>{table.header.map((h, i) => <TableCell key={i} sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{h}</TableCell>)}</TableRow>
              </TableHead>
              <TableBody>
                {preview.map((r, i) => (
                  <TableRow key={i}>{r.map((v, j) => <TableCell key={j} sx={{ whiteSpace: 'nowrap' }}>{v}</TableCell>)}</TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
            <Button variant="contained" onClick={runImport} disabled={busy}
              startIcon={busy ? <CircularProgress size={16} /> : <UploadIcon />}>
              Імпортувати {table.rows.length} записів
            </Button>
            {progress && <Typography variant="body2" color="text.secondary">{progress}</Typography>}
          </Stack>
        </Paper>
      )}

      {result.length > 0 && (
        <Alert severity="success">
          {result.map((l, i) => <div key={i}>{l}</div>)}
        </Alert>
      )}
    </Container>
  )
}
