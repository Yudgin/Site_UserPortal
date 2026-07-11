// Шаблон посылки Новой Почты — пресет параметров для создания ТТН (следующая фаза). Привязан к
// сервисному центру и ФОП-отправителю. Размеры: великий (~29 кг об.вес) / малий (~10 кг об.вес).
// В 1С при создании посылки менялся только № ремонта в описании — здесь description это шаблон.
export type ParcelSize = 'big' | 'small'
export type ShipScenario = 'incoming' | 'return' | 'purchase' | 'parts'
export type PayerType = 'recipient' | 'sender' // кто платит доставку по умолчанию

export interface NpTemplate {
  id: string
  name: string
  serviceCenterId: string // от/к какому сервисному центру
  fopId?: string // ФОП-отправитель (его ключ НП и реквизиты)
  size: ParcelSize
  scenario: ShipScenario
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
