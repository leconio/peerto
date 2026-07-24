export type AppLanguage = "zh" | "en";

export function resolveInitialLanguage(
  savedLanguage: string | null,
): AppLanguage {
  return savedLanguage === "zh" || savedLanguage === "en"
    ? savedLanguage
    : "en";
}
