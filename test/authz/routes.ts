// Route oracle: reads the real decorator metadata off every controller (no DI boot), so expectations track the code.
import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { PERMIT, PUBLIC } from "../../src/core/auth/decorators";
const ROUTE = "route:opts"; // mirrors src/core/http/route.ts (not exported)

export type RouteMeta = { method: string; path: string; public: boolean; roles?: readonly string[]; perms?: string[] };

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);

export async function loadRoutes(): Promise<RouteMeta[]> {
  const src = join(__dirname, "../../src");
  const files = walk(src).filter((f) => f.endsWith(".ts") && readFileSync(f, "utf8").includes("@Controller("));
  const out: RouteMeta[] = [];
  for (const f of files) {
    for (const C of Object.values(await import(f)) as ({ prototype: object } & (() => void))[]) {
      if (typeof C !== "function" || Reflect.getMetadata(PATH_METADATA, C) === undefined) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, C) ?? "");
      for (const k of Object.getOwnPropertyNames(C.prototype)) {
        const fn = (C.prototype as Record<string, unknown>)[k];
        if (typeof fn !== "function" || Reflect.getMetadata(PATH_METADATA, fn) === undefined) continue;
        const subs = [Reflect.getMetadata(PATH_METADATA, fn)].flat().map(String);
        const pick = <T>(key: string) => (Reflect.getMetadata(key, fn) ?? Reflect.getMetadata(key, C)) as T | undefined;
        const r = pick<{ auth?: unknown }>(ROUTE);
        for (const sub of subs) out.push({
          method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number],
          path: ("/" + [base, sub].filter((s) => s && s !== "/").join("/")).replace(/\/+/g, "/"),
          public: !!pick<boolean>(PUBLIC),
          roles: Array.isArray(r?.auth) ? r.auth : undefined,
          perms: pick<string[]>(PERMIT),
        });
      }
    }
  }
  return out;
}
