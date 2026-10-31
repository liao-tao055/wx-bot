import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { IlinkClient, isPrepareFailure, WxBotError, type FetchLike } from "@wx-bot/core";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { WxBinding } = await import("../src/index.ts");

const session = { bot_token: "test-secret", base_url: "https://api.invalid", ilink_bot_id: "test-bot", ilink_user_id: "owner" };
function fixture() {
  const data = new Map<string, any>([["binding", "tong"], ["session", session], ["context_tokens", { owner: "old-context" }]]);
  let alarm: number | null = null;
  const storage: any = {
    async get(key: string) { return structuredClone(data.get(key)); },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) data.set(k as string, structuredClone(v));
    },
    async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) data.delete(k); },
    async getAlarm() { return alarm; },
    async setAlarm(value: number) { alarm = value; },
    async deleteAlarm() { alarm = null; },
    transaction(fn: (tx: unknown) => unknown) { return fn(storage); },
  };
  const binding: any = Object.create(WxBinding.prototype);
  Object.assign(binding, { ctx: { storage }, env: {}, clientGeneration: 0, inbox: { stats: () => ({ pending: 0 }) } });
  return { binding, data, alarm: () => alarm };
}
async function withFetch(fetcher: FetchLike, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("notifyStart uses the authenticated lifecycle endpoint and sends no chat message", async () => {
  const calls: any[] = [];
  const client = new IlinkClient(session, { fetch: async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ ret: 0 });
  } });
  await client.notifyStart();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/ilink/bot/msg/notifystart");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer test-secret");
  assert.ok(calls[0].body.base_info);
  assert.equal(calls[0].body.msg, undefined);
});

test("cold-start polling and sending share one initialized client and token map", async () => {
  const f = fixture(); let starts = 0;
  await withFetch(async () => { starts++; return Response.json({ ret: 0 }); }, async () => {
    const [a, b, c] = await Promise.all([f.binding.liveClient(), f.binding.liveClient(), f.binding.liveClient()]);
    assert.equal(a, b); assert.equal(b, c); assert.equal(starts, 1);
    a.contextTokens.set("owner", "fresh-context");
    assert.equal((await f.binding.liveClient()).contextTokens.get("owner"), "fresh-context");
    assert.equal(f.data.get("session_start").ok, true);
  });
});

test("a session change cannot publish the previous in-flight client", async () => {
  const f = fixture(); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  let calls = 0;
  await withFetch(async () => { if (++calls === 1) { entered(); await gate; } return Response.json({ ret: 0 }); }, async () => {
    const old = f.binding.liveClient();
    const rejected = assert.rejects(old, /session changed/);
    await started;
    await f.binding.useSession({ ...session, ilink_bot_id: "new-bot" }, { owner: "new-context" });
    const current = await f.binding.liveClient();
    release(); await rejected;
    assert.equal(current.botId, "new-bot");
    assert.equal((await f.binding.liveClient()), current);
    assert.equal(current.contextTokens.get("owner"), "new-context");
  });
});

test("transient lifecycle failure stays observable and does not disable polling", async () => {
  const f = fixture();
  await withFetch(async () => new Response("unavailable", { status: 503 }), async () => {
    assert.ok(await f.binding.liveClient());
    assert.equal(f.data.get("session_start").ok, false);
    assert.match(f.data.get("session_start").error, /status 503/);
    assert.deepEqual(f.data.get("session"), session);
  });
});

test("expired lifecycle authentication remains expired and is never hidden", async () => {
  const f = fixture();
  await withFetch(async () => Response.json({ ret: -14 }), async () => {
    await assert.rejects(f.binding.liveClient(), (err: any) => err.kind === "expired");
    assert.ok(f.data.get("expired"));
    assert.equal(f.binding.client, undefined);
  });
});

test("explicit prepare rejection repairs the session but never replays the failed delivery", async () => {
  const f = fixture(); let starts = 0; let sends = 0; let aborted = false;
  f.binding.pollAbort = { abort() { aborted = true; } };
  await withFetch(async (url) => {
    if (String(url).endsWith("notifystart")) { starts++; return Response.json({ ret: 0 }); }
    assert.ok(String(url).endsWith("sendmessage")); sends++;
    return Response.json({ ret: -2, errmsg: "prepare failed" });
  }, async () => {
    await assert.rejects(f.binding.mcpSendOnce("original-id", "original-fingerprint", { to: "owner", text: "one" }), /prepare failed/);
    assert.equal(starts, 2); assert.equal(sends, 2); // Original + existing one-shot token fallback, no third send.
    assert.equal(aborted, true); assert.ok(f.alarm());
    assert.equal(f.data.get("session_recovery").ok, true);
    const receipt = await f.binding.mcpDeliveryStatus("original-id");
    assert.equal(receipt.state, "uncertain"); assert.equal(receipt.fingerprint, "original-fingerprint");
    await assert.rejects(f.binding.mcpSendOnce("original-id", "original-fingerprint", { to: "owner", text: "one" }), /uncertain/);
    assert.equal(sends, 2);
    assert.deepEqual(f.data.get("session"), session);
    assert.deepEqual(f.data.get("context_tokens"), { owner: "old-context" });
  });
});

test("session repair is single-flight and respects a persisted cooldown", async () => {
  const f = fixture(); let starts = 0;
  await withFetch(async () => { starts++; return Response.json({ ret: 0 }); }, async () => {
    await Promise.all([f.binding.recoverSession(), f.binding.recoverSession(), f.binding.recoverSession()]);
    assert.equal(starts, 1);
    await f.binding.recoverSession(); assert.equal(starts, 1);
    f.data.set("session_recovery", { ok: true, updated_at: Date.now() - 61_000 });
    await f.binding.recoverSession(); assert.equal(starts, 2);
  });
});

test("transport ambiguity never triggers lifecycle repair or another send", async () => {
  const f = fixture(); let starts = 0; let sends = 0;
  await withFetch(async (url) => {
    if (String(url).endsWith("notifystart")) { starts++; return Response.json({ ret: 0 }); }
    sends++; throw new Error("connection lost");
  }, async () => {
    await assert.rejects(f.binding.send({ to: "owner", text: "one" }), /connection lost/);
    assert.equal(starts, 1); assert.equal(sends, 1);
    assert.equal(f.data.get("session_recovery"), undefined);
    assert.equal(isPrepareFailure(new WxBotError("upstream", "prepare failed")), false);
  });
});

test("logging out invalidates an in-flight startup and leaves no polling alarm", async () => {
  const f = fixture(); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  await withFetch(async () => { entered(); await gate; return Response.json({ ret: 0 }); }, async () => {
    const pending = f.binding.liveClient();
    const rejected = assert.rejects(pending, /session changed/);
    await started;
    const response = await f.binding.fetch(new Request("https://worker.invalid/session", { method: "DELETE", headers: { "X-WxBot-Binding": "tong" } }));
    assert.equal(response.status, 200);
    release(); await rejected;
    assert.equal(f.binding.client, undefined);
    assert.equal(f.data.get("session"), undefined);
    assert.equal(f.alarm(), null);
  });
});

test("a cold health check reports actual lifecycle startup without sending chat content", async () => {
  const f = fixture(); const paths: string[] = [];
  await withFetch(async (url) => { paths.push(new URL(String(url)).pathname); return Response.json({ ret: 0 }); }, async () => {
    const status = await f.binding.status();
    assert.equal(status.server_version, "0.3.4");
    assert.equal(status.session_start.ok, true);
    assert.equal(status.expired, false);
    await f.binding.status();
    assert.deepEqual(paths, ["/ilink/bot/msg/notifystart"]);
    assert.equal(f.data.get("last_send"), undefined);
  });
});

test("health checks report lifecycle authentication expiry without another login attempt", async () => {
  const f = fixture(); let calls = 0;
  await withFetch(async () => { calls++; return Response.json({ ret: -14 }); }, async () => {
    const status = await f.binding.status();
    assert.equal(status.expired, true);
    assert.equal(status.session_start.ok, false);
    await f.binding.status(); assert.equal(calls, 1);
  });
});

test("health checks re-arm overdue polling and expose the age of historical health", async () => {
  const f = fixture();
  const old = Date.now() - 600_000;
  await f.binding.ctx.storage.setAlarm(old);
  f.data.set("poll_health", { ok: true, updated_at: old });
  await withFetch(async () => Response.json({ ret: 0 }), async () => {
    const before = Date.now();
    const status = await f.binding.status();
    assert.equal(status.poller_running, false);
    assert.ok(status.poll_health_age_ms >= 600_000);
    assert.ok(status.poll_alarm_at >= before);
    assert.equal(status.poll_alarm_at, f.alarm());
    assert.equal(f.data.get("last_send"), undefined);
  });
});

test("health checks preserve a running poller and a short pending retry", async () => {
  const f = fixture(); const controller = new AbortController();
  f.binding.pollAbort = controller;
  const old = Date.now() - 60_000;
  await f.binding.ctx.storage.setAlarm(old);
  await withFetch(async () => Response.json({ ret: 0 }), async () => {
    assert.equal((await f.binding.status()).poller_running, true);
    assert.equal(f.alarm(), old);
    controller.abort();
    const pending = Date.now() + 10_000;
    await f.binding.ctx.storage.setAlarm(pending);
    assert.equal((await f.binding.status()).poller_running, false);
    assert.equal(f.alarm(), pending);
  });
});

test("an unexpected alarm failure is observable and schedules a bounded poll restart", async () => {
  const f = fixture(); const before = Date.now();
  f.binding.runAlarm = async () => { throw new Error("poll-loop-test-error"); };
  await f.binding.alarm();
  assert.equal(f.data.get("poll_alarm_health").state, "failed");
  assert.equal(f.data.get("poll_alarm_health").error, "poll-loop-test-error");
  assert.ok(f.alarm()! >= before + 30_000);
  assert.equal(f.data.get("last_send"), undefined);
});
