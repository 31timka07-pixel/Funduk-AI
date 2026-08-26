/**
 * Фундук AI — Netlify Serverless Function
 * Проксирует запросы к Gemini API, скрывая ключ от клиента.
 *
 * Ключ хранится ТОЛЬКО в переменной окружения Netlify: GEMINI_API_KEY
 * Никогда не возвращается клиенту в ответе, логах или заголовках.
 *
 * Ожидает POST JSON:
 *   { message: string, history: [{role:'user'|'assistant', text:string}], systemPrompt?: string }
 * Ответ:
 *   { ok: true, answer: string, finish_reason?: string }
 *   { ok: false, error: string }
 */

// ── Лимиты ──────────────────────────────────────────────────────────────────
const MAX_MESSAGE_LEN   = 4000;
const MAX_HISTORY_ITEMS = 40;
const MAX_HISTORY_TEXT  = 20000;
const MAX_SYSTEM_LEN    = 8000;
const MAX_BODY_BYTES    = 80_000;

// ── Rate limiting (in-memory, per cold start) ────────────────────────────────
const _reqLog = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQS  = 30;

function isRateLimited(ip) {
  const now = Date.now();
  const list = (_reqLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX_REQS) return true;
  list.push(now);
  _reqLog.set(ip, list);
  if (_reqLog.size > 1000) {
    for (const [k, v] of _reqLog) {
      if (v.every(t => now - t >= RATE_WINDOW_MS)) _reqLog.delete(k);
    }
  }
  return false;
}

// ── Gemini models ───────────────────────────────────────────────────────────
// 2026-08: gemini-2.0-flash закрыт для новых ключей; gemini-3.5-flash часто 503.
// Основная — lite; дальше fallback при high demand.
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
];

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

async function callGeminiOnce(systemPrompt, history, message, apiKey, model) {
  const contents = [];

  for (const item of history) {
    const role = item.role === 'assistant' ? 'model' : 'user';
    const text = String(item.text || '').slice(0, 2000);
    if (text.trim()) contents.push({ role, parts: [{ text }] });
  }

  if (message && message.trim()) {
    contents.push({ role: 'user', parts: [{ text: message }] });
  } else if (contents.length === 0) {
    throw Object.assign(new Error('empty_message'), { status: 400 });
  }

  // Gemini требует чередование user/model; склеиваем подряд идущие одинаковые роли
  const merged = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) {
      last.parts[0].text += '\n' + c.parts[0].text;
    } else {
      merged.push({ role: c.role, parts: [{ text: c.parts[0].text }] });
    }
  }
  // Нельзя начинать с model
  while (merged.length && merged[0].role === 'model') merged.shift();
  if (!merged.length) throw Object.assign(new Error('empty_message'), { status: 400 });

  const body = {
    system_instruction: {
      parts: [{ text: systemPrompt || 'Ты Фундук, полезный помощник.' }]
    },
    contents: merged,
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.7,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 28_000);

  let geminiRes;
  try {
    geminiRes = await fetch(`${geminiUrl(model)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!geminiRes.ok) {
    const status = geminiRes.status;
    if (status === 429) throw Object.assign(new Error('rate_limit'), { status: 429 });
    if (status === 401 || status === 403) throw Object.assign(new Error('auth_error'), { status });
    if (status === 503 || status === 502 || status === 500) {
      throw Object.assign(new Error('unavailable'), { status });
    }
    if (status === 404) throw Object.assign(new Error('model_not_found'), { status: 404 });
    throw Object.assign(new Error('gemini_error'), { status });
  }

  const data = await geminiRes.json();

  const block = data?.promptFeedback?.blockReason;
  if (block) throw Object.assign(new Error('blocked'), { detail: String(block) });

  const candidate = data?.candidates?.[0];
  if (!candidate) throw new Error('no_candidates');

  const finishReason = candidate.finishReason || '';
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    throw Object.assign(new Error('blocked'), { detail: finishReason });
  }

  const text = candidate?.content?.parts
    ?.map(p => p.text || '')
    .join('') || '';

  if (!text.trim()) throw new Error('empty_content');

  return { answer: text, finish_reason: finishReason, model };
}

async function callGemini(systemPrompt, history, message, apiKey) {
  let lastErr;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    try {
      return await callGeminiOnce(systemPrompt, history, message, apiKey, model);
    } catch (err) {
      lastErr = err;
      const retryable =
        err.message === 'unavailable' ||
        err.message === 'model_not_found' ||
        err.message === 'no_candidates' ||
        err.message === 'empty_content' ||
        err.status === 503 ||
        err.status === 502 ||
        err.status === 500 ||
        err.status === 404;
      if (!retryable || i === GEMINI_MODELS.length - 1) throw err;
      // короткая пауза перед следующей моделью
      await new Promise(r => setTimeout(r, 400 + i * 300));
    }
  }
  throw lastErr || new Error('gemini_error');
}

// ── CORS ────────────────────────────────────────────────────────────────────
function getCorsHeaders(requestOrigin) {
  const allowed = [
    /^https:\/\/[a-z0-9-]+\.netlify\.app$/,
    /^https:\/\/funduk-ai\.[a-z.]+$/,
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  ];

  const origin = allowed.some(re => re.test(requestOrigin || ''))
    ? requestOrigin
    : null;

  const base = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (origin) base['Access-Control-Allow-Origin'] = origin;
  return base;
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  let totalLen = 0;
  const result = [];

  for (const item of raw.slice(-MAX_HISTORY_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    const role = String(item.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    // text или content (клиент мог прислать оба варианта)
    let text = '';
    if (typeof item.text === 'string') text = item.text;
    else if (typeof item.content === 'string') text = item.content;
    else if (Array.isArray(item.content)) {
      text = item.content.map(p => (p && p.text) ? p.text : '').join(' ');
    }
    text = String(text).slice(0, 2000);
    totalLen += text.length;
    if (totalLen > MAX_HISTORY_TEXT) break;
    if (text.trim()) result.push({ role, text });
  }

  return result;
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async (req) => {
  const requestOrigin = req.headers.get('origin') || '';
  const corsHeaders = getCorsHeaders(requestOrigin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'Метод не поддерживается' }),
      { status: 405, headers: corsHeaders }
    );
  }

  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Ожидается Content-Type: application/json' }),
      { status: 415, headers: corsHeaders }
    );
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || req.headers.get('x-nf-client-connection-ip')
          || 'unknown';

  if (isRateLimited(ip)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Слишком много запросов. Подождите немного.' }),
      { status: 429, headers: corsHeaders }
    );
  }

  let bodyText;
  try {
    const cl = parseInt(req.headers.get('content-length') || '0', 10);
    if (cl > MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Запрос слишком большой' }),
        { status: 413, headers: corsHeaders }
      );
    }
    bodyText = await req.text();
    if (bodyText.length > MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Запрос слишком большой' }),
        { status: 413, headers: corsHeaders }
      );
    }
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: 'Не удалось прочитать запрос' }),
      { status: 400, headers: corsHeaders }
    );
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: 'Некорректный JSON' }),
      { status: 400, headers: corsHeaders }
    );
  }

  const message = typeof payload.message === 'string'
    ? payload.message.slice(0, MAX_MESSAGE_LEN)
    : '';

  const systemPrompt = typeof payload.systemPrompt === 'string'
    ? payload.systemPrompt.slice(0, MAX_SYSTEM_LEN)
    : '';

  const history = sanitizeHistory(payload.history);

  if (!message.trim() && history.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Пустое сообщение' }),
      { status: 400, headers: corsHeaders }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[ask-ai] GEMINI_API_KEY не задан в переменных окружения Netlify');
    return new Response(
      JSON.stringify({ ok: false, error: 'Сервис временно недоступен' }),
      { status: 503, headers: corsHeaders }
    );
  }

  try {
    const result = await callGemini(systemPrompt, history, message, apiKey);
    return new Response(
      JSON.stringify({
        ok: true,
        answer: result.answer,
        finish_reason: result.finish_reason,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    const status = err.status || 500;
    const code = err.message || '';

    let clientMsg = 'Не удалось получить ответ. Попробуйте ещё раз позже.';
    let httpStatus = 500;

    if (code === 'rate_limit' || status === 429) {
      clientMsg = 'Слишком много запросов к AI. Подождите минуту.';
      httpStatus = 429;
    } else if (code === 'blocked') {
      clientMsg = 'Запрос заблокирован фильтрами безопасности.';
      httpStatus = 422;
    } else if (code === 'empty_message') {
      clientMsg = 'Пустое сообщение.';
      httpStatus = 400;
    } else if (code === 'auth_error') {
      console.error('[ask-ai] Ошибка авторизации Gemini:', status);
      clientMsg = 'Сервис временно недоступен.';
      httpStatus = 503;
    } else if (code === 'unavailable') {
      clientMsg = 'Модель временно перегружена. Попробуйте ещё раз через минуту.';
      httpStatus = 503;
    } else if (err.name === 'AbortError') {
      clientMsg = 'Время ожидания истекло. Попробуйте ещё раз.';
      httpStatus = 504;
    }

    console.error('[ask-ai] Ошибка:', code, httpStatus);

    return new Response(
      JSON.stringify({ ok: false, error: clientMsg }),
      { status: httpStatus, headers: corsHeaders }
    );
  }
};
