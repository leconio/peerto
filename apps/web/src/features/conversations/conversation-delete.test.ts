import { describe, expect, it, vi } from "vitest";
import { deleteConversationTransaction } from "./conversation-delete";

describe("deleteConversationTransaction", () => {
  it("deletes locally only after the peer confirms deletion", async () => {
    const order: string[] = [];
    const result = await deleteConversationTransaction({
      deleteRemote: async () => {
        order.push("remote");
        return true;
      },
      deleteLocal: async () => {
        order.push("local");
        return true;
      },
    });

    expect(result).toBe("deleted");
    expect(order).toEqual(["remote", "local"]);
  });

  it("keeps local data when remote deletion fails", async () => {
    const deleteLocal = vi.fn(async () => true);

    await expect(
      deleteConversationTransaction({
        deleteRemote: async () => false,
        deleteLocal,
      }),
    ).resolves.toBe("remote_failed");
    expect(deleteLocal).not.toHaveBeenCalled();
  });

  it("supports local-only deletion", async () => {
    await expect(
      deleteConversationTransaction({
        deleteLocal: async () => true,
      }),
    ).resolves.toBe("deleted");
  });
});
