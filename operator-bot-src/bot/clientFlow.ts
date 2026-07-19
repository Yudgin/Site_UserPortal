import { InlineKeyboard, Keyboard } from 'grammy';
import { LANGUAGES, t, type Lang } from './i18n.js';

export function clientWelcome(lang: Lang): string {
  return t(lang, 'welcome');
}

/** Reply-клавиатура с запросом контакта (Telegram пришлёт подтверждённый номер). */
export function buildSharePhoneKeyboard(lang: Lang): Keyboard {
  return new Keyboard().requestContact(t(lang, 'btn_share_phone')).resized().oneTime();
}

export function clientMenuText(lang: Lang, name?: string): string {
  return t(lang, 'phone_confirmed', { name: name ? `, ${name}` : '' });
}

/** Меню клиента: «Мои ремонты» + «Язык». */
export function buildClientMenuKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn_my_repairs'), 'my:repairs')
    .row()
    .text(t(lang, 'btn_language'), 'lang:pick');
}

/** Клавиатура выбора языка: по кнопке на язык, callback lang:set:<code>. */
export function buildLanguageKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  LANGUAGES.forEach((language, index) => {
    keyboard.text(`${language.flag} ${language.name}`, `lang:set:${language.code}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard;
}
