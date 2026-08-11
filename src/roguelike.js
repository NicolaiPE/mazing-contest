import { generateBaseMap, shuffleDeterministically } from "./game-engine.js";

export const RUN_FLOORS = 5;
export const BASE_FLOOR_WIDTH = 20;
export const BASE_FLOOR_HEIGHT = 15;
export const FLOOR_SIZE_GROWTH = 2;
export const BASE_BUILD_DURATION_MS = 60_000;
export const BUILD_DURATION_GROWTH_MS = 20_000;

export const AUGMENT_TIERS = Object.freeze({
  GOLD: "gold",
  RADIANT: "radiant",
});

export const AUGMENT_DRAFT_FLOORS = Object.freeze([1, 2, 3]);

export const AUGMENT_IDS = Object.freeze({
  BONUS_GOLD: "bonus-gold",
  WIDE_LAMENT: "wide-lament",
  CORRUPT_SPEED: "corrupt-speed",
  CHEAP_BUILDINGS: "cheap-buildings",
  GATES_OF_HADES: "gates-of-hades",
  TRAP_QUEEN: "trap-queen",
  CRUSHING_COLD: "crushing-cold",
  JUXTAPOSITION: "juxtaposition",
});

export const AUGMENTS = Object.freeze({
  [AUGMENT_IDS.BONUS_GOLD]: Object.freeze({
    id: AUGMENT_IDS.BONUS_GOLD,
    name: "Deep Pockets",
    tier: AUGMENT_TIERS.GOLD,
    icon: "+30",
    description: "Start every remaining floor with 30 extra gold.",
  }),
  [AUGMENT_IDS.WIDE_LAMENT]: Object.freeze({
    id: AUGMENT_IDS.WIDE_LAMENT,
    name: "Echoing Lament",
    tier: AUGMENT_TIERS.GOLD,
    icon: "8×",
    description: "Slow towers affect all eight adjacent tiles, including diagonals.",
  }),
  [AUGMENT_IDS.CORRUPT_SPEED]: Object.freeze({
    id: AUGMENT_IDS.CORRUPT_SPEED,
    name: "Twisted Haste",
    tier: AUGMENT_TIERS.GOLD,
    icon: "⇄",
    description: "Convert every neutral speed tower into a neutral slow tower.",
  }),
  [AUGMENT_IDS.CHEAP_BUILDINGS]: Object.freeze({
    id: AUGMENT_IDS.CHEAP_BUILDINGS,
    name: "Scavenger",
    tier: AUGMENT_TIERS.GOLD,
    icon: "1/3/6",
    description: "Crates cost 1 less, fences 3 less, and guard towers 6 less gold.",
  }),
  [AUGMENT_IDS.GATES_OF_HADES]: Object.freeze({
    id: AUGMENT_IDS.GATES_OF_HADES,
    name: "Gates of Hades",
    tier: AUGMENT_TIERS.RADIANT,
    icon: "+II",
    description: "Spawn one extra linked portal pair on every remaining floor.",
  }),
  [AUGMENT_IDS.TRAP_QUEEN]: Object.freeze({
    id: AUGMENT_IDS.TRAP_QUEEN,
    name: "Trap Queen",
    tier: AUGMENT_TIERS.RADIANT,
    icon: "+3",
    description: "Spawn three extra Trap Doors on every remaining floor.",
  }),
  [AUGMENT_IDS.CRUSHING_COLD]: Object.freeze({
    id: AUGMENT_IDS.CRUSHING_COLD,
    name: "Crushing Cold",
    tier: AUGMENT_TIERS.RADIANT,
    icon: "+2",
    description: "Spawn two extra neutral slow towers on every remaining floor.",
  }),
  [AUGMENT_IDS.JUXTAPOSITION]: Object.freeze({
    id: AUGMENT_IDS.JUXTAPOSITION,
    name: "Juxtaposition",
    tier: AUGMENT_TIERS.RADIANT,
    icon: "4+4",
    description: "Spawn four extra slow towers and four extra speed towers on every remaining floor.",
  }),
});

const SCAVENGER_DISCOUNTS = Object.freeze({
  crate: 1,
  fence: 3,
  tower: 6,
});

const BUILDING_IDS_BY_BASE_COST = Object.freeze({
  10: "crate",
  18: "fence",
  26: "tower",
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

export function augmentTierForDraft(completedFloor) {
  if (
    !Number.isSafeInteger(completedFloor) ||
    !AUGMENT_DRAFT_FLOORS.includes(completedFloor)
  ) {
    throw new RangeError("completedFloor must be 1, 2, or 3.");
  }
  return completedFloor < 3 ? AUGMENT_TIERS.GOLD : AUGMENT_TIERS.RADIANT;
}

export function hasAugmentDraftAfterFloor(completedFloor) {
  return AUGMENT_DRAFT_FLOORS.includes(completedFloor);
}

/** Returns two deterministic, unowned upgrades from the current tier. */
export function draftAugmentChoices(contestSeed, completedFloor, augmentIds = []) {
  const tier = augmentTierForDraft(completedFloor);
  const owned = normalizedAugmentIds(augmentIds);
  const available = Object.keys(AUGMENTS).filter(
    (augmentId) => AUGMENTS[augmentId].tier === tier && !owned.has(augmentId),
  );
  if (available.length < 2) {
    throw new RangeError(`At least two unowned ${tier} augments are required for a draft.`);
  }
  return shuffleDeterministically(
    available,
    `${contestSeed}:augment-draft-v2:${tier}:${completedFloor}`,
  ).slice(0, 2);
}

export function applyResourceAugments(resources, augmentIds = []) {
  const owned = normalizedAugmentIds(augmentIds);
  return {
    ...resources,
    gold:
      resources.gold +
      (owned.has(AUGMENT_IDS.BONUS_GOLD) ? 30 : 0),
  };
}

export function discountedBuildingCost(cost, augmentIds = [], buildingId = null) {
  const owned = normalizedAugmentIds(augmentIds);
  const normalizedBuildingId = buildingId ?? BUILDING_IDS_BY_BASE_COST[cost];
  const discount = owned.has(AUGMENT_IDS.CHEAP_BUILDINGS)
    ? SCAVENGER_DISCOUNTS[normalizedBuildingId] ?? 0
    : 0;
  return Math.max(
    0,
    cost - discount,
  );
}

export function mapGenerationBonuses(augmentIds = []) {
  const owned = normalizedAugmentIds(augmentIds);
  return {
    portalPairs: owned.has(AUGMENT_IDS.GATES_OF_HADES) ? 1 : 0,
    trapDoors: owned.has(AUGMENT_IDS.TRAP_QUEEN) ? 3 : 0,
    slowTowers:
      (owned.has(AUGMENT_IDS.CRUSHING_COLD) ? 2 : 0) +
      (owned.has(AUGMENT_IDS.JUXTAPOSITION) ? 4 : 0),
    speedTowers: owned.has(AUGMENT_IDS.JUXTAPOSITION) ? 4 : 0,
  };
}

export function applyMapAugments(baseMap, augmentIds = []) {
  const owned = normalizedAugmentIds(augmentIds);
  const bonuses = mapGenerationBonuses(augmentIds);
  const hasGenerationBonus = Object.values(bonuses).some((count) => count > 0);
  const augmentedMap = hasGenerationBonus
    ? generateBaseMap({
        seed: baseMap.seed,
        width: baseMap.width,
        height: baseMap.height,
        mapShape: baseMap.mapShape,
        start: baseMap.start,
        goal: baseMap.goal,
        rockDensity: baseMap.rockDensity,
        endlessFeastCount: baseMap.endlessFeast ? 1 : 0,
        slowTowerCount: (baseMap.baseSlowTowers ?? []).length + bonuses.slowTowers,
        speedTowerCount: (baseMap.baseSpeedTowers ?? []).length + bonuses.speedTowers,
        portalCount: (baseMap.portalPair ?? []).length / 2 + bonuses.portalPairs,
        trapDoorCount: (baseMap.baseTrapDoors ?? []).length + bonuses.trapDoors,
      })
    : baseMap;

  if (!owned.has(AUGMENT_IDS.CORRUPT_SPEED)) return augmentedMap;

  const baseSlowTowers = [
    ...(augmentedMap.baseSlowTowers ?? []),
    ...(augmentedMap.baseSpeedTowers ?? []),
  ]
    .map((tower) => ({ x: tower.x, y: tower.y }))
    .sort((first, second) => first.y - second.y || first.x - second.x);
  return {
    ...augmentedMap,
    requestedSlowTowerCount: baseSlowTowers.length,
    baseSlowTowers,
    requestedSpeedTowerCount: 0,
    speedTowerSpawnChance: 0,
    speedTowerSpawnChances: null,
    baseSpeedTowers: [],
  };
}
