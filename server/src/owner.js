import { config, plaidConfigured, billingConfigured } from "./config.js";
import { q, now } from "./db.js";
import { accessFor } from "./auth.js";
import { planByVariant, monthlyValue } from "./billing.js";

const DAY = 864e5;
const ts = v => (v ? Date.parse(String(v).includes("T") ? v : String(v).replace(" ", "T") + "Z") : NaN);
const PAYING = new Set(["active", "past_due"]);

function monthKey(d){ return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"); }
function lastMonths(n){
  const out = [], d = new Date();
  for(let i = n - 1; i >= 0; i--){
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1) - 1);
    out.push({ key: monthKey(m), start: m.getTime(), end: Math.min(end.getTime(), Date.now()) });
  }
  return out;
}

export function ownerSummary(includeTest){
  const t = Date.now();
  const users = q.allUsers.all().filter(u => !u.is_owner);
  const subs = q.allSubs.all().filter(s => includeTest || !s.test_mode);
  const pays = q.allPayments.all().filter(p => includeTest || !p.test_mode);
  const items = q.allItems.all();
  const hiddenTest = includeTest ? 0 : q.allSubs.all().filter(s => s.test_mode).length;

  const paying = subs.filter(s => PAYING.has(s.status));
  const mrr = paying.reduce((a, s) => a + monthlyValue(planByVariant(s.variant_id)), 0);
  const unpriced = paying.filter(s => !planByVariant(s.variant_id)).length;
  const accessOf = new Map(users.map(u => [u.id, accessFor(u)]));
  const onTrial = users.filter(u => ["trial", "on_trial"].includes(accessOf.get(u.id).reason)).length;
  const comped = users.filter(u => accessOf.get(u.id).reason === "comp").length;
  const paid = pays.filter(p => !p.refunded && p.status !== "failed" && p.status !== "void");
  const rev30 = paid.filter(p => t - ts(p.created_at) <= 30 * DAY).reduce((a, p) => a + p.total_cents, 0) / 100;
  const churn30 = subs.filter(s => ["cancelled", "expired"].includes(s.status) && t - ts(s.updated_at) <= 30 * DAY).length;
  const failing = subs.filter(s => ["past_due", "unpaid"].includes(s.status)).length;
  const signups30 = users.filter(u => t - ts(u.created_at) <= 30 * DAY).length;
  const active7 = users.filter(u => u.last_seen_at && t - ts(u.last_seen_at) <= 7 * DAY).length;
  const badItems = items.filter(i => i.status !== "ok").length;

  // MRR by month end is rebuilt from each subscription's start and end, so it is an estimate
  const months = lastMonths(12);
  const mrrSeries = months.map(m => ({
    month: m.key,
    value: subs.reduce((a, s) => {
      const start = ts(s.created_at), end = ts(s.ends_at), trialEnd = ts(s.trial_ends_at);
      if(!(start <= m.end)) return a;
      if(end && end <= m.end && s.status !== "active") return a;
      if(s.status === "expired" && !end && ts(s.updated_at) <= m.end) return a;
      if(trialEnd && trialEnd > m.end) return a;
      if(m.end >= t - DAY && !PAYING.has(s.status)) return a;          // this month: only what is paying now
      return a + monthlyValue(planByVariant(s.variant_id));
    }, 0)
  }));
  const revenueSeries = months.map(m => ({
    month: m.key,
    value: paid.filter(p => { const x = ts(p.created_at); return x >= m.start && x <= m.end; }).reduce((a, p) => a + p.total_cents, 0) / 100
  }));
  const weeks = [];
  for(let i = 11; i >= 0; i--){
    const end = t - i * 7 * DAY, start = end - 7 * DAY;
    weeks.push({ week: new Date(start + DAY).toISOString().slice(0, 10), value: users.filter(u => { const x = ts(u.created_at); return x > start && x <= end; }).length });
  }
  const statuses = {};
  subs.forEach(s => { statuses[s.status] = (statuses[s.status] || 0) + 1; });
  const trialUsers = users.filter(u => accessOf.get(u.id).reason === "trial").length;
  if(trialUsers) statuses.free_trial = trialUsers;

  const last = q.lastEvent.get();
  return {
    kpis: {
      mrr, arr: mrr * 12, paying: paying.length, onTrial, comped, customers: users.length, signups30, active7,
      revenue30: rev30, churn30, failing, banks: items.length, badItems,
      plaidCost: config.plaidCostPerItem ? items.length * config.plaidCostPerItem : null, unpriced, hiddenTest
    },
    series: { mrr: mrrSeries, revenue: revenueSeries, signups: weeks },
    statuses,
    plans: config.billing.plans.map(p => ({ name: p.name, price: p.price, interval: p.interval, variantId: p.variantId,
      subscribers: paying.filter(s => s.variant_id === p.variantId).length })),
    system: {
      billing: billingConfigured(), plaid: plaidConfigured(), plaidEnv: plaidConfigured() ? config.plaid.env : null,
      trialDays: config.trialDays, lastWebhook: last ? last.created_at : null, inviteRequired: Boolean(config.inviteCode)
    }
  };
}

export function ownerCustomers({ search, status, includeTest }){
  const qs = String(search || "").trim().toLowerCase();
  const itemsByUser = new Map();
  q.allItems.all().forEach(i => {
    const r = itemsByUser.get(i.user_id) || { banks: 0, bad: 0 };
    r.banks++; if(i.status !== "ok") r.bad++;
    itemsByUser.set(i.user_id, r);
  });
  const paidByUser = new Map();
  q.allPayments.all().forEach(p => {
    if(!p.user_id || p.refunded || (!includeTest && p.test_mode)) return;
    paidByUser.set(p.user_id, (paidByUser.get(p.user_id) || 0) + p.total_cents);
  });
  return q.allUsers.all().map(u => {
    const sub = q.latestSub.get(u.id), access = accessFor(u), it = itemsByUser.get(u.id) || { banks: 0, bad: 0 };
    const plan = sub ? planByVariant(sub.variant_id) : null;
    return {
      id: u.id, email: u.email, owner: !!u.is_owner, disabled: !!u.disabled, createdAt: u.created_at, lastSeenAt: u.last_seen_at,
      access, trialEnds: u.trial_ends, compUntil: u.comp_until,
      subscription: sub && (includeTest || !sub.test_mode) ? {
        status: sub.status, plan: sub.variant_name || (plan && plan.name), renewsAt: sub.renews_at, endsAt: sub.ends_at,
        card: sub.card_brand ? sub.card_brand + " •" + sub.card_last_four : null, test: !!sub.test_mode, monthly: monthlyValue(plan)
      } : null,
      lifetime: (paidByUser.get(u.id) || 0) / 100, banks: it.banks, badBanks: it.bad
    };
  }).filter(c => {
    if(qs && !c.email.toLowerCase().includes(qs)) return false;
    if(!status || status === "all") return true;
    if(status === "paying") return c.subscription && PAYING.has(c.subscription.status);
    if(status === "trial") return ["trial", "on_trial"].includes(c.access.reason);
    if(status === "comp") return c.access.reason === "comp";
    if(status === "inactive") return !c.access.active;
    if(status === "problems") return c.badBanks > 0 || (c.subscription && ["past_due", "unpaid"].includes(c.subscription.status));
    return true;
  });
}

export function compUntil(days){
  if(days === "forever") return "9999-12-31T00:00:00.000Z";
  const n = Math.max(1, Math.min(3650, Number(days) || 30));
  return new Date(Date.now() + n * DAY).toISOString();
}
export { now };
