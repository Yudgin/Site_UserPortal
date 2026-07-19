// Локализация клиентского режима. Источник — украинский (uk), он же дефолт.
// Остальные языки могут быть неполными: t() падает обратно на украинский.

export type Lang = 'uk' | 'en' | 'de' | 'pl' | 'ro' | 'bg' | 'ru';

export const DEFAULT_LANG: Lang = 'uk';

export const LANGUAGES: { code: Lang; flag: string; name: string }[] = [
  { code: 'uk', flag: '🇺🇦', name: 'Українська' },
  { code: 'en', flag: '🇬🇧', name: 'English' },
  { code: 'de', flag: '🇩🇪', name: 'Deutsch' },
  { code: 'pl', flag: '🇵🇱', name: 'Polski' },
  { code: 'ro', flag: '🇷🇴', name: 'Română' },
  { code: 'bg', flag: '🇧🇬', name: 'Български' },
  { code: 'ru', flag: '🇷🇺', name: 'Русский' },
];

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && LANGUAGES.some((l) => l.code === value);
}

export type MsgKey =
  | 'welcome'
  | 'btn_share_phone'
  | 'btn_my_repairs'
  | 'btn_language'
  | 'menu'
  | 'phone_confirmed'
  | 'share_own_phone'
  | 'phone_unrecognized'
  | 'confirm_phone_first'
  | 'no_repairs'
  | 'save_phone_failed'
  | 'choose_language'
  | 'language_set'
  | 'service_unavailable'
  | 'repairs_title'
  | 'repairs_hint'
  | 'repairs_shown'
  | 'repair'
  | 'complaint'
  | 'selected_option'
  | 'total'
  | 'payment'
  | 'paid'
  | 'unpaid'
  | 'ttn_to_service'
  | 'ttn_return'
  | 'client'
  | 'city'
  | 'warehouse'
  | 'repair_options'
  | 'final_invoice'
  | 'btn_pay'
  | 'btn_open_repair'
  | 'notif_title'
  | 'notif_repair_no'
  | 'notif_status';

type Catalog = Record<MsgKey, string>;

const uk: Catalog = {
  welcome:
    '👋 Вітаємо! Це бот сервісу RunFerry.\n\nТут ви можете переглядати свої ремонти та отримувати сповіщення про їхній статус.\nЩоб продовжити, підтвердіть свій номер телефону — натисніть кнопку нижче.',
  btn_share_phone: '📱 Поділитися номером',
  btn_my_repairs: '🔧 Мої ремонти',
  btn_language: '🌐 Мова',
  menu: 'Меню:',
  phone_confirmed: '✅ Номер підтверджено{name}!\nОберіть дію:',
  share_own_phone: 'Будь ласка, поділіться саме своїм номером — натисніть кнопку нижче.',
  phone_unrecognized: 'Не вдалося розпізнати номер телефону. Спробуйте ще раз.',
  confirm_phone_first: 'Спочатку підтвердіть номер телефону.',
  no_repairs: 'У вас поки немає ремонтів.',
  save_phone_failed: '⚠️ Не вдалося зберегти номер. Спробуйте ще раз.',
  choose_language: '🌐 Оберіть мову:',
  language_set: '✅ Мову змінено.',
  service_unavailable: '⚠️ Сервіс тимчасово недоступний. Спробуйте пізніше.',
  repairs_title: '🔧 Ваші ремонти ({count})',
  repairs_hint: 'Натисніть на ремонт, щоб відкрити подробиці.',
  repairs_shown: 'Показано {shown} останніх.',
  repair: 'Ремонт',
  complaint: 'Скарга',
  selected_option: 'Обраний варіант',
  total: 'Разом',
  payment: 'Оплата',
  paid: 'оплачено',
  unpaid: 'не оплачено',
  ttn_to_service: 'ТТН у сервіс',
  ttn_return: 'ТТН повернення',
  client: 'Клієнт',
  city: 'Місто',
  warehouse: 'Відділення',
  repair_options: 'Варіанти ремонту',
  final_invoice: 'Підсумковий рахунок',
  btn_pay: '💳 Сплатити',
  btn_open_repair: 'Відкрити ремонт',
  notif_title: '🔧 Оновлення по ремонту',
  notif_repair_no: 'Ремонт №{number}',
  notif_status: 'Статус: {status}',
};

const ru: Catalog = {
  welcome:
    '👋 Здравствуйте! Это бот сервиса RunFerry.\n\nЗдесь вы можете смотреть свои ремонты и получать уведомления об их статусе.\nЧтобы продолжить, подтвердите свой номер телефона — нажмите кнопку ниже.',
  btn_share_phone: '📱 Поделиться номером',
  btn_my_repairs: '🔧 Мои ремонты',
  btn_language: '🌐 Язык',
  menu: 'Меню:',
  phone_confirmed: '✅ Номер подтверждён{name}!\nВыберите действие:',
  share_own_phone: 'Пожалуйста, поделитесь именно своим номером — нажмите кнопку ниже.',
  phone_unrecognized: 'Не удалось распознать номер телефона. Попробуйте ещё раз.',
  confirm_phone_first: 'Сначала подтвердите номер телефона.',
  no_repairs: 'У вас пока нет ремонтов.',
  save_phone_failed: '⚠️ Не удалось сохранить номер. Попробуйте ещё раз.',
  choose_language: '🌐 Выберите язык:',
  language_set: '✅ Язык изменён.',
  service_unavailable: '⚠️ Сервис временно недоступен. Попробуйте позже.',
  repairs_title: '🔧 Ваши ремонты ({count})',
  repairs_hint: 'Нажмите на ремонт, чтобы открыть подробности.',
  repairs_shown: 'Показаны {shown} последних.',
  repair: 'Ремонт',
  complaint: 'Жалоба',
  selected_option: 'Выбран вариант',
  total: 'Итого',
  payment: 'Оплата',
  paid: 'оплачено',
  unpaid: 'не оплачено',
  ttn_to_service: 'ТТН в сервис',
  ttn_return: 'ТТН возврата',
  client: 'Клиент',
  city: 'Город',
  warehouse: 'Отделение',
  repair_options: 'Варианты ремонта',
  final_invoice: 'Итоговый счёт',
  btn_pay: '💳 Оплатить',
  btn_open_repair: 'Открыть ремонт',
  notif_title: '🔧 Обновление по ремонту',
  notif_repair_no: 'Ремонт №{number}',
  notif_status: 'Статус: {status}',
};

const en: Partial<Catalog> = {
  welcome:
    "👋 Welcome! This is the RunFerry service bot.\n\nHere you can view your repairs and get notifications about their status.\nTo continue, please confirm your phone number — tap the button below.",
  btn_share_phone: '📱 Share number',
  btn_my_repairs: '🔧 My repairs',
  btn_language: '🌐 Language',
  menu: 'Menu:',
  phone_confirmed: '✅ Phone confirmed{name}!\nChoose an action:',
  share_own_phone: 'Please share your own number — tap the button below.',
  phone_unrecognized: "We couldn't recognize the phone number. Please try again.",
  confirm_phone_first: 'Please confirm your phone number first.',
  no_repairs: "You don't have any repairs yet.",
  save_phone_failed: "⚠️ We couldn't save your number. Please try again.",
  choose_language: '🌐 Choose a language:',
  language_set: '✅ Language changed.',
  service_unavailable: '⚠️ The service is temporarily unavailable. Please try again later.',
  repairs_title: '🔧 Your repairs ({count})',
  repairs_hint: 'Tap a repair to open its details.',
  repairs_shown: 'Showing the {shown} most recent.',
  repair: 'Repair',
  complaint: 'Complaint',
  selected_option: 'Selected option',
  total: 'Total',
  payment: 'Payment',
  paid: 'paid',
  unpaid: 'not paid',
  ttn_to_service: 'Tracking number to service',
  ttn_return: 'Return tracking number',
  client: 'Client',
  city: 'City',
  warehouse: 'Branch',
  repair_options: 'Repair options',
  final_invoice: 'Final invoice',
  btn_pay: '💳 Pay',
  btn_open_repair: 'Open repair',
  notif_title: '🔧 Repair update',
  notif_repair_no: 'Repair #{number}',
  notif_status: 'Status: {status}',
};

const de: Partial<Catalog> = {
  welcome:
    '👋 Willkommen! Das ist der Bot des RunFerry-Service.\n\nHier können Sie Ihre Reparaturen einsehen und Benachrichtigungen über deren Status erhalten.\nUm fortzufahren, bestätigen Sie bitte Ihre Telefonnummer – tippen Sie auf die Schaltfläche unten.',
  btn_share_phone: '📱 Nummer teilen',
  btn_my_repairs: '🔧 Meine Reparaturen',
  btn_language: '🌐 Sprache',
  menu: 'Menü:',
  phone_confirmed: '✅ Nummer bestätigt{name}!\nWählen Sie eine Aktion:',
  share_own_phone:
    'Bitte teilen Sie genau Ihre eigene Nummer – tippen Sie auf die Schaltfläche unten.',
  phone_unrecognized:
    'Die Telefonnummer konnte nicht erkannt werden. Bitte versuchen Sie es erneut.',
  confirm_phone_first: 'Bitte bestätigen Sie zuerst Ihre Telefonnummer.',
  no_repairs: 'Sie haben derzeit keine Reparaturen.',
  save_phone_failed:
    '⚠️ Die Nummer konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.',
  choose_language: '🌐 Wählen Sie eine Sprache:',
  language_set: '✅ Sprache geändert.',
  service_unavailable:
    '⚠️ Der Service ist vorübergehend nicht verfügbar. Bitte versuchen Sie es später erneut.',
  repairs_title: '🔧 Ihre Reparaturen ({count})',
  repairs_hint: 'Tippen Sie auf eine Reparatur, um die Details zu öffnen.',
  repairs_shown: 'Es werden die {shown} letzten angezeigt.',
  repair: 'Reparatur',
  complaint: 'Reklamation',
  selected_option: 'Gewählte Option',
  total: 'Gesamt',
  payment: 'Zahlung',
  paid: 'bezahlt',
  unpaid: 'nicht bezahlt',
  ttn_to_service: 'Sendungsnummer zum Service',
  ttn_return: 'Sendungsnummer der Rücksendung',
  client: 'Kunde',
  city: 'Stadt',
  warehouse: 'Filiale',
  repair_options: 'Reparaturoptionen',
  final_invoice: 'Endabrechnung',
  btn_pay: '💳 Bezahlen',
  btn_open_repair: 'Reparatur öffnen',
  notif_title: '🔧 Update zur Reparatur',
  notif_repair_no: 'Reparatur Nr. {number}',
  notif_status: 'Status: {status}',
};

const pl: Partial<Catalog> = {
  welcome:
    '👋 Witamy! To bot serwisu RunFerry.\n\nTutaj możesz przeglądać swoje naprawy i otrzymywać powiadomienia o ich statusie.\nAby kontynuować, potwierdź swój numer telefonu — naciśnij przycisk poniżej.',
  btn_share_phone: '📱 Udostępnij numer',
  btn_my_repairs: '🔧 Moje naprawy',
  btn_language: '🌐 Język',
  menu: 'Menu:',
  phone_confirmed: '✅ Numer potwierdzony{name}!\nWybierz działanie:',
  share_own_phone: 'Udostępnij proszę swój własny numer — naciśnij przycisk poniżej.',
  phone_unrecognized: 'Nie udało się rozpoznać numeru telefonu. Spróbuj ponownie.',
  confirm_phone_first: 'Najpierw potwierdź numer telefonu.',
  no_repairs: 'Nie masz jeszcze żadnych napraw.',
  save_phone_failed: '⚠️ Nie udało się zapisać numeru. Spróbuj ponownie.',
  choose_language: '🌐 Wybierz język:',
  language_set: '✅ Język został zmieniony.',
  service_unavailable: '⚠️ Serwis jest chwilowo niedostępny. Spróbuj później.',
  repairs_title: '🔧 Twoje naprawy ({count})',
  repairs_hint: 'Naciśnij na naprawę, aby otworzyć szczegóły.',
  repairs_shown: 'Wyświetlono {shown} ostatnich.',
  repair: 'Naprawa',
  complaint: 'Usterka',
  selected_option: 'Wybrany wariant',
  total: 'Razem',
  payment: 'Płatność',
  paid: 'opłacono',
  unpaid: 'nieopłacono',
  ttn_to_service: 'Numer przesyłki do serwisu',
  ttn_return: 'Numer przesyłki zwrotnej',
  client: 'Klient',
  city: 'Miasto',
  warehouse: 'Oddział',
  repair_options: 'Warianty naprawy',
  final_invoice: 'Rachunek końcowy',
  btn_pay: '💳 Zapłać',
  btn_open_repair: 'Otwórz naprawę',
  notif_title: '🔧 Aktualizacja naprawy',
  notif_repair_no: 'Naprawa nr {number}',
  notif_status: 'Status: {status}',
};

const ro: Partial<Catalog> = {
  welcome:
    '👋 Bun venit! Acesta este botul serviciului RunFerry.\n\nAici puteți vedea reparațiile dvs. și primi notificări despre statusul lor.\nPentru a continua, confirmați-vă numărul de telefon — apăsați butonul de mai jos.',
  btn_share_phone: '📱 Trimite numărul',
  btn_my_repairs: '🔧 Reparațiile mele',
  btn_language: '🌐 Limbă',
  menu: 'Meniu:',
  phone_confirmed: '✅ Numărul a fost confirmat{name}!\nAlegeți o acțiune:',
  share_own_phone: 'Vă rugăm să trimiteți chiar propriul dvs. număr — apăsați butonul de mai jos.',
  phone_unrecognized: 'Numărul de telefon nu a putut fi recunoscut. Încercați din nou.',
  confirm_phone_first: 'Mai întâi confirmați numărul de telefon.',
  no_repairs: 'Deocamdată nu aveți nicio reparație.',
  save_phone_failed: '⚠️ Numărul nu a putut fi salvat. Încercați din nou.',
  choose_language: '🌐 Alegeți limba:',
  language_set: '✅ Limba a fost schimbată.',
  service_unavailable: '⚠️ Serviciul este temporar indisponibil. Încercați mai târziu.',
  repairs_title: '🔧 Reparațiile dvs. ({count})',
  repairs_hint: 'Apăsați pe o reparație pentru a vedea detaliile.',
  repairs_shown: 'Sunt afișate ultimele {shown}.',
  repair: 'Reparație',
  complaint: 'Reclamație',
  selected_option: 'Varianta aleasă',
  total: 'Total',
  payment: 'Plată',
  paid: 'plătit',
  unpaid: 'neplătit',
  ttn_to_service: 'Număr de urmărire către service',
  ttn_return: 'Număr de urmărire al returului',
  client: 'Client',
  city: 'Oraș',
  warehouse: 'Oficiu',
  repair_options: 'Variante de reparație',
  final_invoice: 'Factură finală',
  btn_pay: '💳 Plătește',
  btn_open_repair: 'Deschide reparația',
  notif_title: '🔧 Actualizare privind reparația',
  notif_repair_no: 'Reparația nr. {number}',
  notif_status: 'Status: {status}',
};

const bg: Partial<Catalog> = {
  welcome:
    '👋 Добре дошли! Това е ботът на сервиза RunFerry.\n\nТук можете да преглеждате своите ремонти и да получавате известия за техния статус.\nЗа да продължите, потвърдете своя телефонен номер — натиснете бутона по-долу.',
  btn_share_phone: '📱 Споделяне на номер',
  btn_my_repairs: '🔧 Моите ремонти',
  btn_language: '🌐 Език',
  menu: 'Меню:',
  phone_confirmed: '✅ Номерът е потвърден{name}!\nИзберете действие:',
  share_own_phone: 'Моля, споделете именно своя номер — натиснете бутона по-долу.',
  phone_unrecognized: 'Номерът на телефона не можа да бъде разпознат. Опитайте отново.',
  confirm_phone_first: 'Първо потвърдете телефонния номер.',
  no_repairs: 'Все още нямате ремонти.',
  save_phone_failed: '⚠️ Номерът не можа да бъде запазен. Опитайте отново.',
  choose_language: '🌐 Изберете език:',
  language_set: '✅ Езикът е сменен.',
  service_unavailable: '⚠️ Сервизът е временно недостъпен. Опитайте по-късно.',
  repairs_title: '🔧 Вашите ремонти ({count})',
  repairs_hint: 'Натиснете върху ремонт, за да отворите подробностите.',
  repairs_shown: 'Показани са {shown} последни.',
  repair: 'Ремонт',
  complaint: 'Оплакване',
  selected_option: 'Избран вариант',
  total: 'Общо',
  payment: 'Плащане',
  paid: 'платено',
  unpaid: 'неплатено',
  ttn_to_service: 'Номер за проследяване към сервиза',
  ttn_return: 'Номер за проследяване на връщането',
  client: 'Клиент',
  city: 'Град',
  warehouse: 'Офис',
  repair_options: 'Варианти за ремонт',
  final_invoice: 'Окончателна сметка',
  btn_pay: '💳 Плащане',
  btn_open_repair: 'Отваряне на ремонт',
  notif_title: '🔧 Актуализация по ремонта',
  notif_repair_no: 'Ремонт №{number}',
  notif_status: 'Статус: {status}',
};

const CATALOG: Record<Lang, Partial<Catalog>> = { uk, ru, en, de, pl, ro, bg };

/** Перевод ключа на язык lang с подстановкой {vars}; фолбэк — украинский. */
export function t(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string {
  const template = CATALOG[lang]?.[key] ?? uk[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}
