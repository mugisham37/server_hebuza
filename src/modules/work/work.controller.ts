// Reference work route table (52 routes): external agents (/api/work/x/*, /api/agent/x/* extras), public /join, the SM
// application review, and the staff-side decisions. PDFs are the dependency-free text PDF (chat textPdf).
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Route } from "../../core/http/route";
import { RawResponse } from "../../core/http/envelope.interceptor";
import { AuthService } from "../auth/auth.service";
import { textPdf } from "../chat/chat.service";
import { err } from "../ops/lib/ctx";
import { Req, type OpsReq } from "../ops/ops.runner";
import * as w from "./work.service";
import * as j from "./work.join";
import * as D from "./work.dto";
import { WorkRunner } from "./work.runner";
import { userOf } from "./work.store";

const { EXT, SM, SM_READ, FIN, FIN_ONLY } = D;
const rwf = (n: number) => `RWF ${n.toLocaleString("en")}`;
const file = (
  reply: FastifyReply,
  type: string,
  name: string,
  body: Buffer | string,
) =>
  reply
    .header("content-type", type)
    .header("content-disposition", `attachment; filename="${name}"`)
    .send(body);
const pdf = (
  reply: FastifyReply,
  name: string,
  title: string,
  lines: string[],
) => file(reply, "application/pdf", name, textPdf(title, lines));
const oneOf = <T extends string>(v: string, ok: readonly T[]): T => {
  if (!(ok as readonly string[]).includes(v)) throw err.notFound();
  return v as T;
};

@Controller()
export class WorkJoinController {
  constructor(
    private readonly w: WorkRunner,
    private readonly auth: AuthService,
  ) {}

  @Get("public/x/applications/services")
  @Route({ auth: "public", limit: "read" })
  services(@Req() r: OpsReq) {
    return this.w.run(r, (c) => j.publicServices(c.db));
  }
  @Post("public/x/applications")
  @Route({ auth: "public", limit: "auth", audit: "application.submitted" })
  submit(@Req() r: OpsReq, @Body() b: D.JoinSubmitDto) {
    return this.w.run(r, (c) => j.submit(c, b));
  }
  @Post("public/x/applications/:ref/otp")
  @Route({ auth: "public", limit: "auth" })
  otp(@Req() r: OpsReq, @Param("ref") ref: string, @Body() b: D.JoinOtpDto) {
    return this.w.run(r, (c) => j.sendOtp(c, ref, b.email));
  }
  @Post("public/x/applications/:ref/verify")
  @Route({ auth: "public", limit: "auth" })
  async verify(
    @Req() r: OpsReq,
    @Param("ref") ref: string,
    @Body() b: D.JoinVerifyDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { view, token } = await this.w.run(r, (c) => j.verify(c, ref, b));
    this.auth.setCookie(reply, j.COOKIE, token, j.COOKIE_TTL_S);
    return view;
  }
  @Put("public/x/applications/:ref")
  @Route({ auth: "public", limit: "auth", audit: "application.resubmitted" })
  resubmit(
    @Req() r: OpsReq,
    @Param("ref") ref: string,
    @Body() b: D.JoinResubmitDto,
  ) {
    return this.w.run(r, (c) => j.resubmit(c, ref, b));
  }
  @Get("ops/x/applications")
  @Route({ auth: SM_READ })
  list(@Req() r: OpsReq) {
    return this.w.run(r, (c) => j.list(c.db));
  }
  @Get("ops/x/applications/:ref")
  @Route({ auth: SM_READ })
  get(@Req() r: OpsReq, @Param("ref") ref: string) {
    return this.w.run(r, (c) => j.get(c.db, ref));
  }
  @Post("ops/x/applications/:ref/decision")
  @Route({ auth: SM_READ, limit: "write", audit: "application.decided" })
  decide(
    @Req() r: OpsReq,
    @Param("ref") ref: string,
    @Body() b: D.JoinDecisionDto,
  ) {
    return this.w.run(r, (c) => j.decide(c, ref, b, this.w.provision));
  }
}

@Controller()
export class WorkController {
  constructor(private readonly w: WorkRunner) {}

  // ── onboarding ──
  @Get("work/x/scope/:ref")
  @Route({ auth: EXT })
  scope(@Req() r: OpsReq, @Param("ref") ref: string) {
    return this.w.run(r, (c) => w.scopeView(c.db, c.session, ref));
  }
  @Get("work/x/onboarding")
  @Route({ auth: EXT })
  onboarding(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.onboarding(c));
  }
  @Put("work/x/onboarding")
  @Route({ auth: EXT })
  saveOnboarding(@Req() r: OpsReq, @Body() b: D.OnboardingDto) {
    return this.w.run(r, (c) => w.saveOnboarding(c, b));
  }
  @Post("work/x/kyc/upload")
  @Route({ auth: EXT, audit: "kyc.submitted" })
  kyc(@Req() r: OpsReq, @Body() b: D.KycDto) {
    return this.w.run(r, (c) => w.kycUpload(c, b));
  }
  @Post("work/x/onboarding/sign/:docId")
  @Route({ auth: EXT, audit: "contract.signed" })
  signOnboarding(
    @Req() r: OpsReq,
    @Param("docId") id: string,
    @Body() b: D.SignDto,
  ) {
    return this.w.run(r, (c) => w.signOnboarding(c, id, b));
  }
  @Post("work/x/onboarding/submit")
  @Route({ auth: EXT, audit: "worker.onboarding_submitted" })
  submitOnboarding(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.submitOnboarding(c));
  }
  @Get("work/x/credentials")
  @Route({ auth: EXT })
  credentials(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.credentials(c.db, c.session));
  }
  @Post("work/x/credentials")
  @Route({ auth: EXT, audit: "credential.submitted" })
  addCredential(@Req() r: OpsReq, @Body() b: D.CredentialDto) {
    return this.w.run(r, (c) => w.addCredential(c, b));
  }
  @Put("work/x/credentials/:id")
  @Route({ auth: EXT, audit: "credential.submitted" })
  replaceCredential(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: D.CredentialReplaceDto,
  ) {
    return this.w.run(r, (c) => w.replaceCredential(c, id, b));
  }

  // ── jobs ──
  @Post("agent/x/offers/:id/counter")
  @Route({ auth: EXT, limit: "write", audit: "offer.countered" })
  counter(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.CounterDto) {
    return this.w.run(r, (c) => w.counter(c, id, b));
  }
  @Get("agent/x/cases/:code/documents/:id/download")
  @Route({ auth: EXT, limit: "read", audit: "document.downloaded" })
  download(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Param("id") id: string,
  ) {
    return this.w.run(r, (c) => w.download(c, code, id));
  }
  @Get("agent/x/cases/:code/instructions")
  @Route({ auth: EXT })
  instructions(@Req() r: OpsReq, @Param("code") code: string) {
    return this.w.run(r, (c) => w.instructions(c.db, c.session, code));
  }
  @Get("work/x/cases/:code/access-requests")
  @Route({ auth: EXT })
  accessRequests(@Req() r: OpsReq, @Param("code") code: string) {
    return this.w.run(r, (c) => w.accessRequests(c.db, c.session, code));
  }
  @Post("work/x/cases/:code/access-requests")
  @Route({ auth: EXT, audit: "access.requested" })
  requestAccess(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.AccessRequestDto,
  ) {
    return this.w.run(r, (c) => w.requestAccess(c, code, b));
  }
  @Post("agent/x/cases/:code/handback")
  @Route({ auth: EXT, audit: "case.handback_requested" })
  handback(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.HandbackDto,
  ) {
    return this.w.run(r, (c) => w.handback(c, code, b));
  }
  @Get("work/x/cases/:code/contributions")
  @Route({ auth: EXT })
  contributions(@Req() r: OpsReq, @Param("code") code: string) {
    return this.w.run(r, (c) => w.contributions(c.db, c.session, code));
  }

  // ── money ──
  @Get("work/x/statements")
  @Route({ auth: EXT })
  statements(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.statements(c.db, c.session));
  }
  @Get("work/x/statements/:month")
  @Route({ auth: EXT })
  async statement(@Req() r: OpsReq, @Param("month") month: string) {
    return (await this.w.run(r, (c) => w.statement(c.db, c.session, month))).st;
  }
  @Get("work/x/statements/:month/file")
  @Route({ auth: EXT, limit: "read", audit: "statement.downloaded" })
  @RawResponse()
  async statementFile(
    @Req() r: OpsReq,
    @Param("month") month: string,
    @Query() q: D.FileQueryDto,
    @Res() reply: FastifyReply,
  ) {
    const { a, st } = await this.w.run(r, (c) =>
      w.statement(c.db, c.session, month),
    );
    if (q.format === "csv") {
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const body = [
        "ref,service,eligible,rate,share",
        ...st.jobs.map(
          (x) =>
            `${esc(x.ref)},${esc(x.service)},${x.eligible},${esc(x.rate)},${x.share}`,
        ),
        `,,,gross,${st.gross}`,
        `,,,adjustments,${st.adjustments}`,
        `,,,wht,-${st.wht}`,
        `,,,licence,-${st.licence}`,
        `,,,net,${st.net}`,
      ].join("\n");
      return file(reply, "text/csv; charset=utf-8", `${st.number}.csv`, body);
    }
    return pdf(reply, `${st.number}.pdf`, `Statement ${st.number}`, [
      a.name,
      `Period ${st.month}`,
      "",
      ...st.jobs.map(
        (x) =>
          `${x.ref}  ${x.service}  eligible ${rwf(x.eligible)}  ${x.rate}  share ${rwf(x.share)}`,
      ),
      "",
      `Gross ${rwf(st.gross)}`,
      `Adjustments ${rwf(st.adjustments)}`,
      `Withholding tax -${rwf(st.wht)}`,
      `Licence fee -${rwf(st.licence)}`,
      `Net ${rwf(st.net)}`,
      ...(st.carry ? [`Carried to next month ${rwf(st.carry)}`] : []),
    ]);
  }
  @Get("work/x/payouts")
  @Route({ auth: EXT })
  payouts(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.payouts(c.db, c.session));
  }
  @Get("work/x/invoices")
  @Route({ auth: EXT })
  invoices(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.invoices(c.db, c.session));
  }
  @Post("work/x/invoices")
  @Route({ auth: EXT, audit: "invoice.uploaded" })
  uploadInvoice(@Req() r: OpsReq, @Body() b: D.InvoiceDto) {
    return this.w.run(r, (c) => w.uploadInvoice(c, b));
  }

  // ── contract ──
  @Get("work/x/contract")
  @Route({ auth: EXT })
  contract(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.contract(c.db, c.session));
  }
  @Get("work/x/contract/:docId/file")
  @Route({ auth: EXT, limit: "read" })
  @RawResponse()
  async contractFile(
    @Req() r: OpsReq,
    @Param("docId") id: string,
    @Res() reply: FastifyReply,
  ) {
    const { a, d } = await this.w.run(r, (c) =>
      w.contractPdfData(c.db, c.session, id),
    );
    return pdf(
      reply,
      `${d.kind}-v${d.version}.pdf`,
      `${d.title} v${d.version}`,
      [
        `Between HEBUZA and ${a.name}`,
        `From ${d.start}${d.end ? ` to ${d.end}` : ""}${d.noticeDays ? ` - ${d.noticeDays} days' notice` : ""}`,
        "",
        ...d.terms.map((t, i) => `${i + 1}. ${t}`),
        "",
        ...(d.signedAt && d.evidence
          ? [
              `Signed by ${d.evidence.typedName} on ${d.signedAt}`,
              `IP ${d.evidence.ip} - SHA-256 ${d.evidence.sha256}`,
            ]
          : ["Not signed yet."]),
      ],
    );
  }
  @Get("work/x/licence/:number/file")
  @Route({ auth: EXT, limit: "read" })
  @RawResponse()
  async licenceFile(
    @Req() r: OpsReq,
    @Param("number") n: string,
    @Res() reply: FastifyReply,
  ) {
    const { a, l } = await this.w.run(r, (c) =>
      w.licencePdfData(c.db, c.session, n),
    );
    return pdf(reply, `${l.number}.pdf`, `Licence fee invoice ${l.number}`, [
      `Billed to ${a.name}`,
      `Period ${l.period}`,
      `Amount ${rwf(l.amount)}`,
      `Due ${l.due}`,
      `Status ${l.status}`,
    ]);
  }
  @Post("work/x/contract/:docId/sign")
  @Route({ auth: EXT, audit: "contract.signed" })
  sign(@Req() r: OpsReq, @Param("docId") id: string, @Body() b: D.SignDto) {
    return this.w.run(r, (c) => w.signContract(c, id, b));
  }
  @Post("work/x/contract/renew")
  @Route({ auth: EXT, audit: "contract.renewed" })
  renew(@Req() r: OpsReq, @Body() _b: D.RenewDto) {
    return this.w.run(r, (c) => w.renew(c));
  }
  @Post("work/x/contract/notice")
  @Route({ auth: EXT, audit: "contract.notice_given" })
  notice(@Req() r: OpsReq, @Body() b: D.NoticeDto) {
    return this.w.run(r, (c) => w.giveNotice(c, b.reason));
  }
  @Post("work/x/rates/requests")
  @Route({ auth: EXT, audit: "rate.change_proposed" })
  requestRate(@Req() r: OpsReq, @Body() b: D.RateRequestDto) {
    return this.w.run(r, (c) => w.requestRate(c, b));
  }
  @Post("work/x/licence/:number/:how")
  @Route({ auth: EXT, limit: "write", audit: "licence.settled" })
  licence(
    @Req() r: OpsReq,
    @Param("number") n: string,
    @Param("how") how: string,
    @Body() b: D.LicenceDto,
  ) {
    const h = oneOf(how, ["pay", "net"] as const);
    return this.w.run(r, (c) => w.licence(c, n, h, b.phone));
  }
  @Put("work/x/payout-destination")
  @Route({
    auth: EXT,
    stepUp: true,
    limit: "write",
    audit: "payout_destination.change_requested",
  })
  payoutDestination(@Req() r: OpsReq, @Body() b: D.PayoutDestDto) {
    return this.w.run(r, (c) => w.setPayoutDestination(c, b));
  }

  // ── firm ──
  @Get("work/x/firm")
  @Route({ auth: EXT })
  firm(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.firm(c.db, c.session));
  }
  @Post("work/x/firm/members")
  @Route({ auth: EXT, audit: "firm.member_invited" })
  invite(@Req() r: OpsReq, @Body() b: D.InviteMemberDto) {
    return this.w.run(r, (c) => w.inviteMember(c, b));
  }
  @Post("work/x/firm/members/:id/removal")
  @Route({ auth: EXT, audit: "firm.member_removal_requested" })
  removal(@Req() r: OpsReq, @Param("id") id: string, @Body() b: D.ReasonDto) {
    return this.w.run(r, (c) => w.requestRemoval(c, id, b.reason));
  }
  @Post("work/x/firm/jobs/:code/assign")
  @Route({ auth: EXT, audit: "firm.job_assigned" })
  firmAssign(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.FirmAssignDto,
  ) {
    return this.w.run(r, (c) => w.assignInternally(c, code, b.memberId));
  }
}

/** Staff-side decisions for the ops/finance screens. */
@Controller()
export class WorkStaffController {
  constructor(private readonly w: WorkRunner) {}

  /** Staff view of an external worker's pending items (onboarding, access, rates, invoices, payout) for the decisions below. */
  @Get("staff/payout-destinations/pending")
  @Route({ auth: FIN_ONLY, permission: "sup.bank.verify" })
  pendingDestinations(@Req() r: OpsReq) {
    return this.w.run(r, (c) => w.pendingDestinations(c.db));
  }
  @Get("staff/workers/:id/work")
  @Route({ auth: [...SM_READ, ...FIN_ONLY] })
  staffWork(@Req() r: OpsReq, @Param("id") id: string) {
    return this.w.run(r, (c) => w.staffWork(c.db, id));
  }
  @Post("staff/workers/:id/onboarding/decision")
  @Route({
    auth: SM,
    permission: "wrk.profiles.verify",
    audit: "worker.onboarding_decided",
  })
  async onboarding(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Body() b: D.OnboardingDecisionDto,
  ) {
    await this.w.run(r, (c) => w.decideOnboarding(c, id, b));
    return { decided: b.decision };
  }
  @Post("staff/workers/:id/access-requests/:opId/decision")
  @Route({ auth: SM, audit: "access.decided" })
  access(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Param("opId") op: string,
    @Body() b: D.GrantDto,
  ) {
    return this.w.run(r, async (c) =>
      w.decideAccess(c, id, op, b.grant, await managerName(c)),
    );
  }
  @Post("staff/workers/:id/jobs/:code/end-access")
  @Route({ auth: SM, audit: "access.ended" })
  endAccess(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Param("code") code: string,
  ) {
    return this.w.run(r, (c) => w.endAccess(c, id, code, false));
  }
  @Post("staff/workers/:id/jobs/:code/client-lane")
  @Route({ auth: SM, audit: "access.client_lane_toggled" })
  clientLane(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Param("code") code: string,
  ) {
    return this.w.run(r, (c) => w.setClientLane(c, id, code));
  }
  @Post("staff/work/cases/:code/instructions")
  @Route({ auth: SM, audit: "case.instructions_updated" })
  instructions(
    @Req() r: OpsReq,
    @Param("code") code: string,
    @Body() b: D.InstructionsDto,
  ) {
    return this.w.run(r, async (c) =>
      w.addInstructionVersion(c, code, b.text, await managerName(c)),
    );
  }
  @Post("staff/work/offers/:id/counter/:decision")
  @Route({ auth: SM, audit: "offer.counter_decided" })
  counter(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Param("decision") d: string,
  ) {
    const accept = oneOf(d, ["accept", "decline"] as const) === "accept";
    return this.w.run(r, (c) => w.decideCounter(c, id, accept));
  }
  @Post("staff/work/rates/:owner/:serviceId/:action")
  @Route({ auth: FIN, audit: "rate.change_decided" })
  rate(
    @Req() r: OpsReq,
    @Param("owner") owner: string,
    @Param("serviceId") svc: string,
    @Param("action") action: string,
  ) {
    const approve = oneOf(action, ["approve", "reject"] as const) === "approve";
    return this.w.run(r, async (c) =>
      w.decideRate(c, owner, svc, approve, await managerName(c)),
    );
  }
  @Post("staff/workers/:id/invoices/:invId/decision")
  @Route({ auth: FIN, audit: "invoice.decided" })
  invoice(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Param("invId") inv: string,
    @Body() b: D.InvoiceDecisionDto,
  ) {
    return this.w.run(r, (c) =>
      w.decideInvoice(c, id, b.decision, inv, b.note),
    );
  }
  @Post("staff/workers/:id/payout-destination/:result")
  @Route({
    auth: FIN_ONLY,
    permission: "sup.bank.verify",
    audit: "payout_destination.decided",
  })
  destination(
    @Req() r: OpsReq,
    @Param("id") id: string,
    @Param("result") result: string,
  ) {
    const verify = oneOf(result, ["verify", "fail"] as const) === "verify";
    return this.w.run(r, (c) => w.decideDestination(c, id, verify));
  }
}

const managerName = async (c: {
  db: Parameters<typeof userOf>[0];
  session: { id: string };
}) => (await userOf(c.db, c.session.id))?.name ?? "Service manager";
