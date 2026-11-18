import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env";
import { connect } from "node:net";
import type { Readable } from "node:stream";
import { Job } from "../queue/queues";
import { StorageService } from "./storage.service";
import { TxService } from "../db/tx";
import { applicationDocuments, clientDocumentVersions, fieldScans, messageAttachments } from "@/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";

/** ClamAV INSTREAM over TCP; resolves the clamd reply, e.g. "stream: OK" / "stream: Eicar FOUND". */
function clamScan(host: string, port: number, body: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host);
    let reply = "";
    sock.setTimeout(60_000, () => sock.destroy(new Error("clamd timeout")));
    sock.on("error", reject);
    sock.on("data", (d) => { reply += d.toString(); });
    sock.on("end", () => resolve(reply.replace(/\0/g, "").trim()));
    sock.on("connect", async () => {
      try {
        sock.write("zINSTREAM\0");
        for await (const chunk of body) {
          const len = Buffer.alloc(4);
          len.writeUInt32BE((chunk as Buffer).length);
          sock.write(len);
          if (!sock.write(chunk as Buffer)) await new Promise((r) => sock.once("drain", r));
        }
        sock.end(Buffer.alloc(4)); // zero-length chunk terminates the stream
      } catch (e) { sock.destroy(e as Error); }
    });
  });
}

@Injectable()
export class ScanProcessor {
  private readonly log = new Logger("scan");
  private readonly host?: string;
  private readonly port: number;
  private readonly prod: boolean;
  constructor(c: ConfigService<Env, true>, private readonly storage: StorageService, private readonly tx: TxService) {
    const [h, p] = (c.get("CLAMAV_HOST", { infer: true }) ?? "").split(":");
    this.host = h || undefined;
    this.port = Number(p) || 3310;
    this.prod = c.get("NODE_ENV", { infer: true }) === "production";
  }

  @Job("storage.scan")
  async scan(data: unknown) {
    const { key, kind, id } = data as { key: string; kind?: string; id?: string };
    const r = await this.run(key);
    // Downloads serve only `clean`: without clamd, dev marks files clean; production fails closed (stays pending).
    if (r.status === "skipped" && this.prod) return r;
    const scanStatus = r.status === "skipped" ? "clean" : r.status;
    // Owners with a scan_status column; downloads refuse `infected` (the object is also moved to quarantine/).
    await this.tx.runAsSystem(async (db) => {
      if (kind === "chat" && id) await db.update(messageAttachments).set({ scanStatus }).where(eq(messageAttachments.id, id));
      else if (kind === "case" && id) await db.update(applicationDocuments).set({ scanStatus }).where(eq(applicationDocuments.documentId, id));
      else if (kind === "library") await db.update(clientDocumentVersions).set({ scanStatus }).where(eq(clientDocumentVersions.storagePath, key));
      else if (kind === "field")
        // a scan has several pages: infected wins, clean never overwrites infected
        await db.update(fieldScans).set({ scanStatus })
          .where(and(sql`${fieldScans.pageKeys} @> ${JSON.stringify([{ key }])}::jsonb`, ...(scanStatus === "clean" ? [ne(fieldScans.scanStatus, "infected")] : [])));
    });
    return r;
  }

  private async run(key: string) {
    if (!this.host) {
      this.log.warn({ event: "storage.scan.skipped", key, reason: "CLAMAV_HOST unset" });
      return { status: "skipped" };
    }
    const reply = await clamScan(this.host, this.port, await this.storage.getStream(key));
    if (reply.endsWith("OK")) return { status: "clean" };
    if (!reply.endsWith("FOUND")) throw new Error(`clamd: ${reply}`); // retry
    await this.storage.move(key, `quarantine/${key}`);
    this.log.warn({ event: "storage.infected", key, reply });
    return { status: "infected", signature: reply.replace(/^stream: | FOUND$/g, "") };
  }
}
