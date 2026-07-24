import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zh } from "./locales/zh";

export type AppLanguage = "zh" | "en";

const LANGUAGE_KEY = "peerto-language";

function initialLanguage(): AppLanguage {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const initialization = i18n.use(initReactI18next).init({
  resources: { zh, en },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

function applyDocumentLanguage(language: string): void {
  const normalized: AppLanguage = language.startsWith("zh") ? "zh" : "en";
  localStorage.setItem(LANGUAGE_KEY, normalized);
  document.documentElement.lang = normalized === "zh" ? "zh-CN" : "en";
  document.title = i18n.t("appName");
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", i18n.t("metaDescription"));
}

i18n.on("languageChanged", applyDocumentLanguage);

void initialization.then(() => applyDocumentLanguage(i18n.language));

export default i18n;
