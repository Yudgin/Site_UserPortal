// Кнопка-превью «Показати як…»: владелец переключает, как карточку (заявку/калькуляцию) видит
// каждая роль (директор / бухгалтер / спеціаліст / клієнт). Это ТІЛЬКИ превью редакции полей —
// реальные ограничения доступа обеспечиваются правилами/бэкендом (фаза 1b).
import { useState } from 'react'
import { Button, Menu, MenuItem, ListItemIcon, Chip } from '@mui/material'
import { Visibility as VisibilityIcon, Check as CheckIcon } from '@mui/icons-material'
import { VIEW_ROLES, VIEW_ROLE_LABELS, type ViewRole } from '@/types/access'

export default function ViewAsButton({ value, onChange }: { value: ViewRole; onChange: (r: ViewRole) => void }) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null)
  const previewing = value !== 'owner'
  return (
    <>
      <Button size="small" variant={previewing ? 'contained' : 'outlined'} color={previewing ? 'warning' : 'inherit'}
        startIcon={<VisibilityIcon />} onClick={(e) => setAnchor(e.currentTarget)}>
        {previewing ? `Очима: ${VIEW_ROLE_LABELS[value]}` : 'Показати як…'}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {VIEW_ROLES.map((r) => (
          <MenuItem key={r} selected={r === value} onClick={() => { onChange(r); setAnchor(null) }}>
            <ListItemIcon>{r === value ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>
            {VIEW_ROLE_LABELS[r]}{r === 'owner' && <Chip size="small" label="повний" sx={{ ml: 1 }} />}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
