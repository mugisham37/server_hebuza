// Copy of the type block of web/src/lib/marketing/crm.ts (the web file is a React hooks module).
import type { ConsentState, Channel, CrmNote, CrmTask, Lead, LeadActivity, LeadSource, Touch, Locale } from "@/domain/marketing/types";
export type LeadKpi = { total: number; new: number; contacted: number; qualified: number; quote_sent: number; wonMonth: number; lost: number };
export type ConsentEvent = { channel: Channel; state: ConsentState; at: string; source: string };
export type LeadDetail = { lead: Lead; activities: LeadActivity[]; tasks: CrmTask[]; notes: CrmNote[]; duplicates: Lead[]; consentHistory: ConsentEvent[]; retentionAt: string; revenue: number };
export type LeadPatch = Partial<Pick<Lead, "stage" | "lostReason" | "lostNote" | "ownerId" | "nextActionAt" | "estimatedValue" | "tags" | "serviceInterest">>;
export type NewLead = { source: LeadSource; name: string; org?: string; phone?: string; email?: string; language: Locale; serviceInterest: string[]; consent: Record<Channel, ConsentState>; nextActionAt: string; ownerId?: string; force?: boolean };
export type ImportRow = { i: number; data: { name: string; phone?: string; email?: string; org?: string; service?: string; consent: Record<Channel, ConsentState> }; errors: string[]; dupInFile: boolean; dupInCrm?: string };
export type CustomerRow = { id: string; name: string; org?: string; customerId?: string; language: Locale; sector: string; lifetime: number; lastActiveAt: string; consent: Record<Channel, ConsentState>; phoneMasked: string; leads: number; match?: "phone" | "email" | "both" };
export type TimelineEvent = { id: string; kind: "visit" | "form" | "booking" | "case" | "status" | "quote" | "invoice" | "payment" | "message" | "campaign" | "rating" | "note" | "account" | "ai"; title: string; at: string; meta?: string };
export type Customer360 = CustomerRow & {
  district: string; size: string; subscription?: string; ownerId?: string; spark: number[]; timeline: TimelineEvent[];
  cases: { ref: string; service: string; status: string; at: string }[]; comms: { id: string; channel: string; subject: string; at: string; dir: "in" | "out" }[];
  tasks: CrmTask[]; notes: CrmNote[]; firstTouch?: Touch; lastTouch?: Touch; recommended: string[]; related: { cases: number; messages: number; ratings: number; campaigns: number };
  leadIds: string[]; candidates: { id: string; name: string; by: "phone" | "email" | "both" }[];
};

