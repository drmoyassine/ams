import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// UI is English first; Arabic UI strings arrive later. Content direction is handled by dir="auto".
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  resources: {
    en: {
      translation: {
        appName: 'AMS',
        nav: { programs: 'Programs', engagements: 'Engagements', evidence: 'Evidence' },
        login: { title: 'Sign in', email: 'Email', password: 'Password', submit: 'Sign in', failed: 'Sign-in failed' },
        programs: { title: 'Programs', empty: 'No programs visible to you yet.', loadFailed: 'Could not load programs.' },
        soon: 'Coming in a later milestone.',
        signOut: 'Sign out',
      },
    },
  },
});

export default i18n;
