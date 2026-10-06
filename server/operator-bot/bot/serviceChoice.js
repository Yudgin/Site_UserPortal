import { InlineKeyboard } from 'grammy';
function pickString(item, keys) {
    for (const key of keys) {
        const value = item[key];
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
        if (typeof value === 'number')
            return String(value);
    }
    return null;
}
/** Превращает ответ 1С repair_ServoceList в список вариантов для клавиатуры. */
export function extractServiceOptions(items) {
    const options = [];
    for (const item of items) {
        const id = pickString(item, ['ID', 'Id', 'id', 'Code', 'Код']);
        if (id === null || !/^[\w-]+$/.test(id))
            continue; // id попадает в callback_data
        const name = pickString(item, ['Name', 'name', 'Наименование']) ?? id;
        options.push({ id, name });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
// Telegram не принимает больше 100 кнопок в inline-клавиатуре. Оставляем место
// под кнопку отмены, поэтому сервисов показываем не больше 90.
export const MAX_SERVICE_BUTTONS = 90;
/** Клавиатура выбора сервис-центра: callback_data вида s:<id>:<phone>. */
export function buildServiceChoiceKeyboard(options, phone) {
    const keyboard = new InlineKeyboard();
    options.slice(0, MAX_SERVICE_BUTTONS).forEach((option, index) => {
        keyboard.text(option.name, `s:${option.id}:${phone}`);
        if (index % 2 === 1)
            keyboard.row();
    });
    // Кнопка отмены оформления — отдельным рядом. id «cancel» обрабатывается особо.
    keyboard.row().text('✖️ Отмена', `s:cancel:${phone}`);
    return keyboard;
}
