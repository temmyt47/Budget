import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

export const config = {
  port: Number(env.PORT) || 8787,
  dbPath: env.DB_PATH || path.join(here, "..", "data", "safe-to-spend.db"),
  webDir: env.WEB_DIR || path.join(here, "..", "..", "www"),
  serveWeb: env.SERVE_WEB !== "false",
  // when set, new customers must enter this code to sign up
  inviteCode: env.INVITE_CODE || "",
  allowedOrigins: list(env.ALLOWED_ORIGINS),
  encryptionKey: env.ENCRYPTION_KEY || "",
  // accounts with these emails get the owner dashboard
  ownerEmails: list(env.OWNER_EMAILS).map(e => e.toLowerCase()),
  trialDays: env.TRIAL_DAYS === undefined ? 14 : Math.max(0, Number(env.TRIAL_DAYS) || 0),
  billing: {
    webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET || "",
    plans: parsePlans(env.LEMONSQUEEZY_PLANS),
    manageUrl: env.LEMONSQUEEZY_MANAGE_URL || ""
  },
  plaidCostPerItem: Number(env.PLAID_MONTHLY_COST_PER_ITEM) || 0,
  plaid: {
    clientId: env.PLAID_CLIENT_ID || "",
    secret: env.PLAID_SECRET || "",
    env: env.PLAID_ENV || "sandbox",
    products: list(env.PLAID_PRODUCTS || "transactions"),
    countryCodes: list(env.PLAID_COUNTRY_CODES || "US"),
    redirectUri: env.PLAID_REDIRECT_URI || "",
    webhookUrl: env.PLAID_WEBHOOK_URL || "",
    daysRequested: Number(env.PLAID_DAYS_REQUESTED) || 730
  }
};

// LEMONSQUEEZY_PLANS is a JSON list: [{"id","name","price","interval":"month"|"year","variantId","checkoutUrl"}]
function parsePlans(raw){
  if(!raw) return [];
  try{
    const arr = JSON.parse(raw);
    return (Array.isArray(arr) ? arr : []).map(p => ({
      id: String(p.id || p.variantId), name: String(p.name || "Plan"), price: Number(p.price) || 0,
      interval: p.interval === "year" ? "year" : "month", variantId: String(p.variantId || ""), checkoutUrl: String(p.checkoutUrl || "")
    })).filter(p => p.variantId && p.checkoutUrl);
  }catch(e){
    console.error("LEMONSQUEEZY_PLANS is not valid JSON; ignoring it.");
    return [];
  }
}

export const billingConfigured = () => Boolean(config.billing.webhookSecret && config.billing.plans.length);
export const plaidConfigured = () => Boolean(config.plaid.clientId && config.plaid.secret);

export function checkConfig(){
  const problems = [];
  if(plaidConfigured()){
    if(!/^[0-9a-f]{64}$/i.test(config.encryptionKey))
      problems.push("ENCRYPTION_KEY must be 64 hex characters when Plaid is configured. Generate one with: npm run keygen");
    if(!["sandbox", "production"].includes(config.plaid.env))
      problems.push('PLAID_ENV must be "sandbox" or "production".');
  }
  if(config.billing.webhookSecret && !config.billing.plans.length)
    problems.push("LEMONSQUEEZY_PLANS needs at least one plan with a variantId and checkoutUrl when the webhook secret is set.");
  if(billingConfigured() && !config.ownerEmails.length)
    problems.push("Set OWNER_EMAILS so someone can open the owner dashboard.");
  return problems;
}
