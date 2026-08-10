import { shuffleDeterministically } from "./game-engine.js";

export const RUN_FLOORS = 4;
export const BASE_FLOOR_WIDTH = 20;
export const BASE_FLOOR_HEIGHT = 15;
export const FLOOR_SIZE_GROWTH = 2;
export const BASE_BUILD_DURATION_MS = 60_000;
export const BUILD_DURATION_GROWTH_MS = 20_000;

export const AUGMENT_IDS = Object.freeze({
  BONUS_GOLD: "bonus-gold",
  WIDE_LAMENT: "wide-lament",
  CORRUPT_SPEED: "corrupt-speed",
  CHEAP_BUILDINGS: "cheap-buildings",
});

export const AUGMENTS = Object.freeze({
  [AUGMENT_IDS.BONUS_GOLD]: Object.freeze({
    id: AUGMENT_IDS.BONUS_GOLD,
    name: "Deep Pockets",
    icon: "+50",
    description: "Start every remaining floor with 50 extra gold.",
  }),
  [AUGMENT_IDS.WIDE_LAMENT]: Object.freeze({
    id: AUGMENT_IDS.WIDE_LAMENT,
    name: "Echoing Lament",
    icon: "8×",
    description: "Slow towers affect all eight adjacent tiles, including diagonals.",
  }),
  [AUGMENT_IDS.CORRUPT_SPEED]: Object.freeze({
    id: AUGMENT_IDS.CORRUPT_SPEED,
    name: "Twisted Haste",
    icon: "⇄",
    description: "Convert every neutral speed tower into a neutral slow tower.",
  }),
  [AUGMENT_IDS.CHEAP_BUILDINGS]: Object.freeze({
    id: AUGMENT_IDS.CHEAP_BUILDINGS,
    name: "Salvager's Eye",
    icon: "−2",
    description: "Crates, fences, and guard towers cost 2 less gold.",
  }),
});

function normalizedAugmentIds(augmentIds) {
  return new Set(
    [...(augmentIds ?? [])].filter((augmentId) => AUGMENTS[augmentId]),
  );
}

export function floorConfig(floorNumber) {
  if (
    !Number.isSafeInteger(floorNumber) ||
    floorNumber < 1 ||
    floorNumber > RUN_FLOORS
  ) {
    throw new RangeError(`floorNumber must be between 1 and ${RUN_FLOORS}.`);
  }
  const growth = (floorNumber - 1) * FLOOR_SIZE_GROWTH;
  return {
    floorNumber,
    width: BASE_FLOOR_WIDTH + growth,
    height: BASE_FLOOR_HEIGHT + growth,
    buildDurationMs:
      BASE_BUILD_DURATION_MS +
      (floorNumber - 1) * BUILD_DURATION_GROWTH_MS,
  };
}

/** Returns two deterministic, unowned upgrades after a completed floor. */
export function draftAugmentChoices(contestSeed, completedFloor, augmentIds = []) {
  if (
    !Number.isSafeInteger(completedFloor) ||
    completedFloor < 1 ||
    completedFloor >= RUN_FLOORS
  ) {
    throw new RangeError(`completedFloor must be between 1 and ${RUN_FLOORS - 1}.`);
  }
  const owned = normalizedAugmentIds(augmentIds);
  const available = Object.keys(AUGMENTS).filter((augmentId) => !owned.has(augmentId));
  if (available.length < 2) {
    throw new RangeError("At least two unowned augments are required for a draft.");
  }
  return shuffleDeterministically(
    available,
    `${contestSeed}:augment-draft-v1:${completedFloor}`,
  ).slice(0, 2);
}

export function applyResourceAugments(resources, augmentIds = []) {
  const owned = normalizedAugmentIds(augmentIds);
  return {
    ...resources,
    gold:
      resources.gold +
      (owned.has(AUGMENT_IDS.BONUS_GOLD) ? 50 : 0),
  };
}

export function discountedBuildingCost(cost, augmentIds = []) {
  const owned = normalizedAugmentIds(augmentIds);
  return Math.max(
    0,
    cost - (owned.has(AUGMENT_IDS.CHEAP_BUILDINGS) ? 2 : 0),
  );
}

export function applyMapAugments(baseMap, augmentIds = []) {
  const owned = normalizedAugmentIds(augmentIds);
  if (!owned.has(AUGMENT_IDS.CORRUPT_SPEED)) return baseMap;

  const baseSlowTowers = [
    ...(baseMap.baseSlowTowers ?? []),
    ...(baseMap.baseSpeedTowers ?? []),
  ]
    .map((tower) => ({ x: tower.x, y: tower.y }))
    .sort((first, second) => first.y - second.y || first.x - second.x);
  return {
    ...baseMap,
    requestedSlowTowerCount: baseSlowTowers.length,
    baseSlowTowers,
    requestedSpeedTowerCount: 0,
    speedTowerSpawnChance: 0,
    speedTowerSpawnChances: null,
    baseSpeedTowers: [],
  };
}
