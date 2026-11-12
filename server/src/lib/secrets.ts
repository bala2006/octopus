/** Encrypts secrets at rest (API keys, MCP env values) with AES-256-GCM and a key kept in OCTOPUS_HOME. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";

let key: Buffer | null = null;
function secretKey(): Buffer {
  if (key) return key;
  if (config.encryptionKey) return (key = createHash("sha256").update(config.encryptionKey).digest());
  const file = path.join(config.home, "secret.key");
  if (!existsSync(file)) {
    mkdirSync(config.home, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  return (key = Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decrypt(token: string): string {
  if (!token) return "";
  const [v, iv, tag, body] = token.split(".");
  if (v !== "v1" || !iv || !tag || !body) return "";
  try {
    const d = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export const mask = (secret: string) => (secret ? `${secret.slice(0, 3)}…${secret.slice(-4)}` : "");
