import { InlineKeyboard, Keyboard } from 'grammy';
import { LANGUAGES, t } from './i18n.js';
export function clientWelcome(lang) {
    return t(lang, 'welcome');
}
/** Reply-клавиатура с запросом контакта (Telegram пришлёт подтверждённый номер). */
export function buildSharePhoneKeyboard(lang) {
    return new Keyboard().requestContact(t(lang, 'btn_share_phone')).resized().oneTime();
}
export function clientMenuText(lang, name) {
    return t(lang, 'phone_confirmed', { name: name ? `, ${name}` : '' });
}
/** Меню клиента: «Мои ремонты» + «Язык». */
export function buildClientMenuKeyboard(lang) {
    return new InlineKeyboard()
        .text(t(lang, 'btn_my_repairs'), 'my:repairs')
        .row()
        .text(t(lang, 'btn_language'), 'lang:pick');
}
/** Клавиатура выбора языка: по кнопке на язык, callback lang:set:<code>. */
export function buildLanguageKeyboard() {
    const keyboard = new InlineKeyboard();
    LANGUAGES.forEach((language, index) => {
        keyboard.text(`${language.flag} ${language.name}`, `lang:set:${language.code}`);
        if (index % 2 === 1)
            keyboard.row();
    });
    return keyboard;
}
