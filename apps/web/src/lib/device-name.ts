const AUTOMATIC_NAME = "Peerto";

function normalizedPlatform(platform: string): string {
  return platform.replace("Intel", "").trim() || "Web";
}

function identityCode(deviceId: string, length: number): string {
  return deviceId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, length)
    .toUpperCase();
}

export function initialDeviceName(): string {
  return AUTOMATIC_NAME;
}

export function identityDeviceName(deviceId: string): string {
  const code = identityCode(deviceId, 6);
  return `${AUTOMATIC_NAME} ${code || "DEVICE"}`;
}

export function deviceAvatarLabel(
  name: string,
  deviceId: string,
): string {
  const trimmedName = name.trim();
  const automaticName =
    !trimmedName ||
    trimmedName === AUTOMATIC_NAME ||
    trimmedName === identityDeviceName(deviceId);
  const source = automaticName
    ? identityCode(deviceId, 2)
    : trimmedName;
  return Array.from(source).slice(0, 2).join("").toUpperCase() || "P";
}

export function shouldUseIdentityDeviceName(
  name: string,
  platform: string,
): boolean {
  const trimmed = name.trim();
  const legacyPlatform = normalizedPlatform(platform);
  return (
    trimmed === AUTOMATIC_NAME ||
    trimmed === "我的设备" ||
    trimmed === `${legacyPlatform} 设备` ||
    trimmed === `${legacyPlatform} Device`
  );
}
