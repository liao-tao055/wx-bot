import { expect, spyOn, test } from "bun:test";
import { WxBotError } from "@wx-bot/core";
import { handleMcpRequest, MAX_FILE_BYTES } from "../src/mcp.ts";
import { confirmNotReceived, deliverOnce, readDelivery, sha256 } from "../src/mcp-delivery.ts";
import type { Env } from "../src/index.ts";

function memoryStorage() {
  const data = new Map<string, any>();
  let queue = Promise.resolve();
  const storage: any = {
    async get(k: string) { return structuredClone(data.get(k)); },
    async put(k: string, v: unknown) { data.set(k, structuredClone(v)); },
    async delete(k: string | string[]) { for (const name of typeof k === "string" ? [k] : k) data.delete(name); },
    async list({ prefix, limit }: { prefix: string; limit: number }) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); },
    transaction(fn: (s: any) => Promise<unknown>) {
      const next = queue.then(() => fn(storage));
      queue = next.then(() => {}, () => {});
      return next;
    },
  };
  return storage as DurableObjectStorage;
}

function fixture() {
  const state = { logged_in: true, expired: false, allowlist: ["verified-owner"], login: "confirmed" };
  const sent: any[] = [];
  const storage = memoryStorage();
  const fake = {
    status: async () => structuredClone(state),
    mcpDeliveryStatus: (id: string) => readDelivery(storage, id),
    mcpConfirmNotReceived: (id: string, at: number, confirmed: boolean, authorized: boolean) => confirmNotReceived(storage, id, at, confirmed, authorized),
    mcpSendOnce: (id: string, fingerprint: string, req: unknown) => deliverOnce(storage, id, fingerprint, async () => { sent.push(req); }),
  };
  const env = { API_TOKEN: "a-private-runtime-secret-never-in-url", WXBOT: { idFromName: (s: string) => s, get: () => fake } } as unknown as Env;
  const request = async (url: string, options?: RequestInit) => {
    const r = await handleMcpRequest(new Request(url, options), env);
    if (!r) throw new Error("Route not handled");
    return r;
  };
  const link = async () => {
    const r = await request("https://wx.example/b/tong/mcp-link", { headers: { Authorization: `Bearer ${env.API_TOKEN}` } });
    return (await r.json()).server_url as string;
  };
  const rpc = async (url: string, method: string, params: any = {}, modern = false, extra: Record<string, string> = {}) => {
    if (modern) params = { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } };
    return request(url, { method: "POST", headers: { "Content-Type": "application/json", ...(modern ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}) } : {}), ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) });
  };
  const call = async (url: string, name: string, args: any) => (await rpc(url, "tools/call", { name, arguments: args })).json();
  return { env, request, link, rpc, call, state, sent, storage };
}

test("connection link needs bearer auth, is binding-scoped, and hides API_TOKEN", async () => {
  const f = fixture();
  expect((await f.request("https://wx.example/b/tong/mcp-link")).status).toBe(401);
  const url = await f.link();
  expect(url).not.toContain(f.env.API_TOKEN);
  expect((await f.request(url)).status).toBe(405);
  expect((await f.request(url.replace("/tong/", "/other/"))).status).toBe(401);
  f.env.API_TOKEN = "rotated-secret";
  expect((await f.rpc(url, "tools/list")).status).toBe(401);
});

test("existing API routes are passed through and untrusted Origin is rejected", async () => {
  const f = fixture();
  expect(await handleMcpRequest(new Request("https://wx.example/b/tong/v1/send"), f.env)).toBeUndefined();
  expect((await f.rpc(await f.link(), "tools/list", {}, false, { Origin: "https://attacker.example" })).status).toBe(403);
});

test("status distinguishes login from the last actual send result", async () => {
  const f = fixture();
  const last = { state: "failed", updated_at: 123, error: "sendmessage: ret=-2 errcode=0 errmsg=prepare failed" };
  Object.assign(f.state, { last_send: last });
  const result = await f.call(await f.link(), "wechat_status", {});
  expect(result.result.structuredContent.logged_in).toBe(true);
  expect(result.result.structuredContent.last_send).toEqual(last);
});

test("legacy initialize, tool discovery, and notification acknowledgements", async () => {
  const f = fixture(); const url = await f.link();
  const init = await (await f.rpc(url, "initialize", { protocolVersion: "2025-06-18" })).json();
  expect(init.result.protocolVersion).toBe("2025-06-18");
  const tools = await (await f.rpc(url, "tools/list")).json();
  expect(tools.result.tools).toHaveLength(6);
  expect(tools.result.tools.find((t: any) => t.name === "wechat_send_file")._meta["openai/fileParams"]).toEqual(["file"]);
  expect((await f.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status).toBe(202);
});

test("modern discovery and header/body/version checks", async () => {
  const f = fixture(); const url = await f.link();
  const r = await (await f.rpc(url, "server/discover", {}, true)).json();
  expect(r.result.resultType).toBe("complete");
  expect(r.result.supportedVersions).toContain("2026-07-28");
  const bad = await f.rpc(url, "tools/list", {}, true, { "Mcp-Method": "tools/call" });
  expect([bad.status, (await bad.json()).error.code]).toEqual([400, -32020]);
  const unsupported = await f.rpc(url, "tools/list", {}, false, { "MCP-Protocol-Version": "2099-01-01" });
  expect((await unsupported.json()).error.code).toBe(-32022);
  const missing = await f.request(url, { method: "POST", headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  expect(missing.status).toBe(400);
  const absentVersion = await f.rpc(url, "tools/list", {}, true, { "MCP-Protocol-Version": "" });
  expect(absentVersion.status).toBe(400);
});

test("malformed and oversized requests do not trigger sends", async () => {
  const f = fixture(); const url = await f.link();
  expect((await f.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
  expect((await f.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(130 * 1024) })).status).toBe(413);
  expect(f.sent).toHaveLength(0);
});

test("plain text always goes to the verified owner and repeated delivery is suppressed", async () => {
  const f = fixture(); const url = await f.link();
  const args = { delivery_id: "task:2026-10-30:text", task_title: "数学科研小工具", text: "原样内容 $HOME `x`" };
  expect((await f.call(url, "wechat_send_text", args)).result.structuredContent.ok).toBe(true);
  expect((await f.call(url, "wechat_send_text", args)).result.structuredContent.duplicate).toBe(true);
  expect(f.sent).toEqual([{ to: "verified-owner", text: "【数学科研小工具】\n原样内容 $HOME `x`" }]);
  expect((await f.call(url, "wechat_send_text", { ...args, text: "different" })).result.isError).toBe(true);
  expect((await f.call(url, "wechat_send_text", { ...args, delivery_id: "other", to: "somebody-else" })).result.isError).toBe(true);
  expect(f.sent).toHaveLength(1);
});

test("logged-out or ambiguous recipients cannot receive messages", async () => {
  const f = fixture(); const url = await f.link();
  f.state.expired = true;
  expect((await f.call(url, "wechat_send_text", { delivery_id: "x", text: "a" })).result.isError).toBe(true);
  f.state.expired = false; f.state.allowlist.push("someone-else");
  expect((await f.call(url, "wechat_send_text", { delivery_id: "x", text: "a" })).result.isError).toBe(true);
  expect(f.sent).toHaveLength(0);
});

const pdf = new TextEncoder().encode("%PDF-1.7\nattachment test bytes\n");
async function prepare(f: ReturnType<typeof fixture>, url: string, extra: any = {}) {
  return (await f.call(url, "wechat_prepare_file_upload", { delivery_id: "pdf:run1", task_title: "试卷", filename: "预测卷.pdf", size_bytes: pdf.length, sha256: await sha256(pdf), ...extra })).result;
}

test("local binary upload preserves PDF bytes and filename and sends only once", async () => {
  const f = fixture(); const result = await prepare(f, await f.link());
  const upload = result.structuredContent.upload_url;
  expect(upload).not.toContain(f.env.API_TOKEN);
  expect(upload).not.toContain("verified-owner");
  expect((await f.request(upload, { method: "PUT", body: pdf })).status).toBe(200);
  expect((await (await f.request(upload, { method: "PUT", body: pdf })).json()).duplicate).toBe(true);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].media.fileName).toBe("预测卷.pdf");
  expect(f.sent[0].media.data).toEqual(pdf);
  expect(f.sent[0].caption).toBe("【试卷】");
});

test("tampered, expired, changed-owner and wrong-byte uploads never send", async () => {
  const f = fixture(); const url = await f.link();
  const upload = (await prepare(f, url)).structuredContent.upload_url;
  expect((await f.request(upload.slice(0, -1) + (upload.endsWith("A") ? "B" : "A"), { method: "PUT", body: pdf })).status).toBe(401);
  expect((await f.request(upload, { method: "PUT", body: new TextEncoder().encode("wrong") })).status).toBe(400);
  f.state.allowlist = ["changed-owner"];
  expect((await f.request(upload, { method: "PUT", body: pdf })).status).toBe(403);
  f.state.allowlist = ["verified-owner"];
  const original = Date.now(); const clock = spyOn(Date, "now").mockReturnValue(original + 6 * 60_000);
  try { expect((await f.request(upload, { method: "PUT", body: pdf })).status).toBe(401); } finally { clock.mockRestore(); }
  expect(f.sent).toHaveLength(0);
});

test("noncanonical upload ticket encodings are rejected before sending", async () => {
  const f = fixture(); const url = await f.link();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let checked = 0;
  for (const filename of ["a.pdf", "ab.pdf", "abc.pdf"]) {
    const upload = (await prepare(f, url, { filename })).structuredContent.upload_url as string;
    const token = upload.slice(upload.lastIndexOf("/") + 1);
    if (token.length % 4 === 0) continue;
    const alternate = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)!) ^ 1];
    const decode = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decode(alternate)).toBe(decode(token));
    expect((await f.request(upload.slice(0, -token.length) + alternate, { method: "PUT", body: pdf })).status).toBe(401);
    checked++;
  }
  expect(checked).toBe(2);
  expect(f.sent).toHaveLength(0);
});

test("file limits, extensions, path traversal and hashes are validated", async () => {
  const f = fixture(); const url = await f.link();
  for (const extra of [{ filename: "../x.pdf" }, { filename: ".." }, { filename: " " }, { filename: "line\nfile.txt" }, { size_bytes: MAX_FILE_BYTES + 1 }, { sha256: "x".repeat(64) }]) expect((await prepare(f, url, extra)).isError).toBe(true);
  const result = await prepare(f, url, { filename: "not-a-zip.zip" });
  expect((await f.request(result.structuredContent.upload_url, { method: "PUT", body: pdf })).status).toBe(400);
  expect(f.sent).toHaveLength(0);
});

test("host-provided file inputs download trusted OpenAI bytes", async () => {
  const f = fixture(); const url = await f.link();
  const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(pdf));
  try {
    const r = await f.call(url, "wechat_send_file", { delivery_id: "host-file:1", filename: "report.pdf", file: { download_url: "https://files.oaiusercontent.com/test-file", file_id: "test" } });
    expect(r.result.structuredContent.ok).toBe(true);
    expect(f.sent[0].media.data).toEqual(pdf);
    expect(network.mock.calls[0]![1]!.redirect).toBe("manual");
  } finally { network.mockRestore(); }
});

test("arbitrary hosts and redirects are rejected without sending", async () => {
  const f = fixture(); const url = await f.link();
  const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } }));
  try {
    const args = { delivery_id: "ssrf", filename: "report.pdf", file: { download_url: "https://attacker.example/x", file_id: "test" } };
    expect((await f.call(url, "wechat_send_file", args)).result.isError).toBe(true);
    expect(network).toHaveBeenCalledTimes(0);
    args.file.download_url = "https://files.oaiusercontent.com/test-file";
    expect((await f.call(url, "wechat_send_file", args)).result.isError).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(0);
  } finally { network.mockRestore(); }
});

test("receipt admission is atomic and upstream uncertainty does not cause a retry", async () => {
  const storage = memoryStorage(); let sends = 0; let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const first = deliverOnce(storage, "concurrent", "hash", async () => { sends++; await pending; });
  await new Promise((r) => setTimeout(r, 0));
  await expect(deliverOnce(storage, "concurrent", "hash", async () => { sends++; })).rejects.toThrow("uncertain");
  release(); await first; expect(sends).toBe(1);
  await expect(deliverOnce(storage, "network", "hash", async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
  await expect(deliverOnce(storage, "network", "hash", async () => { sends++; })).rejects.toThrow("uncertain");
  expect((await readDelivery(storage, "network"))!.state).toBe("uncertain");
  expect(sends).toBe(1);
});

test("a known no_context failure can be retried after the user sends a new message", async () => {
  const storage = memoryStorage();
  await expect(deliverOnce(storage, "needs-context", "hash", async () => { throw new WxBotError("no_context", "message bot first"); })).rejects.toThrow("message bot first");
  expect(await readDelivery(storage, "needs-context")).toBeUndefined();
  expect(await deliverOnce(storage, "needs-context", "hash", async () => {})).toEqual({ ok: true, duplicate: false });
});

test("MCP explicit review arms an old receipt without sending a message", async () => {
  const f = fixture(); const url = await f.link();
  const at = Date.now() - 60_000;
  await f.storage.put("mcp:delivery:" + await sha256("reviewed"), { fingerprint: "original", state: "uncertain", updated_at: at });
  const args = { delivery_id: "reviewed", expected_updated_at: at, user_confirmed_not_received: true, user_authorized_retry: true };
  const r = (await f.call(url, "wechat_confirm_not_received", args)).result;
  expect(r.structuredContent).toMatchObject({ retry_ready: true, sent: false, state: "retry_ready" });
  expect(f.sent).toHaveLength(0);
  const receipt = (await f.call(url, "wechat_delivery_status", { delivery_id: "reviewed" })).result.structuredContent;
  expect(receipt.state).toBe("retry_ready");
});

test("MCP review cannot infer confirmation or change the verified owner", async () => {
  const f = fixture(); const url = await f.link(); const at = Date.now() - 60_000;
  await f.storage.put("mcp:delivery:" + await sha256("reviewed"), { fingerprint: "original", state: "uncertain", updated_at: at });
  const args = { delivery_id: "reviewed", expected_updated_at: at, user_confirmed_not_received: true, user_authorized_retry: true };
  for (const change of [{ user_authorized_retry: false }, { user_confirmed_not_received: false }, { expected_updated_at: at - 1 }, { to: "other-owner" }]) {
    expect((await f.call(url, "wechat_confirm_not_received", { ...args, ...change })).result.isError).toBe(true);
  }
  f.state.expired = true;
  expect((await f.call(url, "wechat_confirm_not_received", args)).result.isError).toBe(true);
  expect((await readDelivery(f.storage, "reviewed"))!.state).toBe("uncertain");
  expect(f.sent).toHaveLength(0);
});

test("native PDF retry after human review preserves exact filename, title, owner and bytes", async () => {
  const f = fixture(); const url = await f.link(); const at = Date.now() - 60_000;
  const digest = await sha256(pdf);
  const fp = await sha256(JSON.stringify(["verified-owner", "试卷", "预测卷.pdf", digest]));
  await f.storage.put("mcp:delivery:" + await sha256("pdf:run1"), { fingerprint: fp, state: "uncertain", updated_at: at });
  expect((await f.call(url, "wechat_confirm_not_received", { delivery_id: "pdf:run1", expected_updated_at: at, user_confirmed_not_received: true, user_authorized_retry: true })).result.structuredContent.sent).toBe(false);
  const ticket = (await prepare(f, url)).structuredContent.upload_url;
  expect((await f.request(ticket, { method: "PUT", body: pdf })).status).toBe(200);
  expect((await (await f.request(ticket, { method: "PUT", body: pdf })).json()).duplicate).toBe(true);
  expect(f.sent).toEqual([{ to: "verified-owner", caption: "【试卷】", media: { kind: "file", fileName: "预测卷.pdf", data: pdf } }]);
});

test("status reports context observation and poll health separately from login", async () => {
  const f = fixture(); const url = await f.link();
  Object.assign(f.state, { context_available: true, context_observed_at: 12345, poll_health: { ok: false, updated_at: 12350, error: "getupdates HTTP 502" } });
  const status = (await f.call(url, "wechat_status", {})).result.structuredContent;
  expect(status).toMatchObject({ server_version: "0.3.1", supported_file_types: "any", file_delivery_mode: "native_file", logged_in: true, expired: false, context_available: true, context_observed_at: 12345, poll_health: { ok: false, error: "getupdates HTTP 502" }, session_start: null, session_recovery: null });
});

test("workspace uploads preserve Office, text, images and arbitrary binary files exactly", async () => {
  const f = fixture(); const url = await f.link();
  const zip = Uint8Array.from([80, 75, 5, 6, ...new Array(18).fill(0)]);
  const binary = Uint8Array.from([0, 255, 128, 13, 10, 42]);
  for (const [name, data] of [
    ["数学预测卷.pdf", pdf], ["资料.zip", zip], ["详细解答.docx", zip], ["成绩.xlsx", zip],
    ["讲解.pptx", zip], ["旧版文档.doc", binary], ["旧版表格.xls", binary],
    ["说明.txt", new TextEncoder().encode("原样中文\r\n")], ["data.csv", binary],
    ["原始图片.png", binary], ["recording.mp4", binary], ["opaque.bin", binary], ["LICENSE", binary],
  ] as [string, Uint8Array][]) {
    const result = (await f.call(url, "wechat_prepare_file_upload", { delivery_id: "files:" + name, filename: name, size_bytes: data.length, sha256: await sha256(data) })).result;
    expect(result.isError).not.toBe(true);
    const upload = result.structuredContent.upload_url;
    expect((await f.request(upload, { method: "PUT", body: data })).status).toBe(200);
    expect(f.sent.at(-1).media).toEqual({ kind: "file", fileName: name, data });
    expect((await (await f.request(upload, { method: "PUT", body: data })).json()).duplicate).toBe(true);
  }
  expect(f.sent).toHaveLength(13);
});

test("host file inputs support Word and Excel and malformed local paths explain the upload fallback", async () => {
  const f = fixture(); const url = await f.link();
  const zip = Uint8Array.from([80, 75, 5, 6, ...new Array(18).fill(0)]);
  const network = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(zip));
  try {
    for (const filename of ["作业.docx", "统计.xlsx"]) {
      const result = (await f.call(url, "wechat_send_file", { delivery_id: filename, filename, file: { download_url: "https://files.oaiusercontent.com/file", file_id: "test" } })).result;
      expect(result.structuredContent.ok).toBe(true);
      expect(f.sent.at(-1).media).toEqual({ kind: "file", fileName: filename, data: zip });
    }
    const bad = (await f.call(url, "wechat_send_file", { delivery_id: "local", filename: "作业.docx", file: "/workspace/作业.docx" })).result;
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.message).toContain("wechat_prepare_file_upload");
    expect(network).toHaveBeenCalledTimes(2);
  } finally { network.mockRestore(); }
});

test("preparing again detects a sent file, content mismatch and unresolved delivery before uploading", async () => {
  const f = fixture(); const url = await f.link();
  const first = (await prepare(f, url)).structuredContent;
  expect((await f.request(first.upload_url, { method: "PUT", body: pdf })).status).toBe(200);
  const duplicate = (await prepare(f, url)).structuredContent;
  expect(duplicate).toMatchObject({ already_sent: true, duplicate: true, state: "sent" });
  expect(duplicate.upload_url).toBeUndefined();
  const changed = await prepare(f, url, { sha256: await sha256(new TextEncoder().encode("changed")) });
  expect(changed.isError).toBe(true);
  expect(changed.structuredContent.error.message).toContain("different content");
  const receipt = await readDelivery(f.storage, "pdf:run1");
  await f.storage.put("mcp:delivery:" + await sha256("pdf:run1"), { ...receipt, state: "uncertain" });
  const blocked = await prepare(f, url);
  expect(blocked.isError).toBe(true);
  expect(blocked.structuredContent.error.message).toContain("uncertain");
  expect(f.sent).toHaveLength(1);
});
