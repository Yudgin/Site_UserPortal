#!/usr/bin/env node
// Пилот «соединение → запись → расшифровка → резюме» на Binotel API 4.0.
//
// Что делает:
//   1) Инициирует звонок: АТС сначала набирает СОТРУДНИКА, после ответа — КЛИЕНТА.
//      --method ext2ext (по умолчанию): calls/external-number-to-external-number
//          {externalNumber1: мобильный сотрудника, externalNumber2: клиент, pbxNumber: линия компании}
//      --method int2ext: calls/internal-number-to-external-number
//          {internalNumber: внутренняя линия сотрудника (90x/91x), externalNumber: клиент, pbxNumber}
//   2) Опрашивает stats/call-details по generalCallID (раз в 6 с, лимит Binotel — 1 запрос в 3 с),
//      пока звонок не завершится и запись не станет recordingStatus=uploaded.
//   3) Скачивает запись (stats/call-record, ссылка живёт ~1 ч), распознаёт ElevenLabs Scribe v2
//      (стерео → use_multi_channel: канал 0 = сотрудник, канал 1 = клиент), пишет текст по репликам.
//   4) Делает резюме украинской мовой (Anthropic Messages API, по образцу серверного improve-text).
//
// Без флага --go ничего не набирает: печатает, что бы отправил (dry run).
// --from-callid <generalCallID> — пропустить набор, прогнать шаги 2–4 для готового звонка.
// --file <mp3> — только шаги 3–4 для локального файла.
//
// Переменные (server/.env.local основного чекаута или окружение): BINOTEL_KEY, BINOTEL_SECRET,
// ELEVENLABS_API_KEY, ANTHROPIC_API_KEY (без него шаг 4 пропускается). Секреты в код не попадают.
//
// Примеры:
//   node scripts/binotel-call-bridge-test.mjs --employee 0670000255 --client 0675499555 --pbx 0679278039
//   node scripts/binotel-call-bridge-test.mjs --employee 0670000255 --client 0675499555 --pbx 0679278039 --go
//   node scripts/binotel-call-bridge-test.mjs --method int2ext --internal 904 --client 0675499555 --pbx 0679278039 --go
//   node scripts/binotel-call-bridge-test.mjs --from-callid 6925864227
//
// Записи содержат персональные данные: складываются вне репозитория (RECORDINGS_DIR или --out).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// ---------- аргументы ----------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const GO = opt('go', false) === true;
const METHOD = String(opt('method', 'ext2ext')); // ext2ext | int2ext
const EMPLOYEE = opt('employee', null);
const INTERNAL = opt('internal', null);
const CLIENT = opt('client', null);
const PBX = opt('pbx', null);
const LIMIT = Number(opt('limit', 600)); // limitCallTime, с
const FROM_CALLID = opt('from-callid', null);
const LOCAL_FILE = opt('file', null);
const NO_STT = opt('no-stt', false) === true;
const NO_SUMMARY = opt('no-summary', false) === true;
const WAIT_MIN = Number(opt('wait-min', 20));
const OUT_DIR = String(opt('out', process.env.RECORDINGS_DIR || path.join(process.env.TMPDIR || '/tmp', 'runferry-call-recordings')));

// ---------- env ----------
function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
for (const root of [repoRoot, process.env.SITE_MAPPORTAL_ROOT, path.resolve(process.env.HOME || '', 'Documents/GitHub/Site_MapPortal')].filter(Boolean)) {
  loadEnvFile(path.join(root, 'server', '.env.local'));
  loadEnvFile(path.join(root, 'server', '.env'));
}
const { BINOTEL_KEY, BINOTEL_SECRET, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY } = process.env;

const die = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// Национальный формат Binotel: 10 цифр, 0XXXXXXXXX.
const nat = (raw) => {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) return d;
  if (d.length === 12 && d.startsWith('380')) return '0' + d.slice(3);
  if (d.length === 9) return '0' + d;
  return null;
};

// ---------- Binotel API 4.0 ----------
async function binotel(method, body = {}) {
  if (!BINOTEL_KEY || !BINOTEL_SECRET) die('Нет BINOTEL_KEY / BINOTEL_SECRET (server/.env.local)');
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.binotel.com/api/4.0/${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: BINOTEL_KEY, secret: BINOTEL_SECRET, ...body }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`Binotel ${method}: HTTP ${res.status}, не JSON: ${text.slice(0, 300)}`); }
    if (json.status === 'success') return json;
    const m = /after (\d+) sec/.exec(json.message || '');
    if (String(json.code) === '106' && m && attempt < 3) { await sleep((Number(m[1]) + 1) * 1000); continue; }
    const err = new Error(`Binotel ${method}: ${json.status} ${json.code || ''} ${json.message || ''}`.trim());
    err.code = json.code;
    throw err;
  }
}
const first = (callDetails) => (Array.isArray(callDetails) ? callDetails[0] : callDetails && typeof callDetails === 'object' ? Object.values(callDetails)[0] : null);
const FINAL = new Set(['ANSWER', 'TRANSFER', 'BUSY', 'NOANSWER', 'CANCEL', 'CONGESTION', 'CHANUNAVAIL', 'VM', 'VM-SUCCESS']);

// ---------- mp3 header ----------
function inspectMp3(buf) {
  let off = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    off = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  for (let i = off; i < Math.min(buf.length - 4, off + 2_000_000); i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 0x03, layer = (buf[i + 1] >> 1) & 0x03, srIdx = (buf[i + 2] >> 2) & 0x03, chMode = (buf[i + 3] >> 6) & 0x03;
    if (ver === 1 || layer !== 1 || srIdx === 3) continue;
    return { sampleRate: SR[ver][srIdx], channels: chMode === 3 ? 1 : 2 };
  }
  return null;
}

// ---------- ElevenLabs Scribe v2 ----------
async function transcribe(filePath, { multichannel }) {
  if (!ELEVENLABS_API_KEY) die('Нет ELEVENLABS_API_KEY (server/.env.local)');
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'audio/mpeg' }), path.basename(filePath));
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  if (multichannel) { form.append('use_multi_channel', 'true'); form.append('multichannel_output_style', 'combined'); }
  else { form.append('diarize', 'true'); form.append('num_speakers', '2'); }
  const t0 = Date.now();
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ELEVENLABS_API_KEY }, body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  json._elapsedMs = Date.now() - t0;
  return json;
}
function toTurns(result, labels) {
  let words = result.words || [];
  if (Array.isArray(result.transcripts)) {
    words = result.transcripts.flatMap((t, i) => (t.words || []).map((w) => ({ ...w, channel_index: w.channel_index ?? t.channel_index ?? i })));
    words.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }
  const turns = [];
  for (const w of words) {
    if (w.type === 'spacing') continue;
    const raw = w.channel_index != null ? `channel_${w.channel_index}` : (w.speaker_id ?? 'speaker');
    const who = labels[raw] ?? raw;
    const last = turns[turns.length - 1];
    if (last && last.who === who) { last.text += ` ${w.text}`; last.end = w.end ?? last.end; }
    else turns.push({ who, start: w.start ?? 0, end: w.end ?? 0, text: w.text });
  }
  return turns.map((t) => ({ ...t, text: t.text.replace(/\s+([,.!?…:;])/g, '$1').trim() }));
}

// ---------- резюме (Anthropic Messages API, как серверный improve-text) ----------
async function summarize(turns) {
  if (!ANTHROPIC_API_KEY) { console.log('\n(ANTHROPIC_API_KEY нет — резюме пропущено)'); return null; }
  // SDK лежит в server/node_modules (зависимость сервера), поэтому резолвим от server/package.json.
  const { createRequire } = await import('node:module');
  const mod = createRequire(path.join(repoRoot, 'server', 'package.json'))('@anthropic-ai/sdk');
  const Anthropic = mod.default || mod.Anthropic || mod;
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const dialog = turns.map((t) => `[${fmtTime(t.start)}] ${t.who}: ${t.text}`).join('\n');
  const system = [
    'Ти — асистент сервісного центру RunFerry (ремонт прикормочних рибальських корабликів).',
    'Тобі дають розшифровку телефонної розмови майстра сервісу («Співробітник») з клієнтом («Клієнт»).',
    'Розшифровка автоматична: можливі помилки розпізнавання, суржик, російська мова — відновлюй зміст за контекстом.',
    'Напиши стисле резюме УКРАЇНСЬКОЮ мовою для картки заявки. Формат — лише текст без markdown:',
    '1) рядок «Суть:» — 1–3 речення, про що розмова і що з\'ясували;',
    '2) рядок «Домовилися:» — конкретні домовленості (що, хто, коли; суми, строки, адреси, номери — якщо звучали);',
    '3) рядок «Далі:» — наступні кроки для сервісу, або «немає».',
    'Не вигадуй того, чого не було в розмові. Якщо розмова не про ремонт/обслуговування — скажи це одним реченням.',
  ].join('\n');
  const t0 = Date.now();
  const message = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: `Розшифровка розмови:\n"""\n${dialog}\n"""` }],
  });
  if (message.stop_reason === 'refusal') return { text: '(модель відмовилася)', usage: message.usage, elapsedMs: Date.now() - t0 };
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text, usage: message.usage, elapsedMs: Date.now() - t0, model: message.model };
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let filePath = LOCAL_FILE ? path.resolve(String(LOCAL_FILE)) : null;
  let generalCallID = FROM_CALLID ? String(FROM_CALLID) : null;
  const timeline = { originateAt: null, finishedAt: null, uploadedAt: null, downloadedAt: null, transcribedAt: null, summarizedAt: null };

  // 1) соединение
  if (!filePath && !generalCallID) {
    const client = nat(CLIENT);
    const pbx = nat(PBX);
    if (!client) die('--client: номер клиента в формате 0XXXXXXXXX или +380…');
    if (!pbx) die('--pbx: номер линии компании (pbxNumber), например 0679278039');
    let method, body;
    if (METHOD === 'int2ext') {
      if (!INTERNAL) die('--internal: внутренняя линия сотрудника (например 904)');
      method = 'calls/internal-number-to-external-number';
      body = { internalNumber: String(INTERNAL), externalNumber: client, pbxNumber: pbx, limitCallTime: LIMIT, playbackWaiting: 'TRUE', callTimeToExt: 40 };
    } else {
      const emp = nat(EMPLOYEE);
      if (!emp) die('--employee: мобильный сотрудника в формате 0XXXXXXXXX или +380…');
      method = 'calls/external-number-to-external-number';
      body = { externalNumber1: emp, externalNumber2: client, pbxNumber: pbx, limitCallTime: LIMIT, playbackWaiting: 'TRUE' };
    }
    console.log(`Метод: ${method}\nТело (без key/secret): ${JSON.stringify(body)}`);
    if (!GO) { console.log('\nDry run: добавьте --go, чтобы реально позвонить.'); return; }
    timeline.originateAt = Date.now();
    const r = await binotel(method, body);
    generalCallID = String(r.generalCallID || r.callID || '');
    console.log(`\nОтвет Binotel: ${JSON.stringify(r)}`);
    if (!generalCallID) die('В ответе нет generalCallID');
  }

  // 2) ждём завершения и запись
  let call = null;
  if (!filePath) {
    console.log(`\nЖду завершения звонка generalCallID=${generalCallID} (до ${WAIT_MIN} мин)…`);
    const deadline = Date.now() + WAIT_MIN * 60_000;
    let lastLine = '';
    while (Date.now() < deadline) {
      await sleep(6000);
      let det;
      try { det = await binotel('stats/call-details', { generalCallID }); }
      catch (e) { console.log(`  call-details: ${e.message}`); continue; }
      call = first(det.callDetails);
      if (!call) { console.log('  (звонка пока нет в статистике)'); continue; }
      const line = `  ${new Date().toISOString().slice(11, 19)} disposition=${call.disposition} billsec=${call.billsec} waitsec=${call.waitsec} recording=${call.recordingStatus || '-'} int=${call.internalNumber || '-'} type=${call.callType}`;
      if (line.slice(10) !== lastLine.slice(10)) console.log(line);
      lastLine = line;
      if (FINAL.has(String(call.disposition)) && !timeline.finishedAt) timeline.finishedAt = Date.now();
      if (FINAL.has(String(call.disposition)) && String(call.disposition) !== 'ANSWER' && String(call.disposition) !== 'TRANSFER') {
        console.log(`\nЗвонок завершился без разговора: ${call.disposition}. Записи не будет.`);
        console.log(JSON.stringify(call, null, 1));
        return;
      }
      if (call.recordingStatus === 'uploaded') { timeline.uploadedAt = Date.now(); break; }
    }
    if (!call || call.recordingStatus !== 'uploaded') die('Запись не появилась за отведённое время');
    console.log('\nКарточка звонка:\n' + JSON.stringify(call, null, 1));
    fs.writeFileSync(path.join(OUT_DIR, `binotel-${generalCallID}.call.json`), JSON.stringify(call, null, 2));

    await sleep(3500);
    const rec = await binotel('stats/call-record', { generalCallID });
    const url = rec.url || rec.callRecord?.url || rec.link;
    if (!url) die(`stats/call-record без url: ${JSON.stringify(rec).slice(0, 300)}`);
    const res = await fetch(url);
    if (!res.ok) die(`Скачивание записи: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    filePath = path.join(OUT_DIR, `binotel-${generalCallID}.mp3`);
    fs.writeFileSync(filePath, buf);
    timeline.downloadedAt = Date.now();
    console.log(`Запись сохранена: ${filePath} (${(buf.length / 1024).toFixed(0)} КБ, content-type ${res.headers.get('content-type')})`);
  }

  // 3) расшифровка
  const info = inspectMp3(fs.readFileSync(filePath));
  console.log(`Формат: ${info ? `${info.channels === 2 ? 'СТЕРЕО' : 'МОНО'}, ${info.sampleRate} Гц` : 'не распознан'}`);
  if (NO_STT) return;
  const multichannel = info?.channels === 2;
  console.log(`\nElevenLabs Scribe v2 (${multichannel ? 'multichannel' : 'diarize'})…`);
  const result = await transcribe(filePath, { multichannel });
  timeline.transcribedAt = Date.now();
  const labels = multichannel ? { channel_0: 'Співробітник', channel_1: 'Клієнт' } : { speaker_0: 'Спікер 0', speaker_1: 'Спікер 1' };
  const turns = toTurns(result, labels);
  const base = filePath.replace(/\.[^.]+$/, '');
  fs.writeFileSync(base + '.scribe.json', JSON.stringify(result, null, 2));
  const lines = turns.map((t) => `[${fmtTime(t.start)}] ${t.who}: ${t.text}`);
  fs.writeFileSync(base + '.transcript.txt', lines.join('\n') + '\n');
  const lang = result.language_code ?? result.transcripts?.[0]?.language_code ?? '?';
  console.log(`Язык: ${lang}, длительность: ${result.audio_duration_secs ?? result.transcripts?.[0]?.audio_duration_secs ?? '?'} с, время STT: ${(result._elapsedMs / 1000).toFixed(1)} с, реплик: ${turns.length}\n`);
  console.log(lines.join('\n'));

  // 4) резюме
  if (!NO_SUMMARY && turns.length) {
    console.log('\nРезюме (Anthropic)…');
    const s = await summarize(turns);
    if (s) {
      timeline.summarizedAt = Date.now();
      fs.writeFileSync(base + '.summary.txt', s.text + '\n');
      console.log(`\n${s.text}\n\n(модель ${s.model}, ${(s.elapsedMs / 1000).toFixed(1)} с, in=${s.usage?.input_tokens} out=${s.usage?.output_tokens})`);
    }
  }

  // хронометраж
  const t = timeline;
  const d = (a, b) => (a && b ? `${((b - a) / 1000).toFixed(0)} с` : '-');
  console.log(`\nХронометраж: набор→завершение ${d(t.originateAt, t.finishedAt)}; завершение→запись uploaded ${d(t.finishedAt, t.uploadedAt)}; скачивание ${d(t.uploadedAt, t.downloadedAt)}; STT ${d(t.downloadedAt, t.transcribedAt)}; резюме ${d(t.transcribedAt, t.summarizedAt)}`);
  console.log(`Файлы: ${filePath}, ${base}.transcript.txt${fs.existsSync(base + '.summary.txt') ? `, ${base}.summary.txt` : ''}`);
})().catch((e) => die(e.stack || e.message));
