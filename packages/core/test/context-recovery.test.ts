import { expect, test } from "bun:test";
import { IlinkClient, type ClientOptions } from "../src/client.ts";
import { allowlist, sendMessage } from "../src/send.ts";
import { ItemType } from "../src/types.ts";

function fixture(responses: Array<Record<string, unknown> | Error | number>, opts: ClientOptions = {}) {
  const sent: any[] = [];
  const starts: number[] = [];
  let uploads = 0;
  const client = new IlinkClient({ bot_token: "secret-bot-token", base_url: "https://api.invalid", ilink_bot_id: "bot", ilink_user_id: "owner" }, {
    recoverStaleContext: true,
    cdnBase: "https://cdn.invalid",
    ...opts,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("getuploadurl")) return Response.json({ ret: 0, upload_param: "UPLOAD" });
      if (path === "/upload") { uploads++; return new Response(null, { headers: { "x-encrypted-param": "DOWNLOAD" } }); }
      expect(path).toBe("/ilink/bot/sendmessage");
      sent.push({ ...JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("Authorization") });
      starts.push(Date.now());
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === "number") return new Response("server error", { status: response });
      if (!response) throw new Error("unexpected extra send");
      return Response.json(response);
    },
  });
  client.contextTokens.set("owner", "old-context");
  return { client, sent, starts, uploads: () => uploads };
}

test("stale context recovery is opt-in and preserves upstream diagnostic fields", async () => {
  const f = fixture([{ ret: -2, errcode: 17, errmsg: "prepare failed" }], { recoverStaleContext: false });
  await expect(f.client.sendText("owner", "one")).rejects.toThrow("ret=-2 errcode=17 errmsg=prepare failed");
  expect(f.sent).toHaveLength(1);
});

for (const detail of ["unknown error", "prepare failed"]) {
  test(`one bounded recovery after ${detail}; same recipient, payload, client ID and authentication`, async () => {
    const f = fixture([{ ret: -2, errmsg: detail }, { ret: 0 }, { ret: 0 }, { ret: 0 }]);
    await f.client.sendText("owner", "first");
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0].msg.context_token).toBe("old-context");
    expect(f.sent[1].msg).not.toHaveProperty("context_token");
    const { context_token, ...original } = f.sent[0].msg;
    expect(f.sent[1].msg).toEqual(original);
    expect(f.sent[1].authorization).toBe(f.sent[0].authorization);
    await f.client.sendText("owner", "second");
    expect(f.sent[2].msg).not.toHaveProperty("context_token");
    f.client.contextTokens.set("owner", "fresh-context");
    await f.client.sendText("owner", "third");
    expect(f.sent[3].msg.context_token).toBe("fresh-context");
  });
}

test("no repeated retries when tokenless recovery is also rejected", async () => {
  const f = fixture([{ ret: -2, errmsg: "prepare failed" }, { ret: -2, errmsg: "prepare failed" }]);
  await expect(f.client.sendText("owner", "one")).rejects.toThrow("automatic context recovery did not succeed");
  expect(f.sent).toHaveLength(2);
});

test("explicit rate limits and unspecified -2 errors are not retried", async () => {
  for (const errmsg of ["rate limited", "", "invalid parameter"]) {
    const f = fixture([{ ret: -2, errmsg }]);
    await expect(f.client.sendText("owner", "one")).rejects.toThrow("ret=-2");
    expect(f.sent).toHaveLength(1);
  }
});

test("expired authentication never triggers context recovery", async () => {
  for (const response of [{ ret: -14 }, { ret: -2, errcode: -14, errmsg: "prepare failed" }]) {
    const f = fixture([response]);
    await expect(f.client.sendText("owner", "one")).rejects.toMatchObject({ kind: "expired" });
    expect(f.sent).toHaveLength(1);
  }
});

test("transport and HTTP failures remain ambiguous and are never repeated", async () => {
  for (const response of [new Error("connection lost"), 502]) {
    const f = fixture([response]);
    await expect(f.client.sendText("owner", "one")).rejects.toMatchObject({ kind: "upstream" });
    expect(f.sent).toHaveLength(1);
  }
});

test("owner allowlist and initial inbound-message requirement remain enforced", async () => {
  const f = fixture([]);
  await expect(sendMessage(f.client, allowlist("owner"), { binding: "tong", to: "stranger", text: "x" })).rejects.toMatchObject({ kind: "forbidden" });
  f.client.contextTokens.clear();
  await expect(sendMessage(f.client, allowlist("owner"), { binding: "tong", to: "owner", text: "x" })).rejects.toMatchObject({ kind: "no_context" });
  expect(f.sent).toHaveLength(0);
});

test("file recovery does not upload again or resend an already successful caption", async () => {
  const f = fixture([{ ret: 0 }, { ret: -2, errmsg: "prepare failed" }, { ret: 0 }]);
  await f.client.sendMedia("owner", { data: new TextEncoder().encode("zip-test"), fileName: "check.zip", itemType: ItemType.File, caption: "caption" });
  expect(f.uploads()).toBe(1);
  expect(f.sent).toHaveLength(3);
  expect(f.sent[0].msg.item_list[0].type).toBe(ItemType.Text);
  expect(f.sent[1].msg.item_list).toEqual(f.sent[2].msg.item_list);
  expect(f.sent[1].msg.client_id).toBe(f.sent[2].msg.client_id);
  expect(f.sent[2].msg).not.toHaveProperty("context_token");
});

test("nonzero errcode is an error even when ret is zero", async () => {
  const f = fixture([{ ret: 0, errcode: -2, errmsg: "unknown error" }, { ret: 0 }]);
  await f.client.sendText("owner", "one");
  expect(f.sent).toHaveLength(2);
});

test("upstream diagnostics redact authentication and context secrets", async () => {
  const f = fixture([{ ret: -2, errmsg: "invalid secret-bot-token old-context\nvalue" }]);
  const error = await f.client.sendText("owner", "one").catch(e => e);
  expect(error.message).toContain("[redacted]");
  expect(error.message).not.toContain("secret-bot-token");
  expect(error.message).not.toContain("old-context");
  expect(error.message).not.toContain("\n");
});

test("concurrent send requests are paced, including a recovery request", async () => {
  const f = fixture([{ ret: -2, errmsg: "prepare failed" }, { ret: 0 }, { ret: 0 }], { minSendIntervalMs: 30 });
  await Promise.all([f.client.sendText("owner", "a"), f.client.sendText("owner", "b")]);
  expect(f.sent).toHaveLength(3);
  expect(f.starts[1]! - f.starts[0]!).toBeGreaterThanOrEqual(25);
  expect(f.starts[2]! - f.starts[1]!).toBeGreaterThanOrEqual(25);
});
