import { WxBotError } from "@wx-bot/core";

export interface DeliveryReceipt {
  fingerprint: string;
  state: "sending" | "sent" | "uncertain" | "retry_ready";
  updated_at: number;
  /** A one-shot, explicit human review; never an automatic retry policy. */
  reviewed_from?: number;
  manual_reviews?: number;
}

const PREFIX = "mcp:delivery:";
const RETENTION = 7 * 86_400_000;
const REVIEW_DELAY = 30_000;

function validateId(id: string) {
  if (!id || id.length > 200) throw new WxBotError("bad_request", "delivery_id must have 1-200 characters");
}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function readDelivery(storage: DurableObjectStorage, id: string) {
  validateId(id);
  const r = await storage.get<DeliveryReceipt>(PREFIX + await sha256(id));
  return r && Date.now() - r.updated_at < RETENTION ? r : undefined;
}

/** Arm exactly one SAME-content retry only after the user checks WeChat and authorizes it. */
export async function confirmNotReceived(
  storage: DurableObjectStorage,
  id: string,
  expectedUpdatedAt: number,
  userConfirmedNotReceived: boolean,
  userAuthorizedRetry: boolean,
): Promise<DeliveryReceipt> {
  validateId(id);
  if (userConfirmedNotReceived !== true || userAuthorizedRetry !== true) {
    throw new WxBotError("bad_request", "The user must explicitly confirm non-receipt AND authorize one retry; never infer this from silence or a greeting");
  }
  if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0) {
    throw new WxBotError("bad_request", "Use expected_updated_at from the latest delivery status");
  }
  const key = PREFIX + await sha256(id);
  return storage.transaction(async (tx) => {
    const r = await tx.get<DeliveryReceipt>(key);
    if (!r || Date.now() - r.updated_at >= RETENTION) throw new WxBotError("not_found", "No retained delivery to review");
    if (r.state === "retry_ready" && r.reviewed_from === expectedUpdatedAt) return r;
    if (r.updated_at !== expectedUpdatedAt) throw new WxBotError("bad_request", "Delivery changed; read its status again before any review");
    if (r.state !== "uncertain") throw new WxBotError("bad_request", "Only uncertain deliveries can be reviewed; sent and in-progress deliveries stay protected");
    if (Date.now() - r.updated_at < REVIEW_DELAY) throw new WxBotError("bad_request", "Wait at least 30 seconds and check WeChat before reviewing this delivery");
    const next: DeliveryReceipt = {
      ...r, state: "retry_ready", updated_at: Math.max(Date.now(), r.updated_at + 1),
      reviewed_from: expectedUpdatedAt, manual_reviews: (r.manual_reviews ?? 0) + 1,
    };
    await tx.put(key, next);
    return next;
  });
}

/** Reserve atomically; uncertainty requires an explicit, one-shot human review. */
export async function deliverOnce(
  storage: DurableObjectStorage,
  id: string,
  fingerprint: string,
  send: () => Promise<void>,
): Promise<{ ok: true; duplicate: boolean }> {
  validateId(id);
  const key = PREFIX + await sha256(id);
  const reservation = await storage.transaction(async (tx) => {
    const r = await tx.get<DeliveryReceipt>(key);
    if (r && Date.now() - r.updated_at < RETENTION) {
      if (r.fingerprint !== fingerprint) throw new WxBotError("bad_request", "delivery_id was already used for different content");
      if (r.state === "sent") return { duplicate: true as const, receipt: r };
      if (r.state !== "retry_ready") throw new WxBotError("upstream", "Delivery is pending or uncertain. Check WeChat and wechat_delivery_status; do not resend automatically.");
    }
    const receipt: DeliveryReceipt = {
      ...(r && Date.now() - r.updated_at < RETENTION ? r : {}),
      fingerprint, state: "sending", updated_at: Date.now(),
    };
    await tx.put(key, receipt);
    return { duplicate: false as const, receipt };
  });
  if (reservation.duplicate) return { ok: true, duplicate: true };
  const receipt = reservation.receipt;
  try {
    await send();
  } catch (err) {
    if (!receipt.manual_reviews && err instanceof WxBotError && ["bad_request", "forbidden", "no_context", "too_large", "expired"].includes(err.kind)) {
      await storage.delete(key); // Validation/iLink rejection: no delivery occurred.
    } else {
      // A reviewed legacy record must never lose its original fingerprint,
      // including when the one authorized retry fails a precondition.
      await storage.put(key, { ...receipt, state: "uncertain", updated_at: Date.now() } satisfies DeliveryReceipt);
    }
    throw err;
  }
  // A storage error here deliberately leaves "sending", preventing a duplicate.
  await storage.put(key, { ...receipt, state: "sent", updated_at: Date.now() } satisfies DeliveryReceipt);
  const records = await storage.list<DeliveryReceipt>({ prefix: PREFIX, limit: 512 });
  const expired = [...records].filter(([, r]) => Date.now() - r.updated_at >= RETENTION).map(([k]) => k);
  if (expired.length) await storage.delete(expired);
  return { ok: true, duplicate: false };
}
