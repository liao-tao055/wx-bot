import { test } from "bun:test";
import assert from "node:assert/strict";
import { IlinkClient, WxBotError } from "@wx-bot/core";
import { confirmNotReceived, readDelivery, sha256 } from "../src/mcp-delivery.ts";
import { queueDelivery, runDueRetry, wakeContextRetries, retryQueueStatus, deliveryRetryStatus } from "../src/mcp-retry.ts";

function memory() {
  const data = new Map<string, any>(); let tail = Promise.resolve();
  const storage: any = {
    async get(key: string) { return structuredClone(data.get(key)); },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) data.set(k as string, structuredClone(v));
    },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
    async list({ prefix, limit }: { prefix: string; limit?: number }) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit ?? Infinity)); },
    transaction(fn: (tx: any) => unknown) { const next = tail.then(() => fn(storage)); tail = next.then(() => {}, () => {}); return next; },
  };
  return { storage: storage as DurableObjectStorage, data };
}
async function clock(run: (advance: (ms: number) => void) => Promise<void>) {
  const original = Date.now; let now = original(); Date.now = () => now;
  try { await run(ms => { now += ms; }); } finally { Date.now = original; }
}
const text = { to: "verified-owner", text: "authorized task output" };

test("sent is terminal and already-sent content is never submitted again", async () => {
  const { storage } = memory(); let calls = 0;
  assert.equal((await queueDelivery(storage, "id", "fp", text, async () => { calls++; })).ok, true);
  assert.equal((await queueDelivery(storage, "id", "fp", text, async () => { calls++; })).duplicate, true);
  await runDueRetry(storage, async () => { calls++; });
  assert.equal(calls, 1); assert.equal((await retryQueueStatus(storage)).pending, 0);
  await assert.rejects(queueDelivery(storage, "id", "changed", text, async () => {}), /different content/);
});

test("attachment bytes survive a failed request and a later independent queue runner", async () => clock(async advance => {
  const { storage, data } = memory();
  const bytes = Uint8Array.from({ length: 150_013 }, (_, i) => i % 251);
  const req = { to: "verified-owner", caption: "task", media: { kind: "file" as const, fileName: "original.pdf", data: bytes } };
  let identity = ""; let calls = 0;
  const result = await queueDelivery(storage, "file-id", "original-fp", req, async request => {
    calls++; identity = request.clientIdPrefix!;
    assert.deepEqual(request.media!.data, bytes); throw new Error("transport timeout");
  });
  assert.equal(result.queued, true); assert.equal(result.ok, false);
  assert.equal([...data.keys()].filter(k => k.startsWith("mcp:retry-data:")).length, 3);
  advance(120_001);
  await runDueRetry(storage, async request => {
    calls++; assert.equal(request.clientIdPrefix, identity);
    assert.equal(request.to, "verified-owner"); assert.equal(request.media!.fileName, "original.pdf");
    assert.deepEqual(request.media!.data, bytes);
  });
  assert.equal(calls, 2); assert.equal((await readDelivery(storage, "file-id"))!.state, "sent");
  assert.equal((await retryQueueStatus(storage)).pending, 0);
  assert.equal([...data.keys()].filter(k => k.startsWith("mcp:retry-data:")).length, 0);
}));

test("ambiguous failures wait two minutes and do not ask for a new per-attempt grant", async () => clock(async advance => {
  const { storage } = memory(); let calls = 0;
  await queueDelivery(storage, "id", "fp", text, async () => { calls++; throw new Error("connection lost"); });
  advance(119_999); await runDueRetry(storage, async () => { calls++; }); assert.equal(calls, 1);
  advance(2); await runDueRetry(storage, async () => { calls++; throw new Error("still unavailable"); });
  assert.equal(calls, 2); assert.equal((await deliveryRetryStatus(storage, "id"))!.retry_mode, "until_sent");
  advance(120_001); await runDueRetry(storage, async () => { calls++; });
  assert.equal(calls, 3); assert.equal((await readDelivery(storage, "id"))!.state, "sent");
}));

test("missing context waits for recovery and new inbound context wakes the retained job", async () => clock(async () => {
  const { storage } = memory(); let calls = 0;
  await queueDelivery(storage, "id", "fp", text, async () => { calls++; throw new WxBotError("no_context", "needs fresh context"); });
  assert.equal((await deliveryRetryStatus(storage, "id"))!.waiting_context, true);
  await runDueRetry(storage, async () => { calls++; }); assert.equal(calls, 1);
  await wakeContextRetries(storage);
  await runDueRetry(storage, async () => { calls++; });
  assert.equal(calls, 2); assert.equal((await readDelivery(storage, "id"))!.state, "sent");
}));

test("old uncertain and active records are not silently enrolled by a new policy", async () => {
  const { storage } = memory(); let calls = 0;
  for (const state of ["uncertain", "sending"] as const) {
    await storage.put("mcp:delivery:" + await sha256(state), { fingerprint: "fp", state, updated_at: Date.now() - 60_000 });
    await assert.rejects(queueDelivery(storage, state, "fp", text, async () => { calls++; }), /Legacy/);
  }
  assert.equal(calls, 0); assert.equal((await retryQueueStatus(storage)).pending, 0);
});

test("one explicit legacy review enrolls unchanged content for all subsequent retries", async () => clock(async advance => {
  const { storage } = memory(); let calls = 0;
  const at = Date.now() - 60_000;
  await storage.put("mcp:delivery:" + await sha256("old-id"), { fingerprint: "old-fp", state: "uncertain", updated_at: at });
  await confirmNotReceived(storage, "old-id", at, true, true);
  await queueDelivery(storage, "old-id", "old-fp", text, async () => { calls++; throw new Error("timeout"); });
  advance(120_001); await runDueRetry(storage, async () => { calls++; throw new Error("timeout"); });
  advance(120_001); await runDueRetry(storage, async () => { calls++; });
  assert.equal(calls, 3); assert.equal((await readDelivery(storage, "old-id"))!.state, "sent");
}));

test("concurrent admissions and runners share one active attempt", async () => {
  const { storage } = memory(); let calls = 0;
  const send = async () => { calls++; await new Promise(r => setTimeout(r, 10)); };
  await Promise.all(Array.from({ length: 4 }, () => queueDelivery(storage, "id", "fp", text, send)));
  await Promise.all([runDueRetry(storage, send), runDueRetry(storage, send)]);
  assert.equal(calls, 1); assert.equal((await readDelivery(storage, "id"))!.state, "sent");
});

test("changed content cannot replace a retained failed attachment", async () => {
  const { storage } = memory();
  await queueDelivery(storage, "id", "fp", text, async () => { throw new Error("timeout"); });
  await assert.rejects(queueDelivery(storage, "id", "different-fp", { ...text, text: "replacement" }, async () => {}), /different content/);
  assert.equal((await deliveryRetryStatus(storage, "id"))!.fingerprint, "fp");
});

test("corrupt retained bytes never reach the network", async () => clock(async advance => {
  const { storage, data } = memory(); let calls = 0;
  await queueDelivery(storage, "id", "fp", { to: "verified-owner", media: { kind: "file", fileName: "x.pdf", data: new Uint8Array([1, 2, 3]) } }, async () => { calls++; throw new Error("timeout"); });
  const chunk = [...data.keys()].find(k => k.startsWith("mcp:retry-data:"))!;
  data.set(chunk, new Uint8Array([9, 9, 9]));
  advance(120_001); await runDueRetry(storage, async () => { calls++; });
  assert.equal(calls, 1); assert.equal((await retryQueueStatus(storage)).pending, 1);
}));

test("late failure from an expired attempt cannot downgrade a newer successful send", async () => clock(async advance => {
  const { storage } = memory(); let reject!: (error: Error) => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const blocked = new Promise<void>((_, r) => { reject = r; });
  const first = queueDelivery(storage, "id", "fp", text, async () => { entered(); await blocked; });
  await started;
  let second = 0;
  await runDueRetry(storage, async () => { second++; }); assert.equal(second, 0);
  advance(20 * 60_000 + 1);
  await runDueRetry(storage, async () => { second++; }); assert.equal(second, 1);
  reject(new Error("old request failed late")); await first;
  assert.equal((await readDelivery(storage, "id"))!.state, "sent");
  assert.equal((await retryQueueStatus(storage)).pending, 0);
}));

test("stable per-chunk wire client IDs are reused on a later authorized attempt", async () => {
  const sent: any[] = [];
  const client = new IlinkClient({ bot_token: "test", base_url: "https://api.invalid", ilink_bot_id: "bot", ilink_user_id: "owner" }, { fetch: async (_, init) => { sent.push(JSON.parse(String(init?.body)).msg); return Response.json({ ret: 0 }); } });
  client.contextTokens.set("owner", "context");
  const value = "x".repeat(2500);
  await client.sendText("owner", value, "stable-prefix");
  await client.sendText("owner", value, "stable-prefix");
  assert.equal(sent.length, 4);
  assert.equal(sent[0].client_id, sent[2].client_id); assert.equal(sent[1].client_id, sent[3].client_id);
  assert.notEqual(sent[0].client_id, sent[1].client_id);
});
