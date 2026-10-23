// Текст сообщения чата с кликабельными ссылками: ИИ даёт ссылки на карточки запчастей, статьи и видео, а
// обычный текст их не открывает. Ссылкой считаем только http(s)-адреса; хвостовую пунктуацию предложения
// («…/lid-rect.», «(…/x)») в ссылку не включаем. Открывается в новой вкладке без доступа к нашей странице.
import { Link } from '@mui/material'

const URL_RE = /(https?:\/\/[^\s<>«»"']+)/g
const TRAILING_RE = /[.,;:!?)\]]+$/

export function splitLinks(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    const raw = m[0]
    const url = raw.replace(TRAILING_RE, '')
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: url, href: url })
    last = start + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

export default function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) => (p.href
        ? <Link key={i} href={p.href} target="_blank" rel="noopener noreferrer" color="inherit" underline="always" sx={{ wordBreak: 'break-all' }}>{p.text}</Link>
        : <span key={i}>{p.text}</span>))}
    </>
  )
}
