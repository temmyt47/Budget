import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config, plaidConfigured, billingConfigured, checkConfig } from "./config.js";
import { hashToken } from "./crypto.js";
import { q, now } from "./db.js";
import { createLinkToken, exchangePublicToken, syncItem, removeItem, plaidError, verifyWebhook } from "./plaid.js";
import { hashPassword, checkPassword, burnPasswordCheck, normalizeEmail, validEmail, passwordProblem,
  isOwnerEmail, startSession, tempPassword, accessFor } from "./auth.js";
import { checkoutUrl, verifySignature, handleWebhook } from "./billing.js";
import { ownerSummary, ownerCustomers, compUntil } from "./owner.js";

const problems = checkConfig();
if(problems.length){
  problems.forEach(p => console.error("Config error: " + p));
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

/* ── CORS: the phone app's webview origins, plus any you list ── */
const APP_ORIGINS = ["capacitor://localhost", "ionic://localhost", "https://localhost", "http://localhost"];
app.use((req, res, next) => {
  const o = req.headers.origin;
  if(o && (APP_ORIGINS.includes(o) || config.allowedOrigins.includes(o) || config.allowedOrigins.includes("*"))){
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* ── helpers ── */
const fail = (res, status, message, code) => res.status(status).json({ error: message, code: code || undefined });
const json = express.json({ limit: "100kb" });

function requireUser(req, res, next){
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const session = m && q.sessionByToken.get(hashToken(m[1].trim()));
  const user = session && q.userById.get(session.user_id);
  if(!user) return fail(res, 401, "You are signed out. Sign in again.", "UNAUTHORIZED");
  if(user.disabled) return fail(res, 403, "This account is turned off. Contact support.", "DISABLED");
  const t = now();
  if(!session.last_used_at || Date.parse(t) - Date.parse(session.last_used_at) > 5 * 60 * 1000){
    q.touchSession.run(t, session.id); q.touchUser.run(t, user.id);
  }
  req.user = user; req.session = session;
  next();
}
function requireAccess(req, res, next){
  if(!accessFor(req.user).active) return fail(res, 402, "Your subscription is not active.", "SUBSCRIPTION_REQUIRED");
  next();
}
function requireOwner(req, res, next){
  if(!req.user.is_owner) return fail(res, 403, "Only the owner can see this.", "FORBIDDEN");
  next();
}
function requirePlaid(req, res, next){
  if(!plaidConfigured()) return fail(res, 503, "Bank syncing is not set up on this server yet. Add PLAID_CLIENT_ID and PLAID_SECRET.", "PLAID_NOT_CONFIGURED");
  next();
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  const pe = plaidError(e);
  console.error(`[${req.method} ${req.path}]`, pe.code, pe.message);
  if(!res.headersSent) fail(res, pe.status >= 400 && pe.status < 600 ? pe.status : 500, pe.message, pe.code);
});

// small fixed-window limiter keyed by IP (and optionally more)
function limiter(max, windowMs, keyFn){
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for(const [k, h] of hits) if(t - h.t > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const t = Date.now(), k = req.ip + "|" + (keyFn ? keyFn(req) : ""), h = hits.get(k);
    if(!h || t - h.t > windowMs){ hits.set(k, { t, n: 1 }); return next(); }
    if(++h.n > max) return fail(res, 429, "Too many attempts. Wait a few minutes and try again.", "RATE_LIMITED");
    next();
  };
}

function meView(user){
  const sub = q.latestSub.get(user.id);
  return {
    id: user.id, email: user.email, owner: !!user.is_owner, mustChangePassword: !!user.must_change,
    access: accessFor(user), trialDays: config.trialDays,
    subscription: sub ? { status: sub.status, plan: sub.variant_name, renewsAt: sub.renews_at, endsAt: sub.ends_at,
      trialEndsAt: sub.trial_ends_at, card: sub.card_brand ? sub.card_brand + " •" + sub.card_last_four : null, portalUrl: sub.portal_url } : null,
    plans: config.billing.plans.map(p => ({ id: p.id, name: p.name, price: p.price, interval: p.interval, url: checkoutUrl(p, user) })),
    manageUrl: (sub && sub.portal_url) || config.billing.manageUrl || null
  };
}
function itemView(i){
  return { id: i.id, institution: i.institution, status: i.status, error: i.error, lastSynced: i.last_synced ? i.last_synced.replace(" ", "T") + "Z" : null };
}
function changesSince(userId, since){
  return {
    seq: q.userSeq.get(userId).seq,
    accounts: q.changedAccounts.all(userId, since).map(a => ({
      id: a.plaid_account_id, institution: a.institution, name: a.name, officialName: a.official_name, mask: a.mask,
      type: a.type, subtype: a.subtype, current: a.current, available: a.available, currency: a.currency, removed: !!a.removed
    })),
    txns: q.changedTxns.all(userId, since).map(t => ({
      id: t.plaid_txn_id, account: t.plaid_account_id, date: t.date, name: t.name, merchant: t.merchant,
      amount: t.amount, currency: t.currency, pending: !!t.pending, category: t.category, detail: t.category_detail, removed: !!t.removed
    })),
    items: q.items.all(userId).map(itemView)
  };
}
const syncing = new Map();   // item id → promise, so overlapping requests share one Plaid call
function syncOnce(item){
  if(!syncing.has(item.id)) syncing.set(item.id, syncItem(item).finally(() => syncing.delete(item.id)));
  return syncing.get(item.id);
}
async function deleteUserEverywhere(user){
  if(plaidConfigured()) for(const item of q.items.all(user.id)) await removeItem(item);
  q.deleteUser.run(user.id);
}

/* ── public ── */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, plaid: plaidConfigured(), plaidEnv: plaidConfigured() ? config.plaid.env : null,
    billing: billingConfigured(), trialDays: config.trialDays, inviteRequired: Boolean(config.inviteCode) });
});

/* ── accounts ── */
app.post("/api/auth/signup", limiter(8, 60 * 60 * 1000), json, (req, res) => {
  const { email: rawEmail, password, invite } = req.body || {};
  const email = normalizeEmail(rawEmail);
  if(!validEmail(email)) return fail(res, 400, "Enter a real email address.", "BAD_EMAIL");
  const bad = passwordProblem(password);
  if(bad) return fail(res, 400, bad, "WEAK_PASSWORD");
  if(config.inviteCode && invite !== config.inviteCode && !isOwnerEmail(email)) return fail(res, 403, "That invite code is not right.", "BAD_INVITE");
  if(q.userByEmail.get(email)) return fail(res, 409, "An account with that email already exists. Sign in instead.", "EMAIL_TAKEN");
  const created = now();
  const trialEnds = config.trialDays ? new Date(Date.now() + config.trialDays * 864e5).toISOString() : null;
  const { id } = q.addUser.get(email, hashPassword(password), isOwnerEmail(email) ? 1 : 0, trialEnds, created);
  q.claimSubsByEmail.run(id, email);               // someone who paid before creating an account
  const token = startSession(id, req.headers["user-agent"]);
  res.status(201).json({ token, me: meView(q.userById.get(id)) });
});

app.post("/api/auth/login", limiter(12, 15 * 60 * 1000, req => normalizeEmail((req.body || {}).email)), json, (req, res) => {
  const { email: rawEmail, password } = req.body || {};
  const user = q.userByEmail.get(normalizeEmail(rawEmail));
  if(!user){ burnPasswordCheck(String(password || "")); return fail(res, 401, "That email and password don't match.", "BAD_LOGIN"); }
  if(!checkPassword(String(password || ""), user.password_hash)) return fail(res, 401, "That email and password don't match.", "BAD_LOGIN");
  if(user.disabled) return fail(res, 403, "This account is turned off. Contact support.", "DISABLED");
  if(isOwnerEmail(user.email) !== !!user.is_owner) q.setOwner.run(isOwnerEmail(user.email) ? 1 : 0, user.id);
  const token = startSession(user.id, req.headers["user-agent"]);
  res.json({ token, me: meView(q.userById.get(user.id)) });
});

app.post("/api/auth/logout", requireUser, (req, res) => { q.deleteSession.run(req.session.id); res.json({ ok: true }); });

app.post("/api/auth/password", requireUser, limiter(10, 15 * 60 * 1000), json, (req, res) => {
  const { current, next } = req.body || {};
  if(!checkPassword(String(current || ""), req.user.password_hash)) return fail(res, 401, "Your current password is not right.", "BAD_LOGIN");
  const bad = passwordProblem(next);
  if(bad) return fail(res, 400, bad, "WEAK_PASSWORD");
  q.setPassword.run(hashPassword(next), 0, req.user.id);
  q.deleteSessionsExcept.run(req.user.id, req.session.id);   // sign out other devices
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => res.json(meView(req.user)));

app.delete("/api/me", requireUser, wrap(async (req, res) => {
  if(req.user.is_owner) return fail(res, 400, "Owner accounts can't be deleted from the app. Remove the email from OWNER_EMAILS first.", "OWNER");
  await deleteUserEverywhere(req.user);
  res.json({ ok: true });
}));

/* ── bank sync (needs an active trial or subscription) ── */
app.post("/api/link-token", requireUser, requireAccess, requirePlaid, json, wrap(async (req, res) => {
  const itemId = (req.body || {}).itemId;
  const item = itemId ? q.item.get(Number(itemId), req.user.id) : null;
  if(itemId && !item) return fail(res, 404, "That bank connection no longer exists.", "NOT_FOUND");
  res.json({ link_token: await createLinkToken(req.user.id, item) });
}));

app.post("/api/items", requireUser, requireAccess, requirePlaid, json, wrap(async (req, res) => {
  const { public_token, institution } = req.body || {};
  if(!public_token) return fail(res, 400, "Missing public_token.", "BAD_REQUEST");
  const item = await exchangePublicToken(req.user.id, public_token, institution);
  try{ await syncOnce(item); }catch(e){ /* the first pull can lag behind; the next sync picks it up */ }
  res.status(201).json(itemView(q.item.get(item.id, req.user.id)));
}));

app.get("/api/items", requireUser, (req, res) => res.json(q.items.all(req.user.id).map(itemView)));

app.delete("/api/items/:id", requireUser, wrap(async (req, res) => {
  const item = q.item.get(Number(req.params.id), req.user.id);
  if(!item) return fail(res, 404, "That bank connection no longer exists.", "NOT_FOUND");
  await removeItem(item);
  res.json({ ok: true });
}));

// pull fresh data from Plaid, then return every change after `since`
app.post("/api/sync", requireUser, requireAccess, json, wrap(async (req, res) => {
  const since = Math.max(0, Number((req.body || {}).since) || 0);
  const errors = [];
  if(plaidConfigured()){
    for(const item of q.items.all(req.user.id)){
      const fresh = item.last_synced && Date.now() - Date.parse(item.last_synced.replace(" ", "T") + "Z") < 60 * 1000;
      if(fresh && !(req.body || {}).force) continue;
      try{ await syncOnce(item); }
      catch(e){ errors.push({ item: item.id, institution: item.institution, ...plaidError(e) }); }
    }
  }
  res.json({ ...changesSince(req.user.id, since), errors });
}));

/* ── webhooks ── */
app.post("/api/plaid/webhook", express.raw({ type: "*/*", limit: "1mb" }), wrap(async (req, res) => {
  if(!plaidConfigured()) return res.sendStatus(204);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if(!(await verifyWebhook(raw, req.headers["plaid-verification"]))) return fail(res, 401, "Bad signature", "BAD_SIGNATURE");
  const body = JSON.parse(raw.toString("utf8") || "{}");
  const item = body.item_id && q.itemByPlaid.get(body.item_id);
  res.sendStatus(200);                                     // answer Plaid fast, then work
  if(!item) return;
  if(body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE") syncOnce(item).catch(() => {});
  if(body.webhook_type === "ITEM" && ["ERROR", "PENDING_EXPIRATION", "PENDING_DISCONNECT"].includes(body.webhook_code))
    q.itemStatus.run("login_required", (body.error && body.error.display_message) || "Sign in to your bank again to keep syncing.", item.id);
}));

app.post("/api/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if(!verifySignature(raw, req.headers["x-signature"])) return fail(res, 401, "Bad signature", "BAD_SIGNATURE");
  let body;
  try{ body = JSON.parse(raw.toString("utf8")); }catch(e){ return fail(res, 400, "Bad JSON", "BAD_REQUEST"); }
  try{ res.json({ ok: true, ...handleWebhook(body) }); }
  catch(e){ console.error("[billing webhook]", e); fail(res, 500, "Could not store the event", "SERVER_ERROR"); }
});

/* ── owner dashboard ── */
const owner = express.Router();
owner.use(requireUser, requireOwner);
owner.get("/summary", (req, res) => res.json(ownerSummary(req.query.test === "1")));
owner.get("/customers", (req, res) => res.json(ownerCustomers({ search: req.query.q, status: req.query.status, includeTest: req.query.test === "1" })));
owner.get("/events", (req, res) => res.json(q.recentEvents.all(req.query.test === "1" ? 1 : 0)));
function customer(req, res){
  const u = q.userById.get(Number(req.params.id));
  if(!u){ fail(res, 404, "That customer no longer exists.", "NOT_FOUND"); return null; }
  return u;
}
owner.post("/customers/:id/comp", json, (req, res) => {
  const u = customer(req, res); if(!u) return;
  const until = req.body && req.body.days === "none" ? null : compUntil(req.body && req.body.days);
  q.setComp.run(until, u.id);
  res.json({ ok: true, compUntil: until });
});
owner.post("/customers/:id/disable", json, (req, res) => {
  const u = customer(req, res); if(!u) return;
  if(u.is_owner) return fail(res, 400, "You can't turn off an owner account.", "OWNER");
  const off = !!(req.body && req.body.disabled);
  q.setDisabled.run(off ? 1 : 0, u.id);
  if(off) q.deleteSessions.run(u.id);
  res.json({ ok: true, disabled: off });
});
owner.post("/customers/:id/reset-password", (req, res) => {
  const u = customer(req, res); if(!u) return;
  const pw = tempPassword();
  q.setPassword.run(hashPassword(pw), 1, u.id);
  q.deleteSessions.run(u.id);
  res.json({ ok: true, tempPassword: pw });
});
owner.delete("/customers/:id", wrap(async (req, res) => {
  const u = customer(req, res); if(!u) return;
  if(u.is_owner) return fail(res, 400, "You can't delete an owner account.", "OWNER");
  await deleteUserEverywhere(u);
  res.json({ ok: true });
}));
app.use("/api/owner", owner);

app.use("/api", (req, res) => fail(res, 404, "Not found", "NOT_FOUND"));

/* ── pages ── */
// the web copy served from here always talks to this server and follows its billing setup
app.get("/config.js", (req, res) => {
  res.type("application/javascript").setHeader("Cache-Control", "no-store");
  res.send("window.SAFE_CONFIG = " + JSON.stringify({ server: "", requireAccount: billingConfigured(), checkoutInApp: true,
    supportEmail: process.env.SUPPORT_EMAIL || "" }) + ";");
});
const ownerDir = path.join(here, "..", "owner");
app.use("/owner", express.static(ownerDir, { maxAge: 0 }));
if(config.serveWeb && fs.existsSync(config.webDir)) app.use(express.static(config.webDir, { maxAge: "5m" }));

app.listen(config.port, () => {
  console.log(`Safe to Spend server on http://localhost:${config.port}  (owner dashboard: /owner)`);
  console.log(plaidConfigured() ? `Plaid: ${config.plaid.env}` : "Plaid: not configured (bank syncing is off)");
  console.log(billingConfigured() ? `Billing: Lemon Squeezy, ${config.billing.plans.length} plan(s), ${config.trialDays}-day trial` : "Billing: not configured (everyone has access)");
});
