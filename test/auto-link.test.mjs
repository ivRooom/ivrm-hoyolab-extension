import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AUTO_LINK_BRIDGE_EVENT_TYPE,
  AUTO_LINK_MESSAGE_TYPE,
  AUTO_LINK_PAGE_URL,
  buildAutoLinkLogEntry,
  createAutoLinkHandler,
  extractDisplayName,
  isAutoLinkPageUrl,
  parseAutoLinkBridgeDetail,
  parseAutoLinkTokenMessage,
} from "../src/lib/auto-link.mjs";

// #14: auto-link. The properties that matter: only a detail in
// the exact bridge shape the portal mints (version 1, two-segment
// token, string-or-null expiry) is accepted; the background runs
// the same exchange as the manual code entry and reports the same
// user-facing messages; the linked member's display name is kept
// when the portal returns one and treated as absent otherwise.

const TOKEN = "abcDEF123_-.xyzABC789_-";
const detail = {
  version: 1,
  pairingToken: TOKEN,
  expiresAt: "2026-11-24T03:10:00.000Z",
};

test("bridge detail: the portal's shape parses", () => {
  assert.deepEqual(parseAutoLinkBridgeDetail(detail), {
    pairingToken: TOKEN,
    expiresAt: "2026-11-24T03:10:00.000Z",
  });
  assert.deepEqual(parseAutoLinkBridgeDetail({ ...detail, expiresAt: null }), {
    pairingToken: TOKEN,
    expiresAt: null,
  });
});

test("bridge detail: anything off-shape is dropped", () => {
  assert.equal(parseAutoLinkBridgeDetail(null), null);
  assert.equal(parseAutoLinkBridgeDetail("token"), null);
  assert.equal(parseAutoLinkBridgeDetail([detail]), null);
  assert.equal(parseAutoLinkBridgeDetail({ ...detail, version: 2 }), null);
  assert.equal(parseAutoLinkBridgeDetail({ ...detail, version: "1" }), null);
  assert.equal(
    parseAutoLinkBridgeDetail({ ...detail, pairingToken: "no-dot" }),
    null
  );
  assert.equal(
    parseAutoLinkBridgeDetail({ ...detail, pairingToken: "a.b.c" }),
    null
  );
  assert.equal(
    parseAutoLinkBridgeDetail({ ...detail, pairingToken: 42 }),
    null
  );
  assert.equal(
    parseAutoLinkBridgeDetail({ ...detail, expiresAt: 123 }),
    null
  );
  assert.equal(
    parseAutoLinkBridgeDetail({ version: 1, pairingToken: TOKEN }),
    null
  );
});

test("token message: only the hand-off type with a shaped token", () => {
  assert.deepEqual(
    parseAutoLinkTokenMessage({
      type: AUTO_LINK_MESSAGE_TYPE,
      pairingToken: TOKEN,
      expiresAt: null,
    }),
    { pairingToken: TOKEN }
  );
  assert.equal(
    parseAutoLinkTokenMessage({ type: "auto:runNow", pairingToken: TOKEN }),
    null
  );
  assert.equal(
    parseAutoLinkTokenMessage({
      type: AUTO_LINK_MESSAGE_TYPE,
      pairingToken: "bad",
    }),
    null
  );
  assert.equal(parseAutoLinkTokenMessage(null), null);
});

test("sender check: only the link page URL passes", () => {
  assert.equal(isAutoLinkPageUrl(AUTO_LINK_PAGE_URL), true);
  assert.equal(isAutoLinkPageUrl(`${AUTO_LINK_PAGE_URL}?from=popup`), true);
  assert.equal(isAutoLinkPageUrl("https://member.ivrm.jp/profile"), false);
  assert.equal(
    isAutoLinkPageUrl("https://member.ivrm.jp.evil.example/profile/hoyolab-link"),
    false
  );
  assert.equal(isAutoLinkPageUrl(undefined), false);
  assert.equal(isAutoLinkPageUrl(42), false);
});

test("display name: present only on a successful exchange", () => {
  assert.equal(
    extractDisplayName(200, { registered: true, displayName: "いゔる。" }),
    "いゔる。"
  );
  assert.equal(extractDisplayName(200, { registered: true }), null);
  assert.equal(
    extractDisplayName(200, { registered: true, displayName: "  " }),
    null
  );
  assert.equal(
    extractDisplayName(200, { registered: false, displayName: "x" }),
    null
  );
  assert.equal(
    extractDisplayName(401, { registered: true, displayName: "x" }),
    null
  );
  assert.equal(extractDisplayName(200, null), null);
});

function makeHandler({ cookie = "ltuid_v2=1; ltoken_v2=2", exchange } = {}) {
  const calls = [];
  const handler = createAutoLinkHandler({
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      if (exchange) return exchange(url, options);
      return {
        status: 200,
        body: { registered: true, linkToken: "link-token", displayName: "名前" },
      };
    },
    getCookieString: async () => cookie,
    now: () => 1_764_000_000_000,
  });
  return { handler, calls };
}

test("handler: success exchanges the token and returns the link record", async () => {
  const { handler, calls } = makeHandler();
  const result = await handler(TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.ivrm.jp/hoyolab-pairing/exchange"
  );
  assert.deepEqual(calls[0].options, {
    method: "POST",
    body: { pairingToken: TOKEN, cookie: "ltuid_v2=1; ltoken_v2=2" },
  });
  assert.deepEqual(result, {
    ok: true,
    message: "連携しました。ポータルで樹脂や開拓力が表示されます。",
    linkToken: "link-token",
    displayName: "名前",
    linkedAt: 1_764_000_000_000,
  });
});

test("handler: success without optional fields keeps them null", async () => {
  const { handler } = makeHandler({
    exchange: async () => ({ status: 200, body: { registered: true } }),
  });
  const result = await handler(TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.linkToken, null);
  assert.equal(result.displayName, null);
});

test("handler: no HoYoLAB session fails before any request", async () => {
  const { handler, calls } = makeHandler({ cookie: null });
  const result = await handler(TOKEN);
  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_session");
});

test("handler: a malformed token fails before any request", async () => {
  const { handler, calls } = makeHandler();
  const result = await handler("not-a-token");
  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_token");
});

test("handler: exchange failures carry the shared user-facing message", async () => {
  const { handler } = makeHandler({
    exchange: async () => ({ status: 401, body: {} }),
  });
  const result = await handler(TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exchange_failed");
  assert.equal(result.status, 401);
  assert.match(result.message, /ペアリングコードが無効か、期限切れです/);
});

test("handler: a network error is classified, not thrown", async () => {
  const { handler } = makeHandler({
    exchange: async () => {
      throw new Error("offline");
    },
  });
  const result = await handler(TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
});

test("log entry: success and failure in the popup log's shape", () => {
  assert.deepEqual(buildAutoLinkLogEntry({ ok: true }, 123), {
    at: 123,
    kind: "system",
    outcome: "success",
    detail: "自動連携でポータルと連携しました",
  });
  assert.deepEqual(buildAutoLinkLogEntry({ ok: false }, 456), {
    at: 456,
    kind: "system",
    outcome: "failed",
    detail: "自動連携に失敗しました",
  });
});

// The content script cannot import this module, so its inline
// validation is pinned to the same contract by source: same event
// name, same message type, same version, same token pattern, and
// the manifest registers it for the link page only.
test("content script and manifest stay pinned to the bridge contract", async () => {
  const script = await readFile(
    new URL("../src/auto-link-content.js", import.meta.url),
    "utf8"
  );
  assert.ok(script.includes(`"${AUTO_LINK_BRIDGE_EVENT_TYPE}"`));
  assert.ok(script.includes(`"${AUTO_LINK_MESSAGE_TYPE}"`));
  assert.ok(script.includes("version !== BRIDGE_VERSION"));
  assert.ok(script.includes("/^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/"));

  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.content_scripts, [
    {
      js: ["src/auto-link-content.js"],
      matches: ["https://member.ivrm.jp/profile/hoyolab-link*"],
      run_at: "document_idle",
    },
  ]);
});
