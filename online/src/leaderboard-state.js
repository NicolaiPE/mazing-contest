import { normalizeChallengeSeed } from "../../src/challenge.js";

export const LEADERBOARD_LIMIT = 10;
export const LEADERBOARD_MODES = Object.freeze({
  SOLO: "solo",
  ONLINE: "online",
});

const MODE_VALUES = new Set(Object.values(LEADERBOARD_MODES));
const ENTRY_ID_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
const MAX_SCORE_MS = 5 * 86_400_000;
const MAX_REMEMBERED_IDS = 2_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!MODE_VALUES.has(mode)) throw new RangeError("Leaderboard mode must be solo or online.");
  return mode;
}

function normalizeName(value) {
  const playerName = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!playerName) throw new RangeError("Player name is required.");
  return playerName;
}

function normalizeEntry(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Leaderboard entry must be an object.");
  }
  const id = String(value.id ?? "").trim();
  if (!ENTRY_ID_PATTERN.test(id)) throw new RangeError("Leaderboard entry ID is invalid.");
  const mode = normalizeMode(value.mode);
  const playerName = normalizeName(value.playerName);
  const seed = normalizeChallengeSeed(value.seed);
  if (!seed) throw new RangeError("Leaderboard seed is invalid.");
  const scoreMs = Math.round(Number(value.scoreMs));
  if (!Number.isSafeInteger(scoreMs) || scoreMs < 0 || scoreMs > MAX_SCORE_MS) {
    throw new RangeError("Leaderboard score is invalid.");
  }
  return {
    id,
    mode,
    playerName,
    scoreMs,
    seed,
    playedAt: Math.max(0, Math.round(Number(now))),
  };
}

function compareEntries(first, second) {
  return (
    second.scoreMs - first.scoreMs ||
    first.playedAt - second.playedAt ||
    first.playerName.localeCompare(second.playerName) ||
    first.id.localeCompare(second.id)
  );
}

export function createLeaderboardState() {
  return {
    version: 1,
    entries: {
      [LEADERBOARD_MODES.SOLO]: [],
      [LEADERBOARD_MODES.ONLINE]: [],
    },
    seenIds: [],
  };
}

export function leaderboardEntries(state, mode) {
  const normalizedMode = normalizeMode(mode);
  return clone(state.entries[normalizedMode] ?? []).map((entry, index) => ({
    rank: index + 1,
    ...entry,
  }));
}

export function submitLeaderboardEntry(state, value, now = Date.now()) {
  const entry = normalizeEntry(value, now);
  if (state.seenIds.includes(entry.id)) {
    return {
      inserted: false,
      entry: (state.entries[entry.mode] ?? []).find((candidate) => candidate.id === entry.id) ?? null,
      entries: leaderboardEntries(state, entry.mode),
    };
  }
  state.seenIds.push(entry.id);
  if (state.seenIds.length > MAX_REMEMBERED_IDS) {
    state.seenIds.splice(0, state.seenIds.length - MAX_REMEMBERED_IDS);
  }
  state.entries[entry.mode] = [...(state.entries[entry.mode] ?? []), entry]
    .sort(compareEntries)
    .slice(0, LEADERBOARD_LIMIT);
  return {
    inserted: true,
    entry: clone(entry),
    entries: leaderboardEntries(state, entry.mode),
  };
}
