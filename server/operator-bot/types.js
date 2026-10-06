// Доменные типы — общий контракт между всеми модулями приложения.
export const ALL_EVENT_TYPES = ['call.incoming', 'call.completed', 'test'];
/** Нормализация телефона к виду 380XXXXXXXXX (только цифры) */
export function normalizePhone(raw) {
    const digits = raw.replace(/\D+/g, '');
    if (digits.length === 10 && digits.startsWith('0'))
        return '38' + digits;
    return digits;
}
