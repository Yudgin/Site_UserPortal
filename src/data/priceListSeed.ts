// Стартовый каталог прайс-листа (сид).
//
// Используется для первичного наполнения Firestore и как демонстрация модели.
// Ставка нормо-часа и цены — примерные, редактируются администратором.
// Локализация задана для uk/ru/en; недостающие языки берут украинский fallback.

import type { CatalogInput } from '@/utils/pricing'
import type { PricingSettings } from '@/types/pricing'

// ==== Категории ====
const categories: CatalogInput['categories'] = [
  { id: 'cat-logistics', name: { uk: 'Логістика та склад', ru: 'Логистика и склад', en: 'Logistics & warehouse' }, order: 1 },
  { id: 'cat-diag', name: { uk: 'Діагностика', ru: 'Диагностика', en: 'Diagnostics' }, order: 2 },
  { id: 'cat-mech', name: { uk: 'Механіка та електроніка', ru: 'Механика и электроника', en: 'Mechanics & electronics' }, order: 3 },
  { id: 'cat-test', name: { uk: 'Тестування', ru: 'Тестирование', en: 'Testing' }, order: 4 },
  { id: 'cat-pack', name: { uk: 'Пакування', ru: 'Упаковка', en: 'Packaging' }, order: 5 },
]

// ==== Материалы (фиксированная цена, грн) ====
const materials: CatalogInput['materials'] = [
  { id: 'mat-napkins', code: 'M-NAP', name: { uk: 'Серветки сухі', ru: 'Салфетки сухие', en: 'Dry wipes' }, unit: { uk: 'шт', ru: 'шт', en: 'pcs' }, price: 20, active: true },
  { id: 'mat-servo', code: 'M-SERVO', name: { uk: 'Сервопривід', ru: 'Сервопривод', en: 'Servo drive' }, unit: { uk: 'шт', ru: 'шт', en: 'pcs' }, price: 950, active: true },
  { id: 'mat-grease', code: 'M-GRS', name: { uk: 'Мастило технічне', ru: 'Смазка техническая', en: 'Technical grease' }, unit: { uk: 'мл', ru: 'мл', en: 'ml' }, price: 3, active: true },
  { id: 'mat-wrap', code: 'M-WRP', name: { uk: 'Плівка бульбашкова', ru: 'Плёнка пузырчатая', en: 'Bubble wrap' }, unit: { uk: 'м', ru: 'м', en: 'm' }, price: 15, active: true },
  { id: 'mat-box', code: 'M-BOX', name: { uk: 'Коробка транспортувальна', ru: 'Коробка транспортировочная', en: 'Shipping box' }, unit: { uk: 'шт', ru: 'шт', en: 'pcs' }, price: 80, active: true },
  { id: 'mat-oil', code: 'M-OIL', name: { uk: 'Мастило моторне', ru: 'Масло моторное', en: 'Engine oil' }, unit: { uk: 'мл', ru: 'мл', en: 'ml' }, price: 2, active: true },
  { id: 'mat-echo', code: 'M-ECHO', name: { uk: 'Ехолот (комплект)', ru: 'Эхолот (комплект)', en: 'Fish finder (kit)' }, unit: { uk: 'шт', ru: 'шт', en: 'pcs' }, price: 3500, waivesHighSeasonSurcharge: true, active: true },
]

// ==== Доп. товары и услуги (фиксированная цена, грн) ====
const addons: CatalogInput['addons'] = [
  { id: 'add-napkin-util', code: 'A-UTIL', name: { uk: 'Утилізація серветок', ru: 'Утилизация салфеток', en: 'Wipes disposal' }, kind: 'service', price: 30, active: true },
  { id: 'add-warranty', code: 'A-WRN', name: { uk: 'Розширена гарантія 6 міс', ru: 'Расширенная гарантия 6 мес', en: 'Extended warranty 6 mo' }, kind: 'product', price: 250, active: true },
  { id: 'add-express', code: 'A-EXP', name: { uk: 'Термінове обслуговування', ru: 'Срочное обслуживание', en: 'Express service' }, kind: 'service', price: 400, active: true },
]

// ==== Работы (нормо-часы) ====
// dedupe: 'once' — общая операция обслуживания (выполняется один раз на смету, даже
// если жалоб несколько); 'perComplaint' — относится к конкретной поломке (суммируется).
const works: CatalogInput['works'] = [
  // Логистика и склад — общие операции, один раз на смету
  { id: 'w-receive', code: 'W-RCV', name: { uk: 'Приймання та ідентифікація кораблика', ru: 'Приёмка и идентификация кораблика', en: 'Intake & identification' }, categoryId: 'cat-logistics', laborHours: 0.2, dedupe: 'once', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-stock-in', code: 'W-STIN', name: { uk: 'Облік кораблика на складі', ru: 'Учёт кораблика на складе', en: 'Warehouse check-in' }, categoryId: 'cat-logistics', laborHours: 0.1, dedupe: 'once', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-transport-to', code: 'W-TRTO', name: { uk: 'Транспортування на водойму', ru: 'Транспортировка на водоём', en: 'Transport to water' }, categoryId: 'cat-logistics', laborHours: 0.5, dedupe: 'once', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-transport-from', code: 'W-TRFR', name: { uk: 'Транспортування з водойми', ru: 'Транспортировка с водоёма', en: 'Transport from water' }, categoryId: 'cat-logistics', laborHours: 0.5, dedupe: 'once', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-stock-out', code: 'W-STOUT', name: { uk: 'Видача кораблика зі складу', ru: 'Выдача кораблика со склада', en: 'Warehouse check-out' }, categoryId: 'cat-logistics', laborHours: 0.1, dedupe: 'once', materials: [], addons: [], publicVisible: true, active: true },

  // Диагностика — по каждой жалобе отдельно
  { id: 'w-diagnose', code: 'W-DIAG', name: { uk: 'Діагностика несправності', ru: 'Диагностика неисправности', en: 'Fault diagnostics' }, categoryId: 'cat-diag', laborHours: 0.4, dedupe: 'perComplaint', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-prep-test', code: 'W-PREP', name: { uk: 'Підготовка до тестування', ru: 'Подготовка к тестированию', en: 'Test preparation' }, categoryId: 'cat-diag', laborHours: 0.3, dedupe: 'once', materials: [], addons: [], publicVisible: true, active: true },

  // Механика и электроника — конкретный ремонт, по каждой жалобе
  { id: 'w-autopilot', code: 'W-AUTO', name: { uk: 'Налаштування автопілота', ru: 'Настройка автопилота', en: 'Autopilot tuning' }, categoryId: 'cat-mech', laborHours: 0.8, dedupe: 'perComplaint', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-engine-service', code: 'W-ENG', name: { uk: 'ТО двигуна', ru: 'ТО двигателя', en: 'Engine service' }, categoryId: 'cat-mech', laborHours: 1.0, dedupe: 'perComplaint', materials: [{ materialId: 'mat-oil', qty: 200 }], addons: [], publicVisible: true, active: true },
  { id: 'w-servo-remove', code: 'W-SVRM', name: { uk: 'Демонтаж сервоприводу', ru: 'Демонтаж сервопривода', en: 'Servo removal' }, categoryId: 'cat-mech', laborHours: 0.6, dedupe: 'perComplaint', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-servo-install', code: 'W-SVIN', name: { uk: 'Встановлення нового сервоприводу', ru: 'Установка нового сервопривода', en: 'New servo install' }, categoryId: 'cat-mech', laborHours: 0.7, dedupe: 'perComplaint', materials: [{ materialId: 'mat-servo', qty: 1 }, { materialId: 'mat-grease', qty: 5 }], addons: [], publicVisible: true, active: true },
  { id: 'w-servo-calibrate', code: 'W-SVCL', name: { uk: 'Калібрування сервоприводу', ru: 'Калибровка сервопривода', en: 'Servo calibration' }, categoryId: 'cat-mech', laborHours: 0.4, dedupe: 'perComplaint', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-echo-install', code: 'W-ECHO', name: { uk: 'Встановлення ехолота', ru: 'Установка эхолота', en: 'Fish finder install' }, categoryId: 'cat-mech', laborHours: 0.7, dedupe: 'perComplaint', materials: [{ materialId: 'mat-echo', qty: 1 }], addons: [], publicVisible: true, active: true },
  { id: 'w-fw-update', code: 'W-FWUP', name: { uk: 'Оновлення ПЗ автопілота', ru: 'Обновление ПО автопилота', en: 'Autopilot firmware update' }, categoryId: 'cat-mech', laborHours: 0.5, dedupe: 'perComplaint', materials: [], addons: [], publicVisible: true, active: true },

  // Тестирование — один раз на смету (проверяем всё за один выезд)
  { id: 'w-test-run', code: 'W-TEST', name: { uk: 'Тестовий прогін на воді', ru: 'Тестовый прогон на воде', en: 'Water test run' }, categoryId: 'cat-test', laborHours: 0.5, dedupe: 'once', materials: [], addons: [], publicVisible: true, active: true },
  { id: 'w-dry', code: 'W-DRY', name: { uk: 'Сушіння кораблика після тесту', ru: 'Сушка кораблика после теста', en: 'Drying after test' }, categoryId: 'cat-test', laborHours: 0.3, dedupe: 'once', materials: [{ materialId: 'mat-napkins', qty: 2 }], addons: [{ addonId: 'add-napkin-util', includedByDefault: false }], publicVisible: true, active: true },

  // Упаковка — один раз на смету
  { id: 'w-pack', code: 'W-PACK', name: { uk: 'Пакування кораблика', ru: 'Упаковка кораблика', en: 'Boat packaging' }, categoryId: 'cat-pack', laborHours: 0.2, dedupe: 'once', materials: [{ materialId: 'mat-wrap', qty: 2 }, { materialId: 'mat-box', qty: 1 }], addons: [], publicVisible: true, active: true },
]

// ==== Быстрые наборы ====
const kits: CatalogInput['kits'] = [
  {
    id: 'kit-autopilot',
    code: 'K-AUTO',
    name: { uk: 'Налаштування автопілота', ru: 'Настройка автопилота', en: 'Autopilot setup' },
    description: { uk: 'Повний цикл: від приймання до видачі кораблика', ru: 'Полный цикл: от приёмки до выдачи кораблика', en: 'Full cycle: intake to handover' },
    categoryId: 'cat-mech',
    serviceKind: 'repair',
    items: [
      { workId: 'w-receive', qty: 1 },
      { workId: 'w-stock-in', qty: 1 },
      { workId: 'w-prep-test', qty: 1 },
      { workId: 'w-transport-to', qty: 1 },
      { workId: 'w-autopilot', qty: 1 },
      { workId: 'w-test-run', qty: 1 },
      { workId: 'w-dry', qty: 1 },
      { workId: 'w-transport-from', qty: 1 },
      { workId: 'w-pack', qty: 1 },
      { workId: 'w-stock-out', qty: 1 },
    ],
    active: true,
  },
  {
    id: 'kit-servo',
    code: 'K-SERVO',
    name: { uk: 'Заміна сервоприводу', ru: 'Замена сервопривода', en: 'Servo replacement' },
    description: { uk: 'Діагностика, демонтаж, встановлення та калібрування', ru: 'Диагностика, демонтаж, установка и калибровка', en: 'Diagnose, remove, install, calibrate' },
    categoryId: 'cat-mech',
    serviceKind: 'repair',
    seasonMode: 'critical', // не работает управление — без наценки высокого сезона
    items: [
      { workId: 'w-diagnose', qty: 1 },
      { workId: 'w-servo-remove', qty: 1 },
      { workId: 'w-servo-install', qty: 1 },
      { workId: 'w-servo-calibrate', qty: 1 },
    ],
    active: true,
  },
  {
    id: 'kit-engine',
    code: 'K-ENGINE',
    name: { uk: 'ТО двигуна', ru: 'ТО двигателя', en: 'Engine service' },
    description: { uk: 'Повний цикл ТО двигуна з виїздом на воду', ru: 'Полный цикл ТО двигателя с выездом на воду', en: 'Full engine service with water test' },
    categoryId: 'cat-mech',
    serviceKind: 'repair',
    seasonMode: 'critical', // не работает мотор — без наценки высокого сезона
    items: [
      { workId: 'w-receive', qty: 1 },
      { workId: 'w-stock-in', qty: 1 },
      { workId: 'w-prep-test', qty: 1 },
      { workId: 'w-transport-to', qty: 1 },
      { workId: 'w-diagnose', qty: 1 },
      { workId: 'w-engine-service', qty: 1 },
      { workId: 'w-test-run', qty: 1 },
      { workId: 'w-dry', qty: 1 },
      { workId: 'w-transport-from', qty: 1 },
      { workId: 'w-pack', qty: 1 },
      { workId: 'w-stock-out', qty: 1 },
    ],
    active: true,
  },
  {
    id: 'kit-echo',
    code: 'K-ECHO',
    name: { uk: 'Встановлення ехолота', ru: 'Установка эхолота', en: 'Fish finder installation' },
    description: { uk: 'Монтаж і налаштування ехолота (додаткове обладнання)', ru: 'Монтаж и настройка эхолота (доп. оборудование)', en: 'Fish finder mount and setup (add-on)' },
    categoryId: 'cat-mech',
    serviceKind: 'upgrade',
    seasonMode: 'benefit', // льготный: снимает наценку со всей сметы
    items: [
      { workId: 'w-receive', qty: 1 },
      { workId: 'w-stock-in', qty: 1 },
      { workId: 'w-prep-test', qty: 1 },
      { workId: 'w-transport-to', qty: 1 },
      { workId: 'w-echo-install', qty: 1 },
      { workId: 'w-test-run', qty: 1 },
      { workId: 'w-dry', qty: 1 },
      { workId: 'w-transport-from', qty: 1 },
      { workId: 'w-pack', qty: 1 },
      { workId: 'w-stock-out', qty: 1 },
    ],
    active: true,
  },
  {
    id: 'kit-fw-update',
    code: 'K-FWUP',
    name: { uk: 'Оновлення ПЗ автопілота', ru: 'Обновление ПО автопилота', en: 'Autopilot firmware update' },
    description: { uk: 'Оновлення прошивки автопілота (без виїзду на воду)', ru: 'Обновление прошивки автопилота (без выезда на воду)', en: 'Autopilot firmware update (bench)' },
    categoryId: 'cat-mech',
    serviceKind: 'upgrade',
    items: [
      { workId: 'w-receive', qty: 1 },
      { workId: 'w-stock-in', qty: 1 },
      { workId: 'w-fw-update', qty: 1 },
      { workId: 'w-pack', qty: 1 },
      { workId: 'w-stock-out', qty: 1 },
    ],
    active: true,
  },
]

export const priceListSeed: CatalogInput = { categories, materials, addons, works, kits }

// ==== Настройки ценообразования по умолчанию ====
// Расшифровка ставки нормо-часа. Значения по налогам Украины 2025:
//   НДФЛ 18% + військовий збір 5% = 23% (утримання із зарплати);
//   ЄСВ 22% (нарахування роботодавця на ФОП);
//   єдиний податок 5% + військовий збір 1% = 6% (ФОП 3 група, з обороту).
// База зарплати: 45 000 грн/міс «на руки» ÷ 160 робочих годин = 281,25 грн/год.
// Порядок нарахування:
//   • ПДФО+ВЗ 23% від чистої ЗП → «повна зарплата» (чиста + ПДФО+ВЗ);
//   • ЄСВ 22% нараховується НА повну зарплату (чиста + ПДФО+ВЗ) — тому base='cumulative';
//   • +20% на відпустки/лікарняні/навчання та +простій — витрати роботодавця понад це;
//   • адміністрування, норма прибутку, єдиний податок ФОП.
// Простій: майстер не робот — між завданнями є паузи, а ЗП платиться, тому закладаємо
// відсоток простою в ставку. Значення (у т.ч. % простою) редагуються адміністратором.
const defaultRateBreakdown = {
  components: [
    { id: 'rc-salary', name: { uk: 'Зарплата майстру «на руки» (45 000 грн/міс ÷ 160 год)', ru: 'Зарплата мастеру «на руки» (45 000 грн/мес ÷ 160 ч)', en: 'Master net salary (45,000 UAH/mo ÷ 160 h)' }, kind: 'amount' as const, value: 281.25 },
    { id: 'rc-ndfl', name: { uk: 'ПДФО + військовий збір (23% від чистої ЗП)', ru: 'НДФЛ + военный сбор (23% от чистой ЗП)', en: 'Income tax + military levy (23% of net)' }, kind: 'percent' as const, value: 23, base: 'salary' as const },
    { id: 'rc-esv', name: { uk: 'ЄСВ 22% (на повну зарплату = чиста + ПДФО+ВЗ)', ru: 'ЕСВ 22% (на полную зарплату = чистая + НДФЛ+ВС)', en: 'Social contribution 22% (on gross salary)' }, kind: 'percent' as const, value: 22, base: 'cumulative' as const },
    { id: 'rc-vacation', name: { uk: '+20% на відпустки, лікарняні, навчання', ru: '+20% на отпускные, больничные, обучение', en: '+20% leave, sick pay, training' }, kind: 'percent' as const, value: 20, base: 'salary' as const },
    { id: 'rc-idle', name: { uk: 'Простій (паузи між завданнями)', ru: 'Простой (паузы между заданиями)', en: 'Idle time between tasks' }, kind: 'percent' as const, value: 15, base: 'salary' as const },
    { id: 'rc-admin', name: { uk: 'Адміністрування', ru: 'Администрирование', en: 'Administration' }, kind: 'percent' as const, value: 15, base: 'cumulative' as const },
    { id: 'rc-profit', name: { uk: 'Норма прибутку', ru: 'Норма прибыли', en: 'Profit margin' }, kind: 'percent' as const, value: 25, base: 'cumulative' as const },
    { id: 'rc-fop', name: { uk: 'Єдиний податок + військовий збір ФОП', ru: 'Единый налог + военный сбор ФОП', en: 'Flat tax + levy (sole trader)' }, kind: 'percent' as const, value: 6, base: 'revenue' as const },
  ],
}

export const defaultPricingSettings: PricingSettings = {
  currency: 'UAH',
  laborRatePerHour: 222, // fallback; фактически вычисляется из rateBreakdown
  rateBreakdown: defaultRateBreakdown,
  seasons: [
    { id: 'season-winter', name: { uk: 'Зима (низький сезон)', ru: 'Зима (низкий сезон)', en: 'Winter (low season)' }, coefficient: 0.75, months: [12, 1, 2] },
    { id: 'season-normal', name: { uk: 'Звичайний сезон', ru: 'Обычный сезон', en: 'Regular season' }, coefficient: 1, months: [3, 4, 9, 10, 11] },
    { id: 'season-high', name: { uk: 'Високий сезон', ru: 'Высокий сезон', en: 'High season' }, coefficient: 1.5, months: [5, 6, 7, 8] },
  ],
  activeSeasonOverride: null,
  // Общие работы, сопутствующие любому ремонту (добавляются в каждую смету, если ещё не включены):
  // приёмка, подготовка к тесту, тест на воде, сушка, упаковка. Редактируется администратором.
  commonWorkCodes: ['W-RCV', 'W-PREP', 'W-TEST', 'W-DRY', 'W-PACK'],
  updatedAt: new Date('2026-01-01').toISOString(),
  updatedBy: null,
}
