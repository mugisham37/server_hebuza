// F-CRM-17 social monitoring: daily pull of yesterday's organic page metrics from Meta (Facebook page) and LinkedIn
// (organisation page) into the same social rows the manual entry / CSV import writes. Dormant until the tokens are set.
import { addSocial } from "./marketing.insights";
import { get, put, type Caller } from "./marketing.store";

type Env = { META_PAGE_ID?: string; META_PAGE_TOKEN?: string; LINKEDIN_ORG_ID?: string; LINKEDIN_TOKEN?: string };
type Day = { date: string; reach: number; impressions: number; engagements: number; clicks: number; followers: number };

const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

async function meta(e: Env): Promise<Day | null> {
  if (!e.META_PAGE_ID || !e.META_PAGE_TOKEN) return null;
  const metrics = "page_impressions_unique,page_impressions,page_post_engagements,page_total_actions,page_fans";
  const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(e.META_PAGE_ID)}/insights?metric=${metrics}&period=day&access_token=${encodeURIComponent(e.META_PAGE_TOKEN)}`);
  if (!r.ok) throw new Error(`meta ${r.status}`);
  const j = (await r.json()) as { data: { name: string; values: { value: number }[] }[] };
  const v = (n: string) => Number(j.data.find((x) => x.name === n)?.values.at(-1)?.value ?? 0);
  return { date: yesterday(), reach: v("page_impressions_unique"), impressions: v("page_impressions"), engagements: v("page_post_engagements"), clicks: v("page_total_actions"), followers: v("page_fans") };
}

async function linkedin(e: Env): Promise<Day | null> {
  if (!e.LINKEDIN_ORG_ID || !e.LINKEDIN_TOKEN) return null;
  const org = encodeURIComponent(`urn:li:organization:${e.LINKEDIN_ORG_ID}`);
  const h = { Authorization: `Bearer ${e.LINKEDIN_TOKEN}`, "LinkedIn-Version": "202401", "X-Restli-Protocol-Version": "2.0.0" };
  const [s, f] = await Promise.all([
    fetch(`https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${org}`, { headers: h }),
    fetch(`https://api.linkedin.com/rest/networkSizes/${org}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, { headers: h }),
  ]);
  if (!s.ok) throw new Error(`linkedin ${s.status}`);
  const t = ((await s.json()) as { elements?: { totalShareStatistics?: Record<string, number> }[] }).elements?.[0]?.totalShareStatistics ?? {};
  const followers = f.ok ? Number(((await f.json()) as { firstDegreeSize?: number }).firstDegreeSize ?? 0) : 0;
  return { date: yesterday(), reach: t.uniqueImpressionsCount ?? 0, impressions: t.impressionCount ?? 0, engagements: (t.likeCount ?? 0) + (t.commentCount ?? 0) + (t.shareCount ?? 0), clicks: t.clickCount ?? 0, followers };
}

export async function pullSocial(c: Caller, e: Env) {
  let n = 0;
  for (const [network, f] of [["facebook", meta], ["linkedin", linkedin]] as const) {
    let d = await f(e);
    if (!d) continue;
    if (network === "linkedin") {
      // LinkedIn returns lifetime totals: store the snapshot and write the day-over-day delta (first pull only seeds it).
      const prev = await get<Day>(c.db, "social_snapshot", network, true);
      await put(c.db, { kind: "social_snapshot", id: network, data: d });
      if (!prev) continue;
      const delta = (k: "reach" | "impressions" | "engagements" | "clicks") => Math.max(0, d![k] - prev[k]);
      d = { ...d, reach: delta("reach"), impressions: delta("impressions"), engagements: delta("engagements"), clicks: delta("clicks") };
    }
    await addSocial(c, { ...d, network, campaign: "organic", spend: 0 });
    n++;
  }
  return n;
}
