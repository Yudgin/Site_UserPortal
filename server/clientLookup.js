// Пошук клієнта у Firestore за телефоном: заявки, профіль, замовлення корабликів. Спільний для приймача Binotel
// (binotelWebhook.js) і голосового шлюзу (voice-gateway/brain/lookup.mjs) — запити мають лишатися однаковими.
// Лише читання; бюджет часу і обробку помилок задає той, хто викликає.

export const SR_SCAN_LIMIT = 100 // заявок одного телефону (у найактивнішого номера вже 24; без orderBy — беремо з запасом)
export const ORDER_SCAN_LIMIT = 10 // замовлень корабликів одного телефону

// Варіанти запису одного номера (+380…, 380…, 0…): заявки з вхідних менеджера і ручні замовлення корабликів
// зберігають телефон як є. Один запит 'in' на колекцію, як у мобільному застосунку.
export const phoneVariants = (e164) => [e164, e164.slice(1), '0' + e164.slice(4)]

// adminDb — Firestore firebase-admin (або підробка в тестах). Повертає async (phoneE164) => {requests, profile, orders}.
// phoneE164 — канонічний +380XXXXXXXXX (normPhone із phone.js).
export function makeClientLookup(adminDb) {
  return async (phone) => {
    const digits = phone.replace(/\D/g, '')
    const variants = phoneVariants(phone)
    const [srSnap, profSnap, orderSnap] = await Promise.all([
      adminDb.collection('serviceRequests').where('clientPhone', 'in', variants).limit(SR_SCAN_LIMIT).get(),
      adminDb.collection('clientProfiles').doc(digits).get(),
      adminDb.collection('boatOrders').where('clientPhone', 'in', variants).limit(ORDER_SCAN_LIMIT).get(),
    ])
    return {
      requests: srSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      profile: profSnap.exists ? profSnap.data() : null,
      orders: orderSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    }
  }
}

export default makeClientLookup
