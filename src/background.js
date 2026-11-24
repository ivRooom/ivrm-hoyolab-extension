// Service worker for the automation features (extension #1 for
// HoYoLAB, #5 for Skport/Endfield):
// daily check-in claiming and gift-code redemption.
//
// This file is only the chrome.* wiring. All decisions live in
// lib/hoyolab-auto.mjs, lib/hoyolab-auto-runner.mjs,
// lib/game-settings.mjs, lib/skport.mjs and lib/skport-runner.mjs,
// which are unit-tested with plain node.
//
// The HoYoLAB requests are made with credentials: "include", so
// the browser attaches the HoYoLAB session it is already signed
// in with; the cookie values are never read for those features.
// For Skport, the ACCOUNT_TOKEN cookie value is read through the
// cookies permission and used only as the input of the Gryphline
// OAuth exchange (the cred / signToken derived from it are never
// stored). The only network destinations are the official
// HoYoLAB / HoYoverse / Gryphline / Skport APIs and the
// hoyo-codes API.

import {
  AUTO_STORAGE_KEYS,
  appendAutoLog,
  nextCheckinAlarmTime,
} from "./lib/hoyolab-auto.mjs";
import {
  AUTO_LINK_MESSAGE_TYPE,
  LINKED_AT_STORAGE_KEY,
  LINKED_DISPLAY_NAME_STORAGE_KEY,
  buildAutoLinkLogEntry,
  createAutoLinkHandler,
  isAutoLinkPageUrl,
  parseAutoLinkTokenMessage,
} from "./lib/auto-link.mjs";
import { createAutoRunner } from "./lib/hoyolab-auto-runner.mjs";
import { buildHoyolabCookieString } from "./lib/hoyolab-cookie.mjs";
import { GAME_SETTINGS_KEY } from "./lib/game-settings.mjs";
import {
  computeSkportSign,
  md5Hex,
  nextEndfieldAlarmTime,
} from "./lib/skport.mjs";
import { createSkportRunner } from "./lib/skport-runner.mjs";
import {
  AUTH_LOGIN_URLS,
  AUTH_STATE_KEY,
  CHECKIN_RETRY_INTERVAL_MINUTES,
  anyAuthExpired,
  markAuthNotified,
  normalizeAuthState,
  pendingAuthNotifications,
} from "./lib/session-resilience.mjs";
import {
  AUTH_REPORT_STORAGE_KEY,
  LINK_TOKEN_STORAGE_KEY,
  syncAuthReports,
} from "./lib/auth-report.mjs";

const CHECKIN_ALARM = "ivrm-auto-checkin";
const CODES_ALARM = "ivrm-auto-codes";
const ENDFIELD_ALARM = "ivrm-endfield-checkin";
const RETRY_ALARM = "ivrm-auto-retry";
const CODES_PERIOD_MINUTES = 180; // 3 hours, as designed
const SKPORT_STATE_KEY = "skportState";

// ---------------------------------------------------------------
// storage adapters

async function loadData() {
  const stored = await chrome.storage.local.get([
    AUTO_STORAGE_KEYS.settings,
    AUTO_STORAGE_KEYS.records,
    AUTO_STORAGE_KEYS.state,
    AUTO_STORAGE_KEYS.log,
    GAME_SETTINGS_KEY,
    AUTH_STATE_KEY,
  ]);
  return {
    settings: stored[AUTO_STORAGE_KEYS.settings],
    records: stored[AUTO_STORAGE_KEYS.records],
    state: stored[AUTO_STORAGE_KEYS.state],
    log: stored[AUTO_STORAGE_KEYS.log],
    gameSettings: stored[GAME_SETTINGS_KEY],
    authState: stored[AUTH_STATE_KEY],
  };
}

async function saveData(patch) {
  const mapped = {};
  if (patch.records !== undefined) {
    mapped[AUTO_STORAGE_KEYS.records] = patch.records;
  }
  if (patch.state !== undefined) {
    mapped[AUTO_STORAGE_KEYS.state] = patch.state;
  }
  if (patch.log !== undefined) {
    mapped[AUTO_STORAGE_KEYS.log] = patch.log;
  }
  if (patch.authState !== undefined) {
    mapped[AUTH_STATE_KEY] = patch.authState;
  }
  if (Object.keys(mapped).length > 0) {
    await chrome.storage.local.set(mapped);
  }
}

async function loadSkportData() {
  const stored = await chrome.storage.local.get([
    AUTO_STORAGE_KEYS.settings,
    AUTO_STORAGE_KEYS.log,
    GAME_SETTINGS_KEY,
    SKPORT_STATE_KEY,
    AUTH_STATE_KEY,
  ]);
  return {
    settings: stored[AUTO_STORAGE_KEYS.settings],
    gameSettings: stored[GAME_SETTINGS_KEY],
    state: stored[SKPORT_STATE_KEY],
    log: stored[AUTO_STORAGE_KEYS.log],
    authState: stored[AUTH_STATE_KEY],
  };
}

async function saveSkportData(patch) {
  const mapped = {};
  if (patch.state !== undefined) {
    mapped[SKPORT_STATE_KEY] = patch.state;
  }
  if (patch.log !== undefined) {
    mapped[AUTO_STORAGE_KEYS.log] = patch.log;
  }
  if (patch.authState !== undefined) {
    mapped[AUTH_STATE_KEY] = patch.authState;
  }
  if (Object.keys(mapped).length > 0) {
    await chrome.storage.local.set(mapped);
  }
}

// ---------------------------------------------------------------
// fetch adapter

async function fetchJson(url, options = {}) {
  const init = {
    method: options.method ?? "GET",
    credentials: "include",
    headers: { Accept: "application/json", ...(options.headers ?? {}) },
  };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------
// HoYoLAB session presence

// The pairing helper knows how to recognize a usable v2 session
// from the cookie jar. Presence checks use the built string as a
// boolean and never send or store it; the auto-link exchange
// (#14) is the one flow that sends it, exactly like the popup's
// manual code entry does.
async function readSessionCookieString() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "hoyolab.com" });
    return buildHoyolabCookieString(cookies);
  } catch {
    return null;
  }
}

async function hasSession() {
  return (await readSessionCookieString()) !== null;
}

const runner = createAutoRunner({
  fetchJson,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  hasSession,
  loadData,
  saveData,
});

// ---------------------------------------------------------------
// Skport (Endfield)

// The ACCOUNT_TOKEN cookie is httpOnly, so page scripts cannot
// read it, but the cookies permission can. Its value feeds only
// the Gryphline OAuth exchange in the runner. The cookie may be
// stored URL-encoded; the reference tools decode it before use.
async function getSkportAccountToken() {
  try {
    const cookies = await chrome.cookies.getAll({
      domain: "skport.com",
      name: "ACCOUNT_TOKEN",
    });
    const value = cookies.find((cookie) => cookie.value)?.value;
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  } catch {
    return null;
  }
}

// WebCrypto provides HMAC-SHA256 (the MD5 half of the signature
// lives in lib/skport.mjs, which WebCrypto cannot do).
async function hmacSha256Hex(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const skportRunner = createSkportRunner({
  fetchJson,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  getAccountToken: getSkportAccountToken,
  sign: (request) => computeSkportSign(request, { hmacSha256Hex, md5Hex }),
  loadData: loadSkportData,
  saveData: saveSkportData,
});

// ---------------------------------------------------------------
// Login-expired surface (#10)
//
// The runners keep the shared auth state (lib/session-resilience)
// current; this section renders it: a "!" badge while any login
// is expired, and one notification per expiry episode. Clicking
// the notification opens the provider's login page. The popup
// reads the same state and shows its banner.

const AUTH_NOTIFICATION_IDS = {
  hoyolab: "ivrm-auth-hoyolab",
  skport: "ivrm-auth-skport",
};
const AUTH_NOTIFICATION_CONTENT = {
  hoyolab: {
    title: "HoYoLAB のログインが切れています",
    message:
      "自動チェックインをお休みしています。クリックして HoYoLAB でログインし直してください。",
    icon: "src/icon-genshin.png",
  },
  skport: {
    title: "Skport のログインが切れています",
    message:
      "エンドフィールドの自動チェックインをお休みしています。クリックして Skport でログインし直してください。",
    icon: "src/icon-endfield.png",
  },
};

async function syncAuthSurface() {
  try {
    const stored = await chrome.storage.local.get([AUTH_STATE_KEY]);
    let authState = normalizeAuthState(stored[AUTH_STATE_KEY]);
    const expired = anyAuthExpired(authState);
    await chrome.action.setBadgeText({ text: expired ? "!" : "" });
    if (expired) {
      await chrome.action.setBadgeBackgroundColor({ color: "#e8a13a" });
    }
    for (const provider of Object.keys(AUTH_NOTIFICATION_IDS)) {
      const id = AUTH_NOTIFICATION_IDS[provider];
      if (authState[provider].status !== "expired") {
        // The episode ended (a run succeeded again): retire any
        // notification still on screen.
        await chrome.notifications.clear(id).catch(() => {});
      }
    }
    for (const provider of pendingAuthNotifications(authState)) {
      const content = AUTH_NOTIFICATION_CONTENT[provider];
      await chrome.notifications.create(AUTH_NOTIFICATION_IDS[provider], {
        type: "basic",
        iconUrl: chrome.runtime.getURL(content.icon),
        title: content.title,
        message: content.message,
      });
      authState = markAuthNotified(authState, provider);
    }
    await chrome.storage.local.set({ [AUTH_STATE_KEY]: authState });
  } catch {
    // The badge and notifications are best-effort surfaces; the
    // auth state itself is already persisted by the runners.
  }
  // Mirror any login-state transition to the portal (#1684 S2);
  // independent of the surface above and fail-soft on its own.
  await syncAuthReportsToPortal();
}

chrome.notifications.onClicked.addListener((notificationId) => {
  for (const [provider, id] of Object.entries(AUTH_NOTIFICATION_IDS)) {
    if (notificationId !== id) continue;
    void chrome.tabs.create({ url: AUTH_LOGIN_URLS[provider] });
    void chrome.notifications.clear(id);
  }
});

// ---------------------------------------------------------------
// Auth-state reporting to the portal (#1684 S2)
//
// Mirrors transitions of the same login state to the portal,
// which notifies opted-in members in a dedicated Discord
// channel. Only {provider, status} is sent, authorized by the
// link token the pairing saved; without a token this is a no-op.
// Fail-soft throughout (lib/auth-report): a failed report is
// retried by the next sync, never in a loop, and can never break
// a check-in cycle. syncAuthSurface runs after every cycle, so
// transitions are picked up there; the storage listener covers
// the pairing moment itself, when the token first appears.

async function syncAuthReportsToPortal() {
  try {
    const stored = await chrome.storage.local.get([
      AUTH_STATE_KEY,
      AUTH_REPORT_STORAGE_KEY,
      LINK_TOKEN_STORAGE_KEY,
    ]);
    const { reported } = await syncAuthReports({
      fetchFn: (url, init) => fetch(url, init),
      token: stored[LINK_TOKEN_STORAGE_KEY],
      authState: stored[AUTH_STATE_KEY],
      reportedState: stored[AUTH_REPORT_STORAGE_KEY],
    });
    if (
      JSON.stringify(reported) !==
      JSON.stringify(stored[AUTH_REPORT_STORAGE_KEY] ?? null) &&
      (reported.hoyolab !== null || reported.skport !== null)
    ) {
      await chrome.storage.local.set({ [AUTH_REPORT_STORAGE_KEY]: reported });
    }
  } catch {
    // Reporting is best-effort; the local auth state is the
    // source of truth and the next sync retries what is pending.
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const tokenChange = changes[LINK_TOKEN_STORAGE_KEY];
  if (tokenChange && !tokenChange.oldValue && tokenChange.newValue) {
    // Pairing just saved a token: report the current login
    // states once as the baseline.
    void syncAuthReportsToPortal();
  }
});

// ---------------------------------------------------------------
// scheduling

async function ensureAlarms() {
  const checkin = await chrome.alarms.get(CHECKIN_ALARM);
  if (!checkin) {
    chrome.alarms.create(CHECKIN_ALARM, {
      when: nextCheckinAlarmTime(new Date()),
      periodInMinutes: 24 * 60,
    });
  }
  const codes = await chrome.alarms.get(CODES_ALARM);
  if (!codes) {
    chrome.alarms.create(CODES_ALARM, {
      delayInMinutes: 5,
      periodInMinutes: CODES_PERIOD_MINUTES,
    });
  }
  const endfield = await chrome.alarms.get(ENDFIELD_ALARM);
  if (!endfield) {
    chrome.alarms.create(ENDFIELD_ALARM, {
      when: nextEndfieldAlarmTime(new Date()),
      periodInMinutes: 24 * 60,
    });
  }
  const retry = await chrome.alarms.get(RETRY_ALARM);
  if (!retry) {
    chrome.alarms.create(RETRY_ALARM, {
      delayInMinutes: CHECKIN_RETRY_INTERVAL_MINUTES,
      periodInMinutes: CHECKIN_RETRY_INTERVAL_MINUTES,
    });
  }
}

// One cycle at a time: an alarm firing during a manual run (or the
// startup catch-up overlapping an alarm) must not double-attempt.
let running = false;
async function runGuarded(cycle) {
  if (running) return null;
  running = true;
  try {
    return await cycle();
  } finally {
    running = false;
    // Every run can change the login state; keep the badge and
    // notifications in step with it.
    void syncAuthSurface();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarms();
  void syncAuthSurface();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarms();
  void syncAuthSurface();
  // Catch-up: if Chrome was closed or asleep at the alarm time,
  // claim today's check-in now. Each runner's due check (the
  // HoYoLAB day in UTC+8, the Skport day from the 04:00 UTC+8
  // reset) makes this a no-op when there is nothing to claim.
  void runGuarded(async () => {
    await runner.runCheckinCycle();
    await skportRunner.runEndfieldCheckinCycle();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECKIN_ALARM) {
    void runGuarded(() => runner.runCheckinCycle());
  } else if (alarm.name === CODES_ALARM) {
    void runGuarded(() => runner.runCodeCycle());
  } else if (alarm.name === ENDFIELD_ALARM) {
    void runGuarded(() => skportRunner.runEndfieldCheckinCycle());
  } else if (alarm.name === RETRY_ALARM) {
    // Daytime retry (#10): re-run the check-in cycles; each
    // runner spends from its own daily retry budget and stops
    // once today's check-in has landed.
    void runGuarded(async () => {
      await runner.runCheckinCycle({ retry: true });
      await skportRunner.runEndfieldCheckinCycle({ retry: true });
    });
  }
});

// ---------------------------------------------------------------
// Auto-link token hand-off (#14)
//
// The content script on the portal's link page forwards the
// pairing token the page minted after the member's consent click.
// The exchange that follows is the manual code entry's exchange —
// same endpoint, same cookie read at press time, same stored
// record — only the token's transport differs. The result lands
// in the execution log either way, so a failure is visible in the
// popup exactly like a failed manual attempt, and the code entry
// stays available as the fallback.

const autoLinkHandler = createAutoLinkHandler({
  fetchJson,
  getCookieString: readSessionCookieString,
  now: () => Date.now(),
});

async function handleAutoLinkToken(pairingToken) {
  const result = await autoLinkHandler(pairingToken);
  try {
    const stored = await chrome.storage.local.get([AUTO_STORAGE_KEYS.log]);
    await chrome.storage.local.set({
      [AUTO_STORAGE_KEYS.log]: appendAutoLog(
        stored[AUTO_STORAGE_KEYS.log],
        buildAutoLinkLogEntry(result, Date.now())
      ),
    });
    if (result.ok) {
      // Mirror the popup's manual flow: stamp the link, keep the
      // read-only link token the exchange issued (or drop the old
      // one when it issued none), and remember the linked member's
      // display name when the portal returned one.
      const patch = { [LINKED_AT_STORAGE_KEY]: result.linkedAt };
      if (result.linkToken) {
        patch[LINK_TOKEN_STORAGE_KEY] = result.linkToken;
      }
      if (result.displayName) {
        patch[LINKED_DISPLAY_NAME_STORAGE_KEY] = result.displayName;
      }
      await chrome.storage.local.set(patch);
      if (!result.linkToken) {
        await chrome.storage.local.remove(LINK_TOKEN_STORAGE_KEY);
      }
      if (!result.displayName) {
        await chrome.storage.local.remove(LINKED_DISPLAY_NAME_STORAGE_KEY);
      }
    }
  } catch {
    // Persistence is best-effort: the exchange itself already
    // happened server-side, and re-linking repairs the record.
  }
  return result;
}

// ---------------------------------------------------------------
// popup messages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === AUTO_LINK_MESSAGE_TYPE) {
    // Only the link page's tab may hand over a token, and the
    // token is shape-checked again here (lib/auto-link).
    const parsed = parseAutoLinkTokenMessage(message);
    if (!parsed || !isAutoLinkPageUrl(sender?.tab?.url)) {
      sendResponse({ ok: false });
      return false;
    }
    handleAutoLinkToken(parsed.pairingToken)
      .then((result) =>
        sendResponse({ ok: result.ok, message: result.message })
      )
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "auto:getData") {
    loadData()
      .then((data) => sendResponse({ ok: true, data }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "auto:runNow") {
    runGuarded(async () => {
      const checkin = await runner.runCheckinCycle({ force: true });
      const codes = await runner.runCodeCycle({ force: true });
      const endfield = await skportRunner.runEndfieldCheckinCycle({
        force: true,
      });
      return { checkin, codes, endfield };
    })
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "skport:refreshSanity") {
    skportRunner
      .refreshSanity()
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, reason: "failed" }));
    return true;
  }
  return false;
});
