import { expect, spyOn, test } from "bun:test";
import { WxBotError } from "@wx-bot/core";
import { confirmNotReceived, deliverOnce, readDelivery, sha256, type DeliveryReceipt } from "../src/mcp-delivery.ts";

function memory() {
  const data = new Map<string, unknown>();
  let queue = Promise.resolve();
  const storage: any = {
    async get(k: string) { return structuredClone(data.get(k)); },
    async put(k: string, v: unknown) { data.set(k, structuredClone(v)); },
    async delete(k: string | string[]) { for (const key of Array.isArray(k) ? k : [k]) data.delete(key); },
    async list({ prefix, limit }: { prefix: string; limit: number }) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); },
    transaction(fn: (tx: any) => unknown) { const next = queue.then(() => fn(storage)); queue = next.then(() => {}, () => {}); return next; },
  };
  return storage as DurableObjectStorage;
}
async function seed(storage: DurableObjectStorage, state: DeliveryReceipt["state"] = "uncertain", at = Date.now() - 60_000) {
  const receipt: DeliveryReceipt = { state, updated_at: at, fingerprint: "original-content" };
  await storage.put("mcp:delivery:" + await sha256("original-id"), receipt);
  return receipt;
}

test("legacy uncertain receipt remains blocked without explicit review", async () => {
  const s = memory(); await seed(s); let calls = 0;
  await expect(deliverOnce(s, "original-id", "original-content", async () => { calls++; })).rejects.toThrow("uncertain");
  expect(calls).toBe(0);
});

test("both actual non-receipt confirmation and retry authorization are required", async () => {
  const s = memory(); const r = await seed(s);
  for (const [received, authorized] of [[false, false], [true, false], [false, true]]) {
    await expect(confirmNotReceived(s, "original-id", r.updated_at, received!, authorized!)).rejects.toThrow("explicitly confirm");
  }
  expect((await readDelivery(s, "original-id"))!.state).toBe("uncertain");
});

test("review itself never sends, preserves the fingerprint, and grants one same-ID retry", async () => {
  const s = memory(); const r = await seed(s); let calls = 0;
  const ready = await confirmNotReceived(s, "original-id", r.updated_at, true, true);
  expect(ready).toMatchObject({ state: "retry_ready", fingerprint: "original-content", manual_reviews: 1 });
  expect(calls).toBe(0);
  expect(await deliverOnce(s, "original-id", "original-content", async () => { calls++; })).toEqual({ ok: true, duplicate: false });
  expect(await deliverOnce(s, "original-id", "original-content", async () => { calls++; })).toEqual({ ok: true, duplicate: true });
  expect(calls).toBe(1);
});

test("review cannot be used to substitute a different payload", async () => {
  const s = memory(); const r = await seed(s);
  await confirmNotReceived(s, "original-id", r.updated_at, true, true);
  let calls = 0;
  await expect(deliverOnce(s, "original-id", "changed-file-or-content", async () => { calls++; })).rejects.toThrow("different content");
  expect(calls).toBe(0);
  expect((await readDelivery(s, "original-id"))!.state).toBe("retry_ready");
  await deliverOnce(s, "original-id", "original-content", async () => { calls++; });
  expect(calls).toBe(1);
});

test("sent and active sending receipts cannot be unlocked even after a delay", async () => {
  for (const state of ["sent", "sending"] as const) {
    const s = memory(); const r = await seed(s, state);
    await expect(confirmNotReceived(s, "original-id", r.updated_at, true, true)).rejects.toThrow("Only uncertain");
    expect((await readDelivery(s, "original-id"))!.state).toBe(state);
  }
});

test("stale timestamp and too-recent uncertainty do not arm a retry", async () => {
  const s = memory(); const r = await seed(s);
  await expect(confirmNotReceived(s, "original-id", r.updated_at - 1, true, true)).rejects.toThrow("Delivery changed");
  const recent = await seed(s, "uncertain", Date.now());
  await expect(confirmNotReceived(s, "original-id", recent.updated_at, true, true)).rejects.toThrow("30 seconds");
});

test("repeating the identical review is idempotent until its grant is consumed", async () => {
  const s = memory(); const r = await seed(s);
  const first = await confirmNotReceived(s, "original-id", r.updated_at, true, true);
  const second = await confirmNotReceived(s, "original-id", r.updated_at, true, true);
  expect(second).toEqual(first);
  expect(second.manual_reviews).toBe(1);
});

test("a second ambiguous failure needs another fresh human review", async () => {
  const s = memory(); const r = await seed(s);
  await confirmNotReceived(s, "original-id", r.updated_at, true, true);
  let calls = 0;
  await expect(deliverOnce(s, "original-id", "original-content", async () => { calls++; throw new Error("network timeout"); })).rejects.toThrow("network timeout");
  await expect(deliverOnce(s, "original-id", "original-content", async () => { calls++; })).rejects.toThrow("uncertain");
  await expect(confirmNotReceived(s, "original-id", r.updated_at, true, true)).rejects.toThrow("Delivery changed");
  expect(calls).toBe(1);
});

test("a failed reviewed retry cannot discard the fingerprint and allow different content", async () => {
  const s = memory(); const r = await seed(s);
  await confirmNotReceived(s, "original-id", r.updated_at, true, true);
  await expect(deliverOnce(s, "original-id", "original-content", async () => { throw new WxBotError("no_context", "no fresh context"); })).rejects.toThrow("no fresh context");
  expect((await readDelivery(s, "original-id"))!).toMatchObject({ state: "uncertain", fingerprint: "original-content" });
  await expect(deliverOnce(s, "original-id", "different-content", async () => {})).rejects.toThrow("different content");
});

test("concurrent retries consume a manual grant atomically", async () => {
  const s = memory(); const r = await seed(s);
  await confirmNotReceived(s, "original-id", r.updated_at, true, true);
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = deliverOnce(s, "original-id", "original-content", async () => { calls++; await gate; });
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(deliverOnce(s, "original-id", "original-content", async () => { calls++; })).rejects.toThrow("uncertain");
  release(); await first; expect(calls).toBe(1);
});

test("expired or absent receipts and invalid review arguments cannot be authorized", async () => {
  const s = memory();
  await expect(confirmNotReceived(s, "missing", Date.now(), true, true)).rejects.toThrow("No retained");
  const r = await seed(s);
  for (const at of [NaN, Infinity, -1, 1.5]) await expect(confirmNotReceived(s, "original-id", at, true, true)).rejects.toThrow("expected_updated_at");
  const clock = spyOn(Date, "now").mockReturnValue(r.updated_at + 7 * 86_400_000);
  try { await expect(confirmNotReceived(s, "original-id", r.updated_at, true, true)).rejects.toThrow("No retained"); }
  finally { clock.mockRestore(); }
});
