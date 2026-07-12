// Распределение фактической сметы по специалистам (внутренняя экономика). Мастер вручную вписывает
// по каждому специалисту сумму специалисту и сумму центру за администрирование. Специалисты
// подставляются из заявки автоматически; можно добавить/убрать из справочника специалистов центра.
// ВНИМАНИЕ: это внутренние поля — клиенту НЕ показываются (serverный safeEstimate их не отдаёт).
import { useMemo, useState } from 'react'
import {
  Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  TextField, IconButton, Stack, Autocomplete, Button, Chip, Alert, Box,
} from '@mui/material'
import { Delete as DeleteIcon, PersonAdd as PersonAddIcon } from '@mui/icons-material'
import { formatMoney } from '@/utils/pricing'
import type { SpecialistPayout } from '@/types/pricing'

type StaffOption = { uid: string; name: string }

export default function SpecialistPayoutsEditor({ value, onChange, staff, total }: {
  value: SpecialistPayout[]
  onChange: (v: SpecialistPayout[]) => void
  staff: StaffOption[]
  total: number
}) {
  const [toAdd, setToAdd] = useState<StaffOption | null>(null)

  const sumSpec = useMemo(() => value.reduce((s, p) => s + (Number(p.specialistAmount) || 0), 0), [value])
  const sumAdmin = useMemo(() => value.reduce((s, p) => s + (Number(p.centerAdminAmount) || 0), 0), [value])
  const distributed = sumSpec + sumAdmin
  const remainder = Math.round((total - distributed) * 100) / 100

  const available = useMemo(() => staff.filter((s) => !value.some((p) => p.uid === s.uid)), [staff, value])

  const patch = (uid: string, field: 'specialistAmount' | 'centerAdminAmount', raw: string) => {
    const num = Math.max(0, Number(raw) || 0)
    onChange(value.map((p) => (p.uid === uid ? { ...p, [field]: num } : p)))
  }
  const add = () => {
    if (!toAdd) return
    onChange([...value, { uid: toAdd.uid, name: toAdd.name, specialistAmount: 0, centerAdminAmount: 0 }])
    setToAdd(null)
  }
  const remove = (uid: string) => onChange(value.filter((p) => p.uid !== uid))

  return (
    <Paper sx={{ p: 2, mb: 3 }}>
      <Typography variant="subtitle1" sx={{ mb: 0.5 }}>Розподіл між спеціалістами (внутрішнє)</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
        Хто виконував сервіс і скільки отримує спеціаліст / центр за адміністрування. Клієнту не видно.
      </Typography>

      {value.length === 0 ? (
        <Alert severity="info" sx={{ mb: 1.5 }}>Спеціалістів ще немає. Додайте зі списку центру нижче (або спочатку призначте їх у заявці).</Alert>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell>Спеціаліст</TableCell>
                <TableCell align="right">Спеціалісту, грн</TableCell>
                <TableCell align="right">Центру (адмін.), грн</TableCell>
                <TableCell align="right">Разом</TableCell>
                <TableCell padding="none" />
              </TableRow>
            </TableHead>
            <TableBody>
              {value.map((p) => (
                <TableRow key={p.uid}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell align="right">
                    <TextField type="number" size="small" value={p.specialistAmount || ''} onChange={(e) => patch(p.uid, 'specialistAmount', e.target.value)}
                      inputProps={{ min: 0, style: { textAlign: 'right', width: 90 } }} />
                  </TableCell>
                  <TableCell align="right">
                    <TextField type="number" size="small" value={p.centerAdminAmount || ''} onChange={(e) => patch(p.uid, 'centerAdminAmount', e.target.value)}
                      inputProps={{ min: 0, style: { textAlign: 'right', width: 90 } }} />
                  </TableCell>
                  <TableCell align="right">{formatMoney((Number(p.specialistAmount) || 0) + (Number(p.centerAdminAmount) || 0))}</TableCell>
                  <TableCell padding="none"><IconButton size="small" color="error" onClick={() => remove(p.uid)}><DeleteIcon fontSize="small" /></IconButton></TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell><b>Розподілено</b></TableCell>
                <TableCell align="right"><b>{formatMoney(sumSpec)}</b></TableCell>
                <TableCell align="right"><b>{formatMoney(sumAdmin)}</b></TableCell>
                <TableCell align="right"><b>{formatMoney(distributed)}</b></TableCell>
                <TableCell padding="none" />
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Stack direction="row" spacing={1.5} sx={{ mt: 1.5, flexWrap: 'wrap' }} alignItems="center">
        <Chip label={`Кошторис: ${formatMoney(total)}`} />
        <Chip color={remainder < 0 ? 'error' : 'default'} variant="outlined"
          label={`Залишок (не розподілено): ${formatMoney(remainder)}`} />
      </Stack>
      {remainder < 0 && <Alert severity="warning" sx={{ mt: 1 }}>Розподілено більше, ніж сума кошторису.</Alert>}

      <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
        <Autocomplete
          size="small" sx={{ minWidth: 260 }} options={available} value={toAdd}
          onChange={(_, v) => setToAdd(v)} getOptionLabel={(o) => o.name}
          isOptionEqualToValue={(a, b) => a.uid === b.uid}
          noOptionsText={staff.length ? 'Усі вже додані' : 'Немає спеціалістів центру'}
          renderInput={(p) => <TextField {...p} label="Додати спеціаліста" />}
        />
        <Button variant="outlined" startIcon={<PersonAddIcon />} onClick={add} disabled={!toAdd}>Додати</Button>
      </Box>
    </Paper>
  )
}
