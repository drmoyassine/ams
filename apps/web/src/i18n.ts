import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { EN_CATALOGUE } from '@ams/shared';

// The English catalogue is the source of every string (packages/shared/src/locales/en.ts, a flat map of dotted keys; the
// secondary language is produced from it by the translation job and served by GET /api/i18n/{language}). Keys are flat, so
// the key separator is switched off. Anything a language lacks falls back to English.
export const i18nReady = i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  load: 'currentOnly',
  interpolation: { escapeValue: false },
  returnNull: false,
  resources: { en: { translation: EN_CATALOGUE } },
});

// Components import `useTranslation` from here, so the catalogue is always initialised before the first render.
export { useTranslation } from 'react-i18next';
export default i18n;
