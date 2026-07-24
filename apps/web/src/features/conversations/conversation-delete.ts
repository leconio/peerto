export type ConversationDeleteResult =
  | "deleted"
  | "remote_failed"
  | "local_failed";

export async function deleteConversationTransaction({
  deleteRemote,
  deleteLocal,
}: {
  deleteRemote?: () => Promise<boolean>;
  deleteLocal: () => Promise<boolean>;
}): Promise<ConversationDeleteResult> {
  if (deleteRemote && !(await deleteRemote())) {
    return "remote_failed";
  }
  if (!(await deleteLocal())) {
    return "local_failed";
  }
  return "deleted";
}
