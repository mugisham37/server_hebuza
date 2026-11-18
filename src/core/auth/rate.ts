// RATE_LIMIT_FACTOR scales every rate limit (load/authz test runs on staging). Ignored in the Railway production environment.
const raw = Number(process.env.RATE_LIMIT_FACTOR ?? 1);
export const RATE_FACTOR = process.env.RAILWAY_ENVIRONMENT_NAME === "production" || !(raw >= 1) ? 1 : Math.min(raw, 1000);
export const scaled = (n: number) => n * RATE_FACTOR;
