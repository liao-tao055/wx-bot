// Personal, binding-scoped MCP bridge. No API_TOKEN is ever embedded in its URL.
// A derived capability URL is the credential; keep the personal plugin private.
import { safeEqual, WxBotError } from "@wx-bot/core";
import type { Env } from "./index.ts";
import { sha256 } from "./mcp-delivery.ts";

const enc = new TextEncoder();
const BINDING = /^[a-z0-9_-]{1,32}$/;
const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MCP_SERVER_VERSION = "0.3.1";
const SERVER = { name: "wx-bot-personal", version: MCP_SERVER_VERSION };
const INSTRUCTIONS = "Send only user-authorized task output to this binding's verified WeChat owner. Use plain text. Use stable delivery_id values (task + scheduled time + filename) to avoid duplicates for seven days. Any file format is supported as a native file attachment, including PDF, ZIP, Word, Excel, PowerPoint, text, and images; each file is at most 10 MiB. wechat_send_file requires the host-converted file object, NOT a local path string. For local workspace files when host conversion is unavailable, use wechat_prepare_file_upload, then PUT exact local bytes to its short-lived upload_url. A successful PUT sends the file; do not send it again through another route. Never expose connection or upload URLs in chat. Report errors here, not in WeChat. no_context requires a new user message to ClawBot; expired requires re-login. Never retry uncertain delivery automatically.";
const REVIEW_INSTRUCTIONS = " Only after the user explicitly checks WeChat, confirms non-receipt, and authorizes one retry, call wechat_confirm_not_received using the latest delivery status timestamp. A greeting, elapsed time, and the absence of a sent receipt are not consent. Then retry the same delivery_id and identical content exactly once. Never create a new ID to bypass uncertainty.";

const textProp = (description: string, maxLength: number) => ({ type: "string", description, minLength: 1, maxLength });
const common = {
  delivery_id: textProp("Stable identifier for this task run and output; reuse it for retries, up to 200 characters.", 200),
  task_title: { type: "string", description: "Task name, prefixed to the WeChat message or caption.", maxLength: 100 },
};
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = [
  { name: "wechat_status", description: "Check this personal WeChat binding's login before sending. No recipient can be selected.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: readAnnotations },
  { name: "wechat_send_text", description: "Send authorized plain-text task results to the verified WeChat owner. Do not send errors here.", inputSchema: { type: "object", properties: { ...common, text: textProp("Plain text to deliver.", 12000) }, required: ["delivery_id", "text"], additionalProperties: false }, annotations: writeAnnotations },
  {
    name: "wechat_send_file", description: "Send any user-authorized file as a native WeChat file attachment, including PDF, ZIP, Word, Excel, PowerPoint, text, or images, at most 10 MiB. file must be a host-converted file object, not a local path string. If conversion is unavailable use wechat_prepare_file_upload and PUT the local bytes. Does not accept arbitrary download sites.",
    inputSchema: { type: "object", properties: { ...common, filename: textProp("Original attachment basename, including its extension if present; no directory separators.", 180), file: { type: "object", properties: { download_url: { type: "string" }, file_id: { type: "string" }, file_name: { type: "string" }, mime_type: { type: "string" } }, required: ["download_url", "file_id"], additionalProperties: false } }, required: ["delivery_id", "filename", "file"], additionalProperties: false },
    annotations: writeAnnotations, _meta: { "openai/fileParams": ["file"] },
  },
  {
    name: "wechat_prepare_file_upload", description: "Upload any authorized local workspace file (PDF, ZIP, Word, Excel, PowerPoint, text, images, or other binary files) when host file conversion is unavailable. Obtain a 5-minute PUT URL and upload exact bytes from the execution environment. A successful PUT sends the native WeChat file attachment. No phone transfer is needed.",
    inputSchema: { type: "object", properties: { ...common, filename: textProp("Original attachment basename, including its extension if present; no directory separators.", 180), size_bytes: { type: "integer", minimum: 1, maximum: MAX_FILE_BYTES }, sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "Compute from the exact local file bytes." } }, required: ["delivery_id", "filename", "size_bytes", "sha256"], additionalProperties: false }, annotations: { ...writeAnnotations, openWorldHint: false },
  },
  { name: "wechat_delivery_status", description: "Check a stable delivery_id after a timeout. A pending/uncertain delivery must be reviewed in WeChat, not automatically resent.", inputSchema: { type: "object", properties: { delivery_id: common.delivery_id }, required: ["delivery_id"], additionalProperties: false }, annotations: readAnnotations },
  {
    name: "wechat_confirm_not_received",
    description: "After the owner explicitly checks WeChat, confirms this item was not received, and authorizes ONE same-ID same-content retry, arm that retry. Does not send anything. Never use automatically; sent or in-progress items cannot be unlocked.",
    inputSchema: { type: "object", properties: {
      delivery_id: common.delivery_id,
      expected_updated_at: { type: "integer", minimum: 1, description: "Exact updated_at from the latest wechat_delivery_status result." },
      user_confirmed_not_received: { type: "boolean", const: true, description: "True only after the user actually checks WeChat and explicitly confirms non-receipt of this item." },
      user_authorized_retry: { type: "boolean", const: true, description: "True only after the user explicitly authorizes one retry, acknowledging possible duplicates if the old request completes late." },
    }, required: ["delivery_id", "expected_updated_at", "user_confirmed_not_received", "user_authorized_retry"], additionalProperties: false },
    annotations: { ...writeAnnotations, openWorldHint: false },
  },
];

type Obj = Record<string, unknown>;
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function object(x: unknown): Obj {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new HttpError(400, "Expected an object");
  return x as Obj;
}
function str(x: unknown, name: string, max: number): string {
  if (typeof x !== "string" || !x.length || x.length > max) throw new HttpError(400, `${name} must have 1-${max} characters`);
  return x;
}
function taskTitle(x: unknown): string {
  if (x === undefined || x === "") return "";
  const title = str(x, "task_title", 100);
  if (/[\r\n\x00-\x1f]/.test(title)) throw new HttpError(400, "task_title must be one line");
  return title;
}
function filename(x: unknown): string {
  const name = str(x, "filename", 180);
  if (!name.trim() || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)) throw new HttpError(400, "Use a non-empty attachment basename without directory separators or control characters");
  return name;
}
function caption(title: string): string | undefined { return title ? `【${title}】` : undefined; }
function b64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(401, "Invalid upload ticket");
  try {
    const decoded = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    if (b64(decoded) !== value) throw new HttpError(401, "Invalid upload ticket");
    return decoded;
  }
  catch { throw new HttpError(401, "Invalid upload ticket"); }
}
async function mac(secret: string, purpose: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(purpose)));
}
async function ticketKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await mac(secret, "wx-bot/mcp/upload-encryption/v1"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(secret: string, payload: Obj): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("wx-bot-upload-v1") }, await ticketKey(secret), enc.encode(JSON.stringify(payload))));
  const all = new Uint8Array(iv.length + body.length); all.set(iv); all.set(body, iv.length);
  return b64(all);
}
async function openTicket(secret: string, token: string): Promise<Obj> {
  try {
    const all = unb64(token);
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), additionalData: enc.encode("wx-bot-upload-v1") }, await ticketKey(secret), all.slice(12));
    const p = object(JSON.parse(new TextDecoder().decode(raw)));
    if (typeof p.expires_at !== "number" || Date.now() >= p.expires_at) throw new HttpError(401, "Upload ticket expired; prepare a new one with the same delivery_id");
    return p;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "Invalid upload ticket");
  }
}
async function bytes(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > max) { await reader.cancel(); throw new HttpError(413, "Payload exceeds the allowed size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(length); let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  return all;
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + "\n", { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}
function fail(id: unknown, code: number, message: string, status = 400, data?: unknown) {
  return json(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}
function ok(id: unknown, result: Obj, modern: boolean) {
  return json(200, { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result });
}
function errorMessage(err: unknown): string { return err instanceof Error ? err.message : "Unexpected error"; }
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("Origin");
  return !origin || origin === new URL(req.url).origin || origin === "https://chatgpt.com" || origin === "https://chat.openai.com";
}
function stub(env: Env, binding: string) { return env.WXBOT.get(env.WXBOT.idFromName(binding)); }
async function owner(env: Env, binding: string): Promise<string> {
  const st = await stub(env, binding).status();
  if (!st.logged_in || st.expired) throw new WxBotError("expired", "WeChat login is missing or expired; ask the user to scan again");
  if (st.allowlist.length !== 1) throw new WxBotError("forbidden", "Expected exactly one verified WeChat owner");
  return st.allowlist[0]!;
}
function verifyFile(name: string, data: Uint8Array) {
  if (!data.length || data.length > MAX_FILE_BYTES) throw new HttpError(413, "File must have 1 byte to 10 MiB");
  const signature = new TextDecoder().decode(data.slice(0, 8));
  const zip = data[0] === 80 && data[1] === 75 && ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6) || (data[2] === 7 && data[3] === 8));
  if (/\.pdf$/i.test(name) && !signature.startsWith("%PDF-")) throw new HttpError(400, "File content does not match its PDF extension");
  if (/\.(zip|docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i.test(name) && !zip) throw new HttpError(400, "File content does not match its ZIP-based document extension");
  // Other formats are opaque bytes, not converted, executed, or interpreted.
}
function trustedFileUrl(raw: string): URL {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const trusted = host === "chatgpt.com" || host === "oaiusercontent.com" || host.endsWith(".oaiusercontent.com") || /^oai(?:sdmntpr|sdsorpr)[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host) || /^oaisdmntpr[a-z0-9-]*aws\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
  if (u.protocol !== "https:" || u.port && u.port !== "443" || u.username || u.password || !trusted) throw new HttpError(400, "Only host-provided OpenAI file download URLs are accepted; use wechat_prepare_file_upload for a local file instead");
  return u;
}
async function downloadFile(raw: string): Promise<Uint8Array> {
  let url = trustedFileUrl(raw);
  for (let n = 0; n < 4; n++) {
    const resp = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("Location"); await resp.body?.cancel();
      if (!location) throw new HttpError(502, "File download redirect is missing Location");
      url = trustedFileUrl(new URL(location, url).href); continue;
    }
    if (!resp.ok) { await resp.body?.cancel(); throw new HttpError(502, `Host file download returned HTTP ${resp.status}`); }
    if (Number(resp.headers.get("Content-Length") ?? 0) > MAX_FILE_BYTES) { await resp.body?.cancel(); throw new HttpError(413, "File exceeds 10 MiB"); }
    return bytes(resp.body, MAX_FILE_BYTES);
  }
  throw new HttpError(502, "Too many file download redirects");
}
async function sendFile(env: Env, binding: string, to: string, id: string, title: string, name: string, data: Uint8Array) {
  verifyFile(name, data);
  const digest = await sha256(data);
  const fingerprint = await sha256(JSON.stringify([to, title, name, digest]));
  const result = await stub(env, binding).mcpSendOnce(id, fingerprint, { to, caption: caption(title), media: { kind: "file", fileName: name, data } });
  return { ok: result.ok, duplicate: result.duplicate };
}
async function tool(env: Env, binding: string, name: unknown, a: Obj, origin: string): Promise<Obj> {
  if (name === "wechat_status") {
    const st = await stub(env, binding).status();
    return { binding, logged_in: st.logged_in, expired: st.expired, login: st.login ?? null, max_file_bytes: MAX_FILE_BYTES, last_send: st.last_send ?? null,
      server_version: SERVER.version, supported_file_types: "any", file_delivery_mode: "native_file", upload_url_ttl_seconds: 300,
      context_available: st.context_available ?? false, context_observed_at: st.context_observed_at ?? null, poll_health: st.poll_health ?? null,
      session_start: st.session_start ?? null, session_recovery: st.session_recovery ?? null };
  }
  const id = str(a.delivery_id, "delivery_id", 200);
  if (name === "wechat_delivery_status") {
    const r = await stub(env, binding).mcpDeliveryStatus(id);
    return { delivery_id: id, state: r?.state ?? "not_found", updated_at: r?.updated_at ?? null };
  }
  const to = await owner(env, binding);
  if (name === "wechat_confirm_not_received") {
    const r = await stub(env, binding).mcpConfirmNotReceived(id, a.expected_updated_at as number, a.user_confirmed_not_received === true, a.user_authorized_retry === true);
    return { delivery_id: id, state: r.state, updated_at: r.updated_at, retry_ready: true, sent: false, instructions: "Retry the original delivery_id and identical content once. No message has been sent by this confirmation." };
  }
  const title = taskTitle(a.task_title);
  if (name === "wechat_send_text") {
    const text = str(a.text, "text", 12000);
    const result = await stub(env, binding).mcpSendOnce(id, await sha256(JSON.stringify([to, title, text])), { to, text: title ? `${caption(title)}\n${text}` : text });
    return { ok: result.ok, duplicate: result.duplicate };
  }
  const fileName = filename(a.filename);
  if (name === "wechat_send_file") {
    if (!a.file || typeof a.file !== "object" || Array.isArray(a.file)) throw new HttpError(400, "file must be a host-converted file object, not a local path. For a local workspace file use wechat_prepare_file_upload, then PUT its exact bytes.");
    const f = object(a.file);
    str(f.file_id, "file.file_id", 300);
    return sendFile(env, binding, to, id, title, fileName, await downloadFile(str(f.download_url, "file.download_url", 16000)));
  }
  if (name === "wechat_prepare_file_upload") {
    const size = a.size_bytes;
    const digest = str(a.sha256, "sha256", 64).toLowerCase();
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(digest)) throw new HttpError(400, "Provide exact size_bytes (1-10 MiB) and a 64-character SHA-256 hash");
    const fingerprint = await sha256(JSON.stringify([to, title, fileName, digest]));
    const previous = await stub(env, binding).mcpDeliveryStatus(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError(400, "delivery_id was already used for different content");
      if (previous.state === "sent") return { ok: true, duplicate: true, already_sent: true, delivery_id: id, state: "sent" };
      if (previous.state !== "retry_ready") throw new WxBotError("upstream", "Delivery is pending or uncertain. Check WeChat and wechat_delivery_status; do not resend automatically.");
    }
    const expires = Date.now() + 5 * 60_000;
    const token = await seal(env.API_TOKEN, { binding, to, id, title, filename: fileName, size, sha256: digest, expires_at: expires });
    return { upload_url: `${origin}/mcp-upload/${token}`, method: "PUT", content_type: "application/octet-stream", expires_at: expires, delivery_id: id, instructions: "PUT the exact local file bytes to upload_url. Success sends the WeChat attachment. An already_sent response needs no upload. Do not share this URL in the user-facing response." };
  }
  throw new HttpError(400, "Unknown tool");
}

/** Returns undefined for all pre-existing API routes, which retain their bearer auth. */
export async function handleMcpRequest(req: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(req.url);
  const link = /^\/b\/([a-z0-9_-]{1,32})\/mcp-link$/.exec(url.pathname);
  const route = /^\/mcp\/([a-z0-9_-]{1,32})\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  const upload = /^\/mcp-upload\/([A-Za-z0-9_-]{1,5000})$/.exec(url.pathname);
  if (!link && !route && !upload) return undefined;
  if (!env.API_TOKEN) return json(500, { error: "API_TOKEN is not configured" });
  if (!originAllowed(req)) return json(403, { error: "Origin is not allowed" });
  try {
    if (link) {
      if (!safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${env.API_TOKEN}`)) return json(401, { error: "unauthorized" });
      if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
      const b = link[1]!;
      const token = b64(await mac(env.API_TOKEN, `wx-bot/mcp/access/v1:${b}`));
      return json(200, { server_url: `${url.origin}/mcp/${b}/${token}`, authentication: "No authentication", private_url: true, max_file_bytes: MAX_FILE_BYTES });
    }
    if (upload) {
      if (req.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "PUT", "Cache-Control": "no-store" } });
      const p = await openTicket(env.API_TOKEN, upload[1]!);
      const binding = str(p.binding, "binding", 32);
      if (!BINDING.test(binding)) throw new HttpError(401, "Invalid ticket binding");
      if (await owner(env, binding) !== p.to) throw new HttpError(403, "The WeChat owner changed; prepare a new upload");
      if (typeof p.size !== "number" || Number(req.headers.get("Content-Length") ?? p.size) !== p.size) throw new HttpError(400, "Upload size does not match the prepared file");
      const data = await bytes(req.body, Math.min(p.size, MAX_FILE_BYTES));
      if (data.length !== p.size || await sha256(data) !== p.sha256) throw new HttpError(400, "Upload bytes do not match the prepared size/hash");
      return json(200, await sendFile(env, binding, p.to as string, str(p.id, "delivery_id", 200), taskTitle(p.title), filename(p.filename), data));
    }
    const binding = route![1]!;
    const expected = b64(await mac(env.API_TOKEN, `wx-bot/mcp/access/v1:${binding}`));
    if (!safeEqual(route![2]!, expected)) return json(401, { error: "unauthorized" });
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    if (!(req.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return fail(null, -32600, "Use application/json", 415);
    let msg: Obj;
    try { msg = object(JSON.parse(new TextDecoder().decode(await bytes(req.body, 128 * 1024)))); }
    catch (err) { if (err instanceof HttpError && err.status === 413) throw err; return fail(null, -32700, "Invalid JSON-RPC request"); }
    const id = msg.id;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || id !== undefined && typeof id !== "string" && typeof id !== "number") return fail(null, -32600, "Invalid JSON-RPC request");
    const params = msg.params === undefined ? {} : object(msg.params);
    const version = req.headers.get("MCP-Protocol-Version");
    const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta as Obj : {};
    const modern = version === "2026-07-28" || meta["io.modelcontextprotocol/protocolVersion"] === "2026-07-28";
    if (version && !VERSIONS.includes(version)) return fail(id, -32022, "Unsupported protocol version", 400, { supported: VERSIONS, requested: version });
    if (modern) {
      if (version !== "2026-07-28" || meta["io.modelcontextprotocol/protocolVersion"] !== version || req.headers.get("Mcp-Method") !== msg.method || msg.method === "tools/call" && req.headers.get("Mcp-Name") !== params.name) return fail(id, -32020, "MCP request headers do not match the body");
      const info = meta["io.modelcontextprotocol/clientInfo"] as Obj | undefined;
      if (!info || Array.isArray(info) || typeof info.name !== "string" || typeof info.version !== "string" || !meta["io.modelcontextprotocol/clientCapabilities"] || typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object" || Array.isArray(meta["io.modelcontextprotocol/clientCapabilities"])) return fail(id, -32602, "Missing required MCP client metadata");
    }
    if (id === undefined) {
      if (modern || !["notifications/initialized", "notifications/cancelled"].includes(msg.method)) return fail(null, -32600, "Unsupported notification");
      return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (msg.method === "initialize" && !modern) return ok(id, { protocolVersion: typeof params.protocolVersion === "string" && VERSIONS.slice(1).includes(params.protocolVersion) ? params.protocolVersion : "2025-11-25", capabilities: { tools: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS + REVIEW_INSTRUCTIONS }, false);
    if (msg.method === "server/discover") return ok(id, { supportedVersions: VERSIONS, capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": SERVER }, instructions: INSTRUCTIONS + REVIEW_INSTRUCTIONS }, modern);
    if (msg.method === "ping") return ok(id, {}, modern);
    if (msg.method === "tools/list") return ok(id, { tools: TOOLS }, modern);
    if (msg.method === "tools/call") {
      const definition = TOOLS.find((t) => t.name === params.name);
      if (!definition) return fail(id, -32602, "Unknown tool");
      try {
        const args = object(params.arguments ?? {});
        if (Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))) throw new HttpError(400, "Unknown tool argument");
        const result = await tool(env, binding, params.name, args, url.origin);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }, modern);
      } catch (err) {
        const message = errorMessage(err);
        return ok(id, { isError: true, content: [{ type: "text", text: message }], structuredContent: { ok: false, error: { kind: err instanceof WxBotError ? err.kind : err instanceof HttpError ? "invalid_request" : "unexpected", message } } }, modern);
      }
    }
    return fail(id, -32601, "Method not found", 404);
  } catch (err) {
    return json(err instanceof HttpError ? err.status : err instanceof WxBotError ? ({ expired: 401, forbidden: 403, bad_request: 400, too_large: 413 } as Record<string, number>)[err.kind] ?? 502 : 502, { error: errorMessage(err) });
  }
}
