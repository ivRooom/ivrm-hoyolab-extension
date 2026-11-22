// Service worker for the automation features (extension #1):
// daily check-in claiming and gift-code redemption.
//
// This file is only the chrome.* wiring. All decisions live in
// lib/hoyolab-auto.mjs and lib/hoyolab-auto-runner.mjs, which are
// unit-tested with plain node.
//
// The requests to the official APIs are made with
// credentials: "include", so the browser attaches the HoYoLAB
// session it is already signed in with. The extension never reads
// the cookie values for these features, never stores them, and
// never sends them anywhere; the only network destinations are the
// official HoYoLAB / HoYoverse APIs and the hoyo-codes API.

import {
  AUTO_STORAGE_KEYS,
  nextCheckinAlarmTime,
} from "./lib/hoyolab-auto.mjs";
import { createAutoRunner } from "./lib/hoyolab-auto-runner.mjs";
import { buildHoyolabCookieString } from "./lib/hoyolab-cookie.mjs";

const CHECKIN_ALARM = "ivrm-auto-checkin";
const CODES_ALARM = "ivrm-auto-codes";
const CODES_PERIOD_MINUTES = 180; // 3 hours, as designed

// ---------------------------------------------------------------
// storage adapter

async function loadData() {
  const stored = await chrome.storage.local.get([
    AUTO_STORAGE_KEYS.settings,
    AUTO_STORAGE_KEYS.records,
    AUTO_STORAGE_KEYS.state,
    AUTO_STORAGE_KEYS.log,
  ]);
  return {
    settings: stored[AUTO_STORAGE_KEYS.settings],
    records: stored[AUTO_STORAGE_KEYS.records],
    state: stored[AUTO_STORAGE_KEYS.state],
    log: stored[AUTO_STORAGE_KEYS.log],
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

// ---------------------------------------------------------------
// fetch adapter

async function fetchJson(url, options = {}) {
  const init = {
    method: options.method ?? "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
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
  // Catch-up: if Chrome was closed or asleep at 01:05 JST, claim
  // today's check-in now. The runner's due check (the HoYoLAB day
  // in UTC+8) makes this a no-op when there is nothing to claim.
  void runGuarded(() => runner.runCheckinCycle());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECKIN_ALARM) {
    void runGuarded(() => runner.runCheckinCycle());
  } else if (alarm.name === CODES_ALARM) {
    void runGuarded(() => runner.runCodeCycle());
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
      return { checkin, codes };
    })
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
