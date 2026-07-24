import { openDB, type DBSchema } from "idb";

interface PeertoDatabase extends DBSchema {
  identity: {
    key: string;
    value: CryptoKeyPair;
  };
  handles: {
    key: string;
    value: FileSystemFileHandle;
  };
}

let database: ReturnType<typeof openDB<PeertoDatabase>> | undefined;

function getDatabase() {
  database ??= openDB<PeertoDatabase>("peerto-private", 1, {
    upgrade(db) {
      db.createObjectStore("identity");
      db.createObjectStore("handles");
    },
  });
  return database;
}

export async function readKeyPair(): Promise<CryptoKeyPair | undefined> {
  return (await getDatabase()).get("identity", "device-key-pair");
}

export async function writeKeyPair(keyPair: CryptoKeyPair): Promise<void> {
  await (await getDatabase()).put("identity", keyPair, "device-key-pair");
}

export async function putFileHandle(
  key: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  await (await getDatabase()).put("handles", handle, key);
}

export async function getFileHandle(
  key: string,
): Promise<FileSystemFileHandle | undefined> {
  return (await getDatabase()).get("handles", key);
}

export async function deleteFileHandle(key: string): Promise<void> {
  await (await getDatabase()).delete("handles", key);
}
