// One rule for every seed: never production. Staging images run NODE_ENV=production, so they opt in with ALLOW_SEED=staging.
export const seedAllowed = () =>
  process.env.NODE_ENV !== "production" || (process.env.ALLOW_SEED === "staging" && process.env.RAILWAY_ENVIRONMENT_NAME === "staging");
export const assertSeedAllowed = () => {
  if (!seedAllowed()) throw new Error("refusing to seed production");
};
