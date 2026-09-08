export const STORAGE_CONSENT_COOKIE = "peerto_storage_consent";
export const STORAGE_CONSENT_VERSION = "v1";

export function hasStorageConsent(cookieHeader: string): boolean {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .some(
      (part) =>
        part ===
        `${STORAGE_CONSENT_COOKIE}=${STORAGE_CONSENT_VERSION}`,
    );
}

export function storageConsentCookie(secure: boolean): string {
  return [
    `${STORAGE_CONSENT_COOKIE}=${STORAGE_CONSENT_VERSION}`,
    "Max-Age=31536000",
    "Path=/",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
