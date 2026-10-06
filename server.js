/**
 * Минимальный мост транскрибации для YouGile коробка
 */

// ─── Конфигурация ────────────────────────────────────────────────────────────

const requiredEnv = [
  'AUDIO_FETCH_TIMEOUT_MS',
  'MAX_AUDIO_BYTES',
  'MAX_AUDIO_DURATION_SEC',
  'MAX_OUTPUT_CHARS',
  'API_TIMEOUT_MS',
  'MAX_CONCURRENT',
  'RATE_LIMIT_PER_MIN',
  'TRANSCRIPTION_API_BASE',
  'TRANSCRIPTION_API_KEY',
  'TRANSCRIPTION_MODEL',
  'PORT',
  'LOG_LEVEL',
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    console.error(`[FATAL] Переменная окружения ${name} обязательна`);
    process.exit(1);
  }
}

const AUDIO_FETCH_TIMEOUT_MS = Number(process.env.AUDIO_FETCH_TIMEOUT_MS);
const MAX_AUDIO_BYTES        = Number(process.env.MAX_AUDIO_BYTES);
const MAX_AUDIO_DURATION_SEC = Number(process.env.MAX_AUDIO_DURATION_SEC);
const MAX_OUTPUT_CHARS       = Number(process.env.MAX_OUTPUT_CHARS);
const API_TIMEOUT_MS         = Number(process.env.API_TIMEOUT_MS);
const MAX_CONCURRENT         = Number(process.env.MAX_CONCURRENT);
const RATE_LIMIT_PER_MIN     = Number(process.env.RATE_LIMIT_PER_MIN);
const API_BASE               = process.env.TRANSCRIPTION_API_BASE;
const API_KEY                = process.env.TRANSCRIPTION_API_KEY;
const MODEL                  = process.env.TRANSCRIPTION_MODEL;
const PORT                   = Number(process.env.PORT);
const LOG_LEVEL              = process.env.LOG_LEVEL.toLowerCase();

// Опциональный промпт для Whisper (подсказка по языку/терминам)
const TRANSCRIPTION_PROMPT   = (process.env.TRANSCRIPTION_PROMPT || '').trim();

// Опциональная коррекция текста второй моделью
const CORRECTION_ENABLED     = (process.env.CORRECTION_ENABLED || 'false').toLowerCase() === 'true';
const CORRECTION_API_BASE    = (process.env.CORRECTION_API_BASE || '').trim();
const CORRECTION_API_KEY     = (process.env.CORRECTION_API_KEY || '').trim();
const CORRECTION_MODEL       = (process.env.CORRECTION_MODEL || '').trim();
const CORRECTION_PROMPT      = (process.env.CORRECTION_PROMPT || '').trim();
const CORRECTION_TIMEOUT_MS  = Number(process.env.CORRECTION_TIMEOUT_MS || 30000);

if (CORRECTION_ENABLED) {
  for (const [name, value] of [
    ['CORRECTION_API_BASE', CORRECTION_API_BASE],
    ['CORRECTION_API_KEY', CORRECTION_API_KEY],
    ['CORRECTION_MODEL', CORRECTION_MODEL],
    ['CORRECTION_PROMPT', CORRECTION_PROMPT],
  ]) {
    if (!value) {
      console.error(`[FATAL] При CORRECTION_ENABLED=true переменная ${name} обязательна`);
      process.exit(1);
    }
  }
}

// Опциональный whitelist хостов (через запятую). Пусто = разрешены любые.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Внутренний базовый URL для скачивания аудио (например http://192.168.25.100:8001).
// Если задан — origin входящего URL заменяется на этот, путь и query сохраняются.
// Позволяет ходить за файлами по внутренней сети вместо публичного домена.
const INTERNAL_AUDIO_BASE = (process.env.INTERNAL_AUDIO_BASE || '').trim();

// ─── Логирование ─────────────────────────────────────────────────────────────

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 20;

function log(level, ...args) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method](`[${ts}] [${level.toUpperCase()}]`, ...args);
}

const dbg  = (...a) => log('debug', ...a);
const info = (...a) => log('info', ...a);
const warn = (...a) => log('warn', ...a);
const err  = (...a) => log('error', ...a);

info(`Конфиг: port=${PORT}, model=${MODEL}, base=${API_BASE}, maxBytes=${MAX_AUDIO_BYTES}, maxDuration=${MAX_AUDIO_DURATION_SEC}s, maxOutput=${MAX_OUTPUT_CHARS}, concurrent=${MAX_CONCURRENT}, rateLimit=${RATE_LIMIT_PER_MIN}/min, correction=${CORRECTION_ENABLED}, internalAudioBase=${INTERNAL_AUDIO_BASE || 'нет'}`);

// ─── Ограничения нагрузки ────────────────────────────────────────────────────

let activeRequests = 0;

const rateBuckets = new Map(); // ip → [timestamps]

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  let timestamps = rateBuckets.get(ip) || [];
  timestamps = timestamps.filter((t) => now - t < windowMs);
  if (timestamps.length >= RATE_LIMIT_PER_MIN) {
    rateBuckets.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  rateBuckets.set(ip, timestamps);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateBuckets) {
    const alive = timestamps.filter((t) => now - t < 60_000);
    if (alive.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, alive);
  }
}, 60_000).unref();

// ─── Вспомогательные функции ─────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '<некорректный-url>';
  }
}

/**
 * Если задан INTERNAL_AUDIO_BASE — подменяет origin входящего URL
 * на внутренний адрес, сохраняя pathname и search.
 * Пример:
 *   https://task.example.com/files/abc.ogg
 *   → http://192.168.25.100:8001/files/abc.ogg
 */
function rewriteAudioUrl(raw) {
  if (!INTERNAL_AUDIO_BASE) return raw;

  let original;
  try {
    original = new URL(raw);
  } catch {
    return raw; // некорректный URL обработает validateAudioUrl
  }

  const internal = new URL(INTERNAL_AUDIO_BASE);
  const rewritten = new URL(original.pathname + original.search, internal.origin);
  return rewritten.href;
}

function validateAudioUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('некорректный URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`запрещённая схема: ${parsed.protocol}`);
  }

  if (ALLOWED_HOSTS.length > 0) {
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.includes(host)) {
      throw new Error(`хост не в белом списке: ${host}`);
    }
  }

  return parsed.href;
}

function filenameFromUrl(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() || 'audio.bin';
  } catch {
    return 'audio.bin';
  }
}

function mimeFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.webm')) return 'audio/webm';
  return 'audio/*';
}

/**
 * Извлекает текст из ответа сервиса транскрибации.
 * Поддерживает JSON {"text":"..."} и plain text.
 */
function extractText(body) {
  const s = body.trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (typeof j.text === 'string' && j.text.trim()) {
        return j.text.trim();
      }
    } catch {
      // fallthrough
    }
  }
  return s;
}

/**
 * Удаляет известные галлюцинации ASR.
 * Список основан на типичных «водяных знаках» Whisper (DimaTorzok и аналоги).
 * См. https://dimatorzok.com/ru/kak-ubrat/
 */
function cleanTranscriptionArtifacts(text) {
  if (!text) return text;

  let result = text;

  // Фразы-галлюцинации (регистронезависимо)
  const artifacts = [
    // DimaTorzok — все распространённые варианты
    /субтитры\s+(?:создавал|сделал|делал|создал|сделала|создала)\s+dimatorzok/gi,
    /subtitles?\s+by\s+dimatorzok/gi,
    /created\s+by\s+dimatorzok/gi,
    /\bdimatorzok\b/gi,

    // Другие известные подписи
    /subtitles?\s+by\s+the\s+amara\.org\s+community/gi,
    /subtitles?\s+by\s+amara(?:\.org)?/gi,
    /altyaz[ıi]\s+m\.?k\.?/gi,              // тур.
    /titulky\s+vytvo[rř]il\s+johnyx/gi,      // чеш.

    // Типовые концовки — только если занимают всю строку
    /^\s*спасибо\s+за\s+просмотр\.?\s*$/gim,
    /^\s*thank\s+you\s+for\s+watching\.?\s*$/gim,
    /^\s*продолжение\s+следует\.?\s*$/gim,
    /^\s*to\s+be\s+continued\.?\s*$/gim,
  ];

  for (const re of artifacts) {
    result = result.replace(re, '');
  }

  // Убираем лишние пробелы и пустые строки после вырезания
  result = result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return result;
}

/**
 * Извлекает текст из ответа chat-completions.
 */
function extractChatText(body) {
  try {
    const j = JSON.parse(body);
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
  } catch {
    // fallthrough
  }
  return body.trim();
}

function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  warn(`Транскрибация: ответ обрезан с ${text.length} до ${MAX_OUTPUT_CHARS} символов`);
  return text.slice(0, MAX_OUTPUT_CHARS) + '…';
}

/** Всегда HTTP 200 — клиент иначе не завершит обработку сообщения */
function sendMarker(res, message) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

// ─── Работа с аудио ──────────────────────────────────────────────────────────

async function fetchAudio(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUDIO_FETCH_TIMEOUT_MS);
  const started = Date.now();

  try {
    dbg(`Аудио: скачивание ${url}, timeout=${AUDIO_FETCH_TIMEOUT_MS}ms`);

    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`ошибка скачивания ${res.status} ${res.statusText}`);
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_AUDIO_BYTES) {
      throw new Error(`файл слишком большой по Content-Length: ${contentLength} > ${MAX_AUDIO_BYTES}`);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AUDIO_BYTES) {
        reader.cancel();
        throw new Error(`файл слишком большой: ${total} > ${MAX_AUDIO_BYTES}`);
      }
      chunks.push(value);
    }

    if (total === 0) {
      throw new Error('пустое тело ответа');
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
    info(`Аудио: получено ${buf.length} байт с ${hostOf(url)} за ${Date.now() - started}ms`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Транскрибация ───────────────────────────────────────────────────────────

async function transcribe(audioBuf, filename, lang) {
  const form = new FormData();
  form.append('file', new Blob([audioBuf], { type: mimeFromFilename(filename) }), filename);
  form.append('model', MODEL);
  form.append('response_format', 'json');
  form.append('temperature', '0'); // меньше случайных галлюцинаций
  if (lang) form.append('language', lang);
  if (TRANSCRIPTION_PROMPT) form.append('prompt', TRANSCRIPTION_PROMPT);

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);

    try {
      dbg(`API: попытка ${attempt}/3 → ${API_BASE}/audio/transcriptions (file=${filename}, lang=${lang || 'по умолчанию'})`);

      const res = await fetch(`${API_BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
        body: form,
        signal: ctrl.signal,
      });

      const body = await res.text();

      if (res.ok) {
        const text = extractText(body);
        info(`API: 200 за ${Date.now() - started}ms, транскрипция ${text.length} символов: ${JSON.stringify(text.slice(0, 80))}${text.length > 80 ? '…' : ''}`);

        if (!text.trim()) {
          warn('API: 200, но пустая транскрипция (возможно тишина или нераспознаваемый звук)');
        }

        return text;
      }

      lastError = new Error(`API ${res.status}: ${body.slice(0, 300)}`);
      warn(`API: попытка ${attempt} неудачна — ${lastError.message}`);
    } catch (e) {
      lastError = e;
      warn(`API: попытка ${attempt} выбросила исключение: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    await sleep(1000 * attempt);
  }

  throw lastError || new Error('API: все попытки исчерпаны');
}

// ─── Коррекция текста второй моделью ─────────────────────────────────────────
// Транскрибация → LLM: исправление ошибок распознавания и форматирование

async function correctText(rawText) {
  if (!rawText.trim()) return rawText;

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CORRECTION_TIMEOUT_MS);

  const userContent = [
    'Мы попросили распознать голосовое сообщение, и получили вот такой результат:',
    '',
    rawText,
    '',
    'Исправь ошибки распознавания и отформатируй текст.',
  ].join('\n');

  try {
    dbg(`Коррекция: отправка ${rawText.length} символов в ${CORRECTION_MODEL}`);

    const res = await fetch(`${CORRECTION_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CORRECTION_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CORRECTION_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: CORRECTION_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      signal: ctrl.signal,
    });

    const body = await res.text();

    if (!res.ok) {
      throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
    }

    const corrected = extractChatText(body);
    info(`Коррекция: 200 за ${Date.now() - started}ms, ${rawText.length} → ${corrected.length} символов`);

    if (!corrected.trim()) {
      warn('Коррекция: пустой ответ, возвращаем исходный текст');
      return rawText;
    }

    return corrected;
  } catch (e) {
    warn(`Коррекция: не удалось — ${e.message}, возвращаем исходный текст`);
    return rawText; // при ошибке коррекции отдаём сырой текст, а не падаем
  } finally {
    clearTimeout(timer);
  }
}

// ─── HTTP-сервер ─────────────────────────────────────────────────────────────

const { createServer } = await import('node:http');

const server = createServer((req, res) => {
  const started = Date.now();
  const clientIp = req.socket.remoteAddress || 'unknown';

  const handler = async () => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    info(`Запрос: ${req.method} ${u.pathname}${u.search || ''} от ${clientIp}`);

    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (req.method !== 'GET' || u.pathname !== '/transcribe') {
      warn(`Запрос: 404, неизвестный путь ${u.pathname}`);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }

    if (!checkRateLimit(clientIp)) {
      warn(`Запрос: превышен rate-limit для ${clientIp}`);
      sendMarker(res, '[Транскрипция недоступна: слишком много запросов, попробуйте позже]');
      return;
    }

    if (activeRequests >= MAX_CONCURRENT) {
      warn(`Запрос: превышен лимит одновременных запросов (${activeRequests}/${MAX_CONCURRENT})`);
      sendMarker(res, '[Транскрипция недоступна: сервис временно перегружен]');
      return;
    }

    const rawUrl   = (u.searchParams.get('url') || '').trim();
    const lang     = (u.searchParams.get('lang') || '').trim() || 'ru';
    const boxModel = (u.searchParams.get('model') || '').trim();

    info(`Транскрибация: url=${rawUrl} (host=${hostOf(rawUrl)}), lang=${lang}, model=${boxModel || 'нет'}`);

    if (!rawUrl) {
      warn('Транскрибация: отсутствует параметр url');
      sendMarker(res, '[Транскрипция недоступна: отсутствует ссылка на файл]');
      return;
    }

    // Подмена origin на внутренний адрес (если задан INTERNAL_AUDIO_BASE)
    const rewrittenUrl = rewriteAudioUrl(rawUrl);
    if (rewrittenUrl !== rawUrl) {
      info(`Транскрибация: URL переписан на внутренний → ${rewrittenUrl}`);
    }

    let audioUrl;
    try {
      audioUrl = validateAudioUrl(rewrittenUrl);
    } catch (e) {
      warn(`Транскрибация: невалидный url — ${e.message}`);
      sendMarker(res, '[Транскрипция недоступна: некорректная ссылка на файл]');
      return;
    }

    activeRequests++;
    try {
      let audioBuf;
      try {
        audioBuf = await fetchAudio(audioUrl);
      } catch (e) {
        err(`Аудио: не удалось скачать ${audioUrl} → ${e.message}`);
        const isTooLarge = e.message.includes('слишком большой');
        sendMarker(res, isTooLarge
          ? '[Транскрипция недоступна: файл слишком большой]'
          : '[Транскрипция недоступна: не удалось скачать файл]');
        return;
      }

      let text;
      try {
        text = await transcribe(audioBuf, filenameFromUrl(audioUrl), lang);
      } catch (e) {
        err(`Транскрибация: API не удалось → ${e.message}`);
        sendMarker(res, '[Транскрипция недоступна]');
        return;
      }

      // Убираем известные галлюцинации ASR (в т.ч. «Субтитры создавал DimaTorzok»)
      text = cleanTranscriptionArtifacts(text);

      // Опциональная коррекция второй моделью
      if (CORRECTION_ENABLED && text.trim()) {
        text = await correctText(text);
        text = cleanTranscriptionArtifacts(text); // на случай, если модель что-то оставила/добавила
      }

      text = truncateOutput(text);

      info(`Транскрибация: OK за ${Date.now() - started}ms, возвращено ${text.length} символов`);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
    } finally {
      activeRequests--;
    }
  };

  handler().catch((e) => {
    err(`Обработчик: неожиданная ошибка — ${e.message}`);
    if (!res.headersSent) {
      sendMarker(res, '[Транскрипция недоступна]');
    }
  });
});

server.listen(PORT, () => {
  info(`Сервер: мост транскрибации слушает порт :${PORT}`);
});

