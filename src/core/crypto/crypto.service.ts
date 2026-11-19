import { Global, Injectable, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";
import { blindIndex, decrypt, encrypt, key32 } from "@/domain/crypto";

/** Constant-time string equality. */
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Injectable()
export class CryptoService {
  private readonly fieldKey: Buffer;
  /** SEC-rotation: ciphertexts written under the outgoing FIELD_KEY still decrypt until the re-encryption job finishes. */
  private readonly prevFieldKey?: Buffer;
  private readonly indexKey: Buffer;
  constructor(c: ConfigService) {
    this.fieldKey = key32(c.getOrThrow<string>("FIELD_KEY"), "FIELD_KEY");
    const prev = c.get<string>("FIELD_KEY_PREVIOUS");
    if (prev) this.prevFieldKey = key32(prev, "FIELD_KEY_PREVIOUS");
    this.indexKey = key32(c.getOrThrow<string>("BLIND_INDEX_KEY"), "BLIND_INDEX_KEY");
  }

  encrypt(plain: string): string {
    return encrypt(this.fieldKey, plain);
  }

  decrypt(cipher: string): string {
    try {
      return decrypt(this.fieldKey, cipher);
    } catch (e) {
      if (!this.prevFieldKey) throw e;
      return decrypt(this.prevFieldKey, cipher); // GCM auth fails on the wrong key, so the fallback can't misread data
    }
  }

  /** Re-encrypt under the current key (rotation job); returns null when already current. */
  reencrypt(cipher: string): string | null {
    try {
      decrypt(this.fieldKey, cipher);
      return null;
    } catch {
      return this.encrypt(this.decrypt(cipher));
    }
  }

  /** Outbox payloads persist in Postgres + Redis: encrypt the secret-bearing string fields (OTP code, reset link/token) before `OutboxService.add`; the job calls `unseal`. */
  seal<T extends Record<string, unknown>>(o: T, keys: (keyof T & string)[]): T {
    return { ...o, ...Object.fromEntries(keys.filter((k) => typeof o[k] === "string").map((k) => [k, this.encrypt(o[k] as string)])) };
  }

  unseal<T extends Record<string, unknown>>(o: T, keys: (keyof T & string)[]): T {
    return { ...o, ...Object.fromEntries(keys.filter((k) => typeof o[k] === "string").map((k) => [k, this.decrypt(o[k] as string)])) };
  }

  blindIndex(value: string): string {
    return blindIndex(this.indexKey, value);
  }
}

@Global()
@Module({ providers: [CryptoService], exports: [CryptoService] })
export class CryptoModule {}
