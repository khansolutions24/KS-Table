// Bilingual strings. Every UI text is written inline in German and English:
//   tr('Tabelle öffnen', 'Open Table')
//   tr('{n} Datensätze', '{n} records', { n: 12 })
// The language is chosen once at startup (a change in the options applies after restart).

export type Lang = 'de' | 'en';

let current: Lang = 'de';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function tr(de: string, en: string, params?: Record<string, string | number>): string {
  const s = current === 'en' ? en : de;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Locale string for Intl formatting. */
export function locale(): string {
  return current === 'en' ? 'en-US' : 'de-DE';
}
