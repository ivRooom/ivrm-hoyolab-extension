// Orchestration for the automation features (extension #1).
//
// All side effects go through injected dependencies, so this module
// runs unchanged in the service worker (real fetch + chrome.storage)
// and in node --test (fakes):
//
//   deps.fetchJson(url, options) -> Promise<{status, body}>
//     Must throw on network failure. `body` is the parsed JSON or
//     null when the answer was not JSON.
//   deps.sleep(ms) -> Promise<void>
//   deps.now() -> Date
//   deps.hasSession() -> Promise<boolean>
//     Whether a usable HoYoLAB session exists in this browser
//     profile. Only the presence is checked; no value is read here.
//   deps.loadData() -> Promise<{settings, records, state, log,
//     authState}>
//   deps.saveData(patch) -> Promise<void>
//     Persists any of {records, state, log, authState} that changed.
//
// Safety rules baked in here:
// - Nothing runs while the master switch is off, while a risk
//   control stop is latched (until a manual run clears it), or
//   without a HoYoLAB session.
// - A risk-control answer anywhere stops the whole run at once.
// - Redemption attempts for one game are spaced by REDEEM_GAP_MS.
// - Records are saved after every attempt, so a service-worker
//   shutdown mid-cycle never loses a claimed code (which would
//   otherwise risk a duplicate attempt later).

import {
  ACCOUNT_REGIONS_URL,
  ACCOUNT_ROLES_URL,
  AUTO_GAMES,
  HOYO_CODES_API_URL,
  REDEEM_GAP_MS,
  TERMINAL_REDEEM_OUTCOMES,
  appendAutoLog,
  applyRedeemResult,
  classifyExchangeResponse,
  classifySignResponse,
  describeFailureDetail,
  enabledGameIds,
  hoyolabDateKey,
  isCheckinDue,
  isFamilyConsumed,
  normalizeAutoSettings,
  parseHoyoCodesResponse,
  planRedeemAttempts,
} from "./hoyolab-auto.mjs";
import {
  applyAuthSignal,
  isAuthOutcome,
  normalizeRetryState,
  shouldAttemptRetry,
} from "./session-resilience.mjs";

function emptyState() {
  return {
    checkin: {},
    roles: {},
    riskControl: null,
    sessionMissing: false,
    checkinRetry: { day: null, attempts: 0 },
    lastCheckinRunAt: null,
    lastCodeRunAt: null,
  };
}

export function createAutoRunner(deps) {
  async function load() {
    const data = await deps.loadData();
    return {
      settings: normalizeAutoSettings(data.settings, data.gameSettings),
      records: data.records ?? {},
      state: { ...emptyState(), ...(data.state ?? {}) },
      log: Array.isArray(data.log) ? data.log : [],
      authState: data.authState,
    };
  }

  // Folds an auth signal into the shared login state (#10):
  // "expired" when a call (or the session presence check) says
  // the HoYoLAB login is gone, "ok" when a call demonstrably
  // authenticated. Callers include data.authState in their next
  // saveData patch; background.js renders it as badge /
  // notification and the popup as a banner.
  function authSignal(data, signal) {
    data.authState = applyAuthSignal(
      data.authState,
      "hoyolab",
      signal,
      deps.now().getTime()
    ).state;
  }

  function logEntry(data, entry) {
    data.log = appendAutoLog(data.log, {
      at: deps.now().getTime(),
      ...entry,
    });
  }

  // Shared gate for both cycles. Returns a stop reason or null.
  async function gate(data, { force }) {
    if (enabledGameIds(data.settings).length === 0) return "disabled";
    if (data.state.riskControl && !force) return "risk_control";
    if (force && data.state.riskControl) {
      // A manual run is the user's signal that they completed the
      // verification on the official page; unlatch and try again.
      data.state.riskControl = null;
      await deps.saveData({ state: data.state });
    }
    if (!(await deps.hasSession())) {
      authSignal(data, "expired");
      if (!data.state.sessionMissing) {
        data.state.sessionMissing = true;
        logEntry(data, { kind: "auth", outcome: "not_logged_in" });
      }
      await deps.saveData({
        state: data.state,
        log: data.log,
        authState: data.authState,
      });
      return "not_logged_in";
    }
    if (data.state.sessionMissing) {
      data.state.sessionMissing = false;
      authSignal(data, "ok");
      await deps.saveData({ state: data.state, authState: data.authState });
    }
    return null;
  }

  function latchRiskControl(data, gameId) {
    data.state.riskControl = {
      game: gameId,
      at: deps.now().getTime(),
    };
  }

  // --------------------------------------------------------------
  // Daily check-in

  async function runCheckinCycle({ force = false, retry = false } = {}) {
    const data = await load();
    const summary = { ran: false, results: {} };
    const stop = await gate(data, { force });
    if (stop) {
      summary.stopReason = stop;
      return summary;
    }
    if (retry) {
      // Daytime retry (#10): the latched stops (risk control,
      // missing session) already returned at the gate, so what is
      // left is the daily budget. One attempt is spent only when
      // at least one enabled game is still pending; once every
      // game is done the cycle falls through and no-ops per game.
      const dayKey = hoyolabDateKey(deps.now());
      const pending = enabledGameIds(data.settings).filter((gameId) =>
        isCheckinDue(data.state, gameId, deps.now())
      );
      if (pending.length > 0) {
        data.state.checkinRetry = normalizeRetryState(
          data.state.checkinRetry,
          dayKey
        );
        if (
          !shouldAttemptRetry({
            retry: data.state.checkinRetry,
            dayKey,
            pendingCount: pending.length,
            stopped: null,
          })
        ) {
          summary.stopReason = "retry_limit";
          await deps.saveData({ state: data.state });
          return summary;
        }
        data.state.checkinRetry = {
          day: dayKey,
          attempts: data.state.checkinRetry.attempts + 1,
        };
        await deps.saveData({ state: data.state });
      }
    }
    summary.ran = true;
    data.state.lastCheckinRunAt = deps.now().getTime();
    for (const gameId of enabledGameIds(data.settings)) {
      const game = AUTO_GAMES[gameId];
      if (!force && !isCheckinDue(data.state, gameId, deps.now())) {
        summary.results[gameId] = "already_done";
        continue;
      }
      let outcome;
      let detail = "";
      try {
        const options = { method: "POST", body: { act_id: game.actId } };
        if (game.signHeaders) options.headers = game.signHeaders;
        const { status, body } = await deps.fetchJson(game.signUrl, options);
        outcome = classifySignResponse(status, body);
        if (outcome !== "success" && outcome !== "already_done") {
          detail = describeFailureDetail(body);
        }
      } catch {
        outcome = "failed";
      }
      summary.results[gameId] = outcome;
      const entry = { kind: "checkin", game: gameId, outcome };
      if (detail !== "") entry.detail = detail;
      logEntry(data, entry);
      if (outcome === "success" || outcome === "already_done") {
        authSignal(data, "ok");
        data.state.checkin[gameId] = {
          day: hoyolabDateKey(deps.now()),
          outcome,
          at: deps.now().getTime(),
        };
      }
      await deps.saveData({
        state: data.state,
        log: data.log,
        authState: data.authState,
      });
      if (outcome === "risk_control") {
        latchRiskControl(data, gameId);
        await deps.saveData({ state: data.state });
        summary.stopReason = "risk_control";
        break;
      }
      if (outcome === "not_logged_in") {
        authSignal(data, "expired");
        data.state.sessionMissing = true;
        await deps.saveData({
          state: data.state,
          authState: data.authState,
        });
        summary.stopReason = "not_logged_in";
        break;
      }
    }
    await deps.saveData({
      state: data.state,
      log: data.log,
      authState: data.authState,
    });
    return summary;
  }

  // --------------------------------------------------------------
  // Gift-code redemption

  // Finds the user's game role (uid + region) for one game through
  // the official account API, using the cached role when present.
  // Returns null when the account has no character for the game.
  async function findRole(data, gameId) {
    const cached = data.state.roles[gameId];
    if (cached?.uid && cached?.region) return cached;
    const game = AUTO_GAMES[gameId];
    const regions = await deps.fetchJson(
      `${ACCOUNT_REGIONS_URL}?game_biz=${game.gameBiz}`
    );
    // An auth answer here means the session died server-side even
    // though cookies are present; flag it so the cycle can stop
    // as not_logged_in instead of mistaking it for "no role".
    if (isAuthOutcome(classifySignResponse(regions.status, regions.body))) {
      data.authExpired = true;
      return null;
    }
    const regionList = regions.body?.data?.list;
    if (regions.status !== 200 || !Array.isArray(regionList)) {
      throw new Error("regions lookup failed");
    }
    for (const entry of regionList) {
      if (!entry?.region) continue;
      const roles = await deps.fetchJson(
        `${ACCOUNT_ROLES_URL}?game_biz=${game.gameBiz}&region=${entry.region}`
      );
      if (isAuthOutcome(classifySignResponse(roles.status, roles.body))) {
        data.authExpired = true;
        return null;
      }
      const role = roles.body?.data?.list?.[0];
      if (role?.game_uid) {
        const found = {
          uid: String(role.game_uid),
          region: entry.region,
          nickname: typeof role.nickname === "string" ? role.nickname : "",
          at: deps.now().getTime(),
        };
        data.state.roles[gameId] = found;
        await deps.saveData({ state: data.state });
        return found;
      }
    }
    return null;
  }

  // Returns the outcome plus a sanitized failure detail for the
  // run log; the detail is only the retcode and server message
  // (see describeFailureDetail) and is empty on success.
  async function redeemOne(game, role, code) {
    const params = new URLSearchParams({
      game_biz: game.gameBiz,
      region: role.region,
      cdkey: code,
      lang: "ja",
      sLangKey: "ja-jp",
      uid: role.uid,
    });
    try {
      const { status, body } = await deps.fetchJson(
        `${game.exchangeUrl}?${params.toString()}`
      );
      const outcome = classifyExchangeResponse(status, body);
      return {
        outcome,
        detail: outcome === "success" ? "" : describeFailureDetail(body),
      };
    } catch {
      return { outcome: "failed", detail: "" };
    }
  }

  async function runCodeCycle({ force = false } = {}) {
    const data = await load();
    const summary = { ran: false, games: {} };
    const stop = await gate(data, { force });
    if (stop) {
      summary.stopReason = stop;
      return summary;
    }
    summary.ran = true;
    data.state.lastCodeRunAt = deps.now().getTime();
    await deps.saveData({ state: data.state });

    for (const gameId of enabledGameIds(data.settings)) {
      const game = AUTO_GAMES[gameId];
      const gameSummary = { attempted: 0, outcomes: {} };
      summary.games[gameId] = gameSummary;

      let codes;
      try {
        const { status, body } = await deps.fetchJson(
          `${HOYO_CODES_API_URL}?game=${game.codesGame}`
        );
        codes = status === 200 ? parseHoyoCodesResponse(body) : null;
      } catch {
        codes = null;
      }
      if (codes === null) {
        // A failed code fetch skips this game for this cycle only;
        // nothing is recorded, so the next cycle starts clean.
        logEntry(data, { kind: "redeem", game: gameId, outcome: "fetch_failed" });
        await deps.saveData({ log: data.log });
        gameSummary.fetchFailed = true;
        continue;
      }

      const plan = planRedeemAttempts(gameId, codes, data.records);
      const knownCodes = codes.map((entry) => entry.code);
      for (const entry of plan.familyBlocked) {
        data.records = applyRedeemResult(
          data.records,
          gameId,
          entry.code,
          "family_blocked",
          deps.now().getTime(),
          knownCodes
        );
        logEntry(data, {
          kind: "redeem",
          game: gameId,
          code: entry.code,
          outcome: "family_blocked",
        });
      }
      if (plan.familyBlocked.length > 0) {
        await deps.saveData({ records: data.records, log: data.log });
      }
      if (plan.toAttempt.length === 0) continue;

      let role;
      try {
        role = await findRole(data, gameId);
      } catch {
        role = null;
        gameSummary.roleLookupFailed = true;
      }
      if (data.authExpired) {
        authSignal(data, "expired");
        data.state.sessionMissing = true;
        logEntry(data, {
          kind: "auth",
          game: gameId,
          outcome: "not_logged_in",
        });
        await deps.saveData({
          state: data.state,
          log: data.log,
          authState: data.authState,
        });
        summary.stopReason = "not_logged_in";
        return summary;
      }
      if (!role) {
        logEntry(data, { kind: "redeem", game: gameId, outcome: "no_role" });
        await deps.saveData({ log: data.log });
        gameSummary.noRole = true;
        continue;
      }

      let firstAttempt = true;
      for (const entry of plan.toAttempt) {
        // A sibling claimed earlier in this same cycle closes the
        // family; do not spend an attempt on the rest.
        if (isFamilyConsumed(data.records, gameId, entry.code)) {
          data.records = applyRedeemResult(
            data.records,
            gameId,
            entry.code,
            "family_blocked",
            deps.now().getTime(),
            knownCodes
          );
          logEntry(data, {
            kind: "redeem",
            game: gameId,
            code: entry.code,
            outcome: "family_blocked",
          });
          await deps.saveData({ records: data.records, log: data.log });
          continue;
        }
        if (!firstAttempt) await deps.sleep(REDEEM_GAP_MS);
        firstAttempt = false;
        const { outcome, detail } = await redeemOne(game, role, entry.code);
        gameSummary.attempted += 1;
        gameSummary.outcomes[entry.code] = outcome;
        if (outcome === "risk_control") {
          latchRiskControl(data, gameId);
          const stopEntry = {
            kind: "redeem",
            game: gameId,
            code: entry.code,
            outcome,
          };
          if (detail !== "") stopEntry.detail = detail;
          logEntry(data, stopEntry);
          await deps.saveData({ state: data.state, log: data.log });
          summary.stopReason = "risk_control";
          return summary;
        }
        if (outcome === "not_logged_in") {
          authSignal(data, "expired");
          data.state.sessionMissing = true;
          const stopEntry = {
            kind: "redeem",
            game: gameId,
            code: entry.code,
            outcome,
          };
          if (detail !== "") stopEntry.detail = detail;
          logEntry(data, stopEntry);
          await deps.saveData({
            state: data.state,
            log: data.log,
            authState: data.authState,
          });
          summary.stopReason = "not_logged_in";
          return summary;
        }
        // rate_limited is recorded as a plain failure: the code is
        // retried on the next cycle, and the rest of this game is
        // postponed rather than hammering a busy API.
        const recorded = outcome === "rate_limited" ? "failed" : outcome;
        // A business answer (claimed, already used, expired, ...)
        // proves the session authenticated: clear any expiry.
        if (TERMINAL_REDEEM_OUTCOMES.has(recorded) || recorded === "success") {
          authSignal(data, "ok");
        }
        data.records = applyRedeemResult(
          data.records,
          gameId,
          entry.code,
          recorded,
          deps.now().getTime(),
          knownCodes
        );
        const attemptEntry = {
          kind: "redeem",
          game: gameId,
          code: entry.code,
          outcome,
        };
        if (detail !== "") attemptEntry.detail = detail;
        logEntry(data, attemptEntry);
        await deps.saveData({
          records: data.records,
          log: data.log,
          authState: data.authState,
        });
        if (outcome === "rate_limited") break;
      }
    }
    return summary;
  }

  return { runCheckinCycle, runCodeCycle };
}
