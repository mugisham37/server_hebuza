import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 defaults to argon2id; Algorithm is a const enum (unusable under isolatedModules).
const OPTS = { memoryCost: 65536, timeCost: 3, parallelism: 1 };

@Injectable()
export class PasswordService {
  private readonly log = new Logger(PasswordService.name);

  hash(pw: string) {
    return hash(pw, OPTS);
  }

  private dummy?: Promise<string>;
  /** null hash (Google-only account) fails closed after an equal-time dummy verify. */
  async verify(stored: string | null, pw: string) {
    if (!stored) {
      await verify(await (this.dummy ??= this.hash("timing-equaliser")), pw).catch(() => false);
      return false;
    }
    return verify(stored, pw).catch(() => false);
  }

  /** HIBP k-anonymity range check; fail-open so an outage never blocks sign-up. */
  async isBreached(pw: string): Promise<boolean> {
    const sha = createHash("sha1").update(pw).digest("hex").toUpperCase();
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, {
        headers: { "Add-Padding": "true" },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HIBP ${res.status}`);
      const tail = sha.slice(5);
      return (await res.text()).split("\n").some((l) => l.startsWith(tail) && Number(l.split(":")[1]) > 0);
    } catch (e) {
      this.log.warn(`breach check skipped: ${(e as Error).message}`);
      return false;
    }
  }
}
