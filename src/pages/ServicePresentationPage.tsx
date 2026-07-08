import { useNavigate } from 'react-router-dom'
import { Box, Container, Typography, Button, Paper, Stack } from '@mui/material'
import {
  Anchor as AnchorIcon, Insights as EstimateIcon, SupportAgent as ConsultIcon,
  Savings as SavingsIcon, Handyman as UpgradeIcon, ReceiptLong as ReceiptIcon,
  Layers as StepsIcon, WbSunny as SeasonIcon, VisibilityOutlined as TransparentIcon,
  SchoolOutlined as KnowledgeIcon, ArrowForward as ArrowIcon,
} from '@mui/icons-material'

// Морська палітра сервісу RunFerry
const C = {
  navy: '#0B2A3B',
  navy2: '#103A4F',
  petrol: '#12808F',
  aqua: '#3FBFCB',
  amber: '#E8A44C',
  amberDeep: '#D08A2E',
  ground: '#F3F7F8',
  ink: '#122A34',
  muted: '#5A7480',
  line: '#DCE7EA',
}

// Головні принципи (нумерація відповідає docs/service-principles.md — це реальний порядок, не декор)
const PRINCIPLES: { n: string; icon: JSX.Element; title: string; text: string }[] = [
  { n: '01', icon: <ReceiptIcon />, title: 'Зрозуміла вартість, а не «ціна на око»',
    text: 'Кожну роботу розкладаємо на пункти й рахуємо в нормо-годинах — як у хорошому автосервісі. Приймання, діагностика, ремонт, тест на воді, пакування — усе видно.' },
  { n: '02', icon: <TransparentIcon />, title: 'Видно, з чого складається година',
    text: 'За кліком на ставку нормо-години — її розшифровка: оплата майстру, податки, утримання сервісу, норма прибутку. Ви розумієте, за що платите.' },
  { n: '03', icon: <ReceiptIcon />, title: 'Матеріали — окремими рядками',
    text: 'Мастило, запчастини, пакування — окремі позиції за фіксованою ціною. Видно, що саме й за скільки пішло на ваш кораблик.' },
  { n: '04', icon: <StepsIcon />, title: 'Кілька проблем — без подвійного рахунку',
    text: 'Спільні операції (приймання, доставку, пакування) виконуємо й рахуємо один раз. За кожну конкретну несправність — окремо.' },
  { n: '05', icon: <SeasonIcon />, title: 'Не переплачуйте у високий сезон',
    text: 'Якщо кораблик справний — підкажемо: зробіть ремонт у міжсезоння за стандартним тарифом, а взимку ще й зі знижкою. Рішення завжди за вами.' },
  { n: '06', icon: <UpgradeIcon />, title: 'Апгрейди — одразу і без націнки',
    text: 'Встановлення ехолота чи оновлення ПЗ автопілота — це покращення, а не поломка. Робимо одразу, у будь-який сезон, без сезонної націнки.' },
]

const STEPS = [
  { t: 'Звернення', d: 'Ви описуєте проблему та свій кораблик — своїми словами.' },
  { t: 'Діагностика', d: 'Безкоштовна діагностика, визначаємо причину.' },
  { t: 'Кошторис', d: 'Детальний і прозорий; при поломці у сезон — варіант з відтермінуванням.' },
  { t: 'Погодження', d: 'Ви обираєте варіант і приймаєте умови.' },
  { t: 'Роботи', d: 'Ремонт або апгрейд, тестування на воді.' },
  { t: 'Повернення', d: 'Пакування та доставка кораблика назад.' },
]

export default function ServicePresentationPage() {
  const navigate = useNavigate()

  return (
    <Box sx={{ bgcolor: C.ground, color: C.ink, minHeight: '100vh' }}>
      {/* стилі анімації хвиль (з повагою до prefers-reduced-motion) */}
      <style>{`
        @keyframes rf-wave { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        .rf-wave { animation: rf-wave 18s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .rf-wave { animation: none; } }
      `}</style>

      {/* ==== HERO ==== */}
      <Box sx={{ position: 'relative', overflow: 'hidden', color: '#fff',
        background: `radial-gradient(1200px 500px at 80% -10%, ${C.petrol}55, transparent), linear-gradient(160deg, ${C.navy} 0%, ${C.navy2} 60%, ${C.petrol} 140%)` }}>
        <Container maxWidth="lg" sx={{ pt: { xs: 7, md: 11 }, pb: { xs: 14, md: 18 }, position: 'relative', zIndex: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2, opacity: 0.85 }}>
            <AnchorIcon sx={{ color: C.aqua }} />
            <Typography sx={{ letterSpacing: 3, textTransform: 'uppercase', fontSize: 13, fontWeight: 600 }}>
              RunFerry · сервіс прикормочних корабликів
            </Typography>
          </Stack>
          <Typography component="h1" sx={{
            fontWeight: 800, lineHeight: 1.05, textWrap: 'balance',
            fontSize: { xs: 34, sm: 46, md: 58 }, maxWidth: 900, mb: 2.5,
          }}>
            Ремонтуємо прикормочні кораблики — і допомагаємо ними користуватися
          </Typography>
          <Typography sx={{ fontSize: { xs: 16, md: 20 }, color: '#D6E7EB', maxWidth: 680, mb: 4 }}>
            Ми знаємо, що є над чим працювати, і починаємо зі зрозумілих та прозорих цін.
            Наша мета — щоб ваш кораблик служив довше, а не щоб ви більше витратили.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Button size="large" onClick={() => navigate('/questionnaire')}
              startIcon={<EstimateIcon />} endIcon={<ArrowIcon />}
              sx={{ bgcolor: C.amber, color: C.navy, fontWeight: 700, px: 3, py: 1.3,
                '&:hover': { bgcolor: C.amberDeep } }}>
              Оцінити ремонт
            </Button>
            <Button size="large" onClick={() => navigate('/chat')}
              startIcon={<ConsultIcon />}
              sx={{ color: '#fff', borderColor: '#ffffff66', border: '1px solid', px: 3, py: 1.3,
                '&:hover': { borderColor: '#fff', bgcolor: '#ffffff14' } }}>
              Консультація / самодопомога
            </Button>
          </Stack>

          {/* Показники */}
          <Stack direction="row" spacing={{ xs: 3, md: 6 }} sx={{ mt: { xs: 5, md: 7 }, flexWrap: 'wrap', rowGap: 2 }}>
            {[
              { k: 'Нормо-години', v: 'Чесний розрахунок' },
              { k: 'Прозора ставка', v: 'Видно кожну складову' },
              { k: 'Самодопомога', v: 'Підкажемо, як без витрат' },
            ].map((s) => (
              <Box key={s.k}>
                <Typography sx={{ color: C.aqua, fontWeight: 700, fontSize: { xs: 18, md: 22 } }}>{s.k}</Typography>
                <Typography sx={{ color: '#B9D2D8', fontSize: 14 }}>{s.v}</Typography>
              </Box>
            ))}
          </Stack>
        </Container>

        {/* Хвиля */}
        <Box sx={{ position: 'absolute', bottom: -1, left: 0, width: '100%', lineHeight: 0, zIndex: 1 }}>
          <Box component="svg" className="rf-wave" viewBox="0 0 2880 120" preserveAspectRatio="none"
            sx={{ width: '200%', height: { xs: 60, md: 90 }, display: 'block' }}>
            <path fill={C.ground} d="M0,64 C240,120 480,0 720,32 C960,64 1200,128 1440,96 C1680,64 1920,0 2160,32 C2400,64 2640,120 2880,80 L2880,120 L0,120 Z" />
          </Box>
        </Box>
      </Box>

      {/* ==== Честная полоса ==== */}
      <Container maxWidth="md" sx={{ py: { xs: 5, md: 7 }, textAlign: 'center' }}>
        <Typography sx={{ letterSpacing: 2, textTransform: 'uppercase', fontSize: 12, fontWeight: 700, color: C.petrol, mb: 1 }}>
          Ми працюємо над покращенням
        </Typography>
        <Typography sx={{ fontSize: { xs: 20, md: 26 }, fontWeight: 600, textWrap: 'balance', color: C.ink }}>
          Ми змінюємось на краще: спершу — зрозумілі ціни, далі швидші строки та зручніше спілкування.
          Без пафосу — просто робимо сервіс, яким зручно користуватися.
        </Typography>
      </Container>

      {/* ==== Принципи ==== */}
      <Container maxWidth="lg" sx={{ pb: { xs: 4, md: 6 } }}>
        <SectionTitle eyebrow="Як ми рахуємо" title="Прозорість у кожному пункті" />
        <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' } }}>
          {PRINCIPLES.map((p) => (
            <Paper key={p.n} elevation={0} sx={{
              p: 3, borderRadius: 3, border: `1px solid ${C.line}`, bgcolor: '#fff',
              transition: 'transform .18s, box-shadow .18s',
              '&:hover': { transform: 'translateY(-4px)', boxShadow: '0 14px 30px rgba(11,42,59,0.10)' },
            }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1.5 }}>
                <Box sx={{ width: 44, height: 44, borderRadius: 2, display: 'grid', placeItems: 'center',
                  bgcolor: `${C.petrol}14`, color: C.petrol }}>{p.icon}</Box>
                <Typography sx={{ fontWeight: 800, fontSize: 26, color: C.line }}>{p.n}</Typography>
              </Stack>
              <Typography sx={{ fontWeight: 700, fontSize: 17, mb: 0.8, textWrap: 'balance' }}>{p.title}</Typography>
              <Typography sx={{ color: C.muted, fontSize: 14.5, lineHeight: 1.55 }}>{p.text}</Typography>
            </Paper>
          ))}
        </Box>
      </Container>

      {/* ==== Прозора вартість (highlight) ==== */}
      <Box sx={{ py: { xs: 6, md: 8 }, background: `linear-gradient(135deg, ${C.navy} 0%, ${C.petrol} 130%)`, color: '#fff', my: { xs: 4, md: 6 } }}>
        <Container maxWidth="lg">
          <Box sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: '1fr', md: '1.1fr 0.9fr' }, alignItems: 'center' }}>
            <Box>
              <Typography sx={{ letterSpacing: 2, textTransform: 'uppercase', fontSize: 12, fontWeight: 700, color: C.aqua, mb: 1 }}>
                Прозора вартість
              </Typography>
              <Typography sx={{ fontSize: { xs: 24, md: 32 }, fontWeight: 800, mb: 2, textWrap: 'balance' }}>
                Ставка нормо-години — з розшифровкою
              </Typography>
              <Typography sx={{ color: '#D6E7EB', fontSize: 16, mb: 3, maxWidth: 520 }}>
                Оплата майстру, податки, утримання сервісу й норма прибутку — ви бачите, як формується
                ціна години роботи. Опишіть проблему, і помічник дасть попередню оцінку на основі прайсу.
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Button onClick={() => navigate('/questionnaire')} endIcon={<ArrowIcon />}
                  sx={{ bgcolor: C.amber, color: C.navy, fontWeight: 700, px: 3, py: 1.2, '&:hover': { bgcolor: C.amberDeep } }}>
                  Отримати попередню оцінку
                </Button>
                <Button onClick={() => navigate('/price')}
                  sx={{ color: '#fff', border: '1px solid #ffffff66', px: 3, py: 1.2, '&:hover': { borderColor: '#fff', bgcolor: '#ffffff14' } }}>
                  Повний прайс-лист
                </Button>
              </Stack>
            </Box>
            <Paper elevation={0} sx={{ p: 3, borderRadius: 3, bgcolor: '#ffffff12', border: '1px solid #ffffff22' }}>
              {[
                { l: 'Оплата майстру', v: 'основа' },
                { l: 'Податки (ФОП, ЄСВ)', v: '+' },
                { l: 'Утримання сервісу', v: '+' },
                { l: 'Норма прибутку', v: '+' },
              ].map((r, i) => (
                <Stack key={r.l} direction="row" justifyContent="space-between" sx={{
                  py: 1.2, borderTop: i ? '1px solid #ffffff1f' : 'none' }}>
                  <Typography sx={{ color: '#E7F1F3' }}>{r.l}</Typography>
                  <Typography sx={{ color: C.aqua, fontWeight: 700 }}>{r.v}</Typography>
                </Stack>
              ))}
              <Typography sx={{ mt: 1.5, fontSize: 13, color: '#B9D2D8' }}>
                = зрозуміла ставка нормо-години, однакова логіка для всіх робіт.
              </Typography>
            </Paper>
          </Box>
        </Container>
      </Box>

      {/* ==== Етапи ==== */}
      <Container maxWidth="lg" sx={{ pb: { xs: 4, md: 6 } }}>
        <SectionTitle eyebrow="Як проходить обслуговування" title="Шість зрозумілих кроків" />
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(3, 1fr)' } }}>
          {STEPS.map((s, i) => (
            <Paper key={s.t} elevation={0} sx={{ p: 2.5, borderRadius: 3, border: `1px solid ${C.line}`, bgcolor: '#fff', position: 'relative' }}>
              <Box sx={{ width: 30, height: 30, borderRadius: '50%', bgcolor: C.petrol, color: '#fff',
                display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14, mb: 1.2 }}>{i + 1}</Box>
              <Typography sx={{ fontWeight: 700, fontSize: 16, mb: 0.5 }}>{s.t}</Typography>
              <Typography sx={{ color: C.muted, fontSize: 14, lineHeight: 1.5 }}>{s.d}</Typography>
            </Paper>
          ))}
        </Box>
      </Container>

      {/* ==== Самодопомога ==== */}
      <Container maxWidth="lg" sx={{ pb: { xs: 6, md: 8 } }}>
        <Paper elevation={0} sx={{ p: { xs: 3, md: 5 }, borderRadius: 4, border: `1px solid ${C.line}`,
          display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: 'auto 1fr auto' }, alignItems: 'center',
          background: `linear-gradient(120deg, #fff, ${C.aqua}0e)` }}>
          <Box sx={{ width: 64, height: 64, borderRadius: 3, bgcolor: `${C.petrol}16`, color: C.petrol, display: 'grid', placeItems: 'center' }}>
            <KnowledgeIcon sx={{ fontSize: 34 }} />
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 700, fontSize: { xs: 19, md: 22 }, mb: 0.5, textWrap: 'balance' }}>
              Іноді проблему можна вирішити самому — і ми це підкажемо
            </Typography>
            <Typography sx={{ color: C.muted, fontSize: 15 }}>
              Як зарядити акумулятор, налаштувати кораблик або усунути дрібну несправність без витрат.
              Наша мета — допомогти, а не нав’язати ремонт. Відповіді помічника можуть бути неточними —
              за потреби передамо діалог живому майстру.
            </Typography>
          </Box>
          <Button onClick={() => navigate('/chat')} endIcon={<SavingsIcon />} variant="outlined"
            sx={{ color: C.petrol, borderColor: C.petrol, fontWeight: 700, px: 3, py: 1.2, whiteSpace: 'nowrap',
              '&:hover': { borderColor: C.navy, bgcolor: `${C.petrol}0e` } }}>
            Запитати помічника
          </Button>
        </Paper>
      </Container>

      {/* ==== Фінальний CTA ==== */}
      <Box sx={{ background: C.navy, color: '#fff', py: { xs: 6, md: 8 } }}>
        <Container maxWidth="md" sx={{ textAlign: 'center' }}>
          <Typography sx={{ fontSize: { xs: 24, md: 32 }, fontWeight: 800, mb: 1.5, textWrap: 'balance' }}>
            Готові оцінити ваш кораблик?
          </Typography>
          <Typography sx={{ color: '#C7DBE0', fontSize: 16, mb: 4, maxWidth: 560, mx: 'auto' }}>
            Опишіть проблему своїми словами — отримаєте орієнтовну вартість і, за потреби, зв’язок з менеджером.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="center">
            <Button size="large" onClick={() => navigate('/questionnaire')} endIcon={<ArrowIcon />}
              sx={{ bgcolor: C.amber, color: C.navy, fontWeight: 700, px: 4, py: 1.3, '&:hover': { bgcolor: C.amberDeep } }}>
              Почати
            </Button>
          </Stack>
          <Typography sx={{ mt: 4, fontSize: 13, color: '#8FB0B8' }}>
            Спілкуємося вашою мовою · державна мова відповіді — українська
          </Typography>
        </Container>
      </Box>
    </Box>
  )
}

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <Box sx={{ mb: 3.5 }}>
      <Typography sx={{ letterSpacing: 2, textTransform: 'uppercase', fontSize: 12, fontWeight: 700, color: C.petrol, mb: 0.5 }}>
        {eyebrow}
      </Typography>
      <Typography sx={{ fontSize: { xs: 24, md: 30 }, fontWeight: 800, textWrap: 'balance' }}>{title}</Typography>
    </Box>
  )
}
