// Pure helpers for the in-extension automation features: daily
// check-in claiming and gift-code redemption (ivrm-hoyolab-extension
// #1). Kept free of chrome.* APIs and of fetch so they can be
// unit-tested with plain node --test, like hoyolab-cookie.mjs.
//
// Design notes (see DESIGN.md in the feature workspace):
// - Everything runs inside the user's own browser, against the
//   official HoYoLAB APIs, using the session the browser is already
//   signed in with. No credential value is read, stored, or sent to
//   the ivRooom portal for these features; the pairing handoff in
//   hoyolab-cookie.mjs is a separate, read-only flow and is not
//   touched here.
// - Codes come from the community hoyo-codes API (seriaati), whose
//   GET /codes answer is {"codes": [{code, status, game, rewards}],
//   "game": ...} with only status "OK" entries served.
// - Response classification follows the retcode tables used by the
//   open-source clients this design was verified against
//   (genshin.py for -100 / -5003 / rate limits, daydreamer-json's
//   hoyo-auto-checkin for the webExchangeCdkeyHyl retcodes).
//   Anything not in the tables is "failed" and is retried at most
//   once, on the next cycle.

// ----------------------------------------------------------------
// Game table

export const AUTO_GAME_IDS = ["genshin", "starrail", "zzz"];

export const AUTO_GAMES = {
  genshin: {
    id: "genshin",
    label: "原神",
    // hoyo-codes API game parameter and the game_biz suffix base.
    codesGame: "genshin",
    gameBiz: "hk4e_global",
    exchangeUrl:
      "https://public-operation-hk4e.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
    signUrl: "https://sg-hk4e-api.hoyolab.com/event/sol/sign",
    actId: "e202102251931481",
  },
  starrail: {
    id: "starrail",
    label: "崩壊：スターレイル",
    codesGame: "hkrpg",
    gameBiz: "hkrpg_global",
    exchangeUrl:
      "https://public-operation-hkrpg.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
    signUrl: "https://sg-public-api.hoyolab.com/event/luna/os/sign",
    actId: "e202303301540311",
  },
  zzz: {
    id: "zzz",
    label: "ゼンレスゾーンゼロ",
    codesGame: "nap",
    gameBiz: "nap_global",
    exchangeUrl:
      "https://public-operation-nap.hoyolab.com/common/apicdkey/api/webExchangeCdkeyHyl",
    signUrl: "https://sg-public-api.hoyolab.com/event/luna/zzz/os/sign",
    actId: "e202406031448091",
    // The ZZZ luna sign endpoint rejects requests without this
    // header (the other games' sign endpoints do not need it).
    signHeaders: { "x-rpc-signgame": "zzz" },
  },
};

export const HOYO_CODES_API_URL = "https://hoyo-codes.seria.moe/codes";
export const ACCOUNT_REGIONS_URL =
  "https://api-account-os.hoyolab.com/binding/api/getAllRegions";
export const ACCOUNT_ROLES_URL =
  "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken";
export const HOYOLAB_HOME_URL = "https://www.hoyolab.com/";

// Minimum gap between two redemption attempts for the same game.
// The reference tool used ~5.2s; the design fixes 5.5s for margin.
export const REDEEM_GAP_MS = 5500;

// A code whose attempt ended in an unknown failure may be retried
// once on a later cycle; after that it is left alone.
export const MAX_REDEEM_ATTEMPTS = 2;

export const AUTO_LOG_LIMIT = 100;

// ----------------------------------------------------------------
// Settings (chrome.storage.local shape, normalized defensively)

export const AUTO_STORAGE_KEYS = {
  settings: "autoSettings",
  records: "autoRedeemRecords",
  state: "autoState",
  log: "autoLog",
};

export function defaultAutoSettings() {
  return {
    enabled: false,
    games: { genshin: true, starrail: true, zzz: true },
  };
}

export function normalizeAutoSettings(raw, gameSettings) {
  const settings = defaultAutoSettings();
  if (raw && typeof raw === "object") {
    if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
    if (raw.games && typeof raw.games === "object") {
      for (const id of AUTO_GAME_IDS) {
        if (typeof raw.games[id] === "boolean") {
          settings.games[id] = raw.games[id];
        }
      }
    }
  }
  // Per-game settings (#6) win over the legacy per-game switches
  // when present: a game only automates when it is both visible
  // and automation-enabled there. The popup keeps the legacy
  // switches synced to the same effective values, so the two
  // sources agree; this override is the belt-and-braces path for
  // storage written before that sync existed.
  if (gameSettings && typeof gameSettings === "object") {
    for (const id of AUTO_GAME_IDS) {
      const display = gameSettings.display?.[id];
      const automation = gameSettings.automation?.[id];
      if (typeof display === "boolean" || typeof automation === "boolean") {
        settings.games[id] =
          (display ?? true) && (automation ?? settings.games[id]);
      }
    }
  }
  return settings;
}

export function enabledGameIds(settings) {
  if (!settings.enabled) return [];
  return AUTO_GAME_IDS.filter((id) => settings.games[id]);
}

// ----------------------------------------------------------------
// hoyo-codes parsing

// Parses one GET /codes answer into a clean list of
// {code, rewards}. Malformed entries are dropped, codes are
// uppercased and deduplicated, and a non-OK status (the API only
// serves OK codes today, but the field exists) is filtered out.
// Returns null when the payload is not the expected shape at all,
// so the caller can treat the whole fetch as failed.
export function parseHoyoCodesResponse(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.codes)) {
    return null;
  }
  const seen = new Set();
  const parsed = [];
  for (const entry of body.codes) {
    if (!entry || typeof entry.code !== "string") continue;
    if (entry.status !== undefined && entry.status !== "OK") continue;
    const code = entry.code.trim().toUpperCase();
    if (code === "" || seen.has(code)) continue;
    seen.add(code);
    parsed.push({
      code,
      rewards: typeof entry.rewards === "string" ? entry.rewards : "",
    });
  }
  return parsed;
}

// ----------------------------------------------------------------
// ZZZ same-family codes
//
// Rule taken from hoyo-codes' own detector: only for Zenless Zone
// Zero, codes starting with "ZZZ" followed by two digits share a
// family keyed by the first five characters ("ZZZ25", "ZZZ24", ...),
// and only one code per family can be redeemed per account.

export function familyKeyFor(gameId, code) {
  if (gameId !== "zzz" || typeof code !== "string") return null;
  if (code.length < 5 || !code.startsWith("ZZZ")) return null;
  const key = code.slice(0, 5);
  return /^\d{2}$/.test(key.slice(3)) ? key : null;
}

// ----------------------------------------------------------------
// Redemption records and idempotency
//
// records shape: { [gameId]: { [code]: {outcome, at, attempts} } }.
// Terminal outcomes are never attempted again. "failed" is the only
// non-terminal outcome and is retried while attempts remain.

export const TERMINAL_REDEEM_OUTCOMES = new Set([
  "success",
  "already_used",
  "used_by_others",
  "expired",
  "invalid",
  "usage_limit",
  "level_insufficient",
  "family_blocked",
]);

export function isRedeemableRecord(record) {
  if (!record) return true;
  if (TERMINAL_REDEEM_OUTCOMES.has(record.outcome)) return false;
  if (record.outcome === "failed") {
    return (record.attempts ?? 1) < MAX_REDEEM_ATTEMPTS;
  }
  return false;
}

// A family counts as consumed when any of its codes was claimed by
// this account (success, or the API said this account already used
// it — for family codes that answer means the family's one slot is
// gone). The runner consults this again before every attempt, so a
// claim made earlier in the same cycle blocks its siblings at once.
export function isFamilyConsumed(records, gameId, code) {
  const familyKey = familyKeyFor(gameId, code);
  if (!familyKey) return false;
  const recordsForGame = records?.[gameId] ?? {};
  for (const [other, record] of Object.entries(recordsForGame)) {
    if (other === code) continue;
    if (familyKeyFor(gameId, other) !== familyKey) continue;
    if (record.outcome === "success" || record.outcome === "already_used") {
      return true;
    }
  }
  return false;
}

// Splits the fetched codes into the ones to attempt now and the
// ones that only need a family_blocked record written.
export function planRedeemAttempts(gameId, codes, records) {
  const recordsForGame = records?.[gameId] ?? {};
  const toAttempt = [];
  const familyBlocked = [];
  for (const entry of codes) {
    const record = recordsForGame[entry.code];
    if (!isRedeemableRecord(record)) continue;
    if (isFamilyConsumed(records, gameId, entry.code)) {
      familyBlocked.push(entry);
      continue;
    }
    toAttempt.push(entry);
  }
  return { toAttempt, familyBlocked };
}

// Returns a new records object with one attempt result folded in.
// On a claim (success / already_used) for a family code, every
// sibling in `knownCodes` that has no terminal record yet is marked
// family_blocked, so later cycles never spend attempts on them.
export function applyRedeemResult(records, gameId, code, outcome, at, knownCodes = []) {
  const next = { ...(records ?? {}) };
  const forGame = { ...(next[gameId] ?? {}) };
  const previous = forGame[code];
  forGame[code] = {
    outcome,
    at,
    attempts: (previous?.attempts ?? 0) + (outcome === "family_blocked" ? 0 : 1),
  };
  if (outcome === "success" || outcome === "already_used") {
    const familyKey = familyKeyFor(gameId, code);
    if (familyKey) {
      for (const sibling of knownCodes) {
        if (sibling === code) continue;
        if (familyKeyFor(gameId, sibling) !== familyKey) continue;
        if (!isRedeemableRecord(forGame[sibling])) continue;
        if (forGame[sibling]?.outcome === "failed") continue;
        forGame[sibling] = { outcome: "family_blocked", at, attempts: 0 };
      }
    }
  }
  next[gameId] = forGame;
  return next;
}

export function countSuccessfulRedeems(records, monthKey = null) {
  let count = 0;
  for (const forGame of Object.values(records ?? {})) {
    for (const record of Object.values(forGame ?? {})) {
      if (record.outcome !== "success") continue;
      if (monthKey !== null) {
        if (typeof record.at !== "number") continue;
        if (jstMonthKey(new Date(record.at)) !== monthKey) continue;
      }
      count += 1;
    }
  }
  return count;
}

// ----------------------------------------------------------------
// Response classification
//
// Both HoYoLAB APIs answer JSON with a numeric retcode and a
// message. Risk control (the puzzle verification) has no single
// documented retcode; it is recognized by the verification payload
// (gt / challenge fields) or by the message, which is the same
// signal the reference tools key on.

function hasRiskControlSignal(body) {
  const data = body?.data;
  if (data && typeof data === "object") {
    if (typeof data.gt === "string" && data.gt !== "") return true;
    if (typeof data.challenge === "string" && data.challenge !== "") {
      return true;
    }
    if (data.is_risk === true) return true;
  }
  const message = typeof body?.message === "string" ? body.message : "";
  return /risk|captcha|geetest|verification/i.test(message);
}

function baseClassification(status, body) {
  if (status === 429) return "rate_limited";
  if (!body || typeof body !== "object" || typeof body.retcode !== "number") {
    return "failed";
  }
  if (body.retcode === -100) return "not_logged_in";
  if (body.retcode === 10101 || body.retcode === -110) {
    return "rate_limited";
  }
  if (hasRiskControlSignal(body)) return "risk_control";
  return null;
}

// webExchangeCdkeyHyl retcodes (verified against daydreamer-json's
// hoyo-auto-checkin, which drives the same endpoint):
//   0 success / -2001 expired / -2003 invalid / -2006 usage limit /
//   -2011 level insufficient / -2017 already used by this account /
//   -2018 already used by others (one-time code)
const EXCHANGE_RETCODE_OUTCOMES = new Map([
  [0, "success"],
  [-2001, "expired"],
  [-2003, "invalid"],
  [-2006, "usage_limit"],
  [-2011, "level_insufficient"],
  [-2017, "already_used"],
  [-2018, "used_by_others"],
]);

export function classifyExchangeResponse(status, body) {
  const base = baseClassification(status, body);
  if (base !== null) return base;
  return EXCHANGE_RETCODE_OUTCOMES.get(body.retcode) ?? "failed";
}

// Daily sign retcodes: 0 success, -5003 already claimed today
// (genshin.py's AlreadyClaimed). The luna/sol sign endpoints share
// the same convention.
export function classifySignResponse(status, body) {
  const base = baseClassification(status, body);
  if (base !== null) return base;
  if (body.retcode === 0) return "success";
  if (body.retcode === -5003) return "already_done";
  return "failed";
}

// ----------------------------------------------------------------
// Schedule (check-in day boundary)
//
// HoYoLAB's check-in day rolls over at 00:00 UTC+8, so the daily
// alarm is set for 01:05 JST (= 00:05 UTC+8) and "today" for
// check-in purposes is the calendar date in UTC+8, not in JST.
// Running the catch-up before the rollover therefore correctly
// finds nothing to do.

export const CHECKIN_ALARM_TIME_JST = { hour: 1, minute: 5 };

const dateKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const jstMonthFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
});

export function hoyolabDateKey(date) {
  return dateKeyFormat.format(date);
}

export function jstMonthKey(date) {
  return jstMonthFormat.format(date);
}

// Timestamp (ms) of the next 01:05 JST strictly after `date`.
// 01:05 JST is 16:05 UTC of the previous UTC day, so every UTC day
// has exactly one 01:05 JST at 16:05 UTC; computing in UTC avoids
// depending on the host timezone (JST has no DST).
export function nextCheckinAlarmTime(date) {
  let candidate =
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      CHECKIN_ALARM_TIME_JST.hour + 15,
      CHECKIN_ALARM_TIME_JST.minute
    );
  while (candidate <= date.getTime()) {
    candidate += 24 * 60 * 60 * 1000;
  }
  return candidate;
}

export function isCheckinDue(state, gameId, date) {
  const done = state?.checkin?.[gameId];
  return done?.day !== hoyolabDateKey(date);
}

// ----------------------------------------------------------------
// Run log

export function appendAutoLog(log, entry) {
  const next = Array.isArray(log) ? [...log] : [];
  next.push(entry);
  return next.slice(-AUTO_LOG_LIMIT);
}

const OUTCOME_LABELS = {
  success: "成功",
  already_done: "受取済み",
  already_used: "使用済み",
  used_by_others: "他人が使用済み",
  expired: "期限切れ",
  invalid: "無効なコード",
  usage_limit: "使用上限に到達",
  level_insufficient: "ランク不足",
  family_blocked: "同種コード交換済みのため対象外",
  failed: "失敗",
  not_logged_in: "未ログイン",
  risk_control: "認証が必要",
  rate_limited: "混雑のため延期",
  no_role: "ゲームアカウント未連携",
  fetch_failed: "コード取得に失敗",
  skipped: "スキップ",
};

export function describeAutoOutcome(outcome) {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

// A one-line diagnostic for a failed API answer, safe to show in
// the run log and to store in chrome.storage: only the numeric
// retcode and the server's message are used, the message is
// stripped of control characters and truncated, and nothing else
// from the response body is ever included.
export function describeFailureDetail(body) {
  if (!body || typeof body !== "object") return "";
  const hasRetcode = typeof body.retcode === "number";
  const message =
    typeof body.message === "string"
      ? body.message.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60)
      : "";
  if (!hasRetcode && message === "") return "";
  if (hasRetcode && message !== "") return `retcode ${body.retcode}: ${message}`;
  if (hasRetcode) return `retcode ${body.retcode}`;
  return message;
}

// ----------------------------------------------------------------
// Beginner-friendly next-action hints for the outcomes a first-time
// user is most likely to hit. Outcomes not listed here need no
// explanation beyond their label.

const OUTCOME_HINTS = {
  failed:
    "時間をおいて「今すぐ実行」を押すか、HoYoLAB 公式ページで一度手動でチェックインすると直ることがあります",
  not_logged_in: "HoYoLAB にログインしてから開き直してください",
  risk_control:
    "HoYoLAB 公式ページで認証（パズル）を完了してから「今すぐ実行」を押してください",
  rate_limited: "混雑しています。しばらく待つと自動で再試行します",
  no_role:
    "そのゲームのキャラクターが HoYoLAB アカウントに見つかりませんでした。遊んでいないゲームはオフにしてください",
  fetch_failed: "コード一覧を取得できませんでした。次の確認で自動的に再試行します",
};

export function describeAutoOutcomeHint(outcome) {
  return OUTCOME_HINTS[outcome] ?? "";
}
