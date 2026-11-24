// Orchestration for the Skport (Endfield) automation
// (ivrm-hoyolab-extension #5). Mirrors hoyolab-auto-runner.mjs:
// every side effect goes through injected dependencies, so this
// module runs unchanged in the service worker and in node --test.
//
//   deps.fetchJson(url, options) -> Promise<{status, body}>
//     Must throw on network failure. `body` is the parsed JSON or
//     null when the answer was not JSON.
//   deps.sleep(ms) -> Promise<void>
//   deps.now() -> Date
//   deps.getAccountToken() -> Promise<string|null>
//     The ACCOUNT_TOKEN cookie value for skport.com, read by the
//     caller through chrome.cookies. The value is used only as the
//     input of the Gryphline OAuth exchange below; it is never
//     stored and never sent anywhere else.
//   deps.sign({path, body, timestamp, signToken}) -> Promise<string>
//     The Skport request signature (see skport.mjs).
//   deps.loadData() -> Promise<{settings, gameSettings, state, log}>
//     settings/gameSettings are the shared automation settings
//     (raw storage values); state is the Skport runner's own
//     storage slice; log is the shared run log.
//   deps.saveData(patch) -> Promise<void>
//     Persists any of {state, log} that changed.
//
// Safety rules, mirroring the HoYoLAB runner:
// - Nothing runs while the master switch is off, while Endfield
//   is hidden or automation-disabled in the per-game settings
//   (#6), while a risk-control stop is latched (until a manual
//   run clears it), or without a Skport session.
// - The attendance GET (hasToday) always precedes the claim POST,
//   so a day the server already counts as claimed is never
//   claimed twice; local records keyed by the Skport day
//   (04:00 UTC+8 boundary) only skip the status check.
// - cred / signToken are derived fresh on every run from the
//   ACCOUNT_TOKEN and are never persisted.

import {
  appendAutoLog,
  normalizeAutoSettings,
} from "./hoyolab-auto.mjs";
import {
  isGameAutomationEffective,
  migrateGameSettings,
} from "./game-settings.mjs";
import {
  SKPORT_APP_CODE,
  SKPORT_ATTENDANCE_PATH,
  SKPORT_ATTENDANCE_URL,
  SKPORT_BASIC_INFO_URL,
  SKPORT_BINDING_PATH,
  SKPORT_BINDING_URL,
  SKPORT_CARD_DETAIL_PATH,
  SKPORT_CARD_DETAIL_URL,
  SKPORT_CARD_PATH,
  SKPORT_CARD_URL,
  SKPORT_GENERATE_CRED_URL,
  SKPORT_OAUTH_GRANT_URL,
  SKPORT_PLATFORM,
  SKPORT_REFRESH_URL,
  SKPORT_VNAME,
  buildSkportHeaders,
  classifySkportResponse,
  describeSkportFailureDetail,
  estimateSanityFullAt,
  extractSanity,
  isEndfieldCheckinDue,
  parseAttendanceStatus,
  parseBindingRoles,
  parseClaimRewards,
  skportDateKey,
} from "./skport.mjs";

const GAME_ID = "endfield";
const ROLE_GAP_MS = 500; // between roles, as in the reference tools

function emptyState() {
  return {
    checkin: {},
    roles: [],
    riskControl: null,
    sessionMissing: false,
    lastCheckinRunAt: null,
    sanity: null,
  };
}

export function createSkportRunner(deps) {
  async function load() {
    const data = await deps.loadData();
    return {
      masterEnabled: normalizeAutoSettings(data.settings).enabled,
      gameSettings: migrateGameSettings({
        gameSettings: data.gameSettings,
        autoSettings: data.settings,
      }),
      state: { ...emptyState(), ...(data.state ?? {}) },
      log: Array.isArray(data.log) ? data.log : [],
    };
  }

  function logEntry(data, entry) {
    data.log = appendAutoLog(data.log, {
      at: deps.now().getTime(),
      ...entry,
    });
  }

  function automationAllowed(data) {
    return (
      data.masterEnabled && isGameAutomationEffective(data.gameSettings, GAME_ID)
    );
  }

  // --------------------------------------------------------------
  // Authentication: ACCOUNT_TOKEN -> cred + signToken.
  //
  // Step 1 validates the token against the Gryphline account API
  // (status field, not code). Step 2 exchanges it for a one-time
  // OAuth code. Step 3 trades the code for the Skport session
  // cred and the initial sign token. A /web/v1/auth/refresh then
  // rotates the sign token, as xydesu/endfield-assistant does
  // before signing; sglkc/endfield-auto-daily signs with the
  // step-3 token directly, so a failed refresh falls back to it.

  async function authenticate() {
    const accountToken = await deps.getAccountToken();
    if (!accountToken) return { error: "not_logged_in" };

    let info;
    try {
      info = await deps.fetchJson(
        `${SKPORT_BASIC_INFO_URL}?token=${encodeURIComponent(accountToken)}`
      );
    } catch {
      return { error: "failed" };
    }
    if (info.body?.status !== 0) {
      return { error: "not_logged_in", detail: describeSkportFailureDetail(info.body) };
    }

    let grant;
    try {
      grant = await deps.fetchJson(SKPORT_OAUTH_GRANT_URL, {
        method: "POST",
        body: { token: accountToken, appCode: SKPORT_APP_CODE, type: 0 },
      });
    } catch {
      return { error: "failed" };
    }
    const code = grant.body?.data?.code;
    if (grant.body?.status !== 0 || typeof code !== "string" || code === "") {
      return { error: "failed", detail: describeSkportFailureDetail(grant.body) };
    }

    let credAnswer;
    try {
      credAnswer = await deps.fetchJson(SKPORT_GENERATE_CRED_URL, {
        method: "POST",
        headers: { platform: SKPORT_PLATFORM },
        body: { code, kind: 1 },
      });
    } catch {
      return { error: "failed" };
    }
    const cred = credAnswer.body?.data?.cred;
    let signToken = credAnswer.body?.data?.token;
    if (
      credAnswer.body?.code !== 0 ||
      typeof cred !== "string" ||
      cred === "" ||
      typeof signToken !== "string" ||
      signToken === ""
    ) {
      const outcome = classifySkportResponse(credAnswer.status, credAnswer.body);
      return {
        error: outcome,
        detail: describeSkportFailureDetail(credAnswer.body),
      };
    }

    try {
      const refreshed = await deps.fetchJson(SKPORT_REFRESH_URL, {
        headers: {
          cred,
          platform: SKPORT_PLATFORM,
          vName: SKPORT_VNAME,
        },
      });
      const fresh = refreshed.body?.data?.token;
      if (refreshed.body?.code === 0 && typeof fresh === "string" && fresh) {
        signToken = fresh;
      }
    } catch {
      // Keep the step-3 token; it is the documented fallback.
    }
    return { cred, signToken };
  }

  // One signed Skport API call. Attendance/card calls carry no
  // JSON body in the reference implementations, so the signed body
  // segment is empty unless a body is actually sent.
  async function signedFetch(auth, { path, url, method = "GET", gameRole }) {
    const timestamp = String(Math.floor(deps.now().getTime() / 1000));
    const sign = await deps.sign({
      path,
      body: "",
      timestamp,
      signToken: auth.signToken,
    });
    const headers = buildSkportHeaders({
      cred: auth.cred,
      timestamp,
      sign,
      gameRole,
    });
    return deps.fetchJson(url, { method, headers });
  }

  async function fetchRoles(data, auth) {
    const answer = await signedFetch(auth, {
      path: SKPORT_BINDING_PATH,
      url: SKPORT_BINDING_URL,
    });
    const roles = parseBindingRoles(answer.body);
    if (roles === null) {
      return {
        error: classifySkportResponse(answer.status, answer.body),
        detail: describeSkportFailureDetail(answer.body),
      };
    }
    data.state.roles = roles;
    await deps.saveData({ state: data.state });
    return { roles };
  }

  // Best-effort sanity read for the first role. Tries the card
  // detail endpoint named by torikushiii/endfield-auto first and
  // the card endpoint named by xydesu/endfield-assistant second;
  // any failure simply leaves the previous reading in place.
  async function refreshSanityWithAuth(data, auth, roles) {
    const role = roles[0];
    if (!role) return null;
    const attempts = [
      { path: SKPORT_CARD_DETAIL_PATH, url: SKPORT_CARD_DETAIL_URL },
      { path: SKPORT_CARD_PATH, url: SKPORT_CARD_URL },
    ];
    for (const attempt of attempts) {
      try {
        const answer = await signedFetch(auth, {
          ...attempt,
          gameRole: role.gameRole,
        });
        const sanity = extractSanity(answer.body);
        if (sanity) {
          const estimate = estimateSanityFullAt(sanity, deps.now().getTime());
          const reading = {
            current: sanity.current,
            max: sanity.max,
            fullAt: estimate?.fullAt ?? null,
            estimated: estimate?.estimated ?? false,
            at: deps.now().getTime(),
            nickname: role.nickname,
          };
          data.state.sanity = reading;
          await deps.saveData({ state: data.state });
          return reading;
        }
      } catch {
        // Try the next endpoint shape, then give up quietly.
      }
    }
    return null;
  }

  // --------------------------------------------------------------
  // Daily check-in cycle

  async function runEndfieldCheckinCycle({ force = false } = {}) {
    const data = await load();
    const summary = { ran: false, results: {} };
    if (!automationAllowed(data)) {
      summary.stopReason = "disabled";
      return summary;
    }
    if (data.state.riskControl && !force) {
      summary.stopReason = "risk_control";
      return summary;
    }
    if (force && data.state.riskControl) {
      // A manual run is the user's signal that they completed any
      // verification on the official page; unlatch and try again.
      data.state.riskControl = null;
      await deps.saveData({ state: data.state });
    }
    if (!force && !isEndfieldCheckinDue(data.state, deps.now())) {
      summary.results[GAME_ID] = "already_done";
      return summary;
    }
    summary.ran = true;
    data.state.lastCheckinRunAt = deps.now().getTime();
    await deps.saveData({ state: data.state });

    const auth = await authenticate();
    if (auth.error) {
      summary.stopReason = auth.error;
      summary.results[GAME_ID] = auth.error;
      if (auth.error === "not_logged_in") {
        if (!data.state.sessionMissing) {
          data.state.sessionMissing = true;
          logEntry(data, {
            kind: "system",
            game: GAME_ID,
            outcome: "not_logged_in",
          });
        }
      } else {
        const entry = { kind: "checkin", game: GAME_ID, outcome: auth.error };
        if (auth.detail) entry.detail = auth.detail;
        logEntry(data, entry);
      }
      await deps.saveData({ state: data.state, log: data.log });
      return summary;
    }
    if (data.state.sessionMissing) {
      data.state.sessionMissing = false;
      await deps.saveData({ state: data.state });
    }

    const rolesResult = await fetchRoles(data, auth);
    if (rolesResult.error) {
      summary.stopReason = rolesResult.error;
      summary.results[GAME_ID] = rolesResult.error;
      const entry = {
        kind: "checkin",
        game: GAME_ID,
        outcome: rolesResult.error,
      };
      if (rolesResult.detail) entry.detail = rolesResult.detail;
      logEntry(data, entry);
      if (rolesResult.error === "risk_control") {
        data.state.riskControl = { at: deps.now().getTime() };
      }
      await deps.saveData({ state: data.state, log: data.log });
      return summary;
    }
    const roles = rolesResult.roles;
    if (roles.length === 0) {
      summary.results[GAME_ID] = "no_role";
      logEntry(data, { kind: "checkin", game: GAME_ID, outcome: "no_role" });
      await deps.saveData({ log: data.log });
      return summary;
    }

    let claimedOrDone = false;
    let firstRole = true;
    for (const role of roles) {
      if (!firstRole) await deps.sleep(ROLE_GAP_MS);
      firstRole = false;
      const outcome = await checkInRole(data, auth, role, summary);
      if (outcome === "success" || outcome === "already_done") {
        claimedOrDone = true;
      }
      if (summary.stopReason) break;
    }
    if (claimedOrDone) {
      data.state.checkin[GAME_ID] = {
        day: skportDateKey(deps.now()),
        at: deps.now().getTime(),
      };
    }
    await deps.saveData({ state: data.state, log: data.log });

    // The same authenticated session also refreshes the sanity
    // reading shown in the popup; failure here never fails the
    // check-in cycle.
    await refreshSanityWithAuth(data, auth, roles);
    return summary;
  }

  async function checkInRole(data, auth, role, summary) {
    let statusAnswer;
    try {
      statusAnswer = await signedFetch(auth, {
        path: SKPORT_ATTENDANCE_PATH,
        url: SKPORT_ATTENDANCE_URL,
        gameRole: role.gameRole,
      });
    } catch {
      statusAnswer = null;
    }
    const status = statusAnswer ? parseAttendanceStatus(statusAnswer.body) : null;
    if (status?.hasToday) {
      logEntry(data, { kind: "checkin", game: GAME_ID, outcome: "already_done" });
      await deps.saveData({ log: data.log });
      summary.results[GAME_ID] = "already_done";
      return "already_done";
    }

    let claimAnswer;
    try {
      claimAnswer = await signedFetch(auth, {
        path: SKPORT_ATTENDANCE_PATH,
        url: SKPORT_ATTENDANCE_URL,
        method: "POST",
        gameRole: role.gameRole,
      });
    } catch {
      claimAnswer = null;
    }
    const outcome = claimAnswer
      ? classifySkportResponse(claimAnswer.status, claimAnswer.body)
      : "failed";
    const entry = { kind: "checkin", game: GAME_ID, outcome };
    if (outcome === "success") {
      const rewards = parseClaimRewards(claimAnswer.body) ?? [];
      if (rewards.length > 0) entry.detail = rewards.join("、");
    } else if (outcome !== "already_done") {
      const detail = claimAnswer
        ? describeSkportFailureDetail(claimAnswer.body)
        : "";
      if (detail) entry.detail = detail;
    }
    logEntry(data, entry);
    summary.results[GAME_ID] = outcome;
    if (outcome === "risk_control") {
      data.state.riskControl = { at: deps.now().getTime() };
      summary.stopReason = "risk_control";
    }
    if (outcome === "not_logged_in") {
      data.state.sessionMissing = true;
      summary.stopReason = "not_logged_in";
    }
    await deps.saveData({ state: data.state, log: data.log });
    return outcome;
  }

  // --------------------------------------------------------------
  // Sanity refresh on demand (popup). Independent of the
  // automation switches: viewing is a display feature (#6), so a
  // visible game may refresh even with automation off. Still
  // requires a Skport session in this browser.

  async function refreshSanity() {
    const data = await load();
    const visible =
      migrateGameSettings({
        gameSettings: data.gameSettings,
        autoSettings: data.settings,
      }).display[GAME_ID] === true;
    if (!visible) return { ok: false, reason: "hidden" };
    const auth = await authenticate();
    if (auth.error) return { ok: false, reason: auth.error };
    let roles = data.state.roles;
    if (!Array.isArray(roles) || roles.length === 0) {
      const rolesResult = await fetchRoles(data, auth);
      if (rolesResult.error) return { ok: false, reason: rolesResult.error };
      roles = rolesResult.roles;
    }
    if (roles.length === 0) return { ok: false, reason: "no_role" };
    const reading = await refreshSanityWithAuth(data, auth, roles);
    if (!reading) return { ok: false, reason: "unavailable" };
    return { ok: true, sanity: reading };
  }

  return { runEndfieldCheckinCycle, refreshSanity };
}
