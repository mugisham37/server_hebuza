// DLV-10 dormant hook for an external e-signature provider (C3.16-f). Off until ESIGN_PROVIDER is set and a driver
// is added here; meanwhile signing is built in (typed/drawn + audit hash, documents.service sign()).
export type ESignRequest = { deliverableId: string; signerName: string; signerEmail: string | null; fileUrl: string };
export type ESignProvider = { name: string; send(r: ESignRequest): Promise<{ ref: string }> };

/** shortcut: no provider drivers yet; add one (e.g. DocuSign/Dropbox Sign) and return it for its ESIGN_PROVIDER value. */
export function eSignProvider(): ESignProvider | null {
  // Read process.env.ESIGN_PROVIDER here once a driver exists; until then every signature is built in.
  return null;
}
