import { describe, expect, it } from "vitest";
import {
  deviceAvatarLabel,
  identityDeviceName,
  initialDeviceName,
  shouldUseIdentityDeviceName,
} from "./device-name";

describe("device names", () => {
  it("derives a stable short name from the local device identity", () => {
    expect(identityDeviceName("ab_cd-1234")).toBe("Peerto ABCD12");
    expect(identityDeviceName("ab_cd-1234")).toBe(
      identityDeviceName("ab_cd-1234"),
    );
  });

  it("only replaces automatic and legacy platform defaults", () => {
    expect(initialDeviceName()).toBe("Peerto");
    expect(shouldUseIdentityDeviceName("Peerto", "MacIntel")).toBe(true);
    expect(shouldUseIdentityDeviceName("Mac 设备", "MacIntel")).toBe(true);
    expect(shouldUseIdentityDeviceName("Mac Device", "MacIntel")).toBe(true);
    expect(shouldUseIdentityDeviceName("Alice's phone", "MacIntel")).toBe(
      false,
    );
  });

  it("uses the device code for automatic-name avatars", () => {
    expect(deviceAvatarLabel("Peerto", "ab_cd-1234")).toBe("AB");
    expect(
      deviceAvatarLabel(
        identityDeviceName("xy_987654"),
        "xy_987654",
      ),
    ).toBe("XY");
  });

  it("uses the first two characters of a custom device name", () => {
    expect(deviceAvatarLabel("Alice's phone", "ab_cd-1234")).toBe("AL");
    expect(deviceAvatarLabel(" 小明的手机 ", "ab_cd-1234")).toBe("小明");
  });
});
