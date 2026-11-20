#!/usr/bin/env node
// Voice prompts for Binotel inbound-call scenarios (Ukrainian), voiced with ElevenLabs TTS.
//
// For every voice × prompt × length variant the script:
//   1. calls ElevenLabs text-to-speech (raw PCM 24 kHz, cached outside the repo);
//   2. with ffmpeg trims silence, normalises loudness and writes
//        wav-8k/<voice>/<id>[-short].wav  — 8 kHz, 16-bit, mono PCM (what the PBX plays)
//        mp3/<voice>/<id>[-short].mp3     — 44.1 kHz mono MP3 128 kbit/s (spare copy)
//   3. optionally (--check) transcribes the 8 kHz file with ElevenLabs Scribe and reports the
//      word error rate against the script text — a substitute for listening, catches dropped or
//      garbled words (not wrong stress);
//   4. builds samples/<voice>-phone.mp3 — all full-length prompts of one voice at phone quality,
//      so the owner can pick a voice by listening to one file.
// A manifest.json with texts, durations and check results is written next to the audio.
//
// The API key comes only from the environment (ELEVENLABS_API_KEY), e.g.:
//   node --env-file=server/.env.local scripts/binotel-voice-prompts.mjs \
//     --out ../runferry-briefs/telephony/voice-prompts --check
// Options:
//   --out <dir>        output folder (required)
//   --voices a,b       voice keys from VOICES (default: all)
//   --only id1,id2     prompt ids (default: all)
//   --variants full,short
//   --model <id>       ElevenLabs model (default eleven_multilingual_v2)
//   --check            transcribe each 8 kHz file and store WER in the manifest
//   --retries <n>      with --check: extra takes (other seeds) while WER > 0, best kept (default 2)
//   --force            regenerate even if the text/settings did not change
//   --no-samples       skip samples/<voice>-phone.mp3
//   --cache <dir>      raw TTS cache (default: <os tmp>/binotel-voice-prompts-cache)
//   --list             print prompts and exit (no API calls)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const API = 'https://api.elevenlabs.io';

// Ukrainian voices already present in the Runferry ElevenLabs account ("My voices").
const VOICES = {
  mila: { id: 'zDLnIEu0UzYpFE8fq9aq', name: 'Mila G', gender: 'жіночий', note: 'спокійний, діловий (audiobook narrator)' },
  oleksii: { id: 'MajbwhPMg2mRJJCesMAF', name: 'Oleksii Safin', gender: 'чоловічий', note: 'дружній, середній тембр' },
  roman: { id: 'YNU4vLsch5CerDqxgcFS', name: 'Roman', gender: 'чоловічий', note: 'низький, стриманий, розмовний' },
};

// "‖" marks a pause for the narrator: SSML break for models that support it, an ellipsis otherwise.
// Texts are the client-facing scripts (Ukrainian); keep them in sync with prompts.md in runferry-briefs.
const PROMPTS = [
  {
    id: '00-recording-notice',
    title: 'Попередження про запис розмови (першим у кожному сценарії)',
    full: 'Зверніть увагу: ми записуємо розмову, щоб контролювати якість обслуговування.',
    short: 'Розмова записується.',
  },
  {
    id: '01-client-no-request',
    title: 'Відомий клієнт без відкритих заявок, робочий час',
    full: 'Вітаємо! Раді чути власника кораблика Runferry. ‖ Залишайтеся, будь ласка, на лінії — з’єднуємо вас з оператором.',
    short: 'Вітаємо! Раді вашому дзвінку. З’єднуємо вас з оператором.',
  },
  {
    id: '02-request-open-workhours',
    title: 'Клієнт з відкритою заявкою, робочий час',
    full:
      'Вітаємо! Наша система бачить, що за вашим номером телефону відкрита заявка на обслуговування. ‖ ' +
      'Якщо ви телефонуєте щодо цієї заявки, скористайтеся, будь ласка, посиланням з SMS, яке ми надіслали вам під час її створення. ' +
      'Там можна написати нам і стежити за станом заявки. ‖ ' +
      'Якщо у вас інше питання, залишайтеся на лінії — з’єднуємо вас з оператором.',
    short:
      'Вітаємо! За вашим номером є відкрита заявка на обслуговування. ' +
      'Щодо неї пишіть, будь ласка, за посиланням з SMS. ‖ З іншого питання — залишайтеся на лінії.',
  },
  {
    id: '03-request-open-offhours',
    title: 'Клієнт з відкритою заявкою, неробочий час',
    full:
      'Вітаємо! Наша система бачить, що за вашим номером телефону відкрита заявка на обслуговування. ‖ ' +
      'Якщо ви телефонуєте щодо цієї заявки, скористайтеся, будь ласка, посиланням з SMS, яке ми надіслали вам під час її створення: ' +
      'там можна залишити нам повідомлення в будь-який час. ‖ ' +
      'Зараз неробочий час. З інших питань зателефонуйте нам, будь ласка, з понеділка до п’ятниці, з дев’ятої до вісімнадцятої. ‖ ' +
      'Якщо ваше питання термінове, залишайтеся на лінії.',
    short:
      'Вітаємо! За вашим номером є відкрита заявка — щодо неї пишіть, будь ласка, за посиланням з SMS. ‖ ' +
      'Зараз неробочий час: ми працюємо з понеділка до п’ятниці, з дев’ятої до вісімнадцятої. ‖ ' +
      'Якщо питання термінове, залишайтеся на лінії.',
  },
  {
    id: '04-greeting-unknown',
    title: 'Невідомий номер, робочий час',
    full: 'Вітаємо! Ви зателефонували до Runferry. ‖ Залишайтеся, будь ласка, на лінії — з’єднуємо вас з оператором.',
    short: 'Вітаємо! Це Runferry. З’єднуємо вас з оператором.',
  },
  {
    id: '05-hold',
    title: 'Очікування в черзі (повтор між музикою)',
    full:
      'Дякуємо за очікування. Усі оператори зараз розмовляють з іншими клієнтами. ‖ ' +
      'Будь ласка, залишайтеся на лінії — ми відповімо, щойно оператор звільниться.',
    short: 'Дякуємо за очікування. Залишайтеся, будь ласка, на лінії.',
  },
  {
    id: '06-offhours-general',
    title: 'Неробочий час, клієнт без відкритої заявки або невідомий номер → голосова пошта',
    full:
      'Вітаємо! Ви зателефонували до Runferry. ' +
      'Зараз неробочий час: ми працюємо з понеділка до п’ятниці, з дев’ятої до вісімнадцятої. ‖ ' +
      'Залиште, будь ласка, повідомлення після звукового сигналу: назвіть своє ім’я та коротко опишіть питання. ' +
      'Ми передзвонимо вам у робочий час.',
    short:
      'Вітаємо! Зараз неробочий час. Ми працюємо з понеділка до п’ятниці, з дев’ятої до вісімнадцятої. ‖ ' +
      'Залиште повідомлення після сигналу — ми передзвонимо.',
  },
  {
    id: '07-voicemail-no-answer',
    title: 'Ніхто не відповів (після очікування) → голосова пошта',
    full:
      'На жаль, зараз ніхто не може відповісти. ‖ ' +
      'Залиште, будь ласка, повідомлення після звукового сигналу: назвіть своє ім’я та коротко опишіть питання. ' +
      'Ми передзвонимо вам якнайшвидше.',
    short: 'Зараз ніхто не може відповісти. Залиште повідомлення після сигналу — ми передзвонимо.',
  },
];

const SSML_BREAK_MODELS = new Set(['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']);

function ttsText(text, model) {
  const pause = SSML_BREAK_MODELS.has(model) ? ' <break time="0.6s" /> ' : '… ';
  return text.replace(/\s*‖\s*/g, pause).replace(/\s{2,}/g, ' ').trim();
}

function voiceSettings(model) {
  // v3/v4 accept only discrete stability values (0, 0.5, 1); speed is ignored there.
  if (/^eleven_v[34]/.test(model)) return { stability: 0.5, similarity_boost: 0.8, style: 0, use_speaker_boost: true };
  return { stability: 0.55, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1.0 };
}

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`))));
  });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function apiError(res) {
  const body = await res.text();
  return new Error(`ElevenLabs ${res.status}: ${body.slice(0, 400)}`);
}

async function synthesize({ key, voiceId, model, text, seed }) {
  const body = {
    text,
    model_id: model,
    voice_settings: voiceSettings(model),
    apply_text_normalization: 'auto',
    language_code: 'uk',
    seed,
  };
  const call = (b) =>
    fetch(`${API}/v1/text-to-speech/${voiceId}?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/pcm' },
      body: JSON.stringify(b),
    });
  let res = await call(body);
  if (res.status === 400) {
    // Some models reject language_code; retry once without it.
    const err = await res.text();
    if (/language/i.test(err)) {
      delete body.language_code;
      res = await call(body);
    } else {
      throw new Error(`ElevenLabs 400: ${err.slice(0, 400)}`);
    }
  }
  if (!res.ok) throw await apiError(res);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribe({ key, file }) {
  const audio = await fs.readFile(file);
  for (const model of ['scribe_v2', 'scribe_v1']) {
    const form = new FormData();
    form.append('model_id', model);
    form.append('language_code', 'uk');
    form.append('tag_audio_events', 'false');
    form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(file));
    const res = await fetch(`${API}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body: form });
    if (res.ok) return { model, text: (await res.json()).text || '' };
    const err = await apiError(res);
    if (model === 'scribe_v2' && res.status >= 400 && res.status < 500) continue;
    throw err;
  }
  return { model: null, text: '' };
}

// Word-level comparison of the script and the transcript (JS \\b is ASCII-only, so compare whole tokens).
function canonical(w) {
  if (/^(sms|смс|есемес\S*|ес-ем-ес\S*)$/.test(w)) return 'sms';
  if (/^(runferry|ранфер+[іи])$/.test(w)) return 'runferry';
  if (w === '9') return 'дев’ятої';
  if (w === '18') return 'вісімнадцятої';
  return w;
}

function words(text) {
  return text
    .toLowerCase()
    .replace(/‖/g, ' ')
    .replace(/['`ʼ‘]/g, '’')
    .replace(/(\d{1,2}):00/g, '$1')
    .replace(/[.,:;!?—–«»"()…]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(canonical);
}

function wordErrorRate(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length][h.length] / r.length : 0;
}

async function convert(rawFile, wavFile, mp3File) {
  // Trim leading/trailing silence, normalise loudness, then 250 ms lead-in and 400 ms tail
  // so the PBX does not clip the first syllable.
  const common =
    'highpass=f=70,' +
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,' +
    'areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,' +
    'loudnorm=I=-19:TP=-3:LRA=11,adelay=250,apad=pad_dur=0.4';
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', rawFile,
    '-filter_complex', `[0:a]${common},asplit=2[a][b];[a]lowpass=f=3600,aresample=8000:filter_size=128:cutoff=0.95[w];[b]aresample=44100:filter_size=128:cutoff=0.95[m]`,
    '-map', '[w]', '-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1', wavFile,
    '-map', '[m]', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '1', mp3File,
  ]);
}

async function duration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Math.round(parseFloat(out) * 10) / 10;
}

async function buildSample(files, outFile) {
  // One phone-quality file per voice: prompts separated by 1.2 s of silence.
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const f of files) args.push('-i', f);
  const parts = files.map((_, i) => `[${i}:a]apad=pad_dur=1.2[p${i}]`).join(';');
  const concat = files.map((_, i) => `[p${i}]`).join('') + `concat=n=${files.length}:v=0:a=1,aresample=22050:filter_size=128:cutoff=0.95[out]`;
  args.push('-filter_complex', `${parts};${concat}`, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', outFile);
  await run('ffmpeg', args);
}

async function pool(items, limit, fn) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      voices: { type: 'string' },
      only: { type: 'string' },
      variants: { type: 'string', default: 'full,short' },
      model: { type: 'string', default: 'eleven_multilingual_v2' },
      check: { type: 'boolean', default: false },
      retries: { type: 'string', default: '2' },
      force: { type: 'boolean', default: false },
      'no-samples': { type: 'boolean', default: false },
      cache: { type: 'string', default: path.join(os.tmpdir(), 'binotel-voice-prompts-cache') },
      list: { type: 'boolean', default: false },
    },
  });

  const voiceKeys = values.voices ? values.voices.split(',') : Object.keys(VOICES);
  const promptIds = values.only ? values.only.split(',') : PROMPTS.map((p) => p.id);
  const variants = values.variants.split(',');
  for (const v of voiceKeys) if (!VOICES[v]) throw new Error(`Unknown voice "${v}". Known: ${Object.keys(VOICES).join(', ')}`);
  for (const id of promptIds) if (!PROMPTS.some((p) => p.id === id)) throw new Error(`Unknown prompt "${id}"`);

  if (values.list) {
    for (const p of PROMPTS.filter((x) => promptIds.includes(x.id)))
      for (const v of variants) console.log(`${p.id} [${v}] ${ttsText(p[v], values.model)}`);
    return;
  }

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set (use node --env-file=server/.env.local …)');
  if (!values.out) throw new Error('--out <dir> is required');

  const out = path.resolve(values.out);
  await fs.mkdir(values.cache, { recursive: true });
  const manifestFile = path.join(out, 'manifest.json');
  const manifest = (await exists(manifestFile)) ? JSON.parse(await fs.readFile(manifestFile, 'utf8')) : { clips: {} };

  const jobs = [];
  for (const v of voiceKeys)
    for (const p of PROMPTS.filter((x) => promptIds.includes(x.id)))
      for (const variant of variants) jobs.push({ v, p, variant });

  await pool(jobs, 3, async ({ v, p, variant }) => {
    const voice = VOICES[v];
    const base = variant === 'full' ? p.id : `${p.id}-${variant}`;
    const wavRel = `wav-8k/${v}/${base}.wav`;
    const mp3Rel = `mp3/${v}/${base}.mp3`;
    const text = p[variant];
    const tts = ttsText(text, values.model);
    const settings = voiceSettings(values.model);
    const hash = sha({ tts, voice: voice.id, model: values.model, settings, convert: 2 });
    const prev = manifest.clips[wavRel];
    const wavFile = path.join(out, wavRel);
    const mp3File = path.join(out, mp3Rel);
    const upToDate = prev?.hash === hash && (await exists(wavFile)) && (await exists(mp3File)) && (!values.check || prev.check);
    await fs.mkdir(path.dirname(wavFile), { recursive: true });
    await fs.mkdir(path.dirname(mp3File), { recursive: true });

    let take = upToDate && !values.force ? { seed: prev.seed, check: prev.check } : null;
    if (!take) {
      // With --check, re-take up to --retries times with another seed while the transcript differs
      // from the script, and keep the take with the lowest word error rate.
      const seeds = Array.from({ length: values.check ? 1 + Number(values.retries) : 1 }, (_, i) => 761 + i);
      for (const seed of seeds) {
        const rawFile = path.join(values.cache, `${hash}-${seed}.pcm`);
        if (!(await exists(rawFile)) || values.force) {
          await fs.writeFile(rawFile, await synthesize({ key, voiceId: voice.id, model: values.model, text: tts, seed }));
        }
        const tmpWav = `${wavFile}.take${seed}.wav`;
        const tmpMp3 = `${mp3File}.take${seed}.mp3`;
        await convert(rawFile, tmpWav, tmpMp3);
        let check;
        if (values.check) {
          const t = await transcribe({ key, file: tmpWav });
          check = { sttModel: t.model, wer: Math.round(wordErrorRate(text, t.text) * 1000) / 1000, transcript: t.text };
        }
        if (!take || (check && check.wer < take.check.wer)) {
          if (take) await Promise.all([fs.rm(take.tmpWav), fs.rm(take.tmpMp3)]);
          take = { seed, check, tmpWav, tmpMp3, takes: (take?.takes || 0) + 1 };
        } else {
          await Promise.all([fs.rm(tmpWav), fs.rm(tmpMp3)]);
          take.takes += 1;
        }
        if (!check || check.wer === 0) break;
      }
      await fs.rename(take.tmpWav, wavFile);
      await fs.rename(take.tmpMp3, mp3File);
    }

    const entry = {
      prompt: p.id,
      title: p.title,
      variant,
      voice: v,
      voiceName: voice.name,
      model: values.model,
      text,
      hash,
      seed: take.seed,
      wav: wavRel,
      mp3: mp3Rel,
      seconds: await duration(wavFile),
    };
    if (take.check) entry.check = take.check;
    manifest.clips[wavRel] = entry;
    const flag = entry.check ? ` WER=${entry.check.wer}` : '';
    const takes = take.takes > 1 ? ` (${take.takes} takes)` : '';
    console.log(`${upToDate && !values.force ? 'ok  ' : 'new '} ${wavRel} ${entry.seconds}s seed=${take.seed}${flag}${takes}`);
  });

  if (!values['no-samples']) {
    for (const v of voiceKeys) {
      const files = PROMPTS.filter((p) => promptIds.includes(p.id)).map((p) => path.join(out, `wav-8k/${v}/${p.id}.wav`));
      if (!variants.includes('full')) break;
      await fs.mkdir(path.join(out, 'samples'), { recursive: true });
      const sample = path.join(out, `samples/${v}-phone.mp3`);
      await buildSample(files, sample);
      console.log(`sample ${path.relative(out, sample)} ${await duration(sample)}s`);
    }
  }

  manifest.generatedAt = new Date().toISOString();
  manifest.voices = VOICES;
  manifest.formats = {
    wav: 'WAV PCM 16-bit, 8000 Hz, mono, loudness -19 LUFS, peak ≤ -3 dBTP, 250 ms lead-in / 400 ms tail',
    mp3: 'MP3 128 kbit/s, 44100 Hz, mono (same processing, no telephone band limit)',
    samples: 'phone-quality preview: all full-length prompts of one voice, 1.2 s apart',
  };
  manifest.clips = Object.fromEntries(Object.entries(manifest.clips).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest ${manifestFile}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
