// ИИ-подбор позиций прайса для мастера. Диалог: мастер описывает, что планирует выставить
// клиенту, ИИ возвращает позиции прайса (workCode+qty); совпавшие с каталогом можно добавить
// в смету. Переиспользуется в редакторе предложения и фактической калькуляции.
import { useEffect, useMemo, useState } from 'react'
import {
  Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Alert, List, ListItem,
  ListItemText, Checkbox, Box, Typography, Chip,
} from '@mui/material'
import { AutoAwesome as AiIcon } from '@mui/icons-material'
import { aiApi } from '@/api/endpoints/ai'
import { tName, type PriceCatalog, type EstimateWorkInput } from '@/utils/pricing'

// Позиция от ИИ: код может совпасть с РАБОТОЙ (workId) или с НАБОРОМ (kitId — разворачиваем в работы).
interface Picked { workId: string | null; kitId: string | null; code: string; name: string; qty: number; matched: boolean; isKit: boolean }

export default function AiWorkPicker({ priceContext, catalog, onAdd, initialDescription }: {
  priceContext: string
  catalog: PriceCatalog
  onAdd: (works: EstimateWorkInput[]) => void
  initialDescription?: string // засев описания (напр. из диагностики заявки)
}) {
  const [open, setOpen] = useState(false)
  const [desc, setDesc] = useState('')

  // При открытии диалога с пустым полем — засеваем описанием из диагностики (если есть).
  useEffect(() => {
    if (open) setDesc((d) => d || (initialDescription || '').trim())
  }, [open, initialDescription])
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Picked[] | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<Record<number, boolean>>({})

  const byCode = useMemo(() => new Map(Object.values(catalog.works).map((w) => [w.code, w])), [catalog])
  const byKitCode = useMemo(() => new Map(Object.values(catalog.kits).map((k) => [k.code, k])), [catalog])

  const run = async () => {
    if (!desc.trim()) return
    setLoading(true); setErr(''); setPicked(null)
    const res = await aiApi.pickWorks({ description: desc, priceContext })
    setLoading(false)
    if (!res.success || !res.data) { setErr(res.error?.message || 'Не вдалося підібрати'); return }
    const items: Picked[] = res.data.works.map((w) => {
      const qty = w.qty || 1
      const work = byCode.get(w.workCode)
      if (work && work.active) return { workId: work.id, kitId: null, code: w.workCode, name: tName(work.name, 'uk'), qty, matched: true, isKit: false }
      // Код может быть НАБОРОМ (ИИ иногда возвращает код набора вместо разбивки на работы).
      const kit = byKitCode.get(w.workCode)
      if (kit && kit.active) return { workId: null, kitId: kit.id, code: w.workCode, name: tName(kit.name, 'uk'), qty, matched: true, isKit: true }
      return { workId: null, kitId: null, code: w.workCode, name: w.name, qty, matched: false, isKit: false }
    })
    setPicked(items)
    setNote(res.data.note || '')
    const s: Record<number, boolean> = {}
    items.forEach((it, i) => { if (it.matched) s[i] = true })
    setSel(s)
  }

  const close = () => { setOpen(false); setDesc(''); setPicked(null); setNote(''); setErr(''); setSel({}) }

  const add = () => {
    if (!picked) return
    const works: EstimateWorkInput[] = []
    picked.forEach((it, i) => {
      if (!it.matched || !sel[i]) return
      if (it.isKit && it.kitId) {
        // Набор → разворачиваем в его активные работы (как ручное «Додати набір»).
        const kit = catalog.kits[it.kitId]
        kit?.items
          .filter((k) => catalog.works[k.workId]?.active)
          .forEach((k) => works.push({ workId: k.workId, qty: k.qty * it.qty }))
      } else if (it.workId) {
        works.push({ workId: it.workId, qty: it.qty })
      }
    })
    if (works.length) onAdd(works)
    close()
  }

  const canAdd = !!picked && picked.some((it, i) => it.matched && sel[i])

  return (
    <>
      <Button size="small" variant="outlined" startIcon={<AiIcon />} onClick={() => setOpen(true)}>ІІ підбір</Button>
      <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
        <DialogTitle>ІІ підбір позицій прайсу</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Опишіть, що плануєте виставити клієнту — ІІ підбере відповідні позиції з прайсу.
          </Typography>
          <TextField autoFocus fullWidth multiline minRows={2}
            placeholder="напр. заміна сервоприводу керма, діагностика мотора, чистка бункера"
            value={desc} onChange={(e) => setDesc(e.target.value)} />
          <Box sx={{ mt: 1.5 }}>
            <Button variant="contained" onClick={run} disabled={loading || !desc.trim()}>
              {loading ? 'Підбираємо…' : 'Підібрати'}
            </Button>
          </Box>
          {err && <Alert severity="error" sx={{ mt: 2 }}>{err}</Alert>}
          {picked && (
            <Box sx={{ mt: 2 }}>
              {picked.length === 0 ? (
                <Alert severity="info">ІІ не підібрав позицій із прайсу.</Alert>
              ) : (
                <List dense>
                  {picked.map((it, i) => (
                    <ListItem key={i} disablePadding secondaryAction={<Typography variant="body2">×{it.qty}</Typography>}>
                      <Checkbox edge="start" checked={!!sel[i]} disabled={!it.matched}
                        onChange={(e) => setSel({ ...sel, [i]: e.target.checked })} />
                      <ListItemText
                        primary={<>{it.name}{it.isKit && <Chip size="small" label="набір" sx={{ ml: 1 }} />}</>}
                        secondary={it.matched ? (it.isKit ? `${it.code} · розкладеться на роботи` : it.code) : 'немає в прайсі — додайте вручну (кнопкою нижче)'}
                        secondaryTypographyProps={{ color: it.matched ? 'text.secondary' : 'warning.main' }} />
                    </ListItem>
                  ))}
                </List>
              )}
              {note && <Alert severity="info" sx={{ mt: 1 }}>{note}</Alert>}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Закрити</Button>
          <Button variant="contained" onClick={add} disabled={!canAdd}>Додати обрані</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
