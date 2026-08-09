import test from "node:test";
import assert from "node:assert/strict";

import {
  CELL_TYPES,
  DEFAULT_ENDLESS_FEAST_SPAWN_CHANCE,
  DEFAULT_MAP_SHAPES,
  DEFAULT_SPEED_TOWER_SPAWN_CHANCE,
  MAP_SHAPES,
  PLACEMENT_FAILURES,
  buildRivalMaze,
  calculateRouteMetrics,
  calculateRunnerSimulation,
  cellKey,
  createCellGrid,
  createGameState,
  createSeededRng,
  findShortestPath,
  generateBaseMap,
  generateRoundResources,
  getRunnerPositionAtTime,
  listLegalPlacements,
  tryPlaceObstacle,
  tryPlaceObstacleGroup,
  tryRemoveGeneratedObject,
  tryRemoveObstacle,
  tryRemoveObstacleGroup,
} from "../src/game-engine.js";
import {
  addRoundScores,
  createCumulativeScores,
  normalizeRoundCount,
  rankCumulativeScores,
} from "../src/contest-scoring.js";
import { resolveSpectatedContestant } from "../src/spectator.js";
import {
  createChallengeUrl,
  deriveContestRoundSeed,
  normalizeChallengeSeed,
  parseChallengeTarget,
} from "../src/challenge.js";
import {
  AUGMENT_IDS,
  RUN_FLOORS,
  applyMapAugments,
  applyResourceAugments,
  discountedBuildingCost,
  draftAugmentChoices,
  floorConfig,
} from "../src/roguelike.js";

test("roguelike floors grow by 2x2 and grant 20 more build seconds", () => {
  assert.equal(RUN_FLOORS, 4);
  assert.deepEqual(
    Array.from({ length: RUN_FLOORS }, (_, index) => floorConfig(index + 1)),
    [
      { floorNumber: 1, width: 20, height: 15, buildDurationMs: 60_000 },
      { floorNumber: 2, width: 22, height: 17, buildDurationMs: 80_000 },
      { floorNumber: 3, width: 24, height: 19, buildDurationMs: 100_000 },
      { floorNumber: 4, width: 26, height: 21, buildDurationMs: 120_000 },
    ],
  );
});

test("roguelike augment drafts are deterministic, unique, and persistent", () => {
  const firstDraft = draftAugmentChoices("AUGMENT-RUN", 1);
  assert.deepEqual(firstDraft, draftAugmentChoices("AUGMENT-RUN", 1));
  assert.equal(firstDraft.length, 2);
  assert.equal(new Set(firstDraft).size, 2);

  const owned = [firstDraft[0]];
  const secondDraft = draftAugmentChoices("AUGMENT-RUN", 2, owned);
  assert(!secondDraft.includes(firstDraft[0]));
  assert.equal(
    applyResourceAugments(
      { gold: 90, tears: 1 },
      [AUGMENT_IDS.BONUS_GOLD],
    ).gold,
    140,
  );
  assert.equal(
    discountedBuildingCost(10, [AUGMENT_IDS.CHEAP_BUILDINGS]),
    8,
  );

  const converted = applyMapAugments(
    {
      baseSlowTowers: [{ x: 1, y: 1 }],
      baseSpeedTowers: [{ x: 3, y: 2 }],
      requestedSlowTowerCount: 1,
      requestedSpeedTowerCount: 1,
      speedTowerSpawnChance: 0.25,
    },
    [AUGMENT_IDS.CORRUPT_SPEED],
  );
  assert.deepEqual(converted.baseSpeedTowers, []);
  assert.deepEqual(converted.baseSlowTowers, [
    { x: 1, y: 1 },
    { x: 3, y: 2 },
  ]);
});

test("wide Lament fields also trigger from diagonal tiles", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ];
  const towers = [{ x: 2, y: 0, id: "diagonal-lament" }];
  const cardinalOnly = calculateRunnerSimulation(path, towers, {
    stepDurationMs: 1_000,
    turnPenaltyMs: 0,
  });
  const wideLament = calculateRunnerSimulation(path, towers, {
    stepDurationMs: 1_000,
    turnPenaltyMs: 0,
    slowTowerAffectsDiagonals: true,
  });
  assert.equal(cardinalOnly.slowApplications.length, 0);
  assert.equal(wideLament.slowApplications.length, 1);
  assert(wideLament.travelTimeMs > cardinalOnly.travelTimeMs);
});

test("challenge links deterministically define every round and validate targets", () => {
  assert.equal(normalizeChallengeSeed("  friend-42  "), "FRIEND-42");
  assert.equal(deriveContestRoundSeed("friend-42", 1), "FRIEND-42");
  assert.equal(
    deriveContestRoundSeed("friend-42", 2),
    deriveContestRoundSeed("FRIEND-42", 2),
  );
  assert.notEqual(
    deriveContestRoundSeed("friend-42", 2),
    deriveContestRoundSeed("friend-42", 3),
  );
  assert.equal(parseChallengeTarget("12345"), 12_345);
  assert.equal(parseChallengeTarget("not-a-score"), null);
  assert.equal(
    createChallengeUrl("https://example.com/game/?skipIntro=1#old", {
      contestSeed: "friend-42",
      rounds: 3,
      targetMs: 12_345,
    }),
    "https://example.com/game/?challenge=FRIEND-42&rounds=3&target=12345",
  );
  assert.throws(() => deriveContestRoundSeed("friend-42", 0), /positive integer/);
});

test("spectator selection switches rivals only while spectating is enabled", () => {
  const contestants = [
    { id: "player", isPlayer: true, state: { route: ["player"] } },
    { id: "bramble", state: { route: ["bramble"] } },
  ];
  assert.equal(
    resolveSpectatedContestant(contestants, "bramble", true).id,
    "bramble",
  );
  assert.equal(
    resolveSpectatedContestant(contestants, "bramble", false).id,
    "player",
  );
  assert.equal(
    resolveSpectatedContestant(contestants, "missing", true).id,
    "player",
  );
});

test("contest round counts are normalized to the supported range", () => {
  assert.equal(normalizeRoundCount(null), 3);
  assert.equal(normalizeRoundCount("5"), 5);
  assert.equal(normalizeRoundCount(0), 1);
  assert.equal(normalizeRoundCount(99), 20);
  assert.equal(normalizeRoundCount("not-a-number"), 3);
});

test("contest standings add round milliseconds cumulatively and preserve ties", () => {
  const contestants = [
    { id: "player", name: "You", scoreMs: 4_500 },
    { id: "rival-a", name: "Aster", scoreMs: 5_000 },
    { id: "rival-b", name: "Bramble", scoreMs: 4_500 },
  ];
  const empty = createCumulativeScores(contestants);
  const afterFirst = addRoundScores(empty, contestants);
  const afterSecond = addRoundScores(afterFirst, [
    { id: "player", scoreMs: 5_500 },
    { id: "rival-a", scoreMs: 4_000 },
    { id: "rival-b", scoreMs: 5_500 },
  ]);
  const ranking = rankCumulativeScores(contestants, afterSecond);

  assert.deepEqual(empty, { player: 0, "rival-a": 0, "rival-b": 0 });
  assert.deepEqual(afterFirst, { player: 4_500, "rival-a": 5_000, "rival-b": 4_500 });
  assert.deepEqual(afterSecond, { player: 10_000, "rival-a": 9_000, "rival-b": 10_000 });
  assert.deepEqual(
    ranking.map(({ id, totalScoreMs, rank }) => ({ id, totalScoreMs, rank })),
    [
      { id: "rival-b", totalScoreMs: 10_000, rank: 1 },
      { id: "player", totalScoreMs: 10_000, rank: 1 },
      { id: "rival-a", totalScoreMs: 9_000, rank: 3 },
    ],
  );
  assert.deepEqual(empty, { player: 0, "rival-a": 0, "rival-b": 0 });
});

test("seeded RNG repeats exactly for the same seed", () => {
  const first = createSeededRng("round-42");
  const second = createSeededRng("round-42");
  const different = createSeededRng("round-43");
  const firstSequence = Array.from({ length: 8 }, () => first());
  const secondSequence = Array.from({ length: 8 }, () => second());
  const differentSequence = Array.from({ length: 8 }, () => different());

  assert.deepEqual(firstSequence, secondSequence);
  assert.notDeepEqual(firstSequence, differentSequence);
  assert(firstSequence.every((value) => value >= 0 && value < 1));
});

test("round resources are deterministic inclusive integers within configured bounds", () => {
  assert.deepEqual(
    generateRoundResources("economy-round"),
    generateRoundResources("economy-round"),
  );
  const rounds = Array.from({ length: 200 }, (_, index) =>
    generateRoundResources(`economy-${index}`),
  );
  assert(
    rounds.every(
      ({ gold, tears }) =>
        Number.isInteger(gold) &&
        gold >= 80 &&
        gold <= 250 &&
        Number.isInteger(tears) &&
        tears >= 0 &&
        tears <= 2,
    ),
  );
  assert.deepEqual(
    generateRoundResources("fixed", {
      minGold: 123,
      maxGold: 123,
      minTears: 2,
      maxTears: 2,
    }),
    { gold: 123, tears: 2 },
  );
});

test("base maps are deterministic and always retain a route", () => {
  const first = generateBaseMap({
    seed: "shared-round-seed",
    width: 15,
    height: 11,
    rockDensity: 0.22,
  });
  const second = generateBaseMap({
    seed: "shared-round-seed",
    width: 15,
    height: 11,
    rockDensity: 0.22,
  });
  const other = generateBaseMap({
    seed: "another-seed",
    width: 15,
    height: 11,
    rockDensity: 0.22,
  });

  assert.deepEqual(first, second);
  assert.notDeepEqual(first.baseRocks, other.baseRocks);
  assert(findShortestPath(first));
  assert(!first.baseRocks.some((rock) => rock.x === first.start.x && rock.y === first.start.y));
  assert(!first.baseRocks.some((rock) => rock.x === first.goal.x && rock.y === first.goal.y));
});

test("seeded map silhouettes include rectangle, diamond, donut, and flower fields", () => {
  const generatedShapes = new Set(
    Array.from({ length: 256 }, (_, index) =>
      generateBaseMap({
        seed: `shape-roll-${index}`,
        width: 20,
        height: 15,
        rockDensity: 0,
        slowTowerCount: 0,
        speedTowerCount: 0,
      }).mapShape,
    ),
  );
  assert.deepEqual([...generatedShapes].sort(), [...DEFAULT_MAP_SHAPES].sort());

  for (const shape of Object.values(MAP_SHAPES)) {
    const map = generateBaseMap({
      seed: `forced-${shape}`,
      width: 20,
      height: 15,
      mapShape: shape,
      rockDensity: 0,
      slowTowerCount: 0,
      speedTowerCount: 0,
    });
    const replay = generateBaseMap({
      seed: `forced-${shape}`,
      width: 20,
      height: 15,
      mapShape: shape,
      rockDensity: 0,
      slowTowerCount: 0,
      speedTowerCount: 0,
    });
    const voidKeys = new Set(map.voidCells.map(cellKey));
    assert.equal(map.mapShape, shape);
    assert.deepEqual(map, replay);
    assert(findShortestPath(map));
    assert(!voidKeys.has(cellKey(map.start)));
    assert(!voidKeys.has(cellKey(map.goal)));
    assert.equal(shape === MAP_SHAPES.RECTANGLE, map.voidCells.length === 0);
  }

  const flower = generateBaseMap({
    seed: "forced-wider-flower",
    width: 20,
    height: 15,
    mapShape: MAP_SHAPES.FLOWER,
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
  });
  assert.equal(20 * 15 - flower.voidCells.length, 128);

  const donut = generateBaseMap({
    seed: "forced-donut-hole",
    width: 20,
    height: 15,
    mapShape: MAP_SHAPES.DONUT,
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
  });
  const donutState = createGameState({ baseMap: donut, startingGold: 100 });
  const center = { x: 10, y: 7 };
  assert(donut.voidCells.some((cell) => cellKey(cell) === cellKey(center)));
  assert.equal(createCellGrid(donutState)[center.y][center.x], CELL_TYPES.VOID);
  const outsidePlacement = tryPlaceObstacle(donutState, center);
  assert.equal(outsidePlacement.ok, false);
  assert.equal(outsidePlacement.reason, PLACEMENT_FAILURES.OUTSIDE_MAP);
  assert.equal(outsidePlacement.state.gold, 100);
});

test("base slow towers spawn deterministically, block cells, and preserve a route", () => {
  const options = {
    seed: "forced-map-towers",
    width: 12,
    height: 8,
    rockDensity: 0.2,
    slowTowerCount: 2,
  };
  const first = generateBaseMap(options);
  const second = generateBaseMap(options);

  assert.deepEqual(first, second);
  assert.equal(first.baseSlowTowers.length, 2);
  assert(findShortestPath(first));
  assert(
    first.baseSlowTowers.every(
      (tower) =>
        !first.baseRocks.some(
          (rock) => rock.x === tower.x && rock.y === tower.y,
        ) &&
        !(tower.x === first.start.x && tower.y === first.start.y) &&
        !(tower.x === first.goal.x && tower.y === first.goal.y),
    ),
  );

  const state = createGameState({ baseMap: first, startingGold: 100 });
  for (const tower of first.baseSlowTowers) {
    assert.equal(createCellGrid(state)[tower.y][tower.x], CELL_TYPES.SLOW_TOWER);
    assert(!state.route.some((cell) => cell.x === tower.x && cell.y === tower.y));
  }
});

test("slow tower count chances use a rock-independent deterministic RNG stream", () => {
  const noRocks = generateBaseMap({
    seed: "tower-count-stream",
    width: 12,
    height: 8,
    rockDensity: 0,
    slowTowerSpawnChances: [0, 1],
  });
  const manyRocks = generateBaseMap({
    seed: "tower-count-stream",
    width: 12,
    height: 8,
    rockDensity: 0.25,
    slowTowerSpawnChances: [0, 1],
  });
  const forcedTwoByChance = generateBaseMap({
    seed: "tower-count-two",
    width: 12,
    height: 8,
    rockDensity: 0,
    slowTowerSpawnChances: [0, 0, 1],
  });

  assert.equal(noRocks.requestedSlowTowerCount, 1);
  assert.equal(manyRocks.requestedSlowTowerCount, 1);
  assert.equal(noRocks.baseSlowTowers.length, 1);
  assert.equal(manyRocks.baseSlowTowers.length, 1);
  assert.equal(forcedTwoByChance.baseSlowTowers.length, 2);
});

test("speed towers use an independent deterministic 25% spawn roll", () => {
  assert.equal(DEFAULT_SPEED_TOWER_SPAWN_CHANCE, 0.25);
  const first = generateBaseMap({
    seed: "speed-count-stream",
    width: 12,
    height: 8,
    rockDensity: 0,
    slowTowerCount: 0,
  });
  const second = generateBaseMap({
    seed: "speed-count-stream",
    width: 12,
    height: 8,
    rockDensity: 0.25,
    slowTowerCount: 0,
  });
  assert.equal(first.speedTowerSpawnChance, 0.25);
  assert.equal(first.requestedSpeedTowerCount, second.requestedSpeedTowerCount);
  assert(first.requestedSpeedTowerCount === 0 || first.requestedSpeedTowerCount === 1);
});

test("a forced neutral speed tower blocks its cell and preserves the route", () => {
  const options = {
    seed: "forced-speed-tower",
    width: 12,
    height: 8,
    rockDensity: 0.2,
    slowTowerCount: 1,
    speedTowerCount: 1,
  };
  const first = generateBaseMap(options);
  const second = generateBaseMap(options);

  assert.deepEqual(first, second);
  assert.equal(first.baseSpeedTowers.length, 1);
  assert(findShortestPath(first));
  const [tower] = first.baseSpeedTowers;
  assert(!first.baseRocks.some((rock) => rock.x === tower.x && rock.y === tower.y));
  assert(!first.baseSlowTowers.some((slow) => slow.x === tower.x && slow.y === tower.y));
  assert(!findShortestPath(first).some((cell) => cell.x === tower.x && cell.y === tower.y));

  const state = createGameState({ baseMap: first, startingGold: 100 });
  assert.equal(createCellGrid(state)[tower.y][tower.x], CELL_TYPES.SPEED_TOWER);
  assert.throws(
    () => generateBaseMap({ ...options, speedTowerCount: 2 }),
    /either 0 or 1/,
  );
});

test("Endless Feast is a deterministic 20% mandatory checkpoint with an open side", () => {
  assert.equal(DEFAULT_ENDLESS_FEAST_SPAWN_CHANCE, 0.2);
  const options = {
    seed: "forced-endless-feast",
    width: 20,
    height: 15,
    mapShape: MAP_SHAPES.DONUT,
    rockDensity: 0.2,
    slowTowerCount: 1,
    speedTowerCount: 1,
    endlessFeastCount: 1,
  };
  const map = generateBaseMap(options);
  const replay = generateBaseMap(options);
  assert.deepEqual(map, replay);
  assert(map.endlessFeast);
  assert.equal(map.requestedEndlessFeastCount, 1);
  assert.equal(map.endlessFeastSpawnChance, null);

  const feastIndex = findShortestPath(map).findIndex(
    (cell) => cellKey(cell) === cellKey(map.endlessFeast),
  );
  assert(feastIndex > 0);
  const firstLeg = findShortestPath(map, {
    goal: map.endlessFeast,
    checkpoint: null,
  });
  const secondLeg = findShortestPath(map, {
    start: map.endlessFeast,
    checkpoint: null,
  });
  assert.deepEqual(findShortestPath(map), [...firstLeg, ...secondLeg.slice(1)]);

  const generatedObjects = [
    ...map.baseRocks,
    ...map.baseSlowTowers,
    ...map.baseSpeedTowers,
  ];
  assert(
    generatedObjects.every(
      (object) =>
        Math.abs(object.x - map.endlessFeast.x) +
          Math.abs(object.y - map.endlessFeast.y) >
        1,
    ),
  );

  const state = createGameState({ baseMap: map, startingGold: 100 });
  assert.equal(
    createCellGrid(state)[map.endlessFeast.y][map.endlessFeast.x],
    CELL_TYPES.ENDLESS_FEAST,
  );
  assert.equal(
    getRunnerPositionAtTime(state.runnerSimulation, 0).insatiablyHungry,
    true,
  );
  const feastArrival = state.runnerSimulation.segments.find(
    (segment) => segment.type === "move" && segment.toIndex === feastIndex,
  );
  assert(feastArrival);
  assert.equal(
    getRunnerPositionAtTime(
      state.runnerSimulation,
      Math.min(feastArrival.endMs, state.runnerSimulation.travelTimeMs),
    ).insatiablyHungry,
    false,
  );
  const protectedFeast = tryPlaceObstacle(state, map.endlessFeast);
  assert.equal(protectedFeast.reason, PLACEMENT_FAILURES.PROTECTED_CELL);
  assert.equal(state.gold, 100);

  const rolls = Array.from({ length: 400 }, (_, index) =>
    generateBaseMap({
      seed: `endless-feast-roll-${index}`,
      width: 20,
      height: 15,
      mapShape: MAP_SHAPES.RECTANGLE,
      rockDensity: 0,
      slowTowerCount: 0,
      speedTowerCount: 0,
    }),
  );
  const feastRounds = rolls.filter((round) => round.endlessFeast).length;
  assert(feastRounds >= 60 && feastRounds <= 100);
  assert(rolls.every((round) => round.endlessFeastSpawnChance === 0.2));
});

test("Endless Feast allows surrounding builds while one side remains open", () => {
  const state = createGameState({
    baseMap: {
      width: 7,
      height: 7,
      seed: "feast-open-side",
      start: { x: 0, y: 3 },
      goal: { x: 6, y: 3 },
      endlessFeast: { x: 3, y: 3 },
      baseRocks: [],
    },
    startingGold: 100,
  });
  const sides = [
    { x: 3, y: 2 },
    { x: 4, y: 3 },
    { x: 3, y: 4 },
    { x: 2, y: 3 },
  ];
  const surroundedOnThreeSides = tryPlaceObstacleGroup(state, {
    id: "three-feast-sides",
    type: "test-wall",
    cost: 10,
    cells: sides.slice(0, 3),
  });
  assert.equal(surroundedOnThreeSides.ok, true);
  assert.equal(surroundedOnThreeSides.state.gold, 90);
  assert(
    surroundedOnThreeSides.state.route.some(
      (cell) =>
        cell.x === state.endlessFeast.x && cell.y === state.endlessFeast.y,
    ),
  );

  const closesLastSide = tryPlaceObstacle(
    surroundedOnThreeSides.state,
    sides[3],
  );
  assert.equal(closesLastSide.ok, false);
  assert.equal(closesLastSide.reason, PLACEMENT_FAILURES.BLOCKS_PATH);
  assert.equal(closesLastSide.state.gold, 90);

  const closesAllSidesAtOnce = tryPlaceObstacleGroup(state, {
    id: "four-feast-sides",
    type: "test-wall",
    cost: 10,
    cells: sides,
  });
  assert.equal(closesAllSidesAtOnce.ok, false);
  assert.equal(closesAllSidesAtOnce.reason, PLACEMENT_FAILURES.BLOCKS_PATH);
  assert.equal(closesAllSidesAtOnce.state.gold, 100);
});

test("placements must preserve both legs of an Endless Feast route", () => {
  const playable = new Set(["0,1", "1,1", "2,1", "2,0", "3,1", "4,1"]);
  const voidCells = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      if (!playable.has(`${x},${y}`)) voidCells.push({ x, y });
    }
  }
  const state = createGameState({
    baseMap: {
      width: 5,
      height: 3,
      seed: "feast-corridor",
      start: { x: 0, y: 1 },
      goal: { x: 4, y: 1 },
      voidCells,
      endlessFeast: { x: 2, y: 0 },
      baseRocks: [],
    },
    startingGold: 20,
  });
  assert(state.route.some((cell) => cell.x === 2 && cell.y === 0));
  const blockedFirstLeg = tryPlaceObstacle(state, { x: 1, y: 1 });
  assert.equal(blockedFirstLeg.ok, false);
  assert.equal(blockedFirstLeg.reason, PLACEMENT_FAILURES.BLOCKS_PATH);
  assert.equal(blockedFirstLeg.state.gold, 20);
});

test("weighted pathfinding uses diagonals for the geometric shortest route", () => {
  const path = findShortestPath({
    width: 5,
    height: 3,
    start: { x: 0, y: 0 },
    goal: { x: 4, y: 2 },
    blocked: [],
  });

  assert(path);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path.at(-1), { x: 4, y: 2 });
  assert.equal(path.length - 1, 4);
  const metrics = calculateRouteMetrics(path, {
    stepDurationMs: 1_000,
    turnPenaltyMs: 0,
  });
  assert(Math.abs(metrics.distance - (2 + 2 * Math.SQRT2)) < 1e-12);
  assert.equal(metrics.travelTimeMs, 4_828);
  for (let index = 1; index < path.length; index += 1) {
    const deltaX = Math.abs(path[index].x - path[index - 1].x);
    const deltaY = Math.abs(path[index].y - path[index - 1].y);
    assert(deltaX <= 1 && deltaY <= 1 && deltaX + deltaY > 0);
  }
});

test("diagonal moves round one object but never squeeze between two objects", () => {
  const sealedCorner = {
    width: 2,
    height: 2,
    start: { x: 0, y: 0 },
    goal: { x: 1, y: 1 },
    blocked: [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  };
  assert.equal(findShortestPath(sealedCorner), null);

  const oneBlockedSide = findShortestPath({
    width: 3,
    height: 3,
    start: { x: 0, y: 0 },
    goal: { x: 1, y: 1 },
    blocked: [{ x: 1, y: 0 }],
  });
  assert(oneBlockedSide);
  assert.equal(oneBlockedSide.length, 2);
  assert.deepEqual(oneBlockedSide[1], { x: 1, y: 1 });
});

test("placement is immutable, charges gold, and rejects protected/occupied cells", () => {
  const initial = createGameState({
    seed: "placement",
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
  });
  const candidate = initial.route[1];
  const placed = tryPlaceObstacle(initial, candidate);

  assert.equal(placed.ok, true);
  assert.equal(initial.obstacles.length, 0);
  assert.equal(placed.state.obstacles.length, 1);
  assert.equal(placed.state.gold, initial.gold - initial.rules.obstacleCost);
  assert(placed.state.route);

  const occupied = tryPlaceObstacle(placed.state, candidate);
  assert.equal(occupied.ok, false);
  assert.equal(occupied.reason, PLACEMENT_FAILURES.OCCUPIED);

  const protectedResult = tryPlaceObstacle(initial, initial.start);
  assert.equal(protectedResult.ok, false);
  assert.equal(protectedResult.reason, PLACEMENT_FAILURES.PROTECTED_CELL);
  assert.strictEqual(protectedResult.state, initial);
});

test("placement that seals the only route is rejected without charging gold", () => {
  const state = createGameState({
    baseMap: {
      width: 3,
      height: 1,
      seed: "one-corridor",
      start: { x: 0, y: 0 },
      goal: { x: 2, y: 0 },
      baseRocks: [],
    },
    startingGold: 50,
    obstacleCost: 10,
  });
  const result = tryPlaceObstacle(state, { x: 1, y: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PLACEMENT_FAILURES.BLOCKS_PATH);
  assert.equal(result.state.gold, 50);
  assert.equal(result.state.obstacles.length, 0);
});

test("insufficient gold rejects an otherwise valid placement", () => {
  const state = createGameState({
    seed: "poor-player",
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
    startingGold: 5,
    obstacleCost: 10,
  });
  const result = tryPlaceObstacle(state, { x: 1, y: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PLACEMENT_FAILURES.INSUFFICIENT_GOLD);
  assert.strictEqual(result.state, state);
});

test("generated field objects can be removed for 8 gold without mutating the round map", () => {
  const initial = createGameState({
    baseMap: {
      width: 5,
      height: 3,
      seed: "demolition",
      start: { x: 0, y: 1 },
      goal: { x: 4, y: 1 },
      baseRocks: [{ x: 2, y: 1 }],
      baseSlowTowers: [{ x: 1, y: 0 }],
      baseSpeedTowers: [{ x: 3, y: 0 }],
    },
    startingGold: 24,
  });

  const rockRemoved = tryRemoveGeneratedObject(initial, { x: 2, y: 1 });
  assert.equal(rockRemoved.ok, true);
  assert.equal(rockRemoved.cost, 8);
  assert.equal(rockRemoved.removedObject.type, CELL_TYPES.ROCK);
  assert.equal(rockRemoved.state.gold, 16);
  assert.equal(rockRemoved.state.baseRocks.length, 0);
  assert.equal(initial.baseRocks.length, 1);
  assert(rockRemoved.state.route);

  const slowRemoved = tryRemoveGeneratedObject(rockRemoved.state, { x: 1, y: 0 });
  const speedRemoved = tryRemoveGeneratedObject(slowRemoved.state, { x: 3, y: 0 });
  assert.equal(slowRemoved.removedObject.type, CELL_TYPES.SLOW_TOWER);
  assert.equal(speedRemoved.removedObject.type, CELL_TYPES.SPEED_TOWER);
  assert.equal(speedRemoved.state.gold, 0);
  assert.equal(speedRemoved.state.baseSlowTowers.length, 0);
  assert.equal(speedRemoved.state.baseSpeedTowers.length, 0);
  assert.equal(speedRemoved.state.lastAction.type, "remove-generated-object");

  const missing = tryRemoveGeneratedObject(initial, { x: 4, y: 0 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, PLACEMENT_FAILURES.NO_GENERATED_OBJECT);

  const poorState = createGameState({
    baseMap: {
      width: 3,
      height: 2,
      seed: "poor-demolition",
      start: { x: 0, y: 0 },
      goal: { x: 2, y: 0 },
      baseRocks: [{ x: 1, y: 1 }],
    },
    startingGold: 7,
  });
  const unaffordable = tryRemoveGeneratedObject(poorState, { x: 1, y: 1 });
  assert.equal(unaffordable.ok, false);
  assert.equal(unaffordable.reason, PLACEMENT_FAILURES.INSUFFICIENT_GOLD);
  assert.strictEqual(unaffordable.state, poorState);
});

test("removing an obstacle applies the configured refund and recomputes score", () => {
  const initial = createGameState({
    seed: "refund",
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
    obstacleCost: 10,
    refundRate: 0.5,
  });
  const legal = listLegalPlacements(initial)[0];
  assert(legal);
  const placed = tryPlaceObstacle(initial, legal.cell);
  assert.equal(placed.ok, true);
  const removed = tryRemoveObstacle(placed.state, legal.cell);

  assert.equal(removed.ok, true);
  assert.equal(removed.refund, 5);
  assert.equal(removed.state.obstacles.length, 0);
  assert.equal(removed.state.gold, initial.gold - 5);
  assert.equal(removed.state.scoreMs, initial.scoreMs);
});

test("multi-cell groups are placed and removed atomically for one price", () => {
  const state = createGameState({
    seed: "group-placement",
    width: 7,
    height: 5,
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
    startingGold: 50,
  });
  const placement = {
    id: "fence-1",
    type: "fence",
    cost: 18,
    cells: [
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ],
  };
  const placed = tryPlaceObstacleGroup(state, placement);

  assert.equal(placed.ok, true);
  assert.equal(placed.state.gold, 32);
  assert.equal(placed.state.obstacles.length, 2);
  assert(placed.state.obstacles.every((obstacle) => obstacle.groupId === "fence-1"));
  assert(findShortestPath(placed.state));

  const removed = tryRemoveObstacleGroup(placed.state, "fence-1");
  assert.equal(removed.ok, true);
  assert.equal(removed.removedObstacles.length, 2);
  assert.equal(removed.refund, 9);
  assert.equal(removed.state.gold, 41);
  assert.equal(removed.state.obstacles.length, 0);
});

test("slow-tower groups charge Tears once and refund no more than was paid", () => {
  const state = createGameState({
    baseMap: {
      width: 7,
      height: 3,
      seed: "tear-groups",
      start: { x: 0, y: 1 },
      goal: { x: 6, y: 1 },
      baseRocks: [],
      baseSlowTowers: [],
    },
    startingGold: 20,
    startingTears: 2,
    tearRefundRate: 1,
    stepDurationMs: 1_000,
    turnPenaltyMs: 0,
  });
  const placed = tryPlaceObstacleGroup(state, {
    id: "lament-1",
    type: "slow-tower",
    cost: 0,
    tearCost: 2,
    cells: [
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ],
  });

  assert.equal(placed.ok, true);
  assert.equal(state.tears, 2);
  assert.equal(placed.state.tears, 0);
  assert(placed.state.obstacles.every((obstacle) => obstacle.groupTearCost === 2));
  assert(placed.state.scoreMs > state.scoreMs);
  assert.equal(
    placed.state.scoreMs,
    placed.state.runnerSimulation.travelTimeMs,
  );

  const removed = tryRemoveObstacleGroup(placed.state, "lament-1", {
    tearRefundAmount: 999,
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.tearRefund, 2);
  assert.equal(removed.state.tears, 2);
  assert.equal(removed.state.obstacles.length, 0);
  assert.equal(removed.state.scoreMs, state.scoreMs);

  const removedAgain = tryRemoveObstacleGroup(removed.state, "lament-1");
  assert.equal(removedAgain.ok, false);
  assert.equal(removedAgain.reason, PLACEMENT_FAILURES.NO_OBSTACLE);
  assert.equal(removedAgain.state.tears, 2);
});

test("invalid or unaffordable Tear costs reject a whole group atomically", () => {
  const state = createGameState({
    seed: "tear-rejection",
    width: 7,
    height: 5,
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
    startingGold: 20,
    startingTears: 0,
  });
  const proposal = {
    type: "slow-tower",
    cost: 0,
    tearCost: 1,
    cells: [{ x: 2, y: 0 }],
  };
  const unaffordable = tryPlaceObstacleGroup(state, proposal);
  const invalid = tryPlaceObstacleGroup(state, { ...proposal, tearCost: 0.5 });

  assert.equal(unaffordable.ok, false);
  assert.equal(unaffordable.reason, PLACEMENT_FAILURES.INSUFFICIENT_TEARS);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, PLACEMENT_FAILURES.INVALID_TEAR_COST);
  assert.strictEqual(unaffordable.state, state);
  assert.strictEqual(invalid.state, state);
  assert.equal(state.obstacles.length, 0);
  assert.equal(state.tears, 0);
  assert.equal(state.gold, 20);
});

test("a custom refund cannot exceed the recorded purchase price", () => {
  const state = createGameState({
    seed: "refund-cap",
    width: 7,
    height: 5,
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
    startingGold: 20,
  });
  const placed = tryPlaceObstacleGroup(state, {
    id: "crate-1",
    type: "crate",
    cost: 10,
    cells: [{ x: 3, y: 0 }],
  });
  assert.equal(placed.ok, true);

  const removed = tryRemoveObstacleGroup(placed.state, "crate-1", {
    refundAmount: 999,
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.refund, 10);
  assert.equal(removed.state.gold, 20);
  assert.equal(removed.state.lastAction.type, "remove-obstacle-group");
});

test("a group failure leaves every footprint cell and all gold untouched", () => {
  const state = createGameState({
    baseMap: {
      width: 4,
      height: 1,
      seed: "atomic-group",
      start: { x: 0, y: 0 },
      goal: { x: 3, y: 0 },
      baseRocks: [],
    },
    startingGold: 30,
  });
  const result = tryPlaceObstacleGroup(state, {
    type: "fence",
    cost: 18,
    cells: [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, PLACEMENT_FAILURES.BLOCKS_PATH);
  assert.strictEqual(result.state, state);
  assert.equal(state.gold, 30);
  assert.equal(state.obstacles.length, 0);
});

test("blank group IDs are rejected and single-column defaults remain playable", () => {
  const vertical = createGameState({
    seed: "vertical",
    width: 1,
    height: 5,
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
  });
  assert.deepEqual(vertical.start, { x: 0, y: 0 });
  assert.deepEqual(vertical.goal, { x: 0, y: 4 });
  assert(findShortestPath(vertical));

  const result = tryPlaceObstacleGroup(vertical, {
    id: "",
    cost: 1,
    cells: [{ x: 0, y: 2 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PLACEMENT_FAILURES.INVALID_GROUP);
  assert.strictEqual(result.state, vertical);
});

test("route timing counts both steps and direction changes", () => {
  const metrics = calculateRouteMetrics(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    { stepDurationMs: 100, turnPenaltyMs: 25 },
  );

  assert.deepEqual(metrics, {
    reachable: true,
    steps: 3,
    distance: 3,
    turns: 2,
    travelTimeMs: 350,
  });

  const diagonal = calculateRouteMetrics(
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
    { stepDurationMs: 1_000, turnPenaltyMs: 25 },
  );
  assert.equal(diagonal.steps, 2);
  assert.equal(diagonal.turns, 0);
  assert(Math.abs(diagonal.distance - 2 * Math.SQRT2) < 1e-12);
  assert.equal(diagonal.travelTimeMs, 2_828);

  assert.throws(
    () => calculateRouteMetrics([{ x: 0, y: 0 }, { x: 2, y: 1 }]),
    /cardinal or diagonal neighbours/,
  );
});

test("runner timing is unchanged when there are no slow towers", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ];
  const simulation = calculateRunnerSimulation(path, [], {
    stepDurationMs: 100,
    turnPenaltyMs: 25,
  });

  assert.equal(simulation.baseTravelTimeMs, 350);
  assert.equal(simulation.travelTimeMs, 350);
  assert.equal(simulation.slowApplications.length, 0);
  assert.equal(simulation.slowWindows.length, 0);
  assert.deepEqual(getRunnerPositionAtTime(simulation, 350), {
    x: 2,
    y: 1,
    angle: 0,
    pathIndex: 3,
    progress: 1,
    finished: true,
    slowed: false,
    spedUp: false,
    speedMultiplier: 1,
    segmentType: "finished",
  });
});

test("runner timing uses geometric distance for diagonal movement", () => {
  const simulation = calculateRunnerSimulation(
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [],
    { stepDurationMs: 1_000, turnPenaltyMs: 100 },
  );

  assert.equal(simulation.baseTravelTimeMs, 2_514);
  assert.equal(simulation.travelTimeMs, 2_514);
  assert(
    Math.abs(simulation.exactTravelTimeMs - (1_100 + 1_000 * Math.SQRT2)) <
      1e-9,
  );
  assert.equal(simulation.segments[0].type, "move");
  assert(Math.abs(simulation.segments[0].durationMs - 1_000 * Math.SQRT2) < 1e-9);
  // The UI clamps to the rounded score; it must still reach the finished state.
  assert.equal(
    getRunnerPositionAtTime(simulation, simulation.travelTimeMs).finished,
    true,
  );
});

test("a 50% slow lasts five seconds and expires accurately during an edge", () => {
  const path = Array.from({ length: 7 }, (_, x) => ({ x, y: 0 }));
  const simulation = calculateRunnerSimulation(
    path,
    [{ x: 0, y: 1, id: "opening-tower" }],
    { stepDurationMs: 1_000, turnPenaltyMs: 0 },
  );

  assert.equal(simulation.baseTravelTimeMs, 6_000);
  assert.equal(simulation.travelTimeMs, 8_500);
  assert.deepEqual(
    simulation.slowApplications.map(({ towerId, pathIndex, atMs, expiresAtMs }) => ({
      towerId,
      pathIndex,
      atMs,
      expiresAtMs,
    })),
    [
      {
        towerId: "opening-tower",
        pathIndex: 0,
        atMs: 0,
        expiresAtMs: 5_000,
      },
    ],
  );
  assert.deepEqual(simulation.slowWindows, [
    { startMs: 0, endMs: 5_000, towerIds: ["opening-tower"] },
  ]);
  const atExpiry = getRunnerPositionAtTime(simulation, 5_000);
  assert.equal(atExpiry.x, 2.5);
  assert.equal(atExpiry.y, 0);
  assert.equal(atExpiry.slowed, false);
});

test("tower triggers are cardinal on entry and do not fire at the finished goal", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ];
  const simulation = calculateRunnerSimulation(
    path,
    [
      // Diagonal from the initial cell, then cardinal on entry to path[1].
      { x: 1, y: 1, id: "middle" },
      // Cardinal only to the goal; the run is already complete on that entry.
      { x: 2, y: 1, id: "goal-side" },
    ],
    { stepDurationMs: 1_000, turnPenaltyMs: 0 },
  );

  assert.equal(simulation.travelTimeMs, 3_000);
  assert.deepEqual(
    simulation.slowApplications.map(({ towerId, pathIndex, atMs }) => ({
      towerId,
      pathIndex,
      atMs,
    })),
    [{ towerId: "middle", pathIndex: 1, atMs: 1_000 }],
  );
});

test("tower cooldown prevents early repeats and allows a later retrigger", () => {
  const simulation = calculateRunnerSimulation(
    [
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ],
    [{ x: 1, y: 1, id: "loop-tower" }],
    { stepDurationMs: 1_000, turnPenaltyMs: 0 },
  );

  assert.deepEqual(
    simulation.slowApplications.map(({ pathIndex, atMs }) => ({ pathIndex, atMs })),
    [
      { pathIndex: 0, atMs: 0 },
      { pathIndex: 4, atMs: 6_500 },
    ],
  );
  assert.equal(simulation.travelTimeMs, 8_500);
});

test("a second tower refreshes rather than stacking the shared slow", () => {
  const path = Array.from({ length: 7 }, (_, x) => ({ x, y: 0 }));
  const simulation = calculateRunnerSimulation(
    path,
    [
      { x: 0, y: 1, id: "first" },
      { x: 2, y: 1, id: "second" },
    ],
    { stepDurationMs: 1_000, turnPenaltyMs: 0 },
  );

  assert.deepEqual(
    simulation.slowApplications.map(({ towerId, atMs, expiresAtMs, refreshed }) => ({
      towerId,
      atMs,
      expiresAtMs,
      refreshed,
    })),
    [
      { towerId: "first", atMs: 0, expiresAtMs: 5_000, refreshed: false },
      { towerId: "second", atMs: 4_000, expiresAtMs: 9_000, refreshed: true },
    ],
  );
  assert.equal(simulation.slowWindows.length, 1);
  assert.equal(simulation.slowWindows[0].endMs, 9_000);
  assert.equal(simulation.travelTimeMs, 10_500);
});

test("a speed tower grants 2x speed for five seconds with mid-edge expiry", () => {
  const path = Array.from({ length: 12 }, (_, x) => ({ x, y: 0 }));
  const simulation = calculateRunnerSimulation(path, [], {
    stepDurationMs: 1_200,
    turnPenaltyMs: 0,
    speedTowers: [{ x: 0, y: 1, id: "opening-speed" }],
  });

  assert.equal(simulation.baseTravelTimeMs, 13_200);
  assert.equal(simulation.travelTimeMs, 8_200);
  assert.deepEqual(
    simulation.speedApplications.map(
      ({ towerId, pathIndex, atMs, expiresAtMs, refreshed }) => ({
        towerId,
        pathIndex,
        atMs,
        expiresAtMs,
        refreshed,
      }),
    ),
    [
      {
        towerId: "opening-speed",
        pathIndex: 0,
        atMs: 0,
        expiresAtMs: 5_000,
        refreshed: false,
      },
    ],
  );
  assert.deepEqual(simulation.speedWindows, [
    { startMs: 0, endMs: 5_000, towerIds: ["opening-speed"] },
  ]);
  const atExpiry = getRunnerPositionAtTime(simulation, 5_000);
  assert(Math.abs(atExpiry.x - 25 / 3) < 1e-9);
  assert.equal(atExpiry.y, 0);
  assert.equal(atExpiry.spedUp, false);
  assert.equal(atExpiry.speedMultiplier, 1);
});

test("speed tower triggers are cardinal on entry, refresh without cooldown, and skip goal", () => {
  const adjacency = calculateRunnerSimulation(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
    [],
    {
      stepDurationMs: 1_000,
      turnPenaltyMs: 0,
      speedTowers: [
        { x: 1, y: 1, id: "middle" },
        { x: 2, y: 1, id: "goal-side" },
      ],
    },
  );
  assert.equal(adjacency.travelTimeMs, 1_500);
  assert.deepEqual(
    adjacency.speedApplications.map(({ towerId, pathIndex, atMs }) => ({
      towerId,
      pathIndex,
      atMs,
    })),
    [{ towerId: "middle", pathIndex: 1, atMs: 1_000 }],
  );

  const refresh = calculateRunnerSimulation(
    [
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ],
    [],
    {
      stepDurationMs: 1_000,
      turnPenaltyMs: 0,
      speedTowers: [{ x: 1, y: 1, id: "refreshing-speed" }],
    },
  );
  assert.deepEqual(
    refresh.speedApplications.map(({ pathIndex, atMs, refreshed }) => ({
      pathIndex,
      atMs,
      refreshed,
    })),
    [
      { pathIndex: 0, atMs: 0, refreshed: false },
      { pathIndex: 2, atMs: 1_000, refreshed: true },
      { pathIndex: 4, atMs: 2_000, refreshed: true },
    ],
  );
});

test("slow and speed effects multiply and remain visible when they cancel", () => {
  const path = Array.from({ length: 7 }, (_, x) => ({ x, y: 1 }));
  const simulation = calculateRunnerSimulation(
    path,
    [{ x: 0, y: 0, id: "slow" }],
    {
      stepDurationMs: 1_000,
      turnPenaltyMs: 0,
      speedTowers: [{ x: 0, y: 2, id: "speed" }],
    },
  );

  assert.equal(simulation.travelTimeMs, 6_000);
  const duringBoth = getRunnerPositionAtTime(simulation, 2_000);
  assert.equal(duringBoth.slowed, true);
  assert.equal(duringBoth.spedUp, true);
  assert.equal(duringBoth.speedMultiplier, 1);
  assert.equal(duringBoth.x, 2);
});

test("base speed towers feed authoritative state scoring and custom rules", () => {
  const state = createGameState({
    baseMap: {
      width: 13,
      height: 2,
      seed: "state-speed",
      start: { x: 0, y: 0 },
      goal: { x: 12, y: 0 },
      baseRocks: [],
      baseSlowTowers: [],
      baseSpeedTowers: [{ x: 0, y: 1 }],
    },
    stepDurationMs: 1_000,
    turnPenaltyMs: 0,
    speedSpeedMultiplier: 4,
    speedDurationMs: 2_000,
  });

  assert.equal(state.rules.speedSpeedMultiplier, 4);
  assert.equal(state.rules.speedDurationMs, 2_000);
  assert.equal(state.runnerSimulation.speedApplications.length, 1);
  assert.equal(state.routeMetrics.baseTravelTimeMs, 12_000);
  assert.equal(state.scoreMs, 6_000);
  assert.equal(state.scoreMs, state.runnerSimulation.travelTimeMs);
});

test("pathfinding rejects grids above the supported allocation limit", () => {
  assert.throws(
    () =>
      findShortestPath({
        width: 1_000_001,
        height: 1,
        start: { x: 0, y: 0 },
        goal: { x: 1_000_000, y: 0 },
        blocked: [],
      }),
    /1,000,000 cells/,
  );
});

test("cell grid is row-major and can include the current route overlay", () => {
  const state = createGameState({
    seed: "grid",
    width: 5,
    height: 3,
    rockDensity: 0,
    slowTowerCount: 0,
    speedTowerCount: 0,
  });
  const grid = createCellGrid(state, { includeRoute: true });

  assert.equal(grid.length, 3);
  assert.equal(grid[0].length, 5);
  assert.equal(grid[state.start.y][state.start.x], CELL_TYPES.START);
  assert.equal(grid[state.goal.y][state.goal.x], CELL_TYPES.GOAL);
  assert(grid.flat().includes(CELL_TYPES.ROUTE));
});

test("the rival builder is deterministic, solvent, and preserves a route", () => {
  const initial = createGameState({
    seed: "rival-round",
    width: 9,
    height: 7,
    rockDensity: 0.1,
    slowTowerCount: 0,
    speedTowerCount: 0,
    startingGold: 40,
    obstacleCost: 10,
  });
  const first = buildRivalMaze(initial, { seed: "rival-one", maxPlacements: 4 });
  const second = buildRivalMaze(initial, { seed: "rival-one", maxPlacements: 4 });

  assert.deepEqual(first, second);
  assert.equal(first.moves.length, 4);
  assert.equal(first.state.gold, 0);
  assert(findShortestPath(first.state));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(first.state)));
});
