import { WxBotError } from "@wx-bot/core";

export interface DeliveryReceipt {
  fingerprint: string;
  state: "sending" | "sent" | "uncertain";
  updated_at: number;
}

const PREFIX = "mcp:delivery:";
const RETENTION = 7 * 86_400_000;

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function readDelivery(storage: DurableObjectStorage, id: string) {
  const r = await storage.get<DeliveryReceipt>(PREFIX + await sha256(id));
  return r && Date.now() - r.updated_at < RETENTION ? r : undefined;
}

/** Reserve atomically, then send outside the transaction. Never repeat an uncertain send. */
export async function deliverOnce(
  storage: DurableObjectStorage,
  id: string,
  fingerprint: string,
  send: () => Promise<void>,
): Promise<{ ok: true; duplicate: boolean }> {
  if (!id || id.length > 200) throw new WxBotError("bad_request", "delivery_id must have 1-200 characters");
  const key = PREFIX + await sha256(id);
  const old = await storage.transaction(async (tx) => {
    const r = await tx.get<DeliveryReceipt>(key);
    if (r && Date.now() - r.updated_at < RETENTION) return r;
    await tx.put(key, { fingerprint, state: "sending", updated_at: Date.now() } satisfies DeliveryReceipt);
    return undefined;
  });
  if (old) {
    if (old.fingerprint !== fingerprint) throw new WxBotError("bad_request", "delivery_id was already used for different content");
    if (old.state === "sent") return { ok: true, duplicate: true };
    throw new WxBotError("upstream", "Delivery is pending or uncertain. Check WeChat and wechat_delivery_status; do not resend automatically.");
  }
  try {
    await send();
  } catch (err) {
    if (err instanceof WxBotError && ["bad_request", "forbidden", "no_context", "too_large", "expired"].includes(err.kind)) {
      await storage.delete(key); // Validation/iLink rejection: no delivery occurred.
    } else {
      await storage.put(key, { fingerprint, state: "uncertain", updated_at: Date.now() } satisfies DeliveryReceipt);
    }
    throw err;
  }
  // A storage error here deliberately leaves "sending", preventing a duplicate.
  await storage.put(key, { fingerprint, state: "sent", updated_at: Date.now() } satisfies DeliveryReceipt);
  const records = await storage.list<DeliveryReceipt>({ prefix: PREFIX, limit: 512 });
  const expired = [...records].filter(([, r]) => Date.now() - r.updated_at >= RETENTION).map(([k]) => k);
  if (expired.length) await storage.delete(expired);
  return { ok: true, duplicate: false };
}
