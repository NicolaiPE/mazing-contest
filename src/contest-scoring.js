export const MIN_CONTEST_ROUNDS = 1;
export const MAX_CONTEST_ROUNDS = 20;
export const DEFAULT_CONTEST_ROUNDS = 3;

export function normalizeRoundCount(value, options = {}) {
  const minimum = options.minimum ?? MIN_CONTEST_ROUNDS;
  const maximum = options.maximum ?? MAX_CONTEST_ROUNDS;
  const fallback = options.fallback ?? DEFAULT_CONTEST_ROUNDS;
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 1 ||
    maximum < minimum
  ) {
    throw new RangeError("Round limits must be positive integers with maximum >= minimum.");
  }
  if (!Number.isFinite(Number(fallback))) {
    throw new RangeError("fallback must be a finite round count.");
  }
  const fallbackValue = Math.min(maximum, Math.max(minimum, Math.round(Number(fallback))));
  if (value === null || value === undefined || String(value).trim() === "") return fallbackValue;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallbackValue;
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function participantId(participant) {
  const id = String(participant?.id ?? "").trim();
  if (!id) throw new TypeError("Every contestant must have a non-empty id.");
  return id;
}

function participantScore(participant) {
  const scoreMs = participant?.scoreMs ?? participant?.state?.scoreMs;
  if (!Number.isFinite(scoreMs) || scoreMs < 0) {
    throw new RangeError("Every contestant must have a non-negative finite scoreMs.");
  }
  return scoreMs;
}

export function createCumulativeScores(contestants) {
  if (!Array.isArray(contestants)) throw new TypeError("contestants must be an array.");
  const totals = {};
  for (const contestant of contestants) {
    const id = participantId(contestant);
    if (Object.hasOwn(totals, id)) throw new RangeError(`Duplicate contestant id: ${id}`);
    totals[id] = 0;
  }
  return totals;
}

export function addRoundScores(cumulativeScores, contestants) {
  if (!cumulativeScores || typeof cumulativeScores !== "object" || Array.isArray(cumulativeScores)) {
    throw new TypeError("cumulativeScores must be an object.");
  }
  if (!Array.isArray(contestants)) throw new TypeError("contestants must be an array.");
  const next = { ...cumulativeScores };
  const seen = new Set();
  for (const contestant of contestants) {
    const id = participantId(contestant);
    if (seen.has(id)) throw new RangeError(`Duplicate contestant id: ${id}`);
    seen.add(id);
    const prior = next[id] ?? 0;
    if (!Number.isFinite(prior) || prior < 0) {
      throw new RangeError(`Invalid cumulative score for contestant: ${id}`);
    }
    next[id] = prior + participantScore(contestant);
  }
  return next;
}

export function rankCumulativeScores(contestants, cumulativeScores) {
  if (!Array.isArray(contestants)) throw new TypeError("contestants must be an array.");
  if (!cumulativeScores || typeof cumulativeScores !== "object" || Array.isArray(cumulativeScores)) {
    throw new TypeError("cumulativeScores must be an object.");
  }
  const sorted = contestants
    .map((contestant) => {
      const id = participantId(contestant);
      const totalScoreMs = cumulativeScores[id] ?? 0;
      if (!Number.isFinite(totalScoreMs) || totalScoreMs < 0) {
        throw new RangeError(`Invalid cumulative score for contestant: ${id}`);
      }
      return { ...contestant, totalScoreMs };
    })
    .sort(
      (first, second) =>
        second.totalScoreMs - first.totalScoreMs ||
        String(first.name ?? first.id).localeCompare(String(second.name ?? second.id)),
    );

  let rank = 0;
  let previousTotal = null;
  return sorted.map((contestant, index) => {
    if (previousTotal === null || contestant.totalScoreMs !== previousTotal) rank = index + 1;
    previousTotal = contestant.totalScoreMs;
    return { ...contestant, rank };
  });
}
