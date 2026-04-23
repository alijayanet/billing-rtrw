const fs = require('fs');
const path = require('path');

const SUPPORTED_LANGS = new Set(['id', 'en']);
const FALLBACK_LANG = 'id';

function loadLocale(lang) {
  try {
    const filePath = path.join(__dirname, `../locales/${lang}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

const dictionaries = {
  id: loadLocale('id'),
  en: loadLocale('en')
};

function normalizeLang(input) {
  const lang = String(input || '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(lang) ? lang : FALLBACK_LANG;
}

function getNestedValue(obj, keyPath) {
  const keys = String(keyPath || '').split('.');
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function t(lang, key, fallback = '') {
  const useLang = normalizeLang(lang);
  const fromLang = getNestedValue(dictionaries[useLang], key);
  if (fromLang !== undefined) return fromLang;
  const fromFallback = getNestedValue(dictionaries[FALLBACK_LANG], key);
  if (fromFallback !== undefined) return fromFallback;
  return fallback || key;
}

module.exports = {
  SUPPORTED_LANGS,
  FALLBACK_LANG,
  normalizeLang,
  t
};
