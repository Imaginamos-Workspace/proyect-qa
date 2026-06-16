import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en/common.json';
import es from '../locales/es/common.json';

// Default en ESPAÑOL: el equipo viene de Jira en español, la app debe resultarle
// familiar de entrada. Respeta la preferencia guardada si el usuario cambió el idioma.
const savedLang = localStorage.getItem('qa-platform-lang') || 'es';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: savedLang,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  localStorage.setItem('qa-platform-lang', lng);
});

export default i18n;
