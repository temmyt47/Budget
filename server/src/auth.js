import crypto from "node:crypto";
import { config, billingConfigured } from "./config.js";
import { q, now } from "./db.js";
import { newToken, hashToken } from "./crypto.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(pw){
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, salt.toString("base64"), hash.toString("base64")].join("$");
}
export function checkPassword(pw, stored){
  const [kind, n, salt, hash] = String(stored || "").split("$");
  if(kind !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(want, got);
}
// used when an email is unknown, so a wrong email takes as long as a wrong password
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
export function burnPasswordCheck(pw){ checkPassword(pw, DUMMY_HASH); }

export const normalizeEmail = e => String(e || "").trim().toLowerCase();
export const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
export function passwordProblem(pw){
  if(typeof pw !== "string" || pw.length < 8) return "Use at least 8 characters for your password.";
  if(pw.length > 200) return "That password is too long.";
  return null;
}
export const isOwnerEmail = e => config.ownerEmails.includes(normalizeEmail(e));

export function startSession(userId, userAgent){
  const token = newToken(), t = now();
  q.addSession.run(userId, hashToken(token), String(userAgent || "").slice(0, 200), t, t);
  q.touchUser.run(t, userId);
  return token;
}
export function tempPassword(){
  const words = crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x");
  return words.slice(0, 4) + "-" + words.slice(4, 8) + "-" + words.slice(8, 12);
}

const ACTIVE = new Set(["active", "on_trial", "past_due"]);
export function accessFor(user){
  const t = Date.now(), later = iso => iso && Date.parse(iso) > t;
  if(user.is_owner) return { active: true, reason: "owner" };
  if(later(user.comp_until)) return { active: true, reason: "comp", until: user.comp_until };
  const sub = q.latestSub.get(user.id);
  if(sub && ACTIVE.has(sub.status)) return { active: true, reason: sub.status, until: sub.status === "on_trial" ? sub.trial_ends_at : sub.renews_at, plan: sub.variant_name };
  if(sub && sub.status === "cancelled" && later(sub.ends_at)) return { active: true, reason: "cancelled", until: sub.ends_at, plan: sub.variant_name };
  if(later(user.trial_ends)) return { active: true, reason: "trial", until: user.trial_ends };
  if(!billingConfigured()) return { active: true, reason: "free" };   // a server without billing lets everyone in
  return { active: false, reason: sub ? sub.status : (user.trial_ends ? "trial_ended" : "none") };
}
