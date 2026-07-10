// ИИ-подбор позиций прайса для мастера. Диалог: мастер описывает, что планирует выставить
// клиенту, ИИ возвращает позиции прайса (workCode+qty); совпавшие с каталогом можно добавить
// в смету. Переиспользуется в редакторе предложения и фактической калькуляции.
import { useMemo, useState } from 'react'
import {
  Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Alert, List, ListItem,
  ListItemText, Checkbox, Box, Typography,
} from '@mui/material'
import { AutoAwesome as AiIcon } from '@mui/icons-material'
import { aiApi } from '@/api/endpoints/ai'
import { tName, type PriceCatalog, type EstimateWorkInput } from '@/utils/pricing'

interface Picked { workId: string | null; code: string; name: string; qty: number; matched: boolean }

export default function AiWorkPicker({ priceContext, catalog, onAdd }: {
  priceContext: string
  catalog: PriceCatalog
  onAdd: (works: EstimateWorkInput[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [desc, setDesc] = useState('')
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Picked[] | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<Record<number, boolean>>({})

  const byCode = useMemo(() => new Map(Object.values(catalog.works).map((w) => [w.code, w])), [catalog])

  const run = async () => {
    if (!desc.trim()) return
    setLoading(true); setErr(''); setPicked(null)
    const res = await aiApi.pickWorks({ description: desc, priceContext })
    setLoading(false)
    if (!res.success || !res.data) { setErr(res.error?.message || 'Не вдалося підібрати'); return }
    const items: Picked[] = res.data.works.map((w) => {
      const work = byCode.get(w.workCode)
      const matched = !!(work && work.active)
      return { workId: matched ? work!.id : null, code: w.workCode, name: work ? tName(work.name, 'uk') : w.name, qty: w.qty || 1, matched }
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
    const works: EstimateWorkInput[] = picked
      .map((it, i) => ({ it, i }))
      .filter(({ it, i }) => it.matched && sel[i])
      .map(({ it }) => ({ workId: it.workId!, qty: it.qty }))
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
                      <ListItemText primary={it.name}
                        secondary={it.matched ? it.code : 'немає в прайсі — додайте вручну'}
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
