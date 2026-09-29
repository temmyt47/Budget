import crypto from "node:crypto";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { config } from "./config.js";
import { seal, unseal } from "./crypto.js";
import { q, transaction, nextSeq } from "./db.js";

let client = null;
export function plaid(){
  if(!client){
    client = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[config.plaid.env],
      baseOptions: { headers: {
        "PLAID-CLIENT-ID": config.plaid.clientId,
        "PLAID-SECRET": config.plaid.secret,
        "Plaid-Version": "2020-09-14"
      } }
    }));
  }
  return client;
}

// Plaid SDK errors carry the useful part in response.data
export function plaidError(e){
  const d = e && e.response && e.response.data;
  if(d && d.error_code) return { code: d.error_code, message: d.display_message || d.error_message || d.error_code, status: e.response.status };
  return { code: "SERVER_ERROR", message: (e && e.message) || "Unknown error", status: 500 };
}

export async function createLinkToken(userId, item){
  const req = {
    user: { client_user_id: "user-" + userId },
    client_name: "Safe to Spend",
    language: "en",
    country_codes: config.plaid.countryCodes
  };
  if(item){
    req.access_token = unseal(item.access_token);          // update mode: repair a broken login
  }else{
    req.products = config.plaid.products;
    req.transactions = { days_requested: config.plaid.daysRequested };
  }
  if(config.plaid.redirectUri) req.redirect_uri = config.plaid.redirectUri;
  if(config.plaid.webhookUrl) req.webhook = config.plaid.webhookUrl;
  const r = await plaid().linkTokenCreate(req);
  return r.data.link_token;
}

export async function exchangePublicToken(userId, publicToken, institution){
  const r = await plaid().itemPublicTokenExchange({ public_token: publicToken });
  const row = q.addItem.get(userId, r.data.item_id, seal(r.data.access_token), institution || null);
  return q.item.get(row.id, userId);
}

const ACCOUNT_KINDS = new Set(["depository", "credit", "loan", "investment", "brokerage", "other"]);

async function pullAllChanges(access, cursor){
  const added = [], modified = [], removed = [];
  let next = cursor || undefined, more = true;
  while(more){
    const r = await plaid().transactionsSync({ access_token: access, cursor: next, count: 500 });
    added.push(...r.data.added); modified.push(...r.data.modified); removed.push(...r.data.removed);
    more = r.data.has_more; next = r.data.next_cursor;
  }
  return { added, modified, removed, cursor: next };
}

export async function syncItem(item){
  const access = unseal(item.access_token);
  let changes;
  try{
    changes = await pullAllChanges(access, item.cursor);
  }catch(e){
    const pe = plaidError(e);
    if(pe.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"){
      changes = await pullAllChanges(access, item.cursor);   // Plaid asks for a restart from the saved cursor
    }else{
      q.itemStatus.run(pe.code === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error", pe.message, item.id);
      throw e;
    }
  }
  const accts = (await plaid().accountsGet({ access_token: access })).data.accounts;

  transaction(() => {
    const seq = nextSeq(item.user_id);
    for(const a of accts){
      if(!ACCOUNT_KINDS.has(a.type)) continue;
      q.upsertAccount.run(a.account_id, item.user_id, item.id, item.institution, a.name, a.official_name || null,
        a.mask || null, a.type, a.subtype || null, a.balances.current, a.balances.available,
        a.balances.iso_currency_code || a.balances.unofficial_currency_code || null, seq);
    }
    for(const t of changes.added.concat(changes.modified)){
      const pfc = t.personal_finance_category || {};
      q.upsertTxn.run(t.transaction_id, item.user_id, item.id, t.account_id, t.date,
        t.name, t.merchant_name || null, t.amount, t.iso_currency_code || t.unofficial_currency_code || null,
        t.pending ? 1 : 0, pfc.primary || null, pfc.detailed || null, seq);
    }
    for(const r of changes.removed) q.removeTxn.run(seq, r.transaction_id, item.user_id);
    q.itemSynced.run(changes.cursor || null, item.id);
  });
  return { added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length };
}

export async function removeItem(item){
  try{ await plaid().itemRemove({ access_token: unseal(item.access_token) }); }
  catch(e){ /* the item may already be gone at Plaid; local cleanup still has to happen */ }
  transaction(() => {
    const seq = nextSeq(item.user_id);
    q.tombItemTxns.run(seq, item.id);
    q.tombItemAccts.run(seq, item.id);
    q.deleteItem.run(item.id);
  });
}

/* ── webhook verification (Plaid signs webhooks with an ES256 JWT) ── */
const keyCache = new Map();
function b64urlJson(s){ return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); }

export async function verifyWebhook(rawBody, jwt){
  if(!jwt) return false;
  const [h, p, sig] = String(jwt).split(".");
  if(!h || !p || !sig) return false;
  const header = b64urlJson(h);
  if(header.alg !== "ES256" || !header.kid) return false;
  let jwk = keyCache.get(header.kid);
  if(!jwk){
    const r = await plaid().webhookVerificationKeyGet({ key_id: header.kid });
    jwk = r.data.key;
    if(jwk.expired_at) return false;
    keyCache.set(header.kid, jwk);
  }
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  const ok = crypto.verify("sha256", Buffer.from(h + "." + p), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
  if(!ok) return false;
  const claims = b64urlJson(p);
  if(Math.abs(Date.now()/1000 - claims.iat) > 300) return false;
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(bodyHash), Buffer.from(String(claims.request_body_sha256 || "").padEnd(64).slice(0, 64)));
}
