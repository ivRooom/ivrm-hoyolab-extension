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
  nextCheckinAlarmTime,
} from "./lib/hoyolab-auto.mjs";
import { createAutoRunner } from "./lib/hoyolab-auto-runner.mjs";
import { buildHoyolabCookieString } from "./lib/hoyolab-cookie.mjs";
import { GAME_SETTINGS_KEY } from "./lib/game-settings.mjs";
import {
  computeSkportSign,
  md5Hex,
  nextEndfieldAlarmTime,
} from "./lib/skport.mjs";
import { createSkportRunner } from "./lib/skport-runner.mjs";

const CHECKIN_ALARM = "ivrm-auto-checkin";
const CODES_ALARM = "ivrm-auto-codes";
const ENDFIELD_ALARM = "ivrm-endfield-checkin";
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
  ]);
  return {
    settings: stored[AUTO_STORAGE_KEYS.settings],
    records: stored[AUTO_STORAGE_KEYS.records],
    state: stored[AUTO_STORAGE_KEYS.state],
    log: stored[AUTO_STORAGE_KEYS.log],
    gameSettings: stored[GAME_SETTINGS_KEY],
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
  ]);
  return {
    settings: stored[AUTO_STORAGE_KEYS.settings],
    gameSettings: stored[GAME_SETTINGS_KEY],
    state: stored[SKPORT_STATE_KEY],
    log: stored[AUTO_STORAGE_KEYS.log],
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

// Presence check only: the pairing helper already knows how to
// recognize a usable v2 session from the cookie jar. The string it
// builds is used as a boolean here and is never sent or stored.
async function hasSession() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "hoyolab.com" });
    return buildHoyolabCookieString(cookies) !== null;
  } catch {
    return false;
  }
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
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarms();
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
  }
});

// ---------------------------------------------------------------
// popup messages

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
