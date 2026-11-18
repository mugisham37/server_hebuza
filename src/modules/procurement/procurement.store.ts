// Nest wiring for procurement: collects the injected services the world engine needs (ProcDeps), turns a request into
// a Caller (@Proc()), and holds the file helpers (uploads, PDFs).
import {
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyRequest } from "fastify";
import { DB, type Db } from "../../core/db/db";
import { TxService } from "../../core/db/tx";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { CryptoService } from "../../core/crypto/crypto.service";
import { TokenService } from "../../core/auth/tokens";
import { StorageService } from "../../core/storage/storage.service";
import type { Env } from "../../core/config/env";
import type { SessionUser } from "../../core/http/context";
import { LedgerService } from "../ledger/ledger.service";
import {
  poOf,
  procError,
  read,
  systemWrite,
  vendorName,
  vendorOf,
  type Caller,
  type ProcDeps,
} from "./procurement.world";
import { poPdf } from "./procurement.pdf";

export type RawCaller = Omit<Caller, "deps" | "db">;
type Req = FastifyRequest & { user?: SessionUser };
const header = (r: Req, h: string) => {
  const v = r.headers[h];
  return typeof v === "string" ? v : undefined;
};
export const Proc = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RawCaller => {
    const r = ctx.switchToHttp().getRequest<Req>();
    return {
      session: r.user ?? null,
      ip: r.ip,
      ifMatch: header(r, "if-match") ?? null,
      stepUpToken: header(r, "x-step-up-token"),
    };
  },
);

@Injectable()
export class ProcurementStore {
  readonly deps: ProcDeps;
  constructor(
    @Inject(DB) db: Db,
    tx: TxService,
    audit: AuditService,
    outbox: OutboxService,
    crypto: CryptoService,
    tokens: TokenService,
    storage: StorageService,
    ledger: LedgerService,
    config: ConfigService<Env, true>,
  ) {
    const prod = config.get("NODE_ENV", { infer: true }) === "production";
    this.deps = {
      db,
      tx,
      audit,
      outbox,
      crypto,
      tokens,
      storage,
      ledger,
      prod,
    };
  }

  on(raw: RawCaller): Caller {
    return { ...raw, deps: this.deps, db: this.deps.db };
  }

  /** Presigned PUT for a procurement file (vendor KYC documents). */
  presign(
    me: SessionUser,
    f: { filename: string; mime: string; size: number },
  ) {
    return this.deps.storage.presignPut({
      key: StorageService.key(me.id, "procurement"),
      contentType: f.mime,
      size: f.size,
      purpose: "procurement",
    });
  }

  /** 302 target for a vendor document. */
  async vendorDocUrl(c: Caller, id: string, docId: string) {
    const d = await read(c, (w) =>
      vendorOf(w, id)?.documents.find((x) => x.id === docId),
    );
    if (!d?.key) throw procError(404, "not_found");
    return this.deps.storage.presignGet(d.key, d.name);
  }

  /** 302 target for a PO PDF; 409 `pdf_pending` until the worker has rendered it. */
  async poPdfUrl(c: Caller, no: string) {
    const po = await read(c, (w) => poOf(w, no));
    if (!po) throw procError(404, "not_found");
    if (!po.pdfKey) throw procError(409, "pdf_pending");
    return this.deps.storage.presignGet(po.pdfKey, `${po.no}.pdf`);
  }

  /** Worker: render and store the PO PDF, then point the PO at it (re-rendered on every send). */
  async renderPo(no: string) {
    const c = { deps: this.deps, db: this.deps.db, session: null };
    const r = await read(c, (w) => {
      const po = poOf(w, no);
      return po && { po, name: vendorName(w, po.vendorId) };
    });
    if (!r) return;
    const key = `procurement/po/${r.po.no}-v${r.po.version}.pdf`;
    await this.deps.storage.putObject(key, poPdf(r.po, r.name), "application/pdf");
    await systemWrite(this.deps, (w) => {
      const po = poOf(w, no);
      if (po) po.pdfKey = key;
    });
  }
}
