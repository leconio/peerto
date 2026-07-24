import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import { useEffect } from "react";
import type { PeerClient } from "../../services/peer";
import type { ConnectionDialogKind } from "./ConnectionDialogs";
import type { PendingSharedJoin } from "./share-link";

export interface SharedJoinBindings {
  client: PeerClient | undefined;
  pendingRef: MutableRefObject<PendingSharedJoin | undefined>;
  handledRef: MutableRefObject<boolean>;
  setJoinCode: Dispatch<SetStateAction<string>>;
  setConnectionDialog: Dispatch<
    SetStateAction<ConnectionDialogKind>
  >;
}

export function useSharedJoin({
  client,
  pendingRef,
  handledRef,
  setJoinCode,
  setConnectionDialog,
}: SharedJoinBindings): void {
  useEffect(() => {
    if (!client || handledRef.current) return;
    const pending = pendingRef.current;
    if (!pending) return;
    handledRef.current = true;
    pendingRef.current = undefined;
    setJoinCode(pending.code);
    setConnectionDialog("auto");
    client.join(pending.code, pending.token);
  }, [
    client,
    handledRef,
    pendingRef,
    setConnectionDialog,
    setJoinCode,
  ]);
}
