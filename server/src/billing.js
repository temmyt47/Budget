import crypto from "node:crypto";
import { config } from "./config.js";
import { q, now, transaction } from "./db.js";

export const planByVariant = id => config.billing.plans.find(p => p.variantId === String(id)) || null;
export const monthlyValue = p => p ? (p.interval === "year" ? p.price / 12 : p.price) : 0;

export function checkoutUrl(plan, user){
  const u = new URL(plan.checkoutUrl);
  u.searchParams.set("checkout[email]", user.email);
  u.searchParams.set("checkout[custom][user_id]", String(user.id));
  return u.toString();
}

export function verifySignature(raw, signature){
  if(!signature || !config.billing.webhookSecret) return false;
  const want = crypto.createHmac("sha256", config.billing.webhookSecret).update(raw).digest("hex");
  const got = String(signature);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

function resolveUser(custom, email){
  const id = custom && Number(custom.user_id);
  if(id && q.userById.get(id)) return id;
  const u = email && q.userByEmail.get(String(email));
  return u ? u.id : null;
}
const cents = v => Math.round(Number(v) || 0);

// Lemon Squeezy sends the full object on every event, so each handler is an idempotent upsert
export function handleWebhook(body){
  const event = body.meta && body.meta.event_name;
  const custom = (body.meta && body.meta.custom_data) || {};
  const data = body.data || {}, a = data.attributes || {};
  const test = a.test_mode ? 1 : 0, t = now();
  if(!event) return { ignored: true };

  return transaction(() => {
    let userId = null, summary = "";
    if(data.type === "subscriptions"){
      userId = resolveUser(custom, a.user_email);
      q.upsertSub.run(String(data.id), userId, a.user_email || null, a.status || "unknown", a.variant_id != null ? String(a.variant_id) : null,
        a.product_name || null, a.variant_name || null, a.renews_at || null, a.ends_at || null, a.trial_ends_at || null,
        a.card_brand || null, a.card_last_four || null, (a.urls && a.urls.customer_portal) || null, test,
        a.created_at || t, a.updated_at || t);
      summary = (a.variant_name || a.product_name || "Subscription") + " · " + (a.status_formatted || a.status || "");
    }else if(data.type === "subscription-invoices"){
      userId = resolveUser(custom, a.user_email);
      q.upsertPayment.run("inv_" + data.id, "invoice", userId, a.subscription_id != null ? String(a.subscription_id) : null, a.user_email || null,
        cents(a.total_usd != null ? a.total_usd : a.total), a.currency || "USD", a.status || null, a.refunded ? 1 : 0, test, a.created_at || t);
      summary = (a.billing_reason || "payment") + " · " + (a.status_formatted || a.status || "") + " · $" + (cents(a.total_usd != null ? a.total_usd : a.total) / 100).toFixed(2);
    }else if(data.type === "orders"){
      userId = resolveUser(custom, a.user_email);
      const item = a.first_order_item || {};
      // subscription orders are already counted through their invoices
      if(!planByVariant(item.variant_id)){
        q.upsertPayment.run("ord_" + data.id, "order", userId, null, a.user_email || null,
          cents(a.total_usd != null ? a.total_usd : a.total), a.currency || "USD", a.status || null, a.refunded ? 1 : 0, test, a.created_at || t);
      }
      summary = (item.product_name || "Order") + " · " + (a.status_formatted || a.status || "");
    }
    q.addEvent.run(event, data.id != null ? String(data.id) : null, userId, a.user_email || null, summary.slice(0, 200), test, t);
    return { event, userId };
  });
}
