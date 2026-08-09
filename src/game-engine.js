/**
 * Deterministic, UI-agnostic rules for a Mazing Contest round.
 *
 * The public state is deliberately made only from JSON-compatible values. The
 * helpers in this module never mutate a state supplied by the caller.
 */

export const CELL_TYPES = Object.freeze({
  VOID: "void",
  EMPTY: "empty",
  ROCK: "rock",
  SLOW_TOWER: "slow-tower",
  SPEED_TOWER: "speed-tower",
  ENDLESS_FEAST: "endless-feast",
  OBSTACLE: "obstacle",
  START: "start",
  GOAL: "goal",
  ROUTE: "route",
});

export const PLACEMENT_FAILURES = Object.freeze({
  INVALID_CELL: "invalid-cell",
  OUT_OF_BOUNDS: "out-of-bounds",
  PROTECTED_CELL: "protected-cell",
  OCCUPIED: "occupied",
  INSUFFICIENT_GOLD: "insufficient-gold",
  INSUFFICIENT_TEARS: "insufficient-tears",
  BLOCKS_PATH: "blocks-path",
  INVALID_COST: "invalid-cost",
  INVALID_TEAR_COST: "invalid-tear-cost",
  INVALID_GROUP: "invalid-group",
  DUPLICATE_CELL: "duplicate-cell",
  DUPLICATE_GROUP_ID: "duplicate-group-id",
  NO_OBSTACLE: "no-obstacle",
  NO_GENERATED_OBJECT: "no-generated-object",
  OUTSIDE_MAP: "outside-map",
});

export const DEFAULT_GENERATED_OBJECT_REMOVAL_COST = 8;
export const DEFAULT_ENDLESS_FEAST_SPAWN_CHANCE = 0.2;

export const MAP_SHAPES = Object.freeze({
  RECTANGLE: "rectangle",
  DIAMOND: "diamond",
  DONUT: "donut",
  FLOWER: "flower",
});

export const DEFAULT_MAP_SHAPES = Object.freeze(Object.values(MAP_SHAPES));

export const DEFAULT_SLOW_TOWER_SPAWN_CHANCES = Object.freeze([
  0.58,
  0.36,
  0.06,
]);

export const DEFAULT_SPEED_TOWER_SPAWN_CHANCE = 0.25;

export const DEFAULT_GAME_CONFIG = Object.freeze({
  width: 20,
  height: 15,
  rockDensity: 0.14,
  startingGold: 100,
  startingTears: 0,
  obstacleCost: 10,
  refundRate: 0.5,
  tearRefundRate: 1,
  stepDurationMs: 280,
  turnPenaltyMs: 85,
  slowSpeedMultiplier: 0.5,
  slowDurationMs: 5_000,
  slowTowerCooldownMs: 5_000,
  slowTowerSpawnChances: DEFAULT_SLOW_TOWER_SPAWN_CHANCES,
  speedSpeedMultiplier: 2,
  speedDurationMs: 5_000,
  speedTowerSpawnChance: DEFAULT_SPEED_TOWER_SPAWN_CHANCE,
  endlessFeastSpawnChance: DEFAULT_ENDLESS_FEAST_SPAWN_CHANCE,
});

const CARDINAL_DIRECTIONS = Object.freeze([
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 0, y: 1 }),
  Object.freeze({ x: -1, y: 0 }),
  Object.freeze({ x: 0, y: -1 }),
]);

const DIAGONAL_DIRECTIONS = Object.freeze([
  Object.freeze({ x: 1, y: 1 }),
  Object.freeze({ x: -1, y: 1 }),
  Object.freeze({ x: -1, y: -1 }),
  Object.freeze({ x: 1, y: -1 }),
]);

const EIGHT_WAY_DIRECTIONS = Object.freeze([
  ...CARDINAL_DIRECTIONS.map((direction) =>
    Object.freeze({ ...direction, cost: 1 }),
  ),
  ...DIAGONAL_DIRECTIONS.map((direction) =>
    Object.freeze({ ...direction, cost: Math.SQRT2 }),
  ),
]);

function canonicalSeed(seed) {
  return String(seed ?? "mazing-contest");
}

/** FNV-1a hash, followed by an avalanche, to turn any seed into a uint32. */
export function hashSeed(seed) {
  const input = canonicalSeed(seed);
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Returns a deterministic Mulberry32 random function in the same shape as
 * Math.random (inclusive of 0, exclusive of 1).
 */
export function createSeededRng(seed) {
  let state = hashSeed(seed);

  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generates the inclusive per-round economy from a domain-separated seed. */
export function generateRoundResources(seed, options = {}) {
  const minGold = options.minGold ?? 80;
  const maxGold = options.maxGold ?? 250;
  const minTears = options.minTears ?? 0;
  const maxTears = options.maxTears ?? 2;
  for (const [minimum, maximum, name] of [
    [minGold, maxGold, "gold"],
    [minTears, maxTears, "tears"],
  ]) {
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      minimum < 0 ||
      maximum < minimum
    ) {
      throw new RangeError(
        `${name} resource bounds must be non-negative safe integers with max >= min.`,
      );
    }
  }

  const random = createSeededRng(`${canonicalSeed(seed)}:round-resources-v1`);
  const inclusiveInteger = (minimum, maximum) =>
    minimum + Math.floor(random() * (maximum - minimum + 1));
  return {
    gold: inclusiveInteger(minGold, maxGold),
    tears: inclusiveInteger(minTears, maxTears),
  };
}

export function shuffleDeterministically(values, seedOrRng) {
  const shuffled = [...values];
  const random =
    typeof seedOrRng === "function"
      ? seedOrRng
      : createSeededRng(seedOrRng);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

export function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

function cloneCell(cell) {
  return { x: cell.x, y: cell.y };
}

function cellsEqual(first, second) {
  return first.x === second.x && first.y === second.y;
}

function isIntegerCell(cell) {
  return (
    cell !== null &&
    typeof cell === "object" &&
    Number.isInteger(cell.x) &&
    Number.isInteger(cell.y)
  );
}

export function isInsideGrid(cell, width, height) {
  return (
    isIntegerCell(cell) &&
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.x < width &&
    cell.y < height
  );
}

function compareCells(first, second) {
  return first.y - second.y || first.x - second.x;
}

function assertDimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height < 2 ||
    width * height > 1_000_000
  ) {
    throw new RangeError("The grid must contain between 2 and 1,000,000 cells.");
  }
}

function assertEndpoint(cell, name, width, height) {
  if (!isInsideGrid(cell, width, height)) {
    throw new RangeError(`${name} must be an integer cell inside the grid.`);
  }
}

function addBlockedValues(target, values) {
  if (!values) return;

  for (const value of values) {
    if (typeof value === "string") {
      target.add(value);
    } else if (isIntegerCell(value)) {
      target.add(cellKey(value));
    }
  }
}

function blockedSetFor(board, override) {
  const blocked = new Set();
  addBlockedValues(blocked, board.voidCells);

  if (override !== undefined) {
    addBlockedValues(blocked, override);
    return blocked;
  }

  addBlockedValues(blocked, board.blocked);
  addBlockedValues(blocked, board.baseRocks);
  addBlockedValues(blocked, board.baseSlowTowers);
  addBlockedValues(blocked, board.baseSpeedTowers);
  addBlockedValues(blocked, board.obstacles);
  return blocked;
}

function hasOpenEndlessFeastSide(board) {
  if (!board.endlessFeast) return true;
  const blocked = blockedSetFor(board);
  return CARDINAL_DIRECTIONS.some((direction) => {
    const neighbor = {
      x: board.endlessFeast.x + direction.x,
      y: board.endlessFeast.y + direction.y,
    };
    return (
      isInsideGrid(neighbor, board.width, board.height) &&
      !blocked.has(cellKey(neighbor))
    );
  });
}

/**
 * Finds a deterministic shortest path over cardinal and diagonal neighbours.
 * Cardinal edges cost 1 and diagonal edges cost sqrt(2). A diagonal move is
 * legal unless both cells beside the corner are blocked. This lets a runner
 * round one isolated object diagonally, but prevents squeezing through the gap
 * between two diagonally touching obstacles. It accepts
 * either a game state/base map, or a small board descriptor:
 * { width, height, start, goal, blocked }.
 *
 * Returns an array including start and goal, or null when no route exists.
 */
export function findShortestPath(board, options = {}) {
  if (!board || typeof board !== "object") {
    throw new TypeError("A board descriptor is required.");
  }

  const { width, height } = board;
  assertDimensions(width, height);
  const start = options.start ?? board.start;
  const goal = options.goal ?? board.goal;
  assertEndpoint(start, "start", width, height);
  assertEndpoint(goal, "goal", width, height);

  const checkpoint = Object.prototype.hasOwnProperty.call(options, "checkpoint")
    ? options.checkpoint
    : board.endlessFeast ?? null;
  if (checkpoint !== null) {
    assertEndpoint(checkpoint, "checkpoint", width, height);
    const firstLeg = findShortestPath(board, {
      ...options,
      start,
      goal: checkpoint,
      checkpoint: null,
    });
    if (!firstLeg) return null;
    const secondLeg = findShortestPath(board, {
      ...options,
      start: checkpoint,
      goal,
      checkpoint: null,
    });
    if (!secondLeg) return null;
    return [...firstLeg, ...secondLeg.slice(1)];
  }

  const blocked = blockedSetFor(board, options.blocked);
  if (blocked.has(cellKey(start)) || blocked.has(cellKey(goal))) return null;

  const totalCells = width * height;
  const parents = new Int32Array(totalCells);
  parents.fill(-2);
  const distances = new Float64Array(totalCells);
  distances.fill(Number.POSITIVE_INFINITY);
  const settled = new Uint8Array(totalCells);
  const startIndex = start.y * width + start.x;
  const goalIndex = goal.y * width + goal.x;

  parents[startIndex] = -1;
  distances[startIndex] = 0;

  // A small binary min-heap keeps pathfinding fast on the supported million-
  // cell upper bound. Cell index is the stable tie-breaker, so repeated runs
  // produce byte-for-byte identical routes.
  const heap = [];
  const heapLess = (first, second) =>
    first.distance < second.distance ||
    (first.distance === second.distance && first.index < second.index);
  const heapPush = (entry) => {
    let index = heap.length;
    heap.push(entry);
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (!heapLess(heap[index], heap[parentIndex])) break;
      [heap[index], heap[parentIndex]] = [heap[parentIndex], heap[index]];
      index = parentIndex;
    }
  };
  const heapPop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heapLess(heap[left], heap[smallest])) {
          smallest = left;
        }
        if (right < heap.length && heapLess(heap[right], heap[smallest])) {
          smallest = right;
        }
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    }
    return first;
  };
  heapPush({ index: startIndex, distance: 0 });

  while (heap.length > 0) {
    const current = heapPop();
    const currentIndex = current.index;
    if (settled[currentIndex]) continue;
    if (current.distance !== distances[currentIndex]) continue;
    settled[currentIndex] = 1;
    if (currentIndex === goalIndex) break;
    const currentX = currentIndex % width;
    const currentY = Math.floor(currentIndex / width);

    for (const direction of EIGHT_WAY_DIRECTIONS) {
      const nextX = currentX + direction.x;
      const nextY = currentY + direction.y;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
        continue;
      }

      const nextIndex = nextY * width + nextX;
      if (settled[nextIndex]) continue;
      if (blocked.has(`${nextX},${nextY}`)) continue;

      if (direction.x !== 0 && direction.y !== 0) {
        const horizontalSide = `${currentX + direction.x},${currentY}`;
        const verticalSide = `${currentX},${currentY + direction.y}`;
        if (blocked.has(horizontalSide) && blocked.has(verticalSide)) continue;
      }

      const candidateDistance = distances[currentIndex] + direction.cost;
      if (candidateDistance >= distances[nextIndex]) continue;
      distances[nextIndex] = candidateDistance;
      parents[nextIndex] = currentIndex;
      heapPush({ index: nextIndex, distance: candidateDistance });
    }
  }

  if (parents[goalIndex] === -2) return null;

  const reversedPath = [];
  let pathIndex = goalIndex;
  while (pathIndex !== -1) {
    reversedPath.push({
      x: pathIndex % width,
      y: Math.floor(pathIndex / width),
    });
    pathIndex = parents[pathIndex];
  }

  return reversedPath.reverse();
}

export function hasPath(board, options = {}) {
  return findShortestPath(board, options) !== null;
}

/**
 * Converts a path into the round score. Cardinal edges have distance 1 and
 * diagonal edges have distance sqrt(2); every unit of distance costs
 * stepDurationMs. Direction changes add turnPenaltyMs.
 */
export function calculateRouteMetrics(path, options = {}) {
  const stepDurationMs =
    options.stepDurationMs ?? DEFAULT_GAME_CONFIG.stepDurationMs;
  const turnPenaltyMs =
    options.turnPenaltyMs ?? DEFAULT_GAME_CONFIG.turnPenaltyMs;

  if (!Number.isFinite(stepDurationMs) || stepDurationMs < 0) {
    throw new RangeError("stepDurationMs must be a non-negative number.");
  }
  if (!Number.isFinite(turnPenaltyMs) || turnPenaltyMs < 0) {
    throw new RangeError("turnPenaltyMs must be a non-negative number.");
  }

  if (path === null) {
    return {
      reachable: false,
      steps: null,
      distance: null,
      turns: null,
      travelTimeMs: null,
    };
  }
  if (!Array.isArray(path) || path.length === 0) {
    throw new TypeError("path must be a non-empty cell array or null.");
  }

  for (let index = 0; index < path.length; index += 1) {
    if (!isIntegerCell(path[index])) {
      throw new TypeError("Every path entry must be an integer cell.");
    }
    if (index > 0) {
      const deltaX = Math.abs(path[index].x - path[index - 1].x);
      const deltaY = Math.abs(path[index].y - path[index - 1].y);
      if (deltaX > 1 || deltaY > 1 || (deltaX === 0 && deltaY === 0)) {
        throw new RangeError(
          "Consecutive path cells must be cardinal or diagonal neighbours.",
        );
      }
    }
  }

  let turns = 0;
  let previousDirection = null;
  for (let index = 1; index < path.length; index += 1) {
    const direction = {
      x: path[index].x - path[index - 1].x,
      y: path[index].y - path[index - 1].y,
    };
    if (
      previousDirection &&
      (direction.x !== previousDirection.x || direction.y !== previousDirection.y)
    ) {
      turns += 1;
    }
    previousDirection = direction;
  }

  const steps = Math.max(0, path.length - 1);
  let distance = 0;
  for (let index = 1; index < path.length; index += 1) {
    distance += Math.hypot(
      path[index].x - path[index - 1].x,
      path[index].y - path[index - 1].y,
    );
  }
  return {
    reachable: true,
    steps,
    distance,
    turns,
    travelTimeMs: Math.round(
      distance * stepDurationMs + turns * turnPenaltyMs,
    ),
  };
}

function normalizedEffectTowers(towers, effectName, defaultId) {
  if (towers === undefined || towers === null) return [];
  if (!Array.isArray(towers)) {
    throw new TypeError(`${effectName}Towers must be an array of cells.`);
  }

  const seen = new Set();
  return towers
    .map((tower, index) => {
      if (!isIntegerCell(tower)) {
        throw new TypeError(
          `Every ${effectName.toLowerCase()} tower must occupy an integer cell.`,
        );
      }
      const key = cellKey(tower);
      if (seen.has(key)) {
        throw new RangeError(
          `${effectName} towers must occupy unique cells.`,
        );
      }
      seen.add(key);
      return {
        x: tower.x,
        y: tower.y,
        id: String(tower.id ?? `${tower.groupId ?? defaultId}:${key}:${index}`),
      };
    })
    .sort(
      (first, second) =>
        compareCells(first, second) || first.id.localeCompare(second.id),
    );
}

function normalizedSlowTowers(slowTowers) {
  return normalizedEffectTowers(slowTowers, "Slow", "slow-tower");
}

function normalizedSpeedTowers(speedTowers) {
  return normalizedEffectTowers(speedTowers, "Speed", "speed-tower");
}

function simulationRules(options) {
  const rules = {
    stepDurationMs:
      options.stepDurationMs ?? DEFAULT_GAME_CONFIG.stepDurationMs,
    turnPenaltyMs:
      options.turnPenaltyMs ?? DEFAULT_GAME_CONFIG.turnPenaltyMs,
    slowSpeedMultiplier:
      options.slowSpeedMultiplier ?? DEFAULT_GAME_CONFIG.slowSpeedMultiplier,
    slowDurationMs:
      options.slowDurationMs ?? DEFAULT_GAME_CONFIG.slowDurationMs,
    slowTowerCooldownMs:
      options.slowTowerCooldownMs ?? DEFAULT_GAME_CONFIG.slowTowerCooldownMs,
    speedSpeedMultiplier:
      options.speedSpeedMultiplier ?? DEFAULT_GAME_CONFIG.speedSpeedMultiplier,
    speedDurationMs:
      options.speedDurationMs ?? DEFAULT_GAME_CONFIG.speedDurationMs,
  };

  calculateRouteMetrics([{ x: 0, y: 0 }], rules);
  if (
    !Number.isFinite(rules.slowSpeedMultiplier) ||
    rules.slowSpeedMultiplier <= 0 ||
    rules.slowSpeedMultiplier > 1
  ) {
    throw new RangeError("slowSpeedMultiplier must be greater than 0 and at most 1.");
  }
  if (!Number.isFinite(rules.slowDurationMs) || rules.slowDurationMs < 0) {
    throw new RangeError("slowDurationMs must be a non-negative number.");
  }
  if (
    !Number.isFinite(rules.slowTowerCooldownMs) ||
    rules.slowTowerCooldownMs < 0
  ) {
    throw new RangeError("slowTowerCooldownMs must be a non-negative number.");
  }
  if (
    !Number.isFinite(rules.speedSpeedMultiplier) ||
    rules.speedSpeedMultiplier < 1
  ) {
    throw new RangeError("speedSpeedMultiplier must be at least 1.");
  }
  if (!Number.isFinite(rules.speedDurationMs) || rules.speedDurationMs < 0) {
    throw new RangeError("speedDurationMs must be a non-negative number.");
  }
  return rules;
}

/**
 * Produces an authoritative, deterministic runner timeline. Slow and speed
 * towers apply when the runner arrives on a cardinally adjacent cell
 * (including the initial cell at t=0, but excluding the goal where the run is
 * over). Effects of the same kind refresh rather than stack. Slow and speed
 * multiply, so the defaults of 0.5x and 2x cancel while both are active.
 *
 * `slowTowers` remains the second argument for backwards compatibility;
 * neutral speed towers are supplied as `options.speedTowers`.
 */
export function calculateRunnerSimulation(path, slowTowers = [], options = {}) {
  const baseMetrics = calculateRouteMetrics(path, options);
  const towers = normalizedSlowTowers(slowTowers);
  const speedTowers = normalizedSpeedTowers(options.speedTowers ?? []);
  const endlessFeast = options.endlessFeast ? cloneCell(options.endlessFeast) : null;
  const rules = simulationRules(options);

  if (path === null) {
    return {
      reachable: false,
      rules: { ...rules },
      path: null,
      endlessFeast,
      feastPathIndex: -1,
      slowTowers: towers,
      speedTowers,
      segments: [],
      slowApplications: [],
      slowWindows: [],
      speedApplications: [],
      speedWindows: [],
      baseTravelTimeMs: null,
      exactBaseTravelTimeMs: null,
      exactTravelTimeMs: null,
      travelTimeMs: null,
    };
  }

  const copiedPath = path.map(cloneCell);
  const feastPathIndex = endlessFeast
    ? copiedPath.findIndex((cell) => cellsEqual(cell, endlessFeast))
    : -1;
  const segments = [];
  const slowApplications = [];
  const slowWindows = [];
  const speedApplications = [];
  const speedWindows = [];
  const nextReadyAtByTower = new Map(towers.map((tower) => [tower.id, 0]));
  let elapsedMs = 0;
  let slowUntilMs = 0;
  let speedUntilMs = 0;
  const epsilon = 1e-9;

  const appendSegment = (segment) => {
    segments.push({
      ...segment,
      durationMs: segment.endMs - segment.startMs,
    });
  };

  const recordWindow = (windows, untilMs, towerId) => {
    const currentWindow = windows.at(-1);
    if (currentWindow && elapsedMs <= currentWindow.endMs + epsilon) {
      currentWindow.endMs = Math.max(currentWindow.endMs, untilMs);
      currentWindow.towerIds.push(towerId);
    } else {
      windows.push({
        startMs: elapsedMs,
        endMs: untilMs,
        towerIds: [towerId],
      });
    }
  };

  const triggerTowersAt = (pathIndex) => {
    // A goal-side trigger cannot affect this run and should not create a
    // post-finish debuff window in animation data.
    if (pathIndex >= copiedPath.length - 1) return;
    const enteredCell = copiedPath[pathIndex];
    for (const tower of rules.slowDurationMs === 0 ? [] : towers) {
      const distance =
        Math.abs(tower.x - enteredCell.x) + Math.abs(tower.y - enteredCell.y);
      if (distance !== 1) continue;
      const nextReadyAtMs = nextReadyAtByTower.get(tower.id);
      if (elapsedMs + epsilon < nextReadyAtMs) continue;

      const priorSlowUntilMs = slowUntilMs;
      const expiresAtMs = elapsedMs + rules.slowDurationMs;
      slowUntilMs = Math.max(slowUntilMs, expiresAtMs);
      nextReadyAtByTower.set(
        tower.id,
        elapsedMs + rules.slowTowerCooldownMs,
      );
      const application = {
        towerId: tower.id,
        tower: { x: tower.x, y: tower.y },
        cell: cloneCell(enteredCell),
        pathIndex,
        atMs: elapsedMs,
        expiresAtMs: slowUntilMs,
        refreshed: priorSlowUntilMs > elapsedMs,
      };
      slowApplications.push(application);
      recordWindow(slowWindows, slowUntilMs, tower.id);
    }

    if (rules.speedDurationMs === 0) return;
    for (const tower of speedTowers) {
      const distance =
        Math.abs(tower.x - enteredCell.x) + Math.abs(tower.y - enteredCell.y);
      if (distance !== 1) continue;

      const priorSpeedUntilMs = speedUntilMs;
      const expiresAtMs = elapsedMs + rules.speedDurationMs;
      speedUntilMs = Math.max(speedUntilMs, expiresAtMs);
      speedApplications.push({
        towerId: tower.id,
        tower: { x: tower.x, y: tower.y },
        cell: cloneCell(enteredCell),
        pathIndex,
        atMs: elapsedMs,
        expiresAtMs: speedUntilMs,
        refreshed: priorSpeedUntilMs > elapsedMs,
      });
      recordWindow(speedWindows, speedUntilMs, tower.id);
    }
  };

  const statusAtCurrentTime = () => {
    const slowed = elapsedMs + epsilon < slowUntilMs;
    const spedUp = elapsedMs + epsilon < speedUntilMs;
    return {
      slowed,
      spedUp,
      speedMultiplier:
        (slowed ? rules.slowSpeedMultiplier : 1) *
        (spedUp ? rules.speedSpeedMultiplier : 1),
      nextChangeMs: Math.min(
        slowed ? slowUntilMs : Number.POSITIVE_INFINITY,
        spedUp ? speedUntilMs : Number.POSITIVE_INFINITY,
      ),
    };
  };

  const appendTurn = (durationMs, cell, pathIndex, direction) => {
    let remainingMs = durationMs;
    while (remainingMs > epsilon) {
      const status = statusAtCurrentTime();
      const untilStatusChange = Math.max(0, status.nextChangeMs - elapsedMs);
      const partMs = Math.min(remainingMs, untilStatusChange);
      if (partMs <= epsilon) {
        elapsedMs = status.nextChangeMs;
        continue;
      }
      const startMs = elapsedMs;
      elapsedMs += partMs;
      remainingMs -= partMs;
      appendSegment({
        type: "turn",
        pathIndex,
        cell: cloneCell(cell),
        direction: { ...direction },
        startMs,
        endMs: elapsedMs,
        slowed: status.slowed,
        spedUp: status.spedUp,
        speedMultiplier: status.speedMultiplier,
      });
    }
  };

  const appendMove = (from, to, fromIndex) => {
    const edgeDistance = Math.hypot(to.x - from.x, to.y - from.y);
    const baseEdgeDurationMs = rules.stepDurationMs * edgeDistance;
    if (baseEdgeDurationMs === 0) {
      const status = statusAtCurrentTime();
      appendSegment({
        type: "move",
        from: cloneCell(from),
        to: cloneCell(to),
        fromIndex,
        toIndex: fromIndex + 1,
        progressStart: 0,
        progressEnd: 1,
        startMs: elapsedMs,
        endMs: elapsedMs,
        distance: edgeDistance,
        slowed: status.slowed,
        spedUp: status.spedUp,
        speedMultiplier: status.speedMultiplier,
      });
      return;
    }

    let progress = 0;
    while (progress < 1 - epsilon) {
      const status = statusAtCurrentTime();
      const timeToFinishMs =
        ((1 - progress) * baseEdgeDurationMs) / status.speedMultiplier;
      const untilStatusChange = Math.max(0, status.nextChangeMs - elapsedMs);
      const partMs = Math.min(timeToFinishMs, untilStatusChange);
      if (partMs <= epsilon) {
        elapsedMs = status.nextChangeMs;
        continue;
      }

      const progressStart = progress;
      const startMs = elapsedMs;
      progress = Math.min(
        1,
        progress + (partMs * status.speedMultiplier) / baseEdgeDurationMs,
      );
      elapsedMs += partMs;
      appendSegment({
        type: "move",
        from: cloneCell(from),
        to: cloneCell(to),
        fromIndex,
        toIndex: fromIndex + 1,
        progressStart,
        progressEnd: progress,
        startMs,
        endMs: elapsedMs,
        distance: edgeDistance * (progress - progressStart),
        slowed: status.slowed,
        spedUp: status.spedUp,
        speedMultiplier: status.speedMultiplier,
      });
    }
  };

  triggerTowersAt(0);
  let previousDirection = null;
  for (let index = 1; index < copiedPath.length; index += 1) {
    const from = copiedPath[index - 1];
    const to = copiedPath[index];
    const direction = { x: to.x - from.x, y: to.y - from.y };
    if (
      previousDirection &&
      (direction.x !== previousDirection.x || direction.y !== previousDirection.y)
    ) {
      appendTurn(rules.turnPenaltyMs, from, index - 1, direction);
    }
    appendMove(from, to, index - 1);
    triggerTowersAt(index);
    previousDirection = direction;
  }

  return {
    reachable: true,
    rules: { ...rules },
    path: copiedPath,
    endlessFeast,
    feastPathIndex,
    slowTowers: towers,
    speedTowers,
    segments,
    slowApplications,
    slowWindows,
    speedApplications,
    speedWindows,
    baseTravelTimeMs: baseMetrics.travelTimeMs,
    exactBaseTravelTimeMs:
      baseMetrics.distance * rules.stepDurationMs +
      baseMetrics.turns * rules.turnPenaltyMs,
    exactTravelTimeMs: elapsedMs,
    travelTimeMs: Math.round(elapsedMs),
  };
}

/** Returns an interpolated runner position from a simulation timeline. */
export function getRunnerPositionAtTime(simulation, elapsedMs) {
  if (!simulation || typeof simulation !== "object") {
    throw new TypeError("A runner simulation is required.");
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("elapsedMs must be a non-negative number.");
  }
  if (!simulation.reachable || simulation.path === null) return null;

  const path = simulation.path;
  const slowed = simulation.slowWindows.some(
    (window) => elapsedMs >= window.startMs && elapsedMs < window.endMs,
  );
  const spedUp = (simulation.speedWindows ?? []).some(
    (window) => elapsedMs >= window.startMs && elapsedMs < window.endMs,
  );
  const hungerStatus = (pathIndex) =>
    simulation.endlessFeast && simulation.feastPathIndex > 0
      ? { insatiablyHungry: pathIndex < simulation.feastPathIndex }
      : {};
  const currentSpeedMultiplier =
    (slowed
      ? simulation.rules?.slowSpeedMultiplier ??
        DEFAULT_GAME_CONFIG.slowSpeedMultiplier
      : 1) *
    (spedUp
      ? simulation.rules?.speedSpeedMultiplier ??
        DEFAULT_GAME_CONFIG.speedSpeedMultiplier
      : 1);
  // Scores and the UI clock are integer milliseconds. Use the earlier of the
  // exact and rounded endpoints so a clock clamped to travelTimeMs can always
  // display the runner as finished when fractional diagonal timing rounds down.
  const finishAtMs = Math.min(
    simulation.exactTravelTimeMs ?? Number.POSITIVE_INFINITY,
    simulation.travelTimeMs ?? Number.POSITIVE_INFINITY,
  );
  if (path.length === 1 || elapsedMs >= finishAtMs) {
    return {
      ...cloneCell(path.at(-1)),
      angle: 0,
      pathIndex: path.length - 1,
      progress: 1,
      finished: true,
      slowed: false,
      spedUp: false,
      ...hungerStatus(path.length - 1),
      speedMultiplier: 1,
      segmentType: "finished",
    };
  }

  for (const segment of simulation.segments) {
    if (
      elapsedMs > segment.endMs ||
      (elapsedMs === segment.endMs && segment.endMs > segment.startMs)
    ) {
      continue;
    }
    if (segment.type === "turn") {
      return {
        ...cloneCell(segment.cell),
        angle: Math.atan2(segment.direction.y, segment.direction.x),
        pathIndex: segment.pathIndex,
        progress: 0,
        finished: false,
        slowed,
        spedUp,
        ...hungerStatus(segment.pathIndex),
        speedMultiplier: currentSpeedMultiplier,
        segmentType: "turn",
      };
    }
    const durationMs = segment.endMs - segment.startMs;
    const localAmount =
      durationMs === 0
        ? 1
        : Math.max(0, Math.min(1, (elapsedMs - segment.startMs) / durationMs));
    const progress =
      segment.progressStart +
      (segment.progressEnd - segment.progressStart) * localAmount;
    return {
      x: segment.from.x + (segment.to.x - segment.from.x) * progress,
      y: segment.from.y + (segment.to.y - segment.from.y) * progress,
      angle: Math.atan2(
        segment.to.y - segment.from.y,
        segment.to.x - segment.from.x,
      ),
      pathIndex: segment.fromIndex,
      progress,
      finished: false,
      slowed,
      spedUp,
      ...hungerStatus(segment.fromIndex),
      speedMultiplier: currentSpeedMultiplier,
      segmentType: "move",
    };
  }

  return {
    ...cloneCell(path[0]),
    angle: 0,
    pathIndex: 0,
    progress: 0,
    finished: false,
    slowed,
    spedUp,
    ...hungerStatus(0),
    speedMultiplier: currentSpeedMultiplier,
    segmentType: "waiting",
  };
}

function shapeFitsDimensions(shape, width, height) {
  if (shape === MAP_SHAPES.RECTANGLE) return true;
  if (shape === MAP_SHAPES.DIAMOND) return width >= 3 && height >= 3;
  return width >= 7 && height >= 7;
}

function resolveMapShape(options, seed, width, height) {
  const forcedShape = options.mapShape ?? options.shape;
  if (forcedShape !== undefined) {
    if (!DEFAULT_MAP_SHAPES.includes(forcedShape)) {
      throw new RangeError(`Unsupported map shape: ${forcedShape}.`);
    }
    if (!shapeFitsDimensions(forcedShape, width, height)) {
      throw new RangeError(`${forcedShape} does not fit a ${width}x${height} grid.`);
    }
    return forcedShape;
  }

  const requestedShapes = options.mapShapes ?? DEFAULT_MAP_SHAPES;
  if (!Array.isArray(requestedShapes) || requestedShapes.length === 0) {
    throw new TypeError("mapShapes must be a non-empty array.");
  }
  const shapes = [...new Set(requestedShapes)];
  for (const shape of shapes) {
    if (!DEFAULT_MAP_SHAPES.includes(shape)) {
      throw new RangeError(`Unsupported map shape: ${shape}.`);
    }
  }
  const compatible = shapes.filter((shape) =>
    shapeFitsDimensions(shape, width, height),
  );
  if (compatible.length === 0) {
    throw new RangeError(`None of the requested map shapes fit a ${width}x${height} grid.`);
  }
  const random = createSeededRng(`${seed}:map-shape-v1`);
  return compatible[Math.floor(random() * compatible.length)];
}

function cellBelongsToShape(cell, width, height, shape) {
  if (shape === MAP_SHAPES.RECTANGLE) return true;
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const radiusX = Math.max(0.5, (width - 1) / 2);
  const radiusY = Math.max(0.5, (height - 1) / 2);
  const dx = (cell.x - centerX) / radiusX;
  const dy = (cell.y - centerY) / radiusY;

  if (shape === MAP_SHAPES.DIAMOND) {
    return Math.abs(dx) + Math.abs(dy) <= 1.02;
  }

  const distanceSquared = dx * dx + dy * dy;
  if (shape === MAP_SHAPES.DONUT) {
    const innerX = dx / 0.36;
    const innerY = dy / 0.38;
    const insideHole = innerX * innerX + innerY * innerY < 1;
    return distanceSquared <= 1.02 && !insideHole;
  }

  const angle = Math.atan2(dy, dx);
  const distance = Math.sqrt(distanceSquared);
  const petalRadius = 0.73 + 0.29 * Math.cos(4 * angle);
  return distance <= petalRadius;
}

function shapeLayout(width, height, shape) {
  const playableCells = [];
  const voidCells = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = { x, y };
      (cellBelongsToShape(cell, width, height, shape)
        ? playableCells
        : voidCells).push(cell);
    }
  }
  if (playableCells.length < 2) {
    throw new RangeError(`${shape} does not leave enough playable cells.`);
  }

  const middleRow = (height - 1) / 2;
  const byMiddle = (first, second) =>
    Math.abs(first.y - middleRow) - Math.abs(second.y - middleRow) ||
    first.y - second.y;
  if (width === 1) {
    const vertical = [...playableCells].sort(compareCells);
    return {
      playableCells,
      voidCells,
      start: cloneCell(vertical[0]),
      goal: cloneCell(vertical.at(-1)),
    };
  }
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  for (const cell of playableCells) {
    minimumX = Math.min(minimumX, cell.x);
    maximumX = Math.max(maximumX, cell.x);
  }
  const start = playableCells.filter((cell) => cell.x === minimumX).sort(byMiddle)[0];
  const goal = playableCells.filter((cell) => cell.x === maximumX).sort(byMiddle)[0];
  return {
    playableCells,
    voidCells,
    start: cloneCell(start),
    goal: cloneCell(goal),
  };
}

function resolveSlowTowerSpawnCount(options, seed) {
  const forcedCount = options.slowTowerCount ?? options.forcedSlowTowerCount;
  if (forcedCount !== undefined) {
    if (!Number.isSafeInteger(forcedCount) || forcedCount < 0) {
      throw new RangeError("slowTowerCount must be a non-negative safe integer.");
    }
    return { count: forcedCount, forced: true, chances: null };
  }

  const chances = options.slowTowerSpawnChances ??
    DEFAULT_GAME_CONFIG.slowTowerSpawnChances;
  if (!Array.isArray(chances) || chances.length === 0) {
    throw new TypeError("slowTowerSpawnChances must be a non-empty array.");
  }
  let total = 0;
  const copiedChances = chances.map((chance) => {
    if (!Number.isFinite(chance) || chance < 0) {
      throw new RangeError(
        "Every slowTowerSpawnChances entry must be a non-negative number.",
      );
    }
    total += chance;
    return chance;
  });
  if (total <= 0) {
    throw new RangeError("slowTowerSpawnChances must contain a positive chance.");
  }

  const roll = createSeededRng(`${seed}:base-slow-tower-count`)() * total;
  let cumulative = 0;
  for (let count = 0; count < copiedChances.length; count += 1) {
    cumulative += copiedChances[count];
    if (roll < cumulative) {
      return { count, forced: false, chances: copiedChances };
    }
  }
  return {
    count: copiedChances.length - 1,
    forced: false,
    chances: copiedChances,
  };
}

function resolveSpeedTowerSpawnCount(options, seed) {
  const forcedCount = options.speedTowerCount ?? options.forcedSpeedTowerCount;
  if (forcedCount !== undefined) {
    if (!Number.isSafeInteger(forcedCount) || forcedCount < 0 || forcedCount > 1) {
      throw new RangeError("speedTowerCount must be either 0 or 1.");
    }
    return { count: forcedCount, forced: true, chance: null };
  }

  const chance =
    options.speedTowerSpawnChance ?? DEFAULT_GAME_CONFIG.speedTowerSpawnChance;
  if (!Number.isFinite(chance) || chance < 0 || chance > 1) {
    throw new RangeError("speedTowerSpawnChance must be between 0 and 1.");
  }
  const roll = createSeededRng(`${seed}:base-speed-tower-count`)();
  return { count: roll < chance ? 1 : 0, forced: false, chance };
}

function resolveEndlessFeastSpawnCount(options, seed) {
  const forcedCount = options.endlessFeastCount ?? options.forcedEndlessFeastCount;
  if (forcedCount !== undefined) {
    if (!Number.isSafeInteger(forcedCount) || forcedCount < 0 || forcedCount > 1) {
      throw new RangeError("endlessFeastCount must be either 0 or 1.");
    }
    return { count: forcedCount, forced: true, chance: null };
  }

  const chance = options.endlessFeastSpawnChance ??
    DEFAULT_GAME_CONFIG.endlessFeastSpawnChance;
  if (!Number.isFinite(chance) || chance < 0 || chance > 1) {
    throw new RangeError("endlessFeastSpawnChance must be between 0 and 1.");
  }
  const roll = createSeededRng(`${seed}:endless-feast-count-v1`)();
  return { count: roll < chance ? 1 : 0, forced: false, chance };
}

/**
 * Builds deterministic base rocks and occasional slow/speed towers. A
 * candidate is retained only if pathfinding confirms the map still has a
 * route, so every seed is playable. Every feature has a domain-separated RNG
 * stream; the speed-tower roll is therefore an independent 25% by default.
 */
export function generateBaseMap(options = {}) {
  const width = options.width ?? DEFAULT_GAME_CONFIG.width;
  const height = options.height ?? DEFAULT_GAME_CONFIG.height;
  assertDimensions(width, height);

  const seed = canonicalSeed(options.seed);
  const mapShape = resolveMapShape(options, seed, width, height);
  const layout = shapeLayout(width, height, mapShape);
  const start = cloneCell(options.start ?? layout.start);
  const goal = cloneCell(options.goal ?? layout.goal);
  assertEndpoint(start, "start", width, height);
  assertEndpoint(goal, "goal", width, height);
  if (cellsEqual(start, goal)) {
    throw new RangeError("start and goal must be different cells.");
  }
  const voidKeys = new Set(layout.voidCells.map(cellKey));
  if (voidKeys.has(cellKey(start)) || voidKeys.has(cellKey(goal))) {
    throw new RangeError("start and goal must be playable cells in the map shape.");
  }
  if (!hasPath({ width, height, start, goal, voidCells: layout.voidCells })) {
    throw new RangeError(`${mapShape} does not provide a route between its endpoints.`);
  }

  const rockDensity = options.rockDensity ?? DEFAULT_GAME_CONFIG.rockDensity;
  if (!Number.isFinite(rockDensity) || rockDensity < 0 || rockDensity > 1) {
    throw new RangeError("rockDensity must be between 0 and 1.");
  }

  const allCandidates = layout.playableCells.filter(
    (cell) => !cellsEqual(cell, start) && !cellsEqual(cell, goal),
  );

  const endlessFeastSpawn = resolveEndlessFeastSpawnCount(options, seed);
  let endlessFeast = null;
  if (endlessFeastSpawn.count === 1) {
    const playableKeys = new Set(layout.playableCells.map(cellKey));
    const feastCandidates = shuffleDeterministically(
      allCandidates.filter((cell) => {
        const cardinalClearance = CARDINAL_DIRECTIONS.filter((direction) =>
          playableKeys.has(`${cell.x + direction.x},${cell.y + direction.y}`),
        ).length;
        const distanceFromStart = Math.abs(cell.x - start.x) + Math.abs(cell.y - start.y);
        const distanceFromGoal = Math.abs(cell.x - goal.x) + Math.abs(cell.y - goal.y);
        return cardinalClearance >= 3 && distanceFromStart >= 3 && distanceFromGoal >= 3;
      }),
      `${seed}:endless-feast-cell-v1`,
    );
    for (const candidate of feastCandidates) {
      if (hasPath({
        width,
        height,
        start,
        goal,
        voidCells: layout.voidCells,
        endlessFeast: candidate,
      })) {
        endlessFeast = cloneCell(candidate);
        break;
      }
    }
    if (endlessFeastSpawn.forced && !endlessFeast) {
      throw new RangeError("Unable to place Endless Feast in an open, reachable clearing.");
    }
  }

  const feastClearingKeys = new Set();
  if (endlessFeast) {
    feastClearingKeys.add(cellKey(endlessFeast));
    for (const direction of CARDINAL_DIRECTIONS) {
      const neighbor = {
        x: endlessFeast.x + direction.x,
        y: endlessFeast.y + direction.y,
      };
      if (!voidKeys.has(cellKey(neighbor)) && isInsideGrid(neighbor, width, height)) {
        feastClearingKeys.add(cellKey(neighbor));
      }
    }
  }
  const candidates = allCandidates.filter(
    (cell) => !feastClearingKeys.has(cellKey(cell)),
  );

  const shuffled = shuffleDeterministically(candidates, `${seed}:base-rocks`);
  const requestedRockCount = Math.min(
    shuffled.length,
    Math.round(layout.playableCells.length * rockDensity),
  );
  const blocked = new Set();

  for (const candidate of shuffled) {
    if (blocked.size >= requestedRockCount) break;
    const key = cellKey(candidate);
    blocked.add(key);
    const stillReachable = hasPath({
      width,
      height,
      start,
      goal,
      voidCells: layout.voidCells,
      endlessFeast,
      blocked,
    });
    if (!stillReachable) blocked.delete(key);
  }

  const baseRocks = [...blocked]
    .map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    })
    .sort(compareCells);

  const slowTowerSpawn = resolveSlowTowerSpawnCount(options, seed);
  const towerCandidates = shuffleDeterministically(
    candidates.filter((cell) => !blocked.has(cellKey(cell))),
    `${seed}:base-slow-tower-cells`,
  );
  const baseSlowTowers = [];
  for (const candidate of towerCandidates) {
    if (baseSlowTowers.length >= slowTowerSpawn.count) break;
    const key = cellKey(candidate);
    blocked.add(key);
    if (hasPath({
      width,
      height,
      start,
      goal,
      voidCells: layout.voidCells,
      endlessFeast,
      blocked,
    })) {
      baseSlowTowers.push(cloneCell(candidate));
    } else {
      blocked.delete(key);
    }
  }
  baseSlowTowers.sort(compareCells);
  if (slowTowerSpawn.forced && baseSlowTowers.length !== slowTowerSpawn.count) {
    throw new RangeError(
      `Unable to place ${slowTowerSpawn.count} slow towers while preserving a route.`,
    );
  }

  const speedTowerSpawn = resolveSpeedTowerSpawnCount(options, seed);
  const speedTowerCandidates = shuffleDeterministically(
    candidates.filter((cell) => !blocked.has(cellKey(cell))),
    `${seed}:base-speed-tower-cells`,
  );
  const baseSpeedTowers = [];
  for (const candidate of speedTowerCandidates) {
    if (baseSpeedTowers.length >= speedTowerSpawn.count) break;
    const key = cellKey(candidate);
    blocked.add(key);
    if (hasPath({
      width,
      height,
      start,
      goal,
      voidCells: layout.voidCells,
      endlessFeast,
      blocked,
    })) {
      baseSpeedTowers.push(cloneCell(candidate));
    } else {
      blocked.delete(key);
    }
  }
  baseSpeedTowers.sort(compareCells);
  if (speedTowerSpawn.forced && baseSpeedTowers.length !== speedTowerSpawn.count) {
    throw new RangeError(
      `Unable to place ${speedTowerSpawn.count} speed towers while preserving a route.`,
    );
  }

  return {
    width,
    height,
    seed,
    mapShape,
    start,
    goal,
    voidCells: layout.voidCells.map(cloneCell),
    requestedEndlessFeastCount: endlessFeastSpawn.count,
    endlessFeastSpawnChance: endlessFeastSpawn.chance,
    endlessFeast,
    rockDensity,
    requestedRockCount,
    baseRocks,
    requestedSlowTowerCount: slowTowerSpawn.count,
    slowTowerSpawnChances: slowTowerSpawn.chances,
    baseSlowTowers,
    requestedSpeedTowerCount: speedTowerSpawn.count,
    speedTowerSpawnChance: speedTowerSpawn.chance,
    baseSpeedTowers,
  };
}

function cloneBaseMap(baseMap) {
  const width = baseMap.width;
  const height = baseMap.height;
  assertDimensions(width, height);
  const start = cloneCell(baseMap.start);
  const goal = cloneCell(baseMap.goal);
  assertEndpoint(start, "start", width, height);
  assertEndpoint(goal, "goal", width, height);
  if (cellsEqual(start, goal)) {
    throw new RangeError("start and goal must be different cells.");
  }

  const mapShape = baseMap.mapShape ??
    ((baseMap.voidCells?.length ?? 0) > 0 ? "custom" : MAP_SHAPES.RECTANGLE);
  if (mapShape !== "custom" && !DEFAULT_MAP_SHAPES.includes(mapShape)) {
    throw new RangeError(`Unsupported map shape: ${mapShape}.`);
  }
  const voidSeen = new Set();
  const voidCells = (baseMap.voidCells ?? []).map((cell) => {
    if (!isInsideGrid(cell, width, height)) {
      throw new RangeError("Every void cell must be inside the grid.");
    }
    if (cellsEqual(cell, start) || cellsEqual(cell, goal)) {
      throw new RangeError("Start and goal must be playable cells.");
    }
    const key = cellKey(cell);
    if (voidSeen.has(key)) throw new RangeError("Void cells must be unique.");
    voidSeen.add(key);
    return cloneCell(cell);
  });
  voidCells.sort(compareCells);

  const endlessFeast = baseMap.endlessFeast === null || baseMap.endlessFeast === undefined
    ? null
    : cloneCell(baseMap.endlessFeast);
  if (endlessFeast) {
    if (!isInsideGrid(endlessFeast, width, height)) {
      throw new RangeError("Endless Feast must be inside the grid.");
    }
    if (cellsEqual(endlessFeast, start) || cellsEqual(endlessFeast, goal)) {
      throw new RangeError("Endless Feast cannot occupy start or goal.");
    }
    if (voidSeen.has(cellKey(endlessFeast))) {
      throw new RangeError("Endless Feast must occupy a playable cell.");
    }
  }
  const occupiesEndlessFeast = (cell) =>
    endlessFeast !== null && cellsEqual(endlessFeast, cell);

  const seen = new Set();
  const baseRocks = (baseMap.baseRocks ?? []).map((rock) => {
    if (!isInsideGrid(rock, width, height)) {
      throw new RangeError("Every base rock must be inside the grid.");
    }
    if (cellsEqual(rock, start) || cellsEqual(rock, goal)) {
      throw new RangeError("A base rock cannot occupy start or goal.");
    }
    const key = cellKey(rock);
    if (voidSeen.has(key)) throw new RangeError("A base rock must occupy a playable cell.");
    if (occupiesEndlessFeast(rock)) {
      throw new RangeError("A base rock cannot occupy Endless Feast.");
    }
    if (seen.has(key)) throw new RangeError("Base rocks must be unique.");
    seen.add(key);
    return cloneCell(rock);
  });
  baseRocks.sort(compareCells);

  const baseSlowTowers = (baseMap.baseSlowTowers ?? []).map((tower) => {
    if (!isInsideGrid(tower, width, height)) {
      throw new RangeError("Every base slow tower must be inside the grid.");
    }
    if (cellsEqual(tower, start) || cellsEqual(tower, goal)) {
      throw new RangeError("A base slow tower cannot occupy start or goal.");
    }
    const key = cellKey(tower);
    if (voidSeen.has(key)) {
      throw new RangeError("A base slow tower must occupy a playable cell.");
    }
    if (occupiesEndlessFeast(tower)) {
      throw new RangeError("A base slow tower cannot occupy Endless Feast.");
    }
    if (seen.has(key)) {
      throw new RangeError("Base rocks and slow towers must occupy unique cells.");
    }
    seen.add(key);
    return cloneCell(tower);
  });
  baseSlowTowers.sort(compareCells);

  const baseSpeedTowers = (baseMap.baseSpeedTowers ?? []).map((tower) => {
    if (!isInsideGrid(tower, width, height)) {
      throw new RangeError("Every base speed tower must be inside the grid.");
    }
    if (cellsEqual(tower, start) || cellsEqual(tower, goal)) {
      throw new RangeError("A base speed tower cannot occupy start or goal.");
    }
    const key = cellKey(tower);
    if (voidSeen.has(key)) {
      throw new RangeError("A base speed tower must occupy a playable cell.");
    }
    if (occupiesEndlessFeast(tower)) {
      throw new RangeError("A base speed tower cannot occupy Endless Feast.");
    }
    if (seen.has(key)) {
      throw new RangeError(
        "Base rocks, slow towers, and speed towers must occupy unique cells.",
      );
    }
    seen.add(key);
    return cloneCell(tower);
  });
  baseSpeedTowers.sort(compareCells);
  if (baseSpeedTowers.length > 1) {
    throw new RangeError("A base map can contain at most one speed tower.");
  }

  const slowTowerSpawnChances = baseMap.slowTowerSpawnChances ?? null;
  if (
    slowTowerSpawnChances !== null &&
    (!Array.isArray(slowTowerSpawnChances) ||
      slowTowerSpawnChances.some(
        (chance) => !Number.isFinite(chance) || chance < 0,
      ))
  ) {
    throw new RangeError(
      "slowTowerSpawnChances must be null or an array of non-negative numbers.",
    );
  }

  const speedTowerSpawnChance = baseMap.speedTowerSpawnChance ?? null;
  if (
    speedTowerSpawnChance !== null &&
    (!Number.isFinite(speedTowerSpawnChance) ||
      speedTowerSpawnChance < 0 ||
      speedTowerSpawnChance > 1)
  ) {
    throw new RangeError(
      "speedTowerSpawnChance must be null or a number between 0 and 1.",
    );
  }

  const requestedSpeedTowerCount =
    baseMap.requestedSpeedTowerCount ?? baseSpeedTowers.length;
  if (
    !Number.isSafeInteger(requestedSpeedTowerCount) ||
    requestedSpeedTowerCount < 0 ||
    requestedSpeedTowerCount > 1
  ) {
    throw new RangeError("requestedSpeedTowerCount must be either 0 or 1.");
  }

  const endlessFeastSpawnChance = baseMap.endlessFeastSpawnChance ?? null;
  if (
    endlessFeastSpawnChance !== null &&
    (!Number.isFinite(endlessFeastSpawnChance) ||
      endlessFeastSpawnChance < 0 ||
      endlessFeastSpawnChance > 1)
  ) {
    throw new RangeError(
      "endlessFeastSpawnChance must be null or a number between 0 and 1.",
    );
  }
  const requestedEndlessFeastCount =
    baseMap.requestedEndlessFeastCount ?? (endlessFeast ? 1 : 0);
  if (
    !Number.isSafeInteger(requestedEndlessFeastCount) ||
    requestedEndlessFeastCount < 0 ||
    requestedEndlessFeastCount > 1
  ) {
    throw new RangeError("requestedEndlessFeastCount must be either 0 or 1.");
  }

  const copy = {
    width,
    height,
    seed: canonicalSeed(baseMap.seed),
    mapShape,
    start,
    goal,
    voidCells,
    requestedEndlessFeastCount,
    endlessFeastSpawnChance,
    endlessFeast,
    rockDensity: baseMap.rockDensity ?? 0,
    requestedRockCount: baseMap.requestedRockCount ?? baseRocks.length,
    baseRocks,
    requestedSlowTowerCount:
      baseMap.requestedSlowTowerCount ?? baseSlowTowers.length,
    slowTowerSpawnChances:
      slowTowerSpawnChances === null ? null : [...slowTowerSpawnChances],
    baseSlowTowers,
    requestedSpeedTowerCount,
    speedTowerSpawnChance,
    baseSpeedTowers,
  };
  if (!hasOpenEndlessFeastSide(copy)) {
    throw new RangeError("Endless Feast must have at least one unobstructed side.");
  }
  if (!hasPath(copy)) throw new RangeError("The supplied base map has no route.");
  return copy;
}

function rulesFromOptions(options) {
  const rules = {
    obstacleCost: options.obstacleCost ?? DEFAULT_GAME_CONFIG.obstacleCost,
    refundRate: options.refundRate ?? DEFAULT_GAME_CONFIG.refundRate,
    tearRefundRate:
      options.tearRefundRate ?? DEFAULT_GAME_CONFIG.tearRefundRate,
    stepDurationMs:
      options.stepDurationMs ?? DEFAULT_GAME_CONFIG.stepDurationMs,
    turnPenaltyMs: options.turnPenaltyMs ?? DEFAULT_GAME_CONFIG.turnPenaltyMs,
    slowSpeedMultiplier:
      options.slowSpeedMultiplier ?? DEFAULT_GAME_CONFIG.slowSpeedMultiplier,
    slowDurationMs:
      options.slowDurationMs ?? DEFAULT_GAME_CONFIG.slowDurationMs,
    slowTowerCooldownMs:
      options.slowTowerCooldownMs ?? DEFAULT_GAME_CONFIG.slowTowerCooldownMs,
    speedSpeedMultiplier:
      options.speedSpeedMultiplier ?? DEFAULT_GAME_CONFIG.speedSpeedMultiplier,
    speedDurationMs:
      options.speedDurationMs ?? DEFAULT_GAME_CONFIG.speedDurationMs,
  };

  if (!Number.isFinite(rules.obstacleCost) || rules.obstacleCost < 0) {
    throw new RangeError("obstacleCost must be a non-negative number.");
  }
  if (
    !Number.isFinite(rules.refundRate) ||
    rules.refundRate < 0 ||
    rules.refundRate > 1
  ) {
    throw new RangeError("refundRate must be between 0 and 1.");
  }
  if (
    !Number.isFinite(rules.tearRefundRate) ||
    rules.tearRefundRate < 0 ||
    rules.tearRefundRate > 1
  ) {
    throw new RangeError("tearRefundRate must be between 0 and 1.");
  }
  // The simulation helper validates every timing rule in one place.
  simulationRules(rules);
  return rules;
}

function slowTowersForState(state) {
  const baseTowers = (state.baseSlowTowers ?? []).map((tower) => ({
    ...cloneCell(tower),
    id: `base:${cellKey(tower)}`,
  }));
  const placedTowers = (state.obstacles ?? [])
    .filter(
      (obstacle) =>
        obstacle.groupType === "slow-tower" || obstacle.type === "slow-tower",
    )
    .map((tower) => ({
      ...cloneCell(tower),
      id: `placed:${tower.groupId ?? tower.id ?? "slow-tower"}:${cellKey(tower)}`,
    }));
  return [...baseTowers, ...placedTowers];
}

function speedTowersForState(state) {
  const baseTowers = (state.baseSpeedTowers ?? []).map((tower) => ({
    ...cloneCell(tower),
    id: `base-speed:${cellKey(tower)}`,
  }));
  const placedTowers = (state.obstacles ?? [])
    .filter(
      (obstacle) =>
        obstacle.groupType === "speed-tower" || obstacle.type === "speed-tower",
    )
    .map((tower) => ({
      ...cloneCell(tower),
      id: `placed-speed:${tower.groupId ?? tower.id ?? "speed-tower"}:${cellKey(tower)}`,
    }));
  return [...baseTowers, ...placedTowers];
}

function derivedRouteValues(state, route) {
  const baseRouteMetrics = calculateRouteMetrics(route, state.rules);
  const runnerSimulation = calculateRunnerSimulation(
    route,
    slowTowersForState(state),
    {
      ...state.rules,
      speedTowers: speedTowersForState(state),
      endlessFeast: state.endlessFeast,
    },
  );
  const routeMetrics = {
    ...baseRouteMetrics,
    baseTravelTimeMs: baseRouteMetrics.travelTimeMs,
    travelTimeMs: runnerSimulation.travelTimeMs,
  };
  return { routeMetrics, runnerSimulation };
}

function withDerivedRoute(state) {
  const route = findShortestPath(state);
  const { routeMetrics, runnerSimulation } = derivedRouteValues(state, route);
  return {
    ...state,
    route,
    routeMetrics,
    runnerSimulation,
    scoreMs: routeMetrics.travelTimeMs,
  };
}

/** Creates one player's maze board from a seed or a shared base map. */
export function createGameState(options = {}) {
  const baseMap = options.baseMap
    ? cloneBaseMap(options.baseMap)
    : generateBaseMap(options);
  const startingGold =
    options.startingGold ?? DEFAULT_GAME_CONFIG.startingGold;
  if (!Number.isFinite(startingGold) || startingGold < 0) {
    throw new RangeError("startingGold must be a non-negative number.");
  }
  const startingTears =
    options.startingTears ?? DEFAULT_GAME_CONFIG.startingTears;
  if (!Number.isSafeInteger(startingTears) || startingTears < 0) {
    throw new RangeError("startingTears must be a non-negative safe integer.");
  }

  const state = {
    version: 1,
    width: baseMap.width,
    height: baseMap.height,
    seed: baseMap.seed,
    mapShape: baseMap.mapShape,
    start: cloneCell(baseMap.start),
    goal: cloneCell(baseMap.goal),
    voidCells: baseMap.voidCells.map(cloneCell),
    requestedEndlessFeastCount: baseMap.requestedEndlessFeastCount,
    endlessFeastSpawnChance: baseMap.endlessFeastSpawnChance,
    endlessFeast: baseMap.endlessFeast ? cloneCell(baseMap.endlessFeast) : null,
    baseRocks: baseMap.baseRocks.map(cloneCell),
    baseSlowTowers: baseMap.baseSlowTowers.map(cloneCell),
    baseSpeedTowers: baseMap.baseSpeedTowers.map(cloneCell),
    obstacles: [],
    gold: startingGold,
    startingGold,
    tears: startingTears,
    startingTears,
    rules: rulesFromOptions(options),
    revision: 0,
    lastAction: null,
  };

  return withDerivedRoute(state);
}

export function isPlayableCell(state, cell) {
  if (!isInsideGrid(cell, state.width, state.height)) return false;
  const key = cellKey(cell);
  return !(state.voidCells ?? []).some((voidCell) => cellKey(voidCell) === key);
}

export function isEndlessFeastClearingCell(state, cell) {
  if (!state.endlessFeast || !isIntegerCell(cell)) return false;
  return (
    Math.abs(state.endlessFeast.x - cell.x) +
      Math.abs(state.endlessFeast.y - cell.y) <=
    1
  );
}

export function getCellType(state, cell) {
  if (!isInsideGrid(cell, state.width, state.height)) return null;
  if (!isPlayableCell(state, cell)) return CELL_TYPES.VOID;
  if (cellsEqual(cell, state.start)) return CELL_TYPES.START;
  if (cellsEqual(cell, state.goal)) return CELL_TYPES.GOAL;
  if (state.endlessFeast && cellsEqual(cell, state.endlessFeast)) {
    return CELL_TYPES.ENDLESS_FEAST;
  }
  const key = cellKey(cell);
  if (state.baseRocks.some((rock) => cellKey(rock) === key)) {
    return CELL_TYPES.ROCK;
  }
  if (
    (state.baseSlowTowers ?? []).some((tower) => cellKey(tower) === key)
  ) {
    return CELL_TYPES.SLOW_TOWER;
  }
  if (
    (state.baseSpeedTowers ?? []).some((tower) => cellKey(tower) === key)
  ) {
    return CELL_TYPES.SPEED_TOWER;
  }
  if (state.obstacles.some((obstacle) => cellKey(obstacle) === key)) {
    return CELL_TYPES.OBSTACLE;
  }
  return CELL_TYPES.EMPTY;
}

/** Returns a row-major grid that can be rendered directly by a browser UI. */
export function createCellGrid(state, options = {}) {
  const includeRoute = options.includeRoute ?? false;
  const routeKeys = includeRoute
    ? new Set((state.route ?? []).map(cellKey))
    : new Set();
  const grid = [];

  for (let y = 0; y < state.height; y += 1) {
    const row = [];
    for (let x = 0; x < state.width; x += 1) {
      const cell = { x, y };
      const type = getCellType(state, cell);
      row.push(
        routeKeys.has(cellKey(cell)) && type === CELL_TYPES.EMPTY
          ? CELL_TYPES.ROUTE
          : type,
      );
    }
    grid.push(row);
  }

  return grid;
}

function generatedObjectAt(state, cell) {
  const collections = [
    ["baseRocks", CELL_TYPES.ROCK],
    ["baseSlowTowers", CELL_TYPES.SLOW_TOWER],
    ["baseSpeedTowers", CELL_TYPES.SPEED_TOWER],
  ];
  for (const [collection, type] of collections) {
    const object = (state[collection] ?? []).find((candidate) =>
      cellsEqual(candidate, cell),
    );
    if (object) return { collection, type, object };
  }
  return null;
}

function failure(state, reason, details = {}) {
  return { ok: false, reason, state, ...details };
}

/**
 * Removes one object supplied by the seeded base map and charges once. This
 * covers rocks and neutral towers while leaving player-built pieces to the
 * normal obstacle-removal/refund flow.
 */
export function tryRemoveGeneratedObject(state, cell, options = {}) {
  if (!isIntegerCell(cell)) {
    return failure(state, PLACEMENT_FAILURES.INVALID_CELL);
  }
  if (!isInsideGrid(cell, state.width, state.height)) {
    return failure(state, PLACEMENT_FAILURES.OUT_OF_BOUNDS, {
      cell: cloneCell(cell),
    });
  }

  const generated = generatedObjectAt(state, cell);
  if (!generated) {
    return failure(state, PLACEMENT_FAILURES.NO_GENERATED_OBJECT, {
      cell: cloneCell(cell),
    });
  }

  const cost = options.cost ?? DEFAULT_GENERATED_OBJECT_REMOVAL_COST;
  if (!Number.isFinite(cost) || cost < 0) {
    return failure(state, PLACEMENT_FAILURES.INVALID_COST, {
      cell: cloneCell(cell),
      cost,
    });
  }
  if (state.gold < cost) {
    return failure(state, PLACEMENT_FAILURES.INSUFFICIENT_GOLD, {
      cell: cloneCell(cell),
      cost,
      shortfall: cost - state.gold,
    });
  }

  const objects = state[generated.collection].filter(
    (candidate) => !cellsEqual(candidate, cell),
  );
  const nextState = withDerivedRoute({
    ...state,
    [generated.collection]: objects,
    gold: state.gold - cost,
    revision: state.revision + 1,
    lastAction: {
      type: "remove-generated-object",
      objectType: generated.type,
      cell: cloneCell(cell),
      cost,
    },
  });

  return {
    ok: true,
    state: nextState,
    previousState: state,
    removedObject: {
      ...cloneCell(generated.object),
      type: generated.type,
    },
    cost,
    scoreDeltaMs: nextState.scoreMs - state.scoreMs,
  };
}

function resolvedObstacleCost(state, options) {
  return options.cost ?? state.rules.obstacleCost;
}

/**
 * Validates and previews an obstacle without changing state. A successful
 * preview includes the resulting route, metrics, and score delta.
 */
export function evaluateObstaclePlacement(state, cell, options = {}) {
  if (!isIntegerCell(cell)) {
    return failure(state, PLACEMENT_FAILURES.INVALID_CELL);
  }
  if (!isInsideGrid(cell, state.width, state.height)) {
    return failure(state, PLACEMENT_FAILURES.OUT_OF_BOUNDS, {
      cell: cloneCell(cell),
    });
  }
  if (!isPlayableCell(state, cell)) {
    return failure(state, PLACEMENT_FAILURES.OUTSIDE_MAP, {
      cell: cloneCell(cell),
    });
  }
  if (
    cellsEqual(cell, state.start) ||
    cellsEqual(cell, state.goal) ||
    (state.endlessFeast && cellsEqual(cell, state.endlessFeast))
  ) {
    return failure(state, PLACEMENT_FAILURES.PROTECTED_CELL, {
      cell: cloneCell(cell),
    });
  }
  if (getCellType(state, cell) !== CELL_TYPES.EMPTY) {
    return failure(state, PLACEMENT_FAILURES.OCCUPIED, {
      cell: cloneCell(cell),
    });
  }

  const cost = resolvedObstacleCost(state, options);
  if (!Number.isFinite(cost) || cost < 0) {
    return failure(state, PLACEMENT_FAILURES.INVALID_COST, {
      cell: cloneCell(cell),
    });
  }
  if (state.gold < cost) {
    return failure(state, PLACEMENT_FAILURES.INSUFFICIENT_GOLD, {
      cell: cloneCell(cell),
      cost,
      shortfall: cost - state.gold,
    });
  }

  const obstacle = {
    x: cell.x,
    y: cell.y,
    cost,
    owner: options.owner ?? "player",
  };
  const preview = {
    ...state,
    obstacles: [...state.obstacles, obstacle],
  };
  if (!hasOpenEndlessFeastSide(preview)) {
    return failure(state, PLACEMENT_FAILURES.BLOCKS_PATH, {
      cell: cloneCell(cell),
      cost,
    });
  }
  const route = findShortestPath(preview);
  if (!route) {
    return failure(state, PLACEMENT_FAILURES.BLOCKS_PATH, {
      cell: cloneCell(cell),
      cost,
    });
  }

  const { routeMetrics, runnerSimulation } = derivedRouteValues(preview, route);
  return {
    ok: true,
    state,
    cell: cloneCell(cell),
    obstacle,
    cost,
    route,
    routeMetrics,
    runnerSimulation,
    scoreMs: routeMetrics.travelTimeMs,
    scoreDeltaMs: routeMetrics.travelTimeMs - state.routeMetrics.travelTimeMs,
  };
}

/** Places an obstacle immutably, charging gold only after path validation. */
export function tryPlaceObstacle(state, cell, options = {}) {
  const preview = evaluateObstaclePlacement(state, cell, options);
  if (!preview.ok) return preview;

  const obstacles = [...state.obstacles, preview.obstacle].sort(compareCells);
  const nextState = {
    ...state,
    obstacles,
    gold: state.gold - preview.cost,
    revision: state.revision + 1,
    lastAction: {
      type: "place-obstacle",
      cell: cloneCell(cell),
      cost: preview.cost,
      owner: preview.obstacle.owner,
    },
    route: preview.route,
    routeMetrics: preview.routeMetrics,
    runnerSimulation: preview.runnerSimulation,
    scoreMs: preview.routeMetrics.travelTimeMs,
  };

  return {
    ok: true,
    state: nextState,
    previousState: state,
    obstacle: { ...preview.obstacle },
    cost: preview.cost,
    scoreDeltaMs: preview.scoreDeltaMs,
  };
}

function normalizedGroupId(state, placement, cells, owner) {
  if (placement.id !== undefined && placement.id !== null) {
    return String(placement.id);
  }
  const footprint = cells.map(cellKey).sort().join(";");
  return `${owner}:group:${state.revision + 1}:${hashSeed(footprint)}`;
}

/**
 * Validates a multi-cell obstacle as one atomic purchase. The footprint is
 * tested in full before any gold is charged or any state is changed.
 */
export function evaluateObstacleGroupPlacement(state, placement, options = {}) {
  if (
    !placement ||
    typeof placement !== "object" ||
    !Array.isArray(placement.cells) ||
    placement.cells.length === 0
  ) {
    return failure(state, PLACEMENT_FAILURES.INVALID_GROUP);
  }

  const cells = [];
  const seen = new Set();
  for (let index = 0; index < placement.cells.length; index += 1) {
    const cell = placement.cells[index];
    if (!isIntegerCell(cell)) {
      return failure(state, PLACEMENT_FAILURES.INVALID_CELL, { cellIndex: index });
    }
    if (!isInsideGrid(cell, state.width, state.height)) {
      return failure(state, PLACEMENT_FAILURES.OUT_OF_BOUNDS, {
        cell: cloneCell(cell),
        cellIndex: index,
      });
    }
    if (!isPlayableCell(state, cell)) {
      return failure(state, PLACEMENT_FAILURES.OUTSIDE_MAP, {
        cell: cloneCell(cell),
        cellIndex: index,
      });
    }
    if (
      cellsEqual(cell, state.start) ||
      cellsEqual(cell, state.goal) ||
      (state.endlessFeast && cellsEqual(cell, state.endlessFeast))
    ) {
      return failure(state, PLACEMENT_FAILURES.PROTECTED_CELL, {
        cell: cloneCell(cell),
        cellIndex: index,
      });
    }
    const key = cellKey(cell);
    if (seen.has(key)) {
      return failure(state, PLACEMENT_FAILURES.DUPLICATE_CELL, {
        cell: cloneCell(cell),
        cellIndex: index,
      });
    }
    if (getCellType(state, cell) !== CELL_TYPES.EMPTY) {
      return failure(state, PLACEMENT_FAILURES.OCCUPIED, {
        cell: cloneCell(cell),
        cellIndex: index,
      });
    }
    seen.add(key);
    cells.push(cloneCell(cell));
  }

  const cost = placement.cost ?? options.cost ?? state.rules.obstacleCost;
  if (!Number.isFinite(cost) || cost < 0) {
    return failure(state, PLACEMENT_FAILURES.INVALID_COST);
  }
  const tearCost = placement.tearCost ?? options.tearCost ?? 0;
  if (!Number.isSafeInteger(tearCost) || tearCost < 0) {
    return failure(state, PLACEMENT_FAILURES.INVALID_TEAR_COST);
  }
  if (state.gold < cost) {
    return failure(state, PLACEMENT_FAILURES.INSUFFICIENT_GOLD, {
      cost,
      shortfall: cost - state.gold,
    });
  }
  const availableTears = state.tears ?? 0;
  if (availableTears < tearCost) {
    return failure(state, PLACEMENT_FAILURES.INSUFFICIENT_TEARS, {
      tearCost,
      shortfall: tearCost - availableTears,
    });
  }

  const owner = placement.owner ?? options.owner ?? "player";
  if (
    placement.id !== undefined &&
    placement.id !== null &&
    String(placement.id).trim().length === 0
  ) {
    return failure(state, PLACEMENT_FAILURES.INVALID_GROUP);
  }
  const groupId = normalizedGroupId(state, placement, cells, owner);
  if (state.obstacles.some((obstacle) => obstacle.groupId === groupId)) {
    return failure(state, PLACEMENT_FAILURES.DUPLICATE_GROUP_ID, { groupId });
  }
  const groupType = placement.type ?? options.type ?? "obstacle-group";
  const obstacles = cells.map((cell) => ({
    ...cell,
    cost,
    owner,
    groupId,
    groupType,
    groupCost: cost,
    groupTearCost: tearCost,
  }));
  const preview = { ...state, obstacles: [...state.obstacles, ...obstacles] };
  if (!hasOpenEndlessFeastSide(preview)) {
    return failure(state, PLACEMENT_FAILURES.BLOCKS_PATH, {
      cells: cells.map(cloneCell),
      cost,
      groupId,
    });
  }
  const route = findShortestPath(preview);
  if (!route) {
    return failure(state, PLACEMENT_FAILURES.BLOCKS_PATH, {
      cells: cells.map(cloneCell),
      cost,
      groupId,
    });
  }

  const { routeMetrics, runnerSimulation } = derivedRouteValues(preview, route);
  return {
    ok: true,
    state,
    placement: {
      id: groupId,
      type: groupType,
      cells: cells.map(cloneCell),
      cost,
      tearCost,
      owner,
    },
    obstacles,
    cost,
    tearCost,
    route,
    routeMetrics,
    runnerSimulation,
    scoreMs: routeMetrics.travelTimeMs,
    scoreDeltaMs: routeMetrics.travelTimeMs - state.routeMetrics.travelTimeMs,
  };
}

/** Places an arbitrary footprint and charges its cost exactly once. */
export function tryPlaceObstacleGroup(state, placement, options = {}) {
  const preview = evaluateObstacleGroupPlacement(state, placement, options);
  if (!preview.ok) return preview;

  const obstacles = [...state.obstacles, ...preview.obstacles].sort(compareCells);
  const nextState = {
    ...state,
    obstacles,
    gold: state.gold - preview.cost,
    tears: (state.tears ?? 0) - preview.tearCost,
    revision: state.revision + 1,
    lastAction: {
      type: "place-obstacle-group",
      placement: {
        ...preview.placement,
        cells: preview.placement.cells.map(cloneCell),
      },
    },
    route: preview.route,
    routeMetrics: preview.routeMetrics,
    runnerSimulation: preview.runnerSimulation,
    scoreMs: preview.routeMetrics.travelTimeMs,
  };

  return {
    ok: true,
    state: nextState,
    previousState: state,
    placement: {
      ...preview.placement,
      cells: preview.placement.cells.map(cloneCell),
    },
    cost: preview.cost,
    tearCost: preview.tearCost,
    scoreDeltaMs: preview.scoreDeltaMs,
  };
}

/**
 * Removes a placed obstacle. Refunds default to floor(original cost * the
 * state's refund rate); pass { refund: false } or a custom refundRate/amount.
 * Tear refunds default to full (the state's tearRefundRate), can be controlled
 * with tearRefund/tearRefundRate/tearRefundAmount, and are likewise capped at
 * the resource amount actually paid by the group.
 */
export function tryRemoveObstacle(state, cell, options = {}) {
  if (!isIntegerCell(cell)) {
    return failure(state, PLACEMENT_FAILURES.INVALID_CELL);
  }
  if (!isInsideGrid(cell, state.width, state.height)) {
    return failure(state, PLACEMENT_FAILURES.OUT_OF_BOUNDS, {
      cell: cloneCell(cell),
    });
  }

  const obstacleIndex = state.obstacles.findIndex(
    (obstacle) => obstacle.x === cell.x && obstacle.y === cell.y,
  );
  if (obstacleIndex === -1) {
    return failure(state, PLACEMENT_FAILURES.NO_OBSTACLE, {
      cell: cloneCell(cell),
    });
  }

  const obstacle = state.obstacles[obstacleIndex];
  const hasGroupId = obstacle.groupId !== undefined && obstacle.groupId !== null;
  const removedObstacles = hasGroupId
    ? state.obstacles.filter((candidate) => candidate.groupId === obstacle.groupId)
    : [obstacle];
  const originalCost = obstacle.groupCost ?? obstacle.cost;
  let refund = 0;
  if (options.refund !== false) {
    if (options.refundAmount !== undefined) {
      refund = options.refundAmount;
    } else {
      const refundRate = options.refundRate ?? state.rules.refundRate;
      if (!Number.isFinite(refundRate) || refundRate < 0 || refundRate > 1) {
        throw new RangeError("refundRate must be between 0 and 1.");
      }
      refund = Math.floor(originalCost * refundRate);
    }
  }
  if (!Number.isFinite(refund) || refund < 0) {
    throw new RangeError("refundAmount must be a non-negative number.");
  }
  refund = Math.min(originalCost, refund);

  const originalTearCost = hasGroupId
    ? obstacle.groupTearCost ?? 0
    : obstacle.tearCost ?? 0;
  let tearRefund = 0;
  if (options.tearRefund !== false) {
    if (options.tearRefundAmount !== undefined) {
      tearRefund = options.tearRefundAmount;
    } else {
      const tearRefundRate =
        options.tearRefundRate ?? state.rules.tearRefundRate ?? 1;
      if (
        !Number.isFinite(tearRefundRate) ||
        tearRefundRate < 0 ||
        tearRefundRate > 1
      ) {
        throw new RangeError("tearRefundRate must be between 0 and 1.");
      }
      tearRefund = Math.floor(originalTearCost * tearRefundRate);
    }
  }
  if (!Number.isSafeInteger(tearRefund) || tearRefund < 0) {
    throw new RangeError("tearRefundAmount must be a non-negative safe integer.");
  }
  tearRefund = Math.min(originalTearCost, tearRefund);

  const removedSet = new Set(removedObstacles);
  const obstacles = state.obstacles.filter((candidate) => !removedSet.has(candidate));
  const nextState = withDerivedRoute({
    ...state,
    obstacles,
    gold: state.gold + refund,
    tears: (state.tears ?? 0) + tearRefund,
    revision: state.revision + 1,
    lastAction: {
      type: obstacle.groupId ? "remove-obstacle-group" : "remove-obstacle",
      cell: cloneCell(cell),
      refund,
      tearRefund,
      owner: obstacle.owner,
      groupId: obstacle.groupId ?? null,
      cells: removedObstacles.map(cloneCell),
    },
  });

  return {
    ok: true,
    state: nextState,
    previousState: state,
    removedObstacle: { ...obstacle },
    removedObstacles: removedObstacles.map((removed) => ({ ...removed })),
    groupId: obstacle.groupId ?? null,
    refund,
    tearRefund,
  };
}

/**
 * Removes a whole group by id or by any occupied cell in that group. Ungrouped
 * one-cell obstacles are also accepted, which makes this safe for generic undo.
 */
export function tryRemoveObstacleGroup(state, groupIdOrCell, options = {}) {
  let cell = groupIdOrCell;
  if (typeof groupIdOrCell === "string" || typeof groupIdOrCell === "number") {
    const obstacle = state.obstacles.find(
      (candidate) => candidate.groupId === String(groupIdOrCell),
    );
    if (!obstacle) {
      return failure(state, PLACEMENT_FAILURES.NO_OBSTACLE, {
        groupId: String(groupIdOrCell),
      });
    }
    cell = obstacle;
  }
  return tryRemoveObstacle(state, cell, options);
}

/** All currently empty, affordable placements that preserve a route. */
export function listLegalPlacements(state, options = {}) {
  const legal = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const evaluation = evaluateObstaclePlacement(state, { x, y }, options);
      if (evaluation.ok) {
        legal.push({
          cell: { x, y },
          cost: evaluation.cost,
          routeMetrics: evaluation.routeMetrics,
          scoreDeltaMs: evaluation.scoreDeltaMs,
        });
      }
    }
  }
  return legal;
}

function metricComparison(first, second) {
  return (
    first.routeMetrics.travelTimeMs - second.routeMetrics.travelTimeMs ||
    first.routeMetrics.distance - second.routeMetrics.distance ||
    first.routeMetrics.steps - second.routeMetrics.steps ||
    first.routeMetrics.turns - second.routeMetrics.turns
  );
}

/**
 * A deterministic greedy rival: preview legal cells in a seeded tie-break
 * order and choose the placement producing the longest NPC time.
 */
export function chooseRivalPlacement(state, options = {}) {
  const cost = resolvedObstacleCost(state, options);
  if (!Number.isFinite(cost) || cost < 0 || state.gold < cost) return null;

  const candidates = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      if (getCellType(state, { x, y }) === CELL_TYPES.EMPTY) {
        candidates.push({ x, y });
      }
    }
  }

  const ordered = shuffleDeterministically(
    candidates,
    `${options.seed ?? state.seed}:rival:${state.revision}`,
  );
  let best = null;
  for (const cell of ordered) {
    const evaluation = evaluateObstaclePlacement(state, cell, {
      ...options,
      cost,
      owner: options.owner ?? "rival",
    });
    if (evaluation.ok && (!best || metricComparison(evaluation, best) > 0)) {
      best = evaluation;
    }
  }

  if (!best) return null;
  return {
    cell: cloneCell(best.cell),
    cost: best.cost,
    routeMetrics: { ...best.routeMetrics },
    scoreDeltaMs: best.scoreDeltaMs,
  };
}

/** Runs the greedy rival until it is out of gold, moves, or legal cells. */
export function buildRivalMaze(initialState, options = {}) {
  const cost = resolvedObstacleCost(initialState, options);
  const maxAffordable =
    Number.isFinite(cost) && cost > 0
      ? Math.floor(initialState.gold / cost)
      : initialState.width * initialState.height - initialState.obstacles.length;
  const maxPlacements = options.maxPlacements ?? maxAffordable;
  if (!Number.isInteger(maxPlacements) || maxPlacements < 0) {
    throw new RangeError("maxPlacements must be a non-negative integer.");
  }

  let state = initialState;
  const moves = [];
  for (let turn = 0; turn < maxPlacements; turn += 1) {
    const choice = chooseRivalPlacement(state, options);
    if (!choice) break;
    const result = tryPlaceObstacle(state, choice.cell, {
      ...options,
      owner: options.owner ?? "rival",
    });
    if (!result.ok) break;
    state = result.state;
    moves.push({
      cell: cloneCell(choice.cell),
      cost: result.cost,
      scoreDeltaMs: result.scoreDeltaMs,
    });
  }

  return { state, moves };
}
