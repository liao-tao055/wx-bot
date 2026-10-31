import { isPrepareFailure, WxBotError, type SendRequest } from "@wx-bot/core";
import { deliverOnce, readDelivery, sha256, type DeliveryReceipt } from "./mcp-delivery.ts";

type Request = Omit<SendRequest, "binding">;
type StoredRequest = Omit<Request, "media"> & { media?: Omit<NonNullable<Request["media"]>, "data"> };
export interface RetryJob {
  id: string;
  fingerprint: string;
  request: StoredRequest;
  chunks: number;
  byte_length: number;
  data_sha256?: string;
  attempts: number;
  next_retry_at: number;
  lease_until: number;
  last_error?: string;
  waiting_context?: boolean;
}
export interface RetryResult {
  ok: boolean;
  duplicate: boolean;
  queued?: boolean;
  state?: string;
  next_retry_at?: number;
}
const JOBS = "mcp:retry:";
const DATA = "mcp:retry-data:";
const CHUNK = 64 * 1024;
const LEASE = 20 * 60_000;
export const RETRY_POLICY = { mode: "until_sent", min_delay_seconds: 30, max_delay_seconds: 900, ambiguous_delay_seconds: 120, stable_content: true } as const;

const jobKey = async (id: string) => JOBS + await sha256(id);
const dataPrefix = async (id: string, fingerprint: string) => DATA + await sha256(id) + ":" + fingerprint + ":";
function pending(job: RetryJob): RetryResult {
  return { ok: false, duplicate: false, queued: true, state: "queued", next_retry_at: Math.max(job.next_retry_at, job.lease_until) };
}
async function cleanup(storage: DurableObjectStorage, key: string, job: RetryJob) {
  const prefix = await dataPrefix(job.id, job.fingerprint);
  for (let i = 0; i < job.chunks; i += 64) {
    await storage.delete(Array.from({ length: Math.min(64, job.chunks - i) }, (_, n) => prefix + (i + n)));
  }
  await storage.delete(key);
}
async function restore(storage: DurableObjectStorage, job: RetryJob): Promise<Request> {
  if (!job.request.media) return job.request as Request;
  const data = new Uint8Array(job.byte_length);
  const prefix = await dataPrefix(job.id, job.fingerprint);
  let offset = 0;
  for (let i = 0; i < job.chunks; i++) {
    const chunk = await storage.get<Uint8Array>(prefix + i);
    if (!chunk || chunk.length !== Math.min(CHUNK, job.byte_length - offset)) throw new Error("Retained attachment bytes are incomplete; no replacement file was sent");
    data.set(chunk, offset); offset += chunk.length;
  }
  if (offset !== job.byte_length || await sha256(data) !== job.data_sha256) throw new Error("Retained attachment checksum mismatch; no replacement file was sent");
  return { ...job.request, media: { ...job.request.media, data } };
}

/** New authorized deliveries receive a durable, same-content standing retry grant. */
export async function queueDelivery(storage: DurableObjectStorage, id: string, fingerprint: string, req: Request, send: (req: Request) => Promise<void>): Promise<RetryResult> {
  const receipt = await readDelivery(storage, id);
  const key = await jobKey(id);
  const existing = await storage.get<RetryJob>(key);
  if ((receipt && receipt.fingerprint !== fingerprint) || (existing && existing.fingerprint !== fingerprint)) throw new WxBotError("bad_request", "delivery_id was already used for different content");
  if (receipt?.state === "sent") return { ok: true, duplicate: true };
  if (existing) return attemptRetry(storage, id, send);
  // Never silently enroll an old uncertain/in-flight request under a new policy.
  if (receipt && receipt.state !== "retry_ready") throw new WxBotError("upstream", "Legacy delivery is pending or uncertain. Confirm non-receipt once to enroll its original content in until-sent retry.");
  const { media, ...fields } = req;
  const job: RetryJob = {
    id, fingerprint, request: { ...fields, ...(media ? { media: { kind: media.kind, fileName: media.fileName } } : {}) },
    chunks: media ? Math.ceil(media.data.length / CHUNK) : 0, byte_length: media?.data.length ?? 0,
    ...(media ? { data_sha256: await sha256(media.data) } : {}), attempts: 0, next_retry_at: Date.now(), lease_until: 0,
  };
  const prefix = await dataPrefix(id, fingerprint);
  for (let i = 0; i < job.chunks; i += 64) {
    const batch: Record<string, Uint8Array> = {};
    for (let j = i; j < Math.min(i + 64, job.chunks); j++) batch[prefix + j] = media!.data.slice(j * CHUNK, (j + 1) * CHUNK);
    await storage.put(batch);
  }
  await storage.transaction(async tx => {
    const previous = await tx.get<RetryJob>(key);
    const current = await tx.get<DeliveryReceipt>("mcp:delivery:" + await sha256(id));
    if (previous?.fingerprint !== undefined && previous.fingerprint !== fingerprint || current && current.fingerprint !== fingerprint) throw new WxBotError("bad_request", "delivery_id was already used for different content");
    if (current && !previous && !["sent", "retry_ready"].includes(current.state)) throw new WxBotError("upstream", "Legacy delivery still requires one explicit review");
    if (!previous) await tx.put(key, job);
  });
  return attemptRetry(storage, id, send);
}

/** Claim a due attempt atomically. Success is terminal; concurrent callers never send twice. */
export async function attemptRetry(storage: DurableObjectStorage, id: string, send: (req: Request) => Promise<void>): Promise<RetryResult> {
  const key = await jobKey(id);
  const receiptKey = "mcp:delivery:" + await sha256(id);
  const claim = await storage.transaction(async tx => {
    const job = await tx.get<RetryJob>(key);
    const receipt = await tx.get<DeliveryReceipt>(receiptKey);
    if (receipt?.state === "sent") return { sent: true, job };
    if (!job) throw new WxBotError("not_found", "No retained retry job");
    if (receipt && receipt.fingerprint !== job.fingerprint) throw new WxBotError("bad_request", "Retry fingerprint mismatch");
    if (Math.max(job.next_retry_at, job.lease_until) > Date.now()) return { pending: job };
    // A sending lease only expires after the maximum expected request lifetime;
    // the owner's standing grant acknowledges residual late-completion risk.
    if (receipt) await tx.put(receiptKey, { ...receipt, state: "retry_ready" } satisfies DeliveryReceipt);
    const next = { ...job, attempts: job.attempts + 1, lease_until: Date.now() + LEASE };
    await tx.put(key, next);
    return { job: next };
  });
  if (claim.sent) { if (claim.job) await cleanup(storage, key, claim.job); return { ok: true, duplicate: true }; }
  if (claim.pending) return pending(claim.pending);
  const job = claim.job!;
  try {
    const request = await restore(storage, job);
    request.clientIdPrefix = "wxbot-" + (await sha256(id + ":" + job.fingerprint)).slice(0, 24);
    const result = await deliverOnce(storage, id, job.fingerprint, () => send(request));
    await cleanup(storage, key, job);
    return result;
  } catch (error) {
    // Do not report a bookkeeping failure after confirmed delivery as a failed send.
    if ((await readDelivery(storage, id))?.state === "sent") return { ok: true, duplicate: true };
    const waiting = error instanceof WxBotError && ["expired", "no_context", "forbidden"].includes(error.kind);
    const explicit = isPrepareFailure(error) || error instanceof WxBotError && ["bad_request", "forbidden", "no_context", "too_large", "expired"].includes(error.kind);
    const delay = Math.max(waiting ? 300_000 : explicit ? 30_000 : 120_000, Math.min(900_000, 30_000 * 2 ** Math.min(5, job.attempts - 1)));
    const next: RetryJob = { ...job, lease_until: 0, next_retry_at: Date.now() + delay, waiting_context: waiting, last_error: (error as Error).message.slice(0, 500) };
    const retained = await storage.transaction(async tx => {
      const current = await tx.get<RetryJob>(key);
      // An expired older attempt may complete after a newer attempt took over.
      if (!current || current.attempts !== job.attempts || current.lease_until !== job.lease_until) return current;
      await tx.put(key, next);
      return next;
    });
    if (!retained && (await readDelivery(storage, id))?.state === "sent") return { ok: true, duplicate: true };
    return pending(retained ?? next);
  }
}

export async function retryQueueStatus(storage: DurableObjectStorage) {
  const jobs = await storage.list<RetryJob>({ prefix: JOBS });
  const values = [...jobs.values()];
  return { pending: values.length, next_retry_at: values.length ? Math.min(...values.map(j => Math.max(j.next_retry_at, j.lease_until))) : null };
}
export async function deliveryRetryStatus(storage: DurableObjectStorage, id: string) {
  const job = await storage.get<RetryJob>(await jobKey(id));
  return job ? { fingerprint: job.fingerprint, updated_at: job.next_retry_at, retry_mode: "until_sent", retry_attempts: job.attempts, next_retry_at: Math.max(job.next_retry_at, job.lease_until), waiting_context: !!job.waiting_context, last_error: job.last_error ?? null } : null;
}
export async function runDueRetry(storage: DurableObjectStorage, send: (req: Request) => Promise<void>) {
  const jobs = await storage.list<RetryJob>({ prefix: JOBS });
  const due = [...jobs.values()].find(j => Math.max(j.next_retry_at, j.lease_until) <= Date.now());
  if (due) await attemptRetry(storage, due.id, send);
}
export async function wakeContextRetries(storage: DurableObjectStorage) {
  const jobs = await storage.list<RetryJob>({ prefix: JOBS });
  for (const [key, job] of jobs) if (job.waiting_context && !job.lease_until) await storage.put(key, { ...job, next_retry_at: Date.now() });
}
