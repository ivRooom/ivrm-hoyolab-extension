// Pure helpers for the Skport (Arknights: Endfield) integration
// (ivrm-hoyolab-extension #5). Kept free of chrome.* APIs and of
// fetch so they can be unit-tested with plain node --test, like
// hoyolab-auto.mjs. The orchestration lives in skport-runner.mjs;
// the chrome.* wiring lives in background.js.
//
// How this was verified (open-source implementations driving the
// same official endpoints):
// - sglkc/endfield-auto-daily (index.js, documented on DeepWiki
//   pages 3.1-3.3): the three-step Gryphline OAuth flow, the
//   binding endpoint, the attendance GET/POST pair, and
//   computeSignV2.
// - cptmacp's Apps Script gist: the same signing pipeline
//   (generateSign) and the /web/v1/auth/refresh sign-token flow.
// - xydesu/endfield-assistant (utils/attendance.js): refresh before
//   signing, HTTP 403 carrying code 10001 for "already signed".
// - torikushiii/endfield-auto: the player card carries a
//   stamina { current, max, recoveryTime } shape, read from the
//   /game/endfield/card/detail endpoint family.
//
// Signing (both sglkc and the gist agree):
//   headerJson = {"platform":"3","timestamp":<ts>,"dId":"","vName":"1.0.0"}
//   message    = path + body + timestamp + headerJson
//   sign       = MD5( hex( HMAC-SHA256( message, signToken ) ) )
// WebCrypto has no MD5, so md5Hex below is a self-contained
// implementation; HMAC-SHA256 is injected (WebCrypto in the
// browser, node:crypto in tests).
//
// Day boundary: Endfield's daily reset is 04:00 server time and
// the Asia server is anchored to UTC+8, so the Skport day used for
// idempotency records is the Asia/Shanghai calendar date of
// (now - 4h), and the daily alarm fires at 05:05 JST — just after
// the 04:00 UTC+8 reset. The attendance endpoint itself reports
// hasToday, so a record keyed to the wrong side of the boundary
// can never cause a double claim, only an extra status check.

// ----------------------------------------------------------------
// Endpoints and constants

export const SKPORT_APP_CODE = "6eb76d4e13aa36e6";
export const SKPORT_PLATFORM = "3";
export const SKPORT_VNAME = "1.0.0";
export const SKPORT_GAME_ID = "3";

export const SKPORT_BASIC_INFO_URL =
  "https://as.gryphline.com/user/info/v1/basic";
export const SKPORT_OAUTH_GRANT_URL =
  "https://as.gryphline.com/user/oauth2/v2/grant";
export const SKPORT_GENERATE_CRED_URL =
  "https://zonai.skport.com/web/v1/user/auth/generate_cred_by_code";
export const SKPORT_REFRESH_URL = "https://zonai.skport.com/web/v1/auth/refresh";
export const SKPORT_BINDING_URL =
  "https://zonai.skport.com/api/v1/game/player/binding";
export const SKPORT_ATTENDANCE_URL =
  "https://zonai.skport.com/web/v1/game/endfield/attendance";
export const SKPORT_CARD_DETAIL_URL =
  "https://zonai.skport.com/web/v1/game/endfield/card/detail";
export const SKPORT_CARD_URL =
  "https://zonai.skport.com/web/v1/game/endfield/card";

export const SKPORT_BINDING_PATH = "/api/v1/game/player/binding";
export const SKPORT_ATTENDANCE_PATH = "/web/v1/game/endfield/attendance";
export const SKPORT_CARD_DETAIL_PATH = "/web/v1/game/endfield/card/detail";
export const SKPORT_CARD_PATH = "/web/v1/game/endfield/card";

export const SKPORT_SIGN_IN_URL = "https://game.skport.com/endfield/sign-in";

// Sanity regenerates 1 point per 7 minutes 12 seconds per the
// research report's sources; a community source says 6 minutes.
// The card's own recoveryTime is preferred whenever present — this
// constant is only the fallback for the full-recovery estimate and
// is always presented as an estimate.
export const SANITY_RECOVERY_SECONDS_PER_POINT = 432;

// ----------------------------------------------------------------
// MD5 (RFC 1321), self-contained: WebCrypto does not offer MD5,
// and the Skport signature needs it. Input is a string (UTF-8) or
// a Uint8Array; output is the lowercase hex digest.

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = [];
for (let i = 0; i < 64; i += 1) {
  MD5_K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
}

function md5WordToHex(word) {
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += ((word >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

export function md5Hex(input) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_K[i] + words[g]) | 0;
      const rotated =
        ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i]))) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  return (
    md5WordToHex(a0) + md5WordToHex(b0) + md5WordToHex(c0) + md5WordToHex(d0)
  );
}

// ----------------------------------------------------------------
// Request signing

// The header JSON that goes into the signature, byte-for-byte as
// the reference implementations build it (key order matters).
export function skportHeaderJson(timestamp) {
  return JSON.stringify({
    platform: SKPORT_PLATFORM,
    timestamp: String(timestamp),
    dId: "",
    vName: SKPORT_VNAME,
  });
}

export function skportSignMessage(path, body, timestamp) {
  return path + (body ?? "") + String(timestamp) + skportHeaderJson(timestamp);
}

// deps.hmacSha256Hex(key, message) -> Promise<lowercase hex>.
// deps.md5Hex defaults to the built-in implementation above.
export async function computeSkportSign(request, deps) {
  const { path, body = "", timestamp, signToken } = request;
  const md5 = deps.md5Hex ?? md5Hex;
  const hmacHex = await deps.hmacSha256Hex(
    signToken,
    skportSignMessage(path, body, timestamp)
  );
  return md5(hmacHex);
}

export function buildSkportHeaders({ cred, timestamp, sign, gameRole }) {
  const headers = {
    cred,
    platform: SKPORT_PLATFORM,
    vName: SKPORT_VNAME,
    timestamp: String(timestamp),
    "sk-language": "ja",
  };
  if (sign) headers.sign = sign;
  if (gameRole) headers["sk-game-role"] = gameRole;
  return headers;
}

// ----------------------------------------------------------------
// Response parsing
//
// Skport answers carry a numeric `code` and a `message` (the
// Gryphline account endpoints use `status` / `msg` instead; those
// are handled in the runner where they occur).

// Flattens the binding answer into Endfield roles. Returns null
// when the payload is not a successful binding answer at all.
export function parseBindingRoles(body) {
  if (!body || typeof body !== "object" || body.code !== 0) return null;
  const list = body.data?.list;
  if (!Array.isArray(list)) return null;
  const roles = [];
  for (const app of list) {
    if (!app || app.appCode !== "endfield") continue;
    const bindings = Array.isArray(app.bindingList) ? app.bindingList : [];
    for (const binding of bindings) {
      const entries = Array.isArray(binding?.roles) ? binding.roles : [];
      for (const role of entries) {
        if (role?.roleId === undefined || role?.serverId === undefined) {
          continue;
        }
        const roleId = String(role.roleId);
        const serverId = String(role.serverId);
        roles.push({
          gameRole: `${SKPORT_GAME_ID}_${roleId}_${serverId}`,
          roleId,
          serverId,
          nickname: typeof role.nickname === "string" ? role.nickname : "",
          level: typeof role.level === "number" ? role.level : null,
          serverName:
            typeof role.serverName === "string" ? role.serverName : "",
        });
      }
    }
  }
  return roles;
}

// GET attendance answer: { hasToday } or null when unusable.
export function parseAttendanceStatus(body) {
  if (!body || typeof body !== "object" || body.code !== 0) return null;
  if (typeof body.data?.hasToday !== "boolean") return null;
  return { hasToday: body.data.hasToday };
}

// POST attendance answer: human-readable reward lines
// ("name xcount"), or null when the answer is not a success shape.
export function parseClaimRewards(body) {
  if (!body || typeof body !== "object" || body.code !== 0) return null;
  const awardIds = body.data?.awardIds;
  if (!Array.isArray(awardIds)) return [];
  const infoMap = body.data?.resourceInfoMap ?? {};
  return awardIds.map((award) => {
    const info = award?.id !== undefined ? infoMap[award.id] : null;
    if (info && typeof info.name === "string") {
      return `${info.name} x${info.count ?? 1}`;
    }
    return String(award?.id ?? "報酬");
  });
}

// Outcome vocabulary shared with the HoYoLAB automation log:
// success / already_done / not_logged_in / risk_control /
// rate_limited / failed. Code 10001 is Skport's "already signed
// today" and can arrive with HTTP 403, so it is checked before
// any status-based login rule.
export function classifySkportResponse(status, body) {
  if (status === 429) return "rate_limited";
  const code = body && typeof body === "object" ? body.code : undefined;
  if (code === 0) return "success";
  if (code === 10001) return "already_done";
  const message =
    body && typeof body.message === "string" ? body.message : "";
  if (/risk|captcha|geetest|verification/i.test(message)) {
    return "risk_control";
  }
  if (status === 401) return "not_logged_in";
  if (/login|token|credential|unauthor/i.test(message)) {
    return "not_logged_in";
  }
  return "failed";
}

// Same contract as hoyolab-auto.mjs's describeFailureDetail, but
// for Skport's `code` field: only the numeric code and the server
// message, sanitized and truncated, ever reach the run log.
export function describeSkportFailureDetail(body) {
  if (!body || typeof body !== "object") return "";
  const hasCode = typeof body.code === "number";
  const message =
    typeof body.message === "string"
      ? body.message.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60)
      : "";
  if (!hasCode && message === "") return "";
  if (hasCode && message !== "") return `code ${body.code}: ${message}`;
  if (hasCode) return `code ${body.code}`;
  return message;
}

// ----------------------------------------------------------------
// Sanity (理性) from the player card.
//
// The live card/detail payload carries stamina at
// data.detail.dungeon as { curStamina, maxStamina, maxTs }, where
// maxTs is the instant stamina reaches max (yeci226's
// endfield-discord-bot Skport API notes document this shape from
// the real API). torikushiii/endfield-auto's normalized stats
// instead carry stamina { current, max, recoveryTime }, read from
// the same endpoint family. The extractor therefore accepts the
// dungeon shape AND searches a bounded depth for a stamina/sanity
// object with numeric current/max, instead of trusting one fixed
// path. Anything not found renders as "unavailable" in the popup —
// values are never fabricated.

function sanityFromCandidate(value) {
  if (!value || typeof value !== "object") return null;
  const { current, max } = value;
  if (typeof current !== "number" || typeof max !== "number") return null;
  if (max <= 0 || current < 0) return null;
  return {
    current,
    max,
    recoveryTime:
      typeof value.recoveryTime === "number" ? value.recoveryTime : null,
  };
}

// The raw card/detail dungeon block: curStamina/maxStamina, with
// maxTs the full-recovery instant. maxTs is carried as
// recoveryTime so estimateSanityFullAt treats it as the
// full-recovery epoch (it accepts seconds or ms epochs).
function sanityFromDungeon(value) {
  if (!value || typeof value !== "object") return null;
  const { curStamina, maxStamina } = value;
  if (typeof curStamina !== "number" || typeof maxStamina !== "number") {
    return null;
  }
  if (maxStamina <= 0 || curStamina < 0) return null;
  return {
    current: curStamina,
    max: maxStamina,
    recoveryTime: typeof value.maxTs === "number" ? value.maxTs : null,
  };
}

export function extractSanity(body) {
  if (!body || typeof body !== "object") return null;
  const queue = [{ node: body, depth: 0 }];
  while (queue.length > 0) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== "object" || depth > 4) continue;
    for (const key of ["stamina", "sanity"]) {
      const found = sanityFromCandidate(node[key]);
      if (found) return found;
    }
    const dungeon = sanityFromDungeon(node.dungeon);
    if (dungeon) return dungeon;
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return null;
}

// Full-recovery estimate for a sanity reading, as a timestamp in
// ms. Prefers the card's recoveryTime: values that look like an
// epoch are taken as the full-recovery instant (seconds or ms);
// smaller values are treated as remaining seconds. Without a
// usable recoveryTime, falls back to the regeneration rate and
// flags the result as an estimate.
export function estimateSanityFullAt(sanity, nowMs) {
  if (!sanity) return null;
  if (sanity.current >= sanity.max) return { fullAt: nowMs, estimated: false };
  const recoveryTime = sanity.recoveryTime;
  if (typeof recoveryTime === "number" && recoveryTime > 0) {
    if (recoveryTime > 1e11) {
      // Milliseconds epoch.
      return { fullAt: recoveryTime, estimated: false };
    }
    if (recoveryTime > 1e8) {
      // Seconds epoch.
      return { fullAt: recoveryTime * 1000, estimated: false };
    }
    if (recoveryTime <= 7 * 24 * 3600) {
      // Remaining seconds until full.
      return { fullAt: nowMs + recoveryTime * 1000, estimated: false };
    }
  }
  const missing = sanity.max - sanity.current;
  return {
    fullAt: nowMs + missing * SANITY_RECOVERY_SECONDS_PER_POINT * 1000,
    estimated: true,
  };
}

// ----------------------------------------------------------------
// Schedule (Skport day boundary)
//
// The Endfield day rolls over at 04:00 UTC+8 for the Asia server,
// so "today" for check-in records is the Asia/Shanghai calendar
// date four hours before now, and the daily alarm is 05:05 JST
// (04:05 UTC+8), just after the reset.

export const ENDFIELD_ALARM_TIME_JST = { hour: 5, minute: 5 };

const shanghaiDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function skportDateKey(date) {
  return shanghaiDateFormat.format(new Date(date.getTime() - 4 * 3600 * 1000));
}

// Timestamp (ms) of the next 05:05 JST strictly after `date`.
// Same UTC arithmetic as the HoYoLAB alarm: 05:05 JST is 20:05 UTC
// of the previous UTC day, so every UTC day has exactly one
// occurrence and adding 24h steps between them (JST has no DST).
export function nextEndfieldAlarmTime(date) {
  let candidate = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    ENDFIELD_ALARM_TIME_JST.hour + 15,
    ENDFIELD_ALARM_TIME_JST.minute
  );
  while (candidate <= date.getTime()) {
    candidate += 24 * 60 * 60 * 1000;
  }
  return candidate;
}

export function isEndfieldCheckinDue(state, date) {
  const done = state?.checkin?.endfield;
  return done?.day !== skportDateKey(date);
}
