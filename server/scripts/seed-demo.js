// Fills a separate demo database with made-up customers, subscriptions and payments
// so you can preview the owner dashboard. It never touches your real database.
//   npm run demo          (then open http://localhost:8787/owner and sign in as owner@demo.test / demo-owner-pass)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DB_PATH = process.env.DEMO_DB_PATH || path.join(here, "..", "data", "demo.db");
for(const f of [process.env.DB_PATH, process.env.DB_PATH + "-wal", process.env.DB_PATH + "-shm"]) fs.rmSync(f, { force: true });

const { q, db } = await import("../src/db.js");
const { hashPassword } = await import("../src/auth.js");

let seed = 20260928;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const DAY = 864e5, nowMs = Date.now(), iso = ms => new Date(ms).toISOString();
const first = ["ava","ben","cara","dev","eli","fay","gus","hana","ivan","jo","kai","lena","mo","nia","omar","pia","quinn","ray","sana","tom","uma","vic","wren","xin","yara","zed"];
const last = ["lee","patel","kim","ortiz","ng","brown","silva","cohen","ali","novak","reyes","khan"];

const owner = q.addUser.get("owner@demo.test", hashPassword("demo-owner-pass"), 1, null, iso(nowMs - 400 * DAY)).id;
q.touchUser.run(iso(nowMs), owner);

const PLANS = [{ v: "111", name: "Monthly", cents: 999, every: 30 }, { v: "222", name: "Yearly", cents: 7999, every: 365 }];
let invoice = 1, n = 0;
for(let i = 0; i < 140; i++){
  const created = nowMs - Math.floor(Math.pow(rnd(), 0.8) * 360) * DAY - Math.floor(rnd() * DAY);
  const email = first[i % first.length] + "." + last[Math.floor(rnd() * last.length)] + (i > 25 ? i : "") + "@example.com";
  const trialEnds = created + 14 * DAY;
  const id = q.addUser.get(email, hashPassword("customer-pass"), 0, iso(trialEnds), iso(created)).id;
  q.touchUser.run(iso(Math.min(nowMs, created + rnd() * (nowMs - created))), id);
  if(trialEnds > nowMs || rnd() < 0.28) continue;                       // still trialing, or never paid

  const plan = rnd() < 0.72 ? PLANS[0] : PLANS[1];
  const start = trialEnds + Math.floor(rnd() * 3) * DAY;
  let status = "active", ends = null;
  const churnAt = rnd() < 0.22 ? start + (30 + rnd() * 200) * DAY : null;
  if(churnAt && churnAt < nowMs){ status = churnAt + 30 * DAY < nowMs ? "expired" : "cancelled"; ends = churnAt + 30 * DAY; }
  else if(rnd() < 0.05) status = "past_due";
  const subId = String(5000 + i);
  q.upsertSub.run(subId, id, email, status, plan.v, "Safe to Spend", plan.name,
    status === "active" || status === "past_due" ? iso(nowMs + rnd() * plan.every * DAY) : null, ends ? iso(ends) : null, null,
    rnd() < 0.7 ? "visa" : "mastercard", String(1000 + Math.floor(rnd() * 9000)), "https://demo.lemonsqueezy.com/billing", 0,
    iso(start), iso(churnAt && churnAt < nowMs ? churnAt : start));
  for(let t = start; t < Math.min(nowMs, ends || nowMs); t += plan.every * DAY){
    q.upsertPayment.run("inv_" + (invoice++), "invoice", id, subId, email, plan.cents, "USD", "paid", 0, 0, iso(t));
  }
  if(status === "past_due") q.addEvent.run("subscription_payment_failed", subId, id, email, plan.name + " · payment failed", 0, iso(nowMs - rnd() * 3 * DAY));
  n++;
}
const recent = db.prepare("SELECT s.ls_id, s.user_id, s.email, s.variant_name, s.status, s.updated_at FROM subscriptions s ORDER BY updated_at DESC LIMIT 18").all();
recent.reverse().forEach(s => q.addEvent.run(s.status === "active" ? "subscription_payment_success" : "subscription_cancelled", s.ls_id, s.user_id, s.email,
  s.variant_name + " · " + (s.status === "active" ? "Paid" : "Cancelled"), 0, s.updated_at));
q.addEvent.run("subscription_created", "t1", null, "tester@example.com", "Monthly · Active", 1, iso(nowMs - 2 * 3600e3));

console.log(`Demo database ready at ${process.env.DB_PATH}: 140 customers, ${n} subscriptions.`);
console.log("Start it with:  npm run demo:serve   then sign in at /owner as owner@demo.test / demo-owner-pass");
