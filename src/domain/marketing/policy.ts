// Marketing policy defaults (PLACEHOLDER business values) for code outside src/mocks; the server overlays the
// "policy" settings document on top (marketing.store.ts policy()).
export { MKT_POLICY } from "@/domain/policy";
export type MktPolicy = typeof import("@/domain/policy").MKT_POLICY;
