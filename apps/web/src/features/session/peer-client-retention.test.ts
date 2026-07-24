import { describe, expect, it } from "vitest";
import { peerIdsToPrune } from "./peer-client-retention";

describe("peerIdsToPrune", () => {
  it("does not prune below the configured limit", () => {
    expect(
      peerIdsToPrune(
        [
          { peerId: "a", online: true },
          { peerId: "b", online: true },
          { peerId: "c", online: true },
        ],
        "",
        4,
        1,
      ),
    ).toEqual([]);
  });

  it("evicts offline clients before an online client", () => {
    expect(
      peerIdsToPrune(
        [
          { peerId: "online-old", online: true },
          { peerId: "offline-old", online: false },
          { peerId: "online-new", online: true },
          { peerId: "offline-new", online: false },
        ],
        "",
        3,
        1,
      ),
    ).toEqual(["offline-old", "offline-new"]);
  });

  it("protects the selected conversation when lowering the limit", () => {
    expect(
      peerIdsToPrune(
        ["selected", "a", "b", "c", "d"].map((peerId) => ({
          peerId,
          online: true,
        })),
        "selected",
        2,
        0,
      ),
    ).toEqual(["a", "b", "c"]);
  });
});
