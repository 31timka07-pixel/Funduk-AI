/**
 * Фундук AI — конфиг с ключом (деплой рядом с index.html).
 *
 * ВАЖНО для GitHub Pages:
 * - Ключ в этом файле ВИДЕН любому посетителю (DevTools → Sources).
 * - Auth-ключи Google (AQ.) часто отзывают при утечке.
 * - Ограничь ключ в Google Cloud Console:
 *   Application restrictions → HTTP referrers →
 *   https://ТВОЙ-ЛОГИН.github.io/*
 *   https://ТВОЙ-ЛОГИН.github.io/ИМЯ-РЕПО/*
 * - Не публикуй ключ в чатах и Issues.
 *
 * Вставь свой ключ из https://aistudio.google.com/apikey ниже:
 */
window.FUNDUK_CONFIG = window.FUNDUK_CONFIG || {};
window.FUNDUK_CONFIG.GEMINI_API_KEY = ''; // ← вставь ключ сюда, например 'AQ.xxxx'
window.FUNDUK_CONFIG.GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
window.FUNDUK_CONFIG.GEMINI_MODEL = 'gemini-3.5-flash';
window.FUNDUK_CONFIG.GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash'
];
