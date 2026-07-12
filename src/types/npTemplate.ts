// Шаблон посылки Новой Почты — пресет параметров для создания ТТН (следующая фаза). Привязан к
// сервисному центру и ФОП-отправителю. Размеры: великий (~29 кг об.вес) / малий (~10 кг об.вес).
// В 1С при создании посылки менялся только № ремонта в описании — здесь description это шаблон.
export type ParcelSize = 'big' | 'small'
export type ShipScenario = 'incoming' | 'return' | 'purchase' | 'parts'
export type PayerType = 'recipient' | 'sender' // кто платит доставку по умолчанию
// Тип доставки НП: отделение↔отделение и варианты адресной (курьерской) доставки.
export type NpServiceType = 'WarehouseWarehouse' | 'WarehouseDoors' | 'DoorsWarehouse' | 'DoorsDoors'
// Кто на этой стороне ТТН: «сервіс» (фикс. адрес в шаблоне) или «клієнт заявки» (подставляется).
export type NpPartyTarget = 'service' | 'client'
export type NpRecipientTarget = 'service' | 'client' | 'fixed'

// Адрес отделения НП (для фикс. сторон в шаблоне).
export interface NpAddress {
  cityRef?: string
  cityName?: string
  warehouseRef?: string
  warehouseName?: string
}

export interface NpTemplate {
  id: string
  name: string
  serviceCenterId: string // от/к какому сервисному центру
  fopId?: string // ФОП-отправитель (его ключ НП, counterparty и контакт)
  size: ParcelSize
  scenario: ShipScenario
  serviceType?: NpServiceType // тип доставки (по умолчанию WarehouseWarehouse)
  // Стороны отправки:
  senderTarget?: NpPartyTarget // отправитель: сервис (фикс) или клиент заявки
  sender?: NpAddress // адрес отправителя, когда senderTarget = 'service'
  recipientTarget?: NpRecipientTarget // получатель: сервис / клиент заявки / фиксированный
  recipient?: NpAddress // адрес получателя, когда recipientTarget = 'service' | 'fixed'
  recipientName?: string // ФИО получателя (для recipientTarget = 'fixed')
  recipientPhone?: string
  weight: number // фактический вес, кг
  volumeGeneral?: number // объём, м³ (НП считает объёмный вес); опционально
  length?: number // габариты, см (альтернатива volumeGeneral)
  width?: number
  height?: number
  seatsAmount: number // количество мест
  cargoType?: string // тип груза (Parcel/Cargo)
  description: string // шаблон описания (№ ремонта подставится при создании ТТН)
  payerType: PayerType // плательщик доставки по умолчанию
  cod: boolean // наложенный платёж (BackwardDelivery Money) по умолчанию
  active: boolean
  createdAt: string
  updatedAt: string
}

export const SERVICE_TYPE_LABELS: Record<NpServiceType, string> = {
  WarehouseWarehouse: 'Відділення → Відділення',
  WarehouseDoors: 'Відділення → Адреса',
  DoorsWarehouse: 'Адреса → Відділення',
  DoorsDoors: 'Адреса → Адреса',
}

export const SIZE_LABELS: Record<ParcelSize, string> = {
  big: 'Великий (~29 кг об.)',
  small: 'Малий (~10 кг об.)',
}

export const SCENARIO_LABELS: Record<ShipScenario, string> = {
  incoming: 'Приймання кораблика (клієнт → нам)',
  return: 'Повернення клієнту',
  purchase: 'Новий кораблик (продаж)',
  parts: 'Дрібні замовлення / комплектуючі',
}

export const PAYER_LABELS: Record<PayerType, string> = {
  recipient: 'Отримувач',
  sender: 'Відправник',
}
