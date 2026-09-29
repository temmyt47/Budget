import crypto from "node:crypto";
import { config } from "./config.js";

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = t => crypto.createHash("sha256").update(String(t)).digest("hex");

const key = () => Buffer.from(config.encryptionKey, "hex");

// Plaid access tokens are stored sealed with AES-256-GCM: iv.tag.ciphertext
export function seal(plain){
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
}

export function unseal(sealed){
  const [iv, tag, enc] = String(sealed).split(".").map(s => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
