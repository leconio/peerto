import type { DeviceIdentity } from "@peerto/protocol";

export interface RoomRecord {
  id: string;
  code: string;
  host: DeviceIdentity;

  hostTokenHash: string;
  shareTokenHash: string;
  resume: boolean;
  peerDeviceId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface CodeMember {
  device: DeviceIdentity;
  updatedAt: number;
}

export interface CodeRecord {
  code: string;
  tokenHash: string;
  members: Record<string, CodeMember>;
  createdAt: number;
}

export interface StoreStats {
  rooms: number;
  codes: number;
  rateBuckets: number;
}

export interface RoomStore {
  createRoom(
    room: RoomRecord,
    ttlSeconds: number,
    roomKey?: string,
  ): Promise<boolean>;
  getRoom(code: string, roomKey?: string): Promise<RoomRecord | null>;
  deleteRoom(code: string, roomKey?: string, expectedId?: string): Promise<void>;
  createCode(record: CodeRecord, ttlSeconds: number): Promise<boolean>;
  getCode(code: string, tokenHash: string): Promise<CodeRecord | null>;
  upsertCodeMember(
    code: string,
    tokenHash: string,
    member: CodeMember,
    ttlSeconds: number,
    maxMembers: number,
  ): Promise<boolean>;
  deleteCode(code: string, tokenHash: string): Promise<void>;
  isRateLimited(
    bucket: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean>;
  stats(): StoreStats;
  close(): void;
}

interface ExpiringValue<T> {
  value: T;
  expiresAt: number;
}

interface RateBucket {
  count: number;
  expiresAt: number;
}

export interface InMemoryRoomStoreOptions {
  maxRooms: number;
  maxCodes: number;
  maxRateBuckets: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, ExpiringValue<RoomRecord>>();
  private readonly codes = new Map<string, ExpiringValue<CodeRecord>>();
  private readonly rates = new Map<string, RateBucket>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: InMemoryRoomStoreOptions) {
    this.now = options.now || Date.now;
    this.cleanupTimer = setInterval(
      () => this.cleanupExpired(),
      options.cleanupIntervalMs || 30_000,
    );
    this.cleanupTimer.unref();
  }

  async createRoom(
    room: RoomRecord,
    ttlSeconds: number,
    roomKey = room.code,
  ): Promise<boolean> {
    this.deleteExpiredRoom(roomKey);
    if (this.rooms.has(roomKey)) return false;
    if (this.rooms.size >= this.options.maxRooms) {
      this.cleanupExpired();
      if (this.rooms.size >= this.options.maxRooms) return false;
    }
    this.rooms.set(roomKey, {
      value: room,
      expiresAt: this.now() + ttlSeconds * 1_000,
    });
    return true;
  }

  async getRoom(
    code: string,
    roomKey = code,
  ): Promise<RoomRecord | null> {
    this.deleteExpiredRoom(roomKey);
    return this.rooms.get(roomKey)?.value || null;
  }

  async deleteRoom(code: string, roomKey = code, expectedId?: string): Promise<void> {
    if (expectedId !== undefined && this.rooms.get(roomKey)?.value.id !== expectedId) return;
    this.rooms.delete(roomKey);
  }

  async createCode(
    record: CodeRecord,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = this.codeKey(record.code, record.tokenHash);
    this.deleteExpiredCode(key);
    if (this.codes.has(key)) return false;
    if (this.codes.size >= this.options.maxCodes) {
      this.cleanupExpired();
      if (this.codes.size >= this.options.maxCodes) return false;
    }
    this.codes.set(key, {
      value: record,
      expiresAt: this.now() + ttlSeconds * 1_000,
    });
    return true;
  }

  async getCode(
    code: string,
    tokenHash: string,
  ): Promise<CodeRecord | null> {
    const key = this.codeKey(code, tokenHash);
    this.deleteExpiredCode(key);
    return this.codes.get(key)?.value || null;
  }

  async upsertCodeMember(
    code: string,
    tokenHash: string,
    member: CodeMember,
    ttlSeconds: number,
    maxMembers: number,
  ): Promise<boolean> {
    const key = this.codeKey(code, tokenHash);
    this.deleteExpiredCode(key);
    const current = this.codes.get(key);
    if (!current) return false;
    if (
      !current.value.members[member.device.deviceId] &&
      Object.keys(current.value.members).length >= maxMembers
    ) {
      return false;
    }
    current.value = {
      ...current.value,
      members: {
        ...current.value.members,
        [member.device.deviceId]: member,
      },
    };
    current.expiresAt = this.now() + ttlSeconds * 1_000;
    return true;
  }

  async deleteCode(code: string, tokenHash: string): Promise<void> {
    this.codes.delete(this.codeKey(code, tokenHash));
  }

  async isRateLimited(
    bucket: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const now = this.now();
    const current = this.rates.get(bucket);
    if (!current || current.expiresAt <= now) {
      if (current) this.rates.delete(bucket);
      if (this.rates.size >= this.options.maxRateBuckets) {
        this.cleanupExpired();
        if (this.rates.size >= this.options.maxRateBuckets) return true;
      }
      this.rates.set(bucket, {
        count: 1,
        expiresAt: now + windowSeconds * 1_000,
      });
      return false;
    }
    current.count += 1;
    return current.count > limit;
  }

  stats(): StoreStats {
    this.cleanupExpired();
    return {
      rooms: this.rooms.size,
      codes: this.codes.size,
      rateBuckets: this.rates.size,
    };
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    this.rooms.clear();
    this.codes.clear();
    this.rates.clear();
  }

  private codeKey(code: string, tokenHash: string): string {
    return `${code}:${tokenHash}`;
  }

  private deleteExpiredRoom(roomKey: string): void {
    const entry = this.rooms.get(roomKey);
    if (entry && entry.expiresAt <= this.now()) this.rooms.delete(roomKey);
  }

  private deleteExpiredCode(codeKey: string): void {
    const entry = this.codes.get(codeKey);
    if (entry && entry.expiresAt <= this.now()) this.codes.delete(codeKey);
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.rooms) {
      if (entry.expiresAt <= now) this.rooms.delete(key);
    }
    for (const [key, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(key);
    }
    for (const [key, entry] of this.rates) {
      if (entry.expiresAt <= now) this.rates.delete(key);
    }
  }
}
