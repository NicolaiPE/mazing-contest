import { createSeededRng } from "./game-engine.js";

const ROUND_SEED_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROUND_SEED_LENGTH = 6;
const MAX_CHALLENGE_SEED_LENGTH = 24;
const MAX_CHALLENGE_TARGET_MS = 86_400_000;

/** Normalizes a URL-supplied contest seed without inventing a fallback. */
export function normalizeChallengeSeed(value) {
  const normalized = String(value ?? "")
    .trim()
    .slice(0, MAX_CHALLENGE_SEED_LENGTH)
    .toUpperCase();
  return normalized || null;
}

/**
 * Derives every round from one public contest seed. Round one retains the
 * visible challenge code; later rounds use domain-separated seeded RNG.
 */
export function deriveContestRoundSeed(contestSeed, roundNumber) {
  const normalizedSeed = normalizeChallengeSeed(contestSeed);
  if (!normalizedSeed) throw new RangeError("contestSeed must not be blank.");
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1) {
    throw new RangeError("roundNumber must be a positive integer.");
  }
  if (roundNumber === 1) return normalizedSeed;

  const random = createSeededRng(
    `${normalizedSeed}:contest-round-v1:${roundNumber}`,
  );
  return Array.from(
    { length: ROUND_SEED_LENGTH },
    () => ROUND_SEED_ALPHABET[Math.floor(random() * ROUND_SEED_ALPHABET.length)],
  ).join("");
}

/** Parses the optional casual-challenge score embedded in a shared link. */
export function parseChallengeTarget(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const target = Number(value);
  return Number.isSafeInteger(target) &&
    target >= 0 &&
    target <= MAX_CHALLENGE_TARGET_MS
    ? target
    : null;
}

/** Creates a canonical, host-preserving URL for an invitation or score target. */
export function createChallengeUrl(
  baseUrl,
  { contestSeed, rounds, targetMs = null },
) {
  const normalizedSeed = normalizeChallengeSeed(contestSeed);
  if (!normalizedSeed) throw new RangeError("contestSeed must not be blank.");
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) {
    throw new RangeError("rounds must be an integer from 1 through 20.");
  }
  const normalizedTarget = parseChallengeTarget(targetMs);
  if (targetMs !== null && targetMs !== undefined && normalizedTarget === null) {
    throw new RangeError("targetMs is outside the supported range.");
  }

  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  url.searchParams.set("challenge", normalizedSeed);
  url.searchParams.set("rounds", String(rounds));
  if (normalizedTarget !== null) {
    url.searchParams.set("target", String(normalizedTarget));
  }
  return url.href;
}
