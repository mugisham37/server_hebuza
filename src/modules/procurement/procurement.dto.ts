// Request schemas of procurement (moved verbatim from the reference route table; business rules validate the rest).
import { z } from "zod";
import { dto } from "../../core/http/dto";

const int = z.coerce.number().int();
const rwf = z.coerce.number().int().min(0).max(1e12);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/);
const text = (n = 1000) => z.string().max(n);
const reasonBody = z.object({ reason: text().optional() });
const decision = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: text().optional(),
});
const file = z.object({
  id: z.string().max(128),
  name: z.string().max(255),
  size: z.number().optional(),
  expiresOn: z.string().optional(),
});
const contact = z.object({
  name: text(120),
  role: text(120).optional(),
  phone: text(40).optional(),
  email: text(254).optional(),
});
const bankKind = z.enum(["bank", "momo", "airtel"]);

const Limits = z
  .object({
    financeMax: rwf,
    quoteThreshold: rwf,
    quotesRequired: int.min(0).max(10),
    tolerancePct: z.coerce.number().min(0).max(100),
    toleranceMin: rwf,
    lockHours: int.min(0).max(24 * 30),
    reminderOffsets: z.array(int.min(0).max(3650)).max(10),
    budgetWarnPct: int.min(0).max(100),
    depositReturnDays: int.min(0).max(3650),
    vatRoundingTolerance: int.min(0).max(1000),
  })
  .partial();
const Proposal = z.object({
  limits: Limits.optional(),
  budgets: z
    .array(z.object({ code: z.string().max(32), annualBudget: rwf }))
    .max(200)
    .optional(),
  effectiveOn: z.string().max(32).default(""),
  reason: text().default(""),
});
const VendorIn = z.object({
  legalName: text(200).default(""),
  tradingName: text(200).optional(),
  type: z.enum(["landlord", "supplier", "service_provider", "government_body"]),
  tin: z.string().max(32).default(""),
  rdbNumber: text(64).optional(),
  categories: z.array(z.string().max(32)).max(50).optional(),
  contacts: z.array(contact).max(20).optional(),
  address: text(300).optional(),
  paymentTermsDays: int.min(0).max(365).optional(),
  vatRegistered: z.boolean().optional(),
  rating: int.min(0).max(5).optional(),
  bank: z
    .object({ kind: bankKind, label: text(64), number: z.string().max(64) })
    .optional(),
});
const VendorPatch = VendorIn.partial();
const ContractIn = z
  .object({
    vendorId: z.string().max(64),
    kind: z.enum(["lease", "service", "supply", "other"]),
    title: text(200),
    startOn: date,
    endOn: date,
    amount: rwf,
    frequency: z.enum(["one_off", "monthly", "quarterly", "annual"]),
    dueDay: int.min(1).max(31),
    escalationPercent: z.coerce.number().min(0).max(100),
    noticeDays: int.min(0).max(3650),
    autoRenew: z.boolean(),
    depositAmount: rwf,
    budgetCategory: z.string().max(32),
  })
  .partial();
const AdvanceIn = z.object({
  kind: z.enum(["advance", "prepayment", "deposit", "refund", "credit_note"]),
  vendorId: z.string().max(64),
  amount: rwf,
  contractRef: z.string().max(64).optional(),
  note: text(500).optional(),
  returnDueOn: z.string().max(32).optional(),
});
const LineIn = z.object({
  id: z.string().max(32).optional(),
  description: text(300),
  qty: z.coerce.number().positive().max(1e6),
  unitPrice: rwf,
});
const PrBody = z.object({
  title: text(200).optional(),
  lines: z.array(LineIn).max(100).optional(),
  budgetCategory: z.string().max(32).optional(),
  neededBy: z.string().max(32).optional(),
  justification: z.string().max(5000).optional(),
  vendorId: z.string().max(64).optional(),
  vendorFreeText: text(200).optional(),
  quotes: z
    .array(file.extend({ vendorName: text(200), amount: rwf }))
    .max(20)
    .optional(),
  chosenQuoteId: z.string().max(128).optional(),
  chosenReason: text().optional(),
  waiveReason: text().optional(),
  workspace: z.string().max(32).optional(),
  draft: z.boolean().optional(),
  reason: text().optional(),
  note: text().optional(),
});
const PoBody = z.object({
  prNo: z.string().max(64),
  vendorId: z.string().max(64),
  lines: z.array(LineIn).max(100),
  deliveryAddress: text(300).default(""),
  paymentTermsDays: int.min(0).max(365).default(30),
  neededBy: z.string().max(32).default(""),
  send: z.boolean().optional(),
});
const PoAction = z.object({
  reason: text().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().max(32),
        qty: z.coerce.number().int(),
        condition: z.enum(["good", "damaged", "rejected"]).default("good"),
        note: text(500).optional(),
      }),
    )
    .max(100)
    .optional(),
  receivedById: z.string().max(64).optional(),
  receivedAt: z.string().max(40).optional(),
  evidence: z.object({ name: z.string().max(255), uploadId: z.string().max(96).optional() }).optional(),
  notes: text().optional(),
  service: z.boolean().optional(),
  reverses: z.string().max(64).optional(),
});
const BillLine = z.object({
  id: z.string().max(32),
  description: text(300),
  qty: z.coerce.number().positive().max(1e6),
  unitPrice: rwf,
  vatable: z.boolean().default(true),
});
const BillBody = z.object({
  vendorId: z.string().max(64).default(""),
  vendorInvoiceNo: text(64).default(""),
  invoiceDate: z.string().max(32).default(""),
  dueOn: z.string().max(32).optional(),
  poNo: z.string().max(64).optional(),
  contractRef: z.string().max(64).optional(),
  noPoJustification: text().optional(),
  vatMode: z.enum(["excl", "incl"]).default("excl"),
  lines: z.array(BillLine).max(100).default([]),
  file: file.optional(),
  submit: z.boolean().optional(),
});
const Correct = z.object({
  lines: z.array(BillLine).max(100).default([]),
  vatMode: z.enum(["excl", "incl"]).default("excl"),
});
const Payment = z.object({
  allocations: z
    .array(z.object({ billNo: z.string().max(64), amount: z.number() }))
    .max(100)
    .default([]),
  method: z.enum(["bank", "mtn_momo", "airtel_money"]),
  reference: text(128).default(""),
  proof: file.optional(),
});


const upload = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(128),
  size: z.number().int().positive().max(25 * 1024 * 1024),
});

export class ProposalDto extends dto(Proposal) {}
export class DecisionDto extends dto(decision) {}
export class ReasonDto extends dto(reasonBody) {}
export class VendorDto extends dto(VendorIn) {}
export class VendorPatchDto extends dto(VendorPatch) {}
export class ContractDto extends dto(ContractIn) {}
export class AdvanceDto extends dto(AdvanceIn) {}
export class PrDto extends dto(PrBody) {}
export class PoDto extends dto(PoBody) {}
export class PoActionDto extends dto(PoAction) {}
export class BillDto extends dto(BillBody) {}
export class CorrectDto extends dto(Correct) {}
export class PaymentDto extends dto(Payment) {}
export class UploadDto extends dto(upload) {}

export class HorizonQueryDto extends dto(
  z.object({ horizon: z.coerce.number().int().min(1).max(730).default(90) }),
) {}
export class TypeQueryDto extends dto(
  z.object({ type: z.string().max(32).optional() }),
) {}
export class AuditQueryDto extends dto(
  z.object({
    kind: z.string().max(64).default(""),
    id: z.string().max(128).default(""),
  }),
) {}
export class AsOfQueryDto extends dto(
  z.object({ asOf: z.string().max(32).optional() }),
) {}
export class RangeQueryDto extends dto(
  z.object({
    from: z.string().max(32).optional(),
    to: z.string().max(32).optional(),
  }),
) {}
export class DateRangeDto extends dto(z.object({ from: date, to: date })) {}
export class ExportLogDto extends dto(
  z.object({
    report: z.string().max(64),
    rows: z.coerce.number().int().min(0),
    params: z.string().max(1000).optional(),
  }),
) {}
export class VendorQueryDto extends dto(
  z.object({
    q: z.string().max(200).optional(),
    type: z.string().max(32).optional(),
    status: z.string().max(32).optional(),
    category: z.string().max(32).optional(),
    bank: z.string().max(32).optional(),
  }),
) {}
export class VendorDupQueryDto extends dto(
  z.object({
    tin: z.string().max(32).optional(),
    name: z.string().max(200).optional(),
    except: z.string().max(64).optional(),
  }),
) {}
export class VendorStatusDto extends dto(
  z.object({
    to: z.enum(["active", "inactive", "blocked"]),
    reason: text().optional(),
  }),
) {}
export class BankChangeDto extends dto(
  z.object({
    kind: bankKind.default("bank"),
    label: text(64).default(""),
    number: z.string().max(64).optional(),
    reason: text().optional(),
    doc: z.string().max(255).optional(),
  }),
) {}
export class RevealDto extends dto(
  z.object({ field: z.enum(["bank", "tin"]), reason: text().optional() }),
) {}
/** `filename/mime/size` (optional) → the response carries a presigned PUT for the file. */
export class VendorDocDto extends dto(
  z.object({
    name: z.string().max(255).optional(),
    expiresOn: z.string().max(32).optional(),
    filename: z.string().min(1).max(255).optional(),
    mime: z.string().min(1).max(128).optional(),
    size: z.number().int().positive().max(25 * 1024 * 1024).optional(),
  }),
) {}
export class VerifyBankDto extends dto(
  z.object({
    decision: z.enum(["verify", "reject"]),
    reason: text().optional(),
    callback: z
      .object({
        calledNumber: z.string().max(40).default(""),
        holderConfirmed: z.boolean(),
        last4Confirmed: z.boolean(),
        answeredBy: text(120),
      })
      .optional(),
  }),
) {}
export class ContractQueryDto extends dto(
  z.object({
    q: z.string().max(200).optional(),
    status: z.string().max(32).optional(),
    vendor: z.string().max(64).optional(),
  }),
) {}
export class RenewalDto extends dto(
  z.object({
    amount: rwf,
    endOn: z.string().max(32).default(""),
    noticeDays: int.min(0).max(3650).optional(),
    reason: text().optional(),
  }),
) {}
export class TerminateDto extends dto(
  z.object({
    effectiveOn: z.string().max(32).optional(),
    checklist: z.array(z.string().max(64)).max(20).optional(),
    reason: text().optional(),
  }),
) {}
export class ReturnDto extends dto(
  z.object({
    received: rwf,
    bankRef: text(128).optional(),
    date: z.string().max(32).optional(),
    proof: z.string().max(255).optional(),
    deductions: z
      .array(z.object({ reason: text(500).default(""), amount: rwf }))
      .max(20)
      .optional(),
  }),
) {}
export class OffsetDto extends dto(
  z.object({ billNo: z.string().max(64), amount: rwf }),
) {}
export class ApplyAdvanceDto extends dto(
  z.object({ advanceNo: z.string().max(64), amount: rwf }),
) {}
export class PrQueryDto extends dto(
  z.object({
    mine: z.string().max(4).optional(),
    status: z.string().max(32).optional(),
  }),
) {}
export class ChaseDto extends dto(
  z.object({ text: z.string().min(1).max(4000) }),
) {}
export class ReceiptQueryDto extends dto(
  z.object({ notInvoiced: z.string().max(4).optional() }),
) {}
export class BillDupQueryDto extends dto(
  z.object({
    vendorId: z.string().max(64).optional(),
    invoiceNo: z.string().max(64).optional(),
  }),
) {}
export class OverrideDto extends dto(
  z.object({ override: text().optional() }),
) {}
export class ExceptionDto extends dto(
  z.object({
    decision: z.enum(["approve", "reject"]).optional(),
    reason: text().optional(),
  }),
) {}
