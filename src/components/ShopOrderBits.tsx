// Общее для страниц «Замовлення з сайту»: артикул с фото и чипы состояния.
import { useState } from 'react'
import { Box, Chip } from '@mui/material'
import { ImageNotSupported as NoPhotoIcon } from '@mui/icons-material'
import { SHOP_FLAG_LABELS, SHOP_SKU_PHOTOS, SHOP_STATE_LABELS, shopStateColor, type ShopFlag, type ShopOrderState } from '@/types/shopOrder'

export function SkuPhoto({ sku, size }: { sku: string; size: number | Record<string, number> }) {
  const [failed, setFailed] = useState(false)
  const url = SHOP_SKU_PHOTOS[sku]
  const frame = { width: size, height: size, flexShrink: 0, borderRadius: 1, bgcolor: 'action.hover' }
  if (!url || failed) {
    return <Box sx={{ ...frame, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled' }}><NoPhotoIcon /></Box>
  }
  return <Box component="img" src={url} alt={sku} loading="lazy" onError={() => setFailed(true)} sx={{ ...frame, objectFit: 'contain' }} />
}

export const StateChip = ({ state }: { state: ShopOrderState }) => (
  <Chip size="small" color={shopStateColor(state)} label={SHOP_STATE_LABELS[state] || state} />
)

export const FlagChips = ({ flags }: { flags: ShopFlag[] }) => (
  <>
    {flags.map((f) => <Chip key={f} size="small" color="error" label={SHOP_FLAG_LABELS[f] || f} />)}
  </>
)
