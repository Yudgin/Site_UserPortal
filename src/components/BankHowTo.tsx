// Инструкция «где взять ключ» прямо у полей банка на /fops: владельцу не нужно искать её в переписке.
// Шаги сверены с документом ПриватБанка по «Автоклієнту» и с инструкциями сервисов, которые подключают те же банки.
import type { ReactNode } from 'react'
import { Accordion, AccordionDetails, AccordionSummary, Box, Link, Typography } from '@mui/material'
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material'

export type BankKind = 'mono' | 'privat' | 'novapay'

const ext = (href: string, text: string) => <Link href={href} target="_blank" rel="noopener noreferrer">{text}</Link>

const HOWTO: Record<BankKind, { steps: ReactNode[]; notes: string[] }> = {
  mono: {
    steps: [
      <>На компʼютері відкрийте {ext('https://api.monobank.ua/', 'api.monobank.ua')}.</>,
      'Застосунком monobank власника цього ФОП відскануйте QR-код зі сторінки і підтвердьте доступ у застосунку.',
      'Скопіюйте токен, що зʼявиться на сторінці, і вставте в поле вище.',
    ],
    notes: [
      'Токен видає сама людина, на яку відкрито ФОП: для кожного ФОП свій токен.',
      'Токен лише для читання: переказати гроші з ним неможливо.',
      'Він відкриває і особисті картки цієї людини, але портал читає тільки рахунки ФОП.',
      'Окремий ФОП для особистих карток заводити не потрібно.',
    ],
  },
  privat: {
    steps: [
      'Увійдіть у «Приват24 для бізнесу» і оберіть цей ФОП.',
      'У меню відкрийте «Каталог послуг» → «Автоклієнт» (інша назва — «Інтеграція (Автоклієнт)»), встановіть і запустіть його.',
      'Натисніть «Підключити додаток» і оберіть «API». Введіть назву, наприклад RunFerry, поставте позначку про ознайомлення з умовами і натисніть «Зберегти».',
      'У рядку нового додатка натисніть піктограму встановлення (стрілка вниз) і підтвердьте «Ознайомлений».',
      'У вікні «Авторизаційні дані для роботи з API» скопіюйте token у поле вище.',
      'Якщо банк показує пару id і token («авторизаційні дані в старому форматі»), заповніть обидва поля.',
    ],
    notes: [
      'Портал цим ключем лише читає залишки і виписки, платежів не створює.',
      'Якщо під час підключення банк питає про права, оберіть тільки виписки.',
    ],
  },
  novapay: {
    steps: [
      <>Увійдіть у бізнес-кабінет {ext('https://business.novapay.ua/', 'business.novapay.ua')}.</>,
      'Відкрийте «Система» → «Налаштування» → вкладка «API».',
      'У блоці «Генерація Refresh Token» натисніть «Згенерувати», оберіть підприємство (цей ФОП), введіть назву, наприклад RunFerry, і натисніть «Продовжити».',
      'Скопіюйте Refresh Token і сертифікат у поля вище. Логін — той, яким ви входите в кабінет.',
    ],
    notes: [
      'Одночасно діє до пʼяти токенів; перелік підприємств фіксується під час генерації.',
      'Перевірку підключення і завантаження виписок NovaPay портал ще не вміє: зʼявляться з наступним оновленням.',
      'Якщо у вкладці «API» є файл «API інструкція», збережіть його: він потрібен, щоб доробити завантаження.',
    ],
  },
}

export default function BankHowTo({ bank }: { bank: BankKind }) {
  const { steps, notes } = HOWTO[bank]
  return (
    <Accordion disableGutters elevation={0} variant="outlined" sx={{ '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />} sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
        <Typography variant="body2" color="primary">Як отримати</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Box component="ol" sx={{ m: 0, pl: 2.5, '& li': { mb: 0.5 } }}>
          {steps.map((s, i) => <Typography key={i} component="li" variant="body2">{s}</Typography>)}
        </Box>
        <Box component="ul" sx={{ mt: 1, mb: 0, pl: 2.5 }}>
          {notes.map((n) => <Typography key={n} component="li" variant="caption" color="text.secondary" sx={{ display: 'list-item' }}>{n}</Typography>)}
        </Box>
      </AccordionDetails>
    </Accordion>
  )
}
