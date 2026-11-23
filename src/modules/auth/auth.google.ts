// Google sign-in (OIDC authorization code + PKCE). Browser navigations only: start/callback answer with 302s to the web,
// never JSON. Decision logic lives in auth.google.rules.ts; the session itself is AuthService.signIn (same as password).
import {
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Logger,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import type IORedis from "ioredis";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet } from "jose";
import { z } from "zod";
import { termsAcceptances, userIdentities, users } from "@/db/schema";
import { homeFor, normalizeRoles } from "@/domain/auth/roles";
import { CurrentUser } from "../../core/auth/decorators";
import type { Env } from "../../core/config/env";
import type { Tx } from "../../core/db/db";
import { AuditService } from "../../core/db/audit";
import { OutboxService } from "../../core/db/outbox";
import { assignCustomerNo } from "../../core/db/customer-no";
import { iso } from "../../core/db/ids";
import { settingOf } from "../../core/db/system-records";
import type { SessionUser } from "../../core/http/context";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { AppError } from "../../core/http/errors";
import { Route } from "../../core/http/route";
import { REDIS } from "../../core/queue/queue.module";
import { AuthService, type Http, type User } from "./auth.service";
import { genId, maskEmail, opaqueToken, sha256 } from "./auth.rules";
import {
  consumeState,
  decide,
  gate,
  landing,
  OAuthErr,
  parseRoles,
  safeNext,
  verifyIdToken,
  type GoogleClaims,
  type Intent,
  type OAuthState,
} from "./auth.google.rules";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
const LANGS = ["rw", "en", "fr"];
const stateKey = (s: string) => `auth:oauth:google:${sha256(s)}`;
const linkKey = (t: string) => `auth:oauth:link:${sha256(t)}`;
const b64 = (b: Buffer) => b.toString("base64url");

export const Identities = z.object({
  identities: z.array(
    z.object({
      provider: z.string(),
      email: z.string().nullable(),
      linkedAt: z.string(),
      lastUsedAt: z.string().nullable(),
    }),
  ),
  hasPassword: z.boolean(),
});

@Injectable()
export class GoogleAuthService {
  private readonly log = new Logger("GoogleAuth");
  constructor(
    private readonly auth: AuthService,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly cfg: ConfigService<Env, true>,
  ) {
    auth.onLinkToken = (tx, t, u) => this.consumeLink(tx, t, u);
  }

  get mock() {
    return (
      this.cfg.get("GOOGLE_OAUTH_MOCK", { infer: true }) &&
      this.cfg.get("NODE_ENV", { infer: true }) !== "production"
    );
  }
  private get creds() {
    const id = this.cfg.get("GOOGLE_OAUTH_CLIENT_ID", { infer: true });
    const secret = this.cfg.get("GOOGLE_OAUTH_CLIENT_SECRET", { infer: true });
    return id && secret ? { id, secret } : null;
  }
  get enabled() {
    return this.mock || !!this.creds;
  }
  private get web() {
    return this.cfg
      .get("WEB_ORIGIN", { infer: true })
      .split(",")[0]
      .trim()
      .replace(/\/$/, "");
  }
  private get redirectUri() {
    return `${this.web.replace(/\/$/, "")}/api/auth/oauth/google/callback`; // via the web origin (it proxies /api) so session cookies land on the web host
  }
  private errUrl(lang: string, code: string) {
    return `${this.web}/${lang}/login?oauth_error=${code}`;
  }

  async start(
    h: Http,
    me: SessionUser | null,
    q: Record<string, string | undefined>,
  ) {
    const cookieLang = h.req.cookies?.NEXT_LOCALE;
    const lang =
      [q.lang, cookieLang].find((l) => l && LANGS.includes(l)) ?? "en";
    const intent = (
      ["login", "signup", "link"].includes(q.intent ?? "") ? q.intent : "login"
    ) as Intent;
    if (!this.enabled || (intent === "link" && !me))
      return this.errUrl(lang, "failed");
    const state = b64(randomBytes(32));
    const st: OAuthState = {
      codeVerifier: b64(randomBytes(48)),
      nonce: b64(randomBytes(24)),
      intent,
      next: safeNext(q.next),
      lang,
      ...(intent === "link" && { linkUserId: me!.id }),
    };
    await this.redis.setex(stateKey(state), 600, JSON.stringify(st));
    if (this.mock) {
      const p = new URLSearchParams({ state, code: "mock" });
      for (const k of ["mock_email", "mock_sub", "mock_unverified"])
        if (q[k]) p.set(k, q[k]!);
      return `${this.redirectUri}?${p}`;
    }
    const p = new URLSearchParams({
      client_id: this.creds!.id,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce: st.nonce,
      code_challenge: b64(
        createHash("sha256").update(st.codeVerifier).digest(),
      ),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `${AUTH_URL}?${p}`;
  }

  private async claims(
    st: OAuthState,
    q: Record<string, string | undefined>,
  ): Promise<GoogleClaims> {
    if (this.mock) {
      const email = q.mock_email?.trim().toLowerCase();
      if (!email) throw new OAuthErr("failed", "mock_email required");
      if (q.mock_unverified) throw new OAuthErr("email_unverified");
      return {
        sub: q.mock_sub || `mock-${email}`,
        email,
        emailVerified: true,
        name: email.split("@")[0],
      };
    }
    const c = this.creds!;
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: q.code ?? "",
        redirect_uri: this.redirectUri,
        client_id: c.id,
        client_secret: c.secret,
        code_verifier: st.codeVerifier,
      }),
    });
    if (!r.ok) throw new OAuthErr("failed", `token ${r.status}`);
    const { id_token } = (await r.json()) as { id_token?: string };
    if (!id_token) throw new OAuthErr("failed", "no id_token");
    return verifyIdToken(id_token, JWKS, c.id, st.nonce);
  }

  /** Returns the web URL to 302 to; never throws. */
  async callback(h: Http, q: Record<string, string | undefined>) {
    let lang = "en";
    try {
      if (!this.enabled) throw new OAuthErr("failed", "disabled");
      const st = await consumeState(
        this.redis,
        q.state ? stateKey(q.state) : null,
      );
      lang = st.lang;
      if (q.error)
        throw new OAuthErr(
          q.error === "access_denied" ? "cancelled" : "failed",
          q.error,
        );
      if (!q.code) throw new OAuthErr("failed", "no code");
      const c = await this.claims(st, q);
      return await this.auth.txs.run((tx) => this.resolve(tx, h, st, c));
    } catch (e) {
      if (!(e instanceof OAuthErr)) this.log.error(e);
      else if (e.code === "failed")
        this.log.warn(`google sign-in failed: ${e.message}`);
      return this.errUrl(lang, e instanceof OAuthErr ? e.code : "failed");
    }
  }

  private identity = (tx: Tx, sub: string) =>
    tx
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, "google"),
          eq(userIdentities.subject, sub),
        ),
      )
      .then((r) => r[0]);
  private link = (
    tx: Tx,
    userId: string,
    c: Pick<GoogleClaims, "sub" | "email">,
  ) =>
    tx
      .insert(userIdentities)
      .values({
        id: genId("uid"),
        userId,
        provider: "google",
        subject: c.sub,
        email: c.email,
        emailVerified: true,
        linkedAt: iso(),
        lastUsedAt: iso(),
      });

  private async resolve(tx: Tx, h: Http, st: OAuthState, c: GoogleClaims) {
    const at = (p: string) => `${this.web}/${st.lang}${p}`;
    const ident = await this.identity(tx, c.sub);
    if (st.intent === "link") {
      if (ident && ident.userId !== st.linkUserId)
        throw new OAuthErr("already_linked");
      if (!ident) {
        await this.link(tx, st.linkUserId!, c);
        await this.audit.record(tx, {
          action: "auth.oauth.link",
          entity: "user",
          entityId: st.linkUserId!,
          after: { provider: "google", email: c.email },
        });
      }
      const sep = (st.next ?? "/settings").includes("?") ? "&" : "?";
      return at(`${st.next ?? "/settings"}${sep}oauth=linked`);
    }
    const same = await tx.select().from(users).where(eq(users.email, c.email));
    const d = decide(ident?.userId ?? null, same);
    const allowed = parseRoles(await settingOf(tx, "auth.google_roles"));
    let u: User | undefined;
    let action = "auth.oauth.login";
    if (d.kind === "link_required") {
      const token = opaqueToken("olk");
      await this.redis.setex(
        linkKey(token),
        900,
        JSON.stringify({ userId: d.userId, sub: c.sub, email: c.email }),
      );
      return at(
        `/login?oauth=link_required&email=${encodeURIComponent(maskEmail(c.email))}&link_token=${encodeURIComponent(token)}`,
      );
    }
    if (d.kind === "create") {
      if (gate({ isActive: true, role: "client" }, allowed))
        throw new OAuthErr("not_allowed");
      u = await this.createClient(tx, c, st.lang);
      action = "auth.oauth.signup";
    } else {
      u = await this.auth.getUser(tx, d.userId);
      if (!u) throw new OAuthErr("failed", "user vanished");
      if (d.link) {
        await this.link(tx, u.userId, c);
        await this.audit.record(tx, {
          action: "auth.oauth.link",
          entity: "user",
          entityId: u.userId,
          after: { provider: "google", email: c.email },
        });
      }
    }
    const g = gate(u, allowed);
    if (g) throw new OAuthErr(g);
    await tx
      .update(userIdentities)
      .set({ lastUsedAt: iso() })
      .where(
        and(
          eq(userIdentities.provider, "google"),
          eq(userIdentities.subject, c.sub),
        ),
      );
    const r = await this.auth.signIn(tx, h, u, c.email);
    await this.audit.record(tx, {
      action,
      entity: "user",
      entityId: u.userId,
      after: { provider: "google" },
    });
    const next = st.next ?? homeFor(normalizeRoles({ role: u.role }));
    return landing(this.web, st.lang, next, r.mfaRequired);
  }

  private async createClient(tx: Tx, c: GoogleClaims, lang: string) {
    const t = iso();
    const [u] = await tx
      .insert(users)
      .values({
        userId: genId("usr"),
        name: c.name?.trim() || c.email.split("@")[0],
        email: c.email,
        phoneE164: null,
        passwordHash: null,
        role: "client",
        isActive: true,
        isEmailVerified: true,
        language: lang,
        createdAt: t,
        updatedAt: t,
      })
      .returning();
    await assignCustomerNo(tx, u.userId);
    await tx
      .insert(termsAcceptances)
      .values({
        id: genId("terms"),
        userId: u.userId,
        policyVersion: "2026-05-auth-bootstrap",
        acceptedAt: t,
      });
    await this.outbox.add(tx, {
      type: "auth.user.signed_up",
      payload: { userId: u.userId, role: "client" },
    });
    await this.link(tx, u.userId, c);
    return u;
  }

  /** Pending link from link_required, consumed by the next correct password for that same account. */
  private async consumeLink(tx: Tx, token: string, u: User) {
    const raw = await this.redis.getdel(linkKey(token));
    const p = raw
      ? (JSON.parse(raw) as { userId: string; sub: string; email: string })
      : null;
    if (!p || p.userId !== u.userId || (await this.identity(tx, p.sub))) return;
    await this.link(tx, u.userId, p);
    if (u.email === p.email)
      await tx
        .update(users)
        .set({ isEmailVerified: true, updatedAt: iso() })
        .where(eq(users.userId, u.userId));
    await this.audit.record(tx, {
      action: "auth.oauth.link",
      entity: "user",
      entityId: u.userId,
      after: { provider: "google", email: p.email },
    });
  }

  identities(me: SessionUser) {
    return this.auth.txs.run(async (tx) => {
      const u = await this.auth.getUser(tx, me.id);
      const rows = await tx
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.userId, me.id));
      return {
        identities: rows.map((r) => ({
          provider: r.provider,
          email: r.email,
          linkedAt: new Date(r.linkedAt).toISOString(),
          lastUsedAt: r.lastUsedAt
            ? new Date(r.lastUsedAt).toISOString()
            : null,
        })),
        hasPassword: !!u?.passwordHash,
      };
    });
  }

  unlink(me: SessionUser) {
    return this.auth.txs.run(async (tx) => {
      if (!(await this.auth.getUser(tx, me.id))?.passwordHash)
        throw new AppError(
          409,
          "last_sign_in_method",
          "Set a password before removing Google sign-in.",
        );
      const gone = await tx
        .delete(userIdentities)
        .where(
          and(
            eq(userIdentities.userId, me.id),
            eq(userIdentities.provider, "google"),
          ),
        )
        .returning({ id: userIdentities.id });
      if (gone.length)
        await this.audit.record(tx, {
          action: "auth.oauth.unlink",
          entity: "user",
          entityId: me.id,
          after: { provider: "google" },
        });
      return { removed: gone.length > 0 };
    });
  }
}

type Rq = FastifyRequest;
type Rp = FastifyReply;
type Q = Record<string, string | undefined>;

@Controller()
export class GoogleAuthController {
  constructor(private readonly g: GoogleAuthService) {}

  /** Browser navigation: 302 to Google (or to the callback in mock mode). intent=login|signup|link, next=/path, lang. */
  @Get("auth/oauth/google/start")
  @Route({ auth: "public", limit: "auth" })
  @RawResponse()
  async start(
    @Query() q: Q,
    @CurrentUser() me: SessionUser | null,
    @Req() req: Rq,
    @Res() reply: Rp,
  ) {
    return reply
      .header("cache-control", "no-store")
      .redirect(await this.g.start({ req, reply }, me, q), 302);
  }

  /** Google's redirect target (top-level GET, so the Origin/CSRF guard doesn't apply). Always 302s to the web. */
  @Get("auth/oauth/google/callback")
  @Route({ auth: "public", limit: "auth" })
  @RawResponse()
  async callback(@Query() q: Q, @Req() req: Rq, @Res() reply: Rp) {
    return reply
      .header("cache-control", "no-store")
      .redirect(await this.g.callback({ req, reply }, q), 302);
  }

  @Get("me/identities")
  @Route({ auth: "user", out: Identities })
  identities(@CurrentUser() me: SessionUser) {
    return this.g.identities(me);
  }

  @Delete("me/identities/google")
  @Route({
    auth: "user",
    stepUp: true,
    out: z.object({ removed: z.boolean() }),
  })
  unlink(@CurrentUser() me: SessionUser) {
    return this.g.unlink(me);
  }
}
