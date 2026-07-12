// Редактор РАЗРЕЗОВ ПО ТРЕБОВАНИЯМ клиента (секции). Одна калькуляция = несколько требований,
// у каждого: название («Встановлення ехолота»), направление (ремонт/апгрейд), свои роботи + набори
// (набори фільтруються за напрямом секції) + ІІ-підбір. Загальні роботи (приймання/тест/пакування)
// движок додає сам — тут їх нема. Итог/подытоги показываются отдельно (сгруппированный результат).
import { useMemo } from 'react'
import {
  Paper, Stack, Typography, TextField, ToggleButton, ToggleButtonGroup, Autocomplete, IconButton,
  Button, Divider, Box, Table, TableBody, TableRow, TableCell,
} from '@mui/material'
import { Delete as DeleteIcon, Add as AddIcon } from '@mui/icons-material'
import AiWorkPicker from '@/components/AiWorkPicker'
import { tName, type PriceCatalog, type EstimateWorkInput } from '@/utils/pricing'
import { newSection, type EditableSection, type EditableWorkRow } from '@/utils/estimateSections'
import type { ServiceKind } from '@/types/pricing'

let rk = 0
const rowKey = () => `r${(rk += 1)}`

export default function SectionsWorksEditor({ sections, onChange, catalog, priceContext, aiSeed }: {
  sections: EditableSection[]
  onChange: (s: EditableSection[]) => void
  catalog: PriceCatalog
  priceContext: string
  aiSeed?: string // засев описания для ИИ-подбора (напр. диагностика заявки)
}) {
  const activeWorks = useMemo(() => Object.values(catalog.works).filter((w) => w.active), [catalog])
  const kitsFor = (kind: ServiceKind) => Object.values(catalog.kits).filter((k) => k.active && k.serviceKind === kind)

  const patchSection = (key: string, patch: Partial<EditableSection>) =>
    onChange(sections.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  const addRows = (key: string, rows: EditableWorkRow[]) =>
    onChange(sections.map((s) => (s.key === key ? { ...s, rows: [...s.rows, ...rows] } : s)))
  const setRowQty = (secKey: string, rKey: string, qty: number) =>
    onChange(sections.map((s) => (s.key === secKey ? { ...s, rows: s.rows.map((r) => (r.key === rKey ? { ...r, qty: Math.max(0.1, qty) } : r)) } : s)))
  const removeRow = (secKey: string, rKey: string) =>
    onChange(sections.map((s) => (s.key === secKey ? { ...s, rows: s.rows.filter((r) => r.key !== rKey) } : s)))
  const removeSection = (key: string) => onChange(sections.filter((s) => s.key !== key))
  const addSection = () => onChange([...sections, newSection('repair')])

  const addWork = (secKey: string, workId: string) => addRows(secKey, [{ key: rowKey(), workId, qty: 1 }])
  const addKit = (secKey: string, kitId: string) => {
    const kit = catalog.kits[kitId]
    if (!kit) return
    addRows(secKey, kit.items.filter((it) => catalog.works[it.workId]?.active).map((it) => ({ key: rowKey(), workId: it.workId, qty: it.qty })))
  }
  const addAi = (secKey: string, works: EstimateWorkInput[]) =>
    addRows(secKey, works.map((w) => ({ key: rowKey(), workId: w.workId, qty: w.qty })))

  return (
    <Stack spacing={2}>
      {sections.length === 0 && (
        <Typography variant="body2" color="text.secondary">Ще немає вимог. Додайте перше требування (наприклад «Ремонт керма» або «Встановлення ехолота»).</Typography>
      )}
      {sections.map((sec, idx) => (
        <Paper key={sec.key} variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 1.5 }} alignItems={{ sm: 'center' }}>
            <TextField label={`Вимога ${idx + 1}`} placeholder="напр. Встановлення ехолота" value={sec.complaint}
              onChange={(e) => patchSection(sec.key, { complaint: e.target.value })} size="small" fullWidth />
            <ToggleButtonGroup size="small" exclusive value={sec.serviceKind}
              onChange={(_e, v) => v && patchSection(sec.key, { serviceKind: v as ServiceKind })}>
              <ToggleButton value="repair">Ремонт</ToggleButton>
              <ToggleButton value="upgrade">Апгрейд</ToggleButton>
            </ToggleButtonGroup>
            <IconButton color="error" onClick={() => removeSection(sec.key)} title="Прибрати вимогу"><DeleteIcon /></IconButton>
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 1 }}>
            <Autocomplete sx={{ flex: 2 }} size="small" options={activeWorks}
              getOptionLabel={(w) => `${w.code} · ${tName(w.name, 'uk')}`}
              onChange={(_e, w) => w && addWork(sec.key, w.id)} value={null} blurOnSelect clearOnBlur
              renderInput={(p) => <TextField {...p} label="Додати роботу" />} />
            <Autocomplete sx={{ flex: 2 }} size="small" options={kitsFor(sec.serviceKind)}
              getOptionLabel={(k) => `${k.code} · ${tName(k.name, 'uk')}`}
              onChange={(_e, k) => k && addKit(sec.key, k.id)} value={null} blurOnSelect clearOnBlur
              renderInput={(p) => <TextField {...p} label={`Набір (${sec.serviceKind === 'upgrade' ? 'апгрейд' : 'ремонт'})`} />} />
            <AiWorkPicker priceContext={priceContext} catalog={catalog} onAdd={(works) => addAi(sec.key, works)} initialDescription={aiSeed} />
          </Stack>

          {sec.rows.length === 0 ? (
            <Typography variant="caption" color="text.secondary">Додайте роботи або набір до цієї вимоги.</Typography>
          ) : (
            <Table size="small">
              <TableBody>
                {sec.rows.map((r) => {
                  const w = catalog.works[r.workId]
                  return (
                    <TableRow key={r.key}>
                      <TableCell sx={{ border: 0 }}>{w ? tName(w.name, 'uk') : r.workId}</TableCell>
                      <TableCell sx={{ border: 0, width: 90 }} align="right">
                        <TextField type="number" size="small" value={r.qty}
                          onChange={(e) => setRowQty(sec.key, r.key, Number(e.target.value) || 0)}
                          inputProps={{ min: 0.1, step: 0.1, style: { textAlign: 'right', width: 60 } }} />
                      </TableCell>
                      <TableCell sx={{ border: 0, width: 40 }} padding="none">
                        <IconButton size="small" color="error" onClick={() => removeRow(sec.key, r.key)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Paper>
      ))}

      <Box>
        <Button startIcon={<AddIcon />} variant="outlined" onClick={addSection}>Додати вимогу (розділ)</Button>
      </Box>
      <Divider />
      <Typography variant="caption" color="text.secondary">
        Загальні роботи (приймання, тест, сушіння, пакування) додаються автоматично окремим розділом.
      </Typography>
    </Stack>
  )
}
