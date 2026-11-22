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
//   deps.loadData() -> Promise<{settings, records, state, log}>
//   deps.saveData(patch) -> Promise<void>
//     Persists any of {records, state, log} that changed.
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
  appendAutoLog,
  applyRedeemResult,
  classifyExchangeResponse,
  classifySignResponse,
  enabledGameIds,
  hoyolabDateKey,
  isCheckinDue,
  isFamilyConsumed,
  normalizeAutoSettings,
  parseHoyoCodesResponse,
  planRedeemAttempts,
} from "./hoyolab-auto.mjs";

function emptyState() {
  return {
    checkin: {},
    roles: {},
    riskControl: null,
    sessionMissing: false,
    lastCheckinRunAt: null,
    lastCodeRunAt: null,
  };
}

export function createAutoRunner(deps) {
  async function load() {
    const data = await deps.loadData();
    return {
      settings: normalizeAutoSettings(data.settings),
      records: data.records ?? {},
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
      if (!data.state.sessionMissing) {
        data.state.sessionMissing = true;
        logEntry(data, { kind: "system", outcome: "not_logged_in" });
        await deps.saveData({ state: data.state, log: data.log });
      }
      return "not_logged_in";
    }
    if (data.state.sessionMissing) {
      data.state.sessionMissing = false;
      await deps.saveData({ state: data.state });
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

  async function runCheckinCycle({ force = false } = {}) {
    const data = await load();
    const summary = { ran: false, results: {} };
    const stop = await gate(data, { force });
    if (stop) {
      summary.stopReason = stop;
      return summary;
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
      try {
        const { status, body } = await deps.fetchJson(game.signUrl, {
          method: "POST",
          body: { act_id: game.actId },
        });
        outcome = classifySignResponse(status, body);
      } catch {
        outcome = "failed";
      }
      summary.results[gameId] = outcome;
      logEntry(data, { kind: "checkin", game: gameId, outcome });
      if (outcome === "success" || outcome === "already_done") {
        data.state.checkin[gameId] = {
          day: hoyolabDateKey(deps.now()),
          outcome,
          at: deps.now().getTime(),
        };
      }
      await deps.saveData({ state: data.state, log: data.log });
      if (outcome === "risk_control") {
        latchRiskControl(data, gameId);
        await deps.saveData({ state: data.state });
        summary.stopReason = "risk_control";
        break;
      }
      if (outcome === "not_logged_in") {
        data.state.sessionMissing = true;
        await deps.saveData({ state: data.state });
        summary.stopReason = "not_logged_in";
        break;
      }
    }
    await deps.saveData({ state: data.state, log: data.log });
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
    const regionList = regions.body?.data?.list;
    if (regions.status !== 200 || !Array.isArray(regionList)) {
      throw new Error("regions lookup failed");
    }
    for (const entry of regionList) {
      if (!entry?.region) continue;
      const roles = await deps.fetchJson(
        `${ACCOUNT_ROLES_URL}?game_biz=${game.gameBiz}&region=${entry.region}`
      );
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
      return classifyExchangeResponse(status, body);
    } catch {
      return "failed";
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
        const outcome = await redeemOne(game, role, entry.code);
        gameSummary.attempted += 1;
        gameSummary.outcomes[entry.code] = outcome;
        if (outcome === "risk_control") {
          latchRiskControl(data, gameId);
          logEntry(data, {
            kind: "redeem",
            game: gameId,
            code: entry.code,
            outcome,
          });
          await deps.saveData({ state: data.state, log: data.log });
          summary.stopReason = "risk_control";
          return summary;
        }
        if (outcome === "not_logged_in") {
          data.state.sessionMissing = true;
          logEntry(data, {
            kind: "redeem",
            game: gameId,
            code: entry.code,
            outcome,
          });
          await deps.saveData({ state: data.state, log: data.log });
          summary.stopReason = "not_logged_in";
          return summary;
        }
        // rate_limited is recorded as a plain failure: the code is
        // retried on the next cycle, and the rest of this game is
        // postponed rather than hammering a busy API.
        const recorded = outcome === "rate_limited" ? "failed" : outcome;
        data.records = applyRedeemResult(
          data.records,
          gameId,
          entry.code,
          recorded,
          deps.now().getTime(),
          knownCodes
        );
        logEntry(data, {
          kind: "redeem",
          game: gameId,
          code: entry.code,
          outcome,
        });
        await deps.saveData({ records: data.records, log: data.log });
        if (outcome === "rate_limited") break;
      }
    }
    return summary;
  }

  return { runCheckinCycle, runCodeCycle };
}
