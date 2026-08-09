import {
  DEFAULT_GENERATED_OBJECT_REMOVAL_COST,
  cellKey,
  createGameState,
  createSeededRng,
  evaluateObstacleGroupPlacement,
  generateBaseMap,
  generateRoundResources,
  getRunnerPositionAtTime,
  isEndlessFeastClearingCell,
  isPlayableCell,
  shuffleDeterministically,
  tryPlaceObstacleGroup,
  tryRemoveGeneratedObject,
  tryRemoveObstacleGroup,
} from "./game-engine.js";
import {
  addRoundScores,
  createCumulativeScores,
  rankCumulativeScores,
} from "./contest-scoring.js";
import { resolveSpectatedContestant } from "./spectator.js";
import {
  createChallengeUrl,
  deriveContestRoundSeed,
  normalizeChallengeSeed,
  parseChallengeTarget,
} from "./challenge.js";
import {
  AUGMENTS,
  AUGMENT_IDS,
  RUN_FLOORS,
  applyMapAugments,
  applyResourceAugments,
  discountedBuildingCost,
  draftAugmentChoices,
  floorConfig,
} from "./roguelike.js";

const ROCK_DENSITY = 0.115;
const MIN_STARTING_GOLD = 80;
const MAX_STARTING_GOLD = 250;
const STEP_DURATION_MS = 280;
// Scores use deterministic geometric movement time. Turns remain visible route
// metadata but do not make results depend on equivalent path tie ordering.
const TURN_PENALTY_MS = 0;

const TOOLS = Object.freeze({
  crate: {
    id: "crate",
    name: "Supply crate",
    cost: 10,
    tearCost: 0,
    rotations: 1,
    footprint: [[0, 0]],
  },
  fence: {
    id: "fence",
    name: "Timber fence",
    cost: 18,
    tearCost: 0,
    rotations: 2,
    footprint: [
      [0, 0],
      [1, 0],
    ],
  },
  tower: {
    id: "tower",
    name: "Guard tower",
    cost: 26,
    tearCost: 0,
    rotations: 4,
    footprint: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  },
  slowTower: {
    id: "slowTower",
    groupType: "slow-tower",
    name: "Lament tower",
    cost: 0,
    tearCost: 1,
    rotations: 1,
    footprint: [[0, 0]],
  },
});

const DEMOLISH_TOOL = Object.freeze({
  id: "demolish",
  name: "Demolish generated object",
  cost: DEFAULT_GENERATED_OBJECT_REMOVAL_COST,
  tearCost: 0,
  rotations: 1,
  action: "remove-generated-object",
});

const SELECTABLE_TOOLS = Object.freeze({
  ...TOOLS,
  [DEMOLISH_TOOL.id]: DEMOLISH_TOOL,
});

const MAP_SHAPE_LABELS = Object.freeze({
  rectangle: "Rectangle",
  diamond: "Diamond",
  donut: "Donut",
  flower: "Flower petals",
  custom: "Custom",
});

const RIVAL_SPECS = Object.freeze([
  { id: "bramble", name: "Bramblewick", color: "#7f9d55", samples: 16 },
  { id: "cinder", name: "Cinder Vale", color: "#d6783d", samples: 28 },
  {
    id: "vesper",
    name: "Vesper Quill",
    color: "#9b78b4",
    samples: 42,
    strategy: "lookahead",
    lookaheadWidth: 6,
    lookaheadSamples: 7,
    maxEvaluations: 20_000,
  },
]);

const FAILURE_COPY = Object.freeze({
  "invalid-cell": "That is not a buildable cell.",
  "out-of-bounds": "The whole piece must stay inside the field.",
  "protected-cell": "The entrance, portal, and Endless Feast tile are protected.",
  occupied: "Something already occupies that space.",
  "insufficient-gold": "You do not have enough gold for that action.",
  "blocks-path": "Sacred rule: one route must always remain open.",
  "invalid-cost": "That piece has an invalid cost.",
  "invalid-tear-cost": "That piece has an invalid Tear cost.",
  "insufficient-tears": "You need a Tear of the Runner to build that tower.",
  "duplicate-cell": "A footprint cannot cover the same cell twice.",
  "duplicate-group-id": "That obstacle has already been placed.",
  "invalid-group": "That obstacle footprint is invalid.",
  "no-generated-object": "Choose a rock or neutral tower generated with this field.",
  "outside-map": "That cell lies outside this floor's playable shape.",
});

const dom = {
  app: document.querySelector("#app"),
  canvas: document.querySelector("#gameCanvas"),
  arenaWrap: document.querySelector("#arenaWrap"),
  gold: document.querySelector("#goldValue"),
  tears: document.querySelector("#tearValue"),
  timer: document.querySelector("#timerValue"),
  augmentValue: document.querySelector("#augmentValue"),
  activeAugmentChip: document.querySelector("#activeAugmentChip"),
  speedTowerNote: document.querySelector("#speedTowerNote"),
  speedTowerRule: document.querySelector("#speedTowerRule"),
  slowTowerRule: document.querySelector("#slowTowerRule"),
  seed: document.querySelector("#seedValue"),
  shape: document.querySelector("#shapeValue"),
  phaseKicker: document.querySelector("#phaseKicker"),
  phaseTitle: document.querySelector("#phaseTitle"),
  phaseDescription: document.querySelector("#phaseDescription"),
  phaseBanner: document.querySelector("#phaseBanner"),
  placementTip: document.querySelector("#placementTip"),
  cursorStatus: document.querySelector("#cursorStatus"),
  rotationHint: document.querySelector("#rotationHint"),
  route: document.querySelector("#routeValue"),
  estimate: document.querySelector("#estimateValue"),
  placed: document.querySelector("#placedValue"),
  scoreMeter: document.querySelector("#scoreMeterFill"),
  scoreCaption: document.querySelector("#scoreCaption"),
  mazeOwnerHeading: document.querySelector("#mazeOwnerHeading"),
  leaderboard: document.querySelector("#leaderboard"),
  spectateHint: document.querySelector("#spectateHint"),
  standingNote: document.querySelector("#standingNote"),
  mapNote: document.querySelector("#mapNote"),
  buildHints: [...document.querySelectorAll(".build-hint")],
  spectateFooterHint: document.querySelector("#spectateFooterHint"),
  runButton: document.querySelector("#runButton"),
  undoButton: document.querySelector("#undoButton"),
  toolCards: [...document.querySelectorAll(".tool-card")],
  eventLog: document.querySelector("#eventLog"),
  welcomeModal: document.querySelector("#welcomeModal"),
  augmentModal: document.querySelector("#augmentModal"),
  resultModal: document.querySelector("#resultModal"),
  startButton: document.querySelector("#startButton"),
  replayRoundButton: document.querySelector("#replayRoundButton"),
  nextRoundButton: document.querySelector("#nextRoundButton"),
  resultEmblem: document.querySelector("#resultEmblem"),
  resultEyebrow: document.querySelector("#resultEyebrow"),
  resultTitle: document.querySelector("#resultTitle"),
  resultCopy: document.querySelector("#resultCopy"),
  resultBoard: document.querySelector("#resultBoard"),
  challengeResult: document.querySelector("#challengeResult"),
  roundCount: document.querySelector("#roundCountInput"),
  shareChallengeButton: document.querySelector("#shareChallengeButton"),
  welcomeShareButton: document.querySelector("#welcomeShareButton"),
  resultShareButton: document.querySelector("#resultShareButton"),
  challengeTarget: document.querySelector("#challengeTarget"),
  roundCountHelp: document.querySelector("#roundCountHelp"),
  augmentEyebrow: document.querySelector("#augmentEyebrow"),
  augmentChoices: document.querySelector("#augmentChoices"),
  augmentOwned: document.querySelector("#augmentOwned"),
};

const context = dom.canvas.getContext("2d");
const query = new URLSearchParams(window.location.search);
let isSharedChallenge = query.has("challenge");
let phase = "welcome";
let roundNumber = 0;
let totalRounds = RUN_FLOORS;
let completedRounds = 0;
let cumulativeScores = createCumulativeScores([
  { id: "player" },
  ...RIVAL_SPECS,
]);
let contestSeed = "";
let roundSeed = "";
let roundResources = { gold: 100, tears: 0 };
let rivalRoundResources = { gold: 100, tears: 0 };
let currentFloor = floorConfig(1);
let selectedAugments = [];
let pendingAugmentChoices = [];
let baseMap = null;
let initialPlayerState = null;
let playerState = null;
let rivals = [];
let spectatedContestantId = "player";
let renderContestant = null;
let renderState = null;
let actionHistory = [];
let selectedToolId = "crate";
let rotation = 0;
let hoverCell = null;
let keyboardCell = { x: 2, y: Math.floor(currentFloor.height / 2) };
let previewCache = null;
let buildDeadline = 0;
let buildRemainingMs = currentFloor.buildDurationMs;
let runStartedAt = 0;
let runElapsedMs = 0;
let phaseToken = 0;
let geometry = null;
let toastTimer = 0;
let placementTipTimer = 0;
let lastUiTick = -1;
let leaderboardRenderKey = "";
let audioContext = null;
let pointerGesture = null;
let canvasNeedsResize = true;
let lastCanvasDraw = 0;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

window.addEventListener("error", (event) => {
  document.body.dataset.appError = event.message || "Unknown application error";
});
window.addEventListener("unhandledrejection", (event) => {
  document.body.dataset.appError = String(event.reason || "Unhandled promise rejection");
});

function openModal(modal, preferredFocus) {
  dom.app.inert = true;
  dom.app.setAttribute("aria-hidden", "true");
  modal.classList.add("open");
  window.requestAnimationFrame(() => preferredFocus?.focus());
}

function closeModal(modal, focusCanvas = true) {
  modal.classList.remove("open");
  dom.app.inert = false;
  dom.app.removeAttribute("aria-hidden");
  if (focusCanvas) window.requestAnimationFrame(() => dom.canvas.focus());
}

function openDialog() {
  return document.querySelector(".modal-backdrop.open");
}

function trapModalFocus(event) {
  if (event.key !== "Tab") return false;
  const modal = openDialog();
  if (!modal) return false;
  const focusable = [...modal.querySelectorAll("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")];
  if (focusable.length === 0) return false;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

function makeSeed() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

function requestedSeed() {
  return normalizeChallengeSeed(query.get("challenge") ?? query.get("seed"));
}

let challengeTargetMs = parseChallengeTarget(query.get("target"));

function selectedRoundCount() {
  if (dom.roundCount) dom.roundCount.value = String(RUN_FLOORS);
  return RUN_FLOORS;
}

function updateStartButtonLabel() {
  dom.startButton.textContent = `Start ${RUN_FLOORS}-floor run`;
}

function resetContestProgress() {
  roundNumber = 0;
  completedRounds = 0;
  currentFloor = floorConfig(1);
  selectedAugments = [];
  pendingAugmentChoices = [];
  cumulativeScores = createCumulativeScores([
    { id: "player" },
    ...RIVAL_SPECS,
  ]);
  document.body.dataset.completedRounds = "0";
  document.body.dataset.contestRounds = String(totalRounds);
  document.body.dataset.cumulativeScores = JSON.stringify(cumulativeScores);
  document.body.dataset.contestComplete = "false";
  document.body.dataset.augments = "[]";
}

function prepareContest(seed, waitForWelcome = true) {
  contestSeed = normalizeChallengeSeed(seed) ?? makeSeed();
  resetContestProgress();
  document.body.dataset.contestSeed = contestSeed;
  initRound(deriveContestRoundSeed(contestSeed, 1), waitForWelcome);
}

function createRoundState(seed, resources, floor) {
  const sharedMap = generateBaseMap({
    seed,
    width: floor.width,
    height: floor.height,
    rockDensity: ROCK_DENSITY,
  });
  const playerBaseMap = applyMapAugments(sharedMap, selectedAugments);
  const playerResources = applyResourceAugments(resources, selectedAugments);
  const state = createGameState({
    baseMap: playerBaseMap,
    startingGold: playerResources.gold,
    startingTears: playerResources.tears,
    obstacleCost: discountedBuildingCost(TOOLS.crate.cost, selectedAugments),
    refundRate: 1,
    stepDurationMs: STEP_DURATION_MS,
    turnPenaltyMs: TURN_PENALTY_MS,
    slowTowerAffectsDiagonals: selectedAugments.includes(
      AUGMENT_IDS.WIDE_LAMENT,
    ),
  });
  return { sharedMap, playerBaseMap, playerResources, state };
}

function initRound(seed, waitForWelcome = false) {
  phaseToken += 1;
  roundNumber += 1;
  currentFloor = floorConfig(roundNumber);
  roundSeed = seed;
  rivalRoundResources = generateRoundResources(seed, {
    minGold: MIN_STARTING_GOLD,
    maxGold: MAX_STARTING_GOLD,
    minTears: 0,
    maxTears: 2,
  });
  const created = createRoundState(seed, rivalRoundResources, currentFloor);
  roundResources = created.playerResources;
  baseMap = created.playerBaseMap;
  initialPlayerState = created.state;
  playerState = created.state;
  spectatedContestantId = "player";
  document.body.dataset.spectating = spectatedContestantId;
  actionHistory = [];
  selectedToolId = "crate";
  rotation = 0;
  hoverCell = null;
  keyboardCell = { ...(playerState.route[1] ?? playerState.start) };
  buildRemainingMs = currentFloor.buildDurationMs;
  runElapsedMs = 0;
  previewCache = null;
  rivals = buildRivals(created.sharedMap, seed, rivalRoundResources);
  assertRivalFairness(rivals, rivalRoundResources, created.sharedMap);
  phase = waitForWelcome ? "welcome" : "build";
  if (!waitForWelcome) {
    buildDeadline = performance.now() + currentFloor.buildDurationMs;
  }
  canvasNeedsResize = true;
  document.body.dataset.floor = String(roundNumber);
  document.body.dataset.floorWidth = String(currentFloor.width);
  document.body.dataset.floorHeight = String(currentFloor.height);
  document.body.dataset.buildDurationMs = String(currentFloor.buildDurationMs);
  dom.seed.textContent = seed;
  const shapeLabel = MAP_SHAPE_LABELS[baseMap.mapShape] ?? baseMap.mapShape;
  dom.shape.textContent = shapeLabel;
  updateCanvasLabel();
  updateInterface(true);
}

function beginBuild() {
  phase = "build";
  buildRemainingMs = currentFloor.buildDurationMs;
  buildDeadline = performance.now() + currentFloor.buildDurationMs;
  dom.phaseBanner.textContent = "Build phase";
  window.setTimeout(() => {
    if (phase === "build") dom.phaseBanner.textContent = "";
  }, 1200);
  updateInterface(true);
  const neutralSlowCount = baseMap.baseSlowTowers?.length ?? 0;
  const neutralSpeedCount = baseMap.baseSpeedTowers?.length ?? 0;
  const towerNotes = [];
  if (neutralSlowCount > 0) {
    towerNotes.push(`${neutralSlowCount} neutral slow ${neutralSlowCount === 1 ? "tower" : "towers"}`);
  }
  if (neutralSpeedCount > 0) towerNotes.push("1 neutral speed tower");
  if (baseMap.endlessFeast) towerNotes.unshift("Endless Feast checkpoint");
  showToast(
    `${MAP_SHAPE_LABELS[baseMap.mapShape] ?? baseMap.mapShape} field · ${roundResources.gold} gold · ${roundResources.tears} ${roundResources.tears === 1 ? "Tear" : "Tears"} of the Runner${towerNotes.length > 0 ? ` · ${towerNotes.join(" · ")}` : ""}.`,
    "neutral",
  );
  tone("start");
}

function ownedAugmentCopy() {
  const names = activeAugmentNames();
  return names.length > 0
    ? `Owned: ${names.join(" · ")}`
    : "No augments owned yet.";
}

function openAugmentDraft() {
  if (roundNumber >= totalRounds) return;
  phase = "augment";
  pendingAugmentChoices = draftAugmentChoices(
    contestSeed,
    roundNumber,
    selectedAugments,
  );
  dom.augmentEyebrow.textContent = `Floor ${roundNumber} cleared · ${totalRounds - roundNumber} remaining`;
  dom.augmentChoices.innerHTML = pendingAugmentChoices
    .map((augmentId) => {
      const augment = AUGMENTS[augmentId];
      return `
        <button class="augment-choice" type="button" data-augment="${augment.id}">
          <span class="augment-icon" aria-hidden="true">${augment.icon}</span>
          <span><strong>${augment.name}</strong><small>${augment.description}</small></span>
          <b>Choose</b>
        </button>`;
    })
    .join("");
  dom.augmentOwned.textContent = ownedAugmentCopy();
  document.body.dataset.phase = phase;
  document.body.dataset.augmentChoices = JSON.stringify(pendingAugmentChoices);
  openModal(dom.augmentModal, dom.augmentChoices.querySelector("button"));
}

function chooseAugment(augmentId) {
  if (phase !== "augment" || !pendingAugmentChoices.includes(augmentId)) return;
  selectedAugments.push(augmentId);
  pendingAugmentChoices = [];
  document.body.dataset.augments = JSON.stringify(selectedAugments);
  document.body.dataset.augmentChoices = "[]";
  closeModal(dom.augmentModal, false);
  dom.phaseBanner.textContent = "";
  initRound(deriveContestRoundSeed(contestSeed, roundNumber + 1));
  window.requestAnimationFrame(() => dom.canvas.focus());
  showToast(`${AUGMENTS[augmentId].name} acquired for the rest of this run.`, "success");
  tone("start");
}

function rotatedOffsets(tool, turn) {
  let cells = tool.footprint.map(([x, y]) => ({ x, y }));
  for (let index = 0; index < turn % 4; index += 1) {
    cells = cells.map((cell) => ({ x: -cell.y, y: cell.x }));
  }
  const minX = Math.min(...cells.map((cell) => cell.x));
  const minY = Math.min(...cells.map((cell) => cell.y));
  return cells.map((cell) => ({ x: cell.x - minX, y: cell.y - minY }));
}

function footprintAt(tool, turn, anchor) {
  return rotatedOffsets(tool, turn).map((offset) => ({
    x: anchor.x + offset.x,
    y: anchor.y + offset.y,
  }));
}

function groupProposal(tool, turn, anchor, owner = "player", id = undefined) {
  return {
    cells: footprintAt(tool, turn, anchor),
    cost: tool.cost,
    tearCost: tool.tearCost,
    type: tool.groupType ?? tool.id,
    owner,
    id,
  };
}

function canAffordTool(tool, state) {
  return tool.cost <= state.gold && tool.tearCost <= (state.tears ?? 0);
}

function playerTool(toolId) {
  const tool = SELECTABLE_TOOLS[toolId];
  if (!tool || !["crate", "fence", "tower"].includes(tool.id)) return tool;
  return {
    ...tool,
    cost: discountedBuildingCost(tool.cost, selectedAugments),
  };
}

function activeAugmentNames() {
  return selectedAugments.map((augmentId) => AUGMENTS[augmentId].name);
}

function candidateAnchors(state, seedOrRng, limit, focusRoute = false) {
  const keys = new Set();
  const routeCandidates = [];
  const otherCandidates = [];
  const add = (cell, candidates) => {
    if (
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x >= state.width ||
      cell.y >= state.height ||
      keys.has(cellKey(cell))
    ) {
      return;
    }
    keys.add(cellKey(cell));
    candidates.push({ x: cell.x, y: cell.y });
  };
  for (const cell of state.route) {
    for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
      for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
        add(
          { x: cell.x + xOffset, y: cell.y + yOffset },
          routeCandidates,
        );
      }
    }
  }
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      add({ x, y }, otherCandidates);
    }
  }
  if (focusRoute) {
    return [
      ...shuffleDeterministically(routeCandidates, `${seedOrRng}:route`),
      ...shuffleDeterministically(otherCandidates, `${seedOrRng}:other`),
    ].slice(0, limit);
  }
  return shuffleDeterministically(
    [...routeCandidates, ...otherCandidates],
    seedOrRng,
  ).slice(0, limit);
}

function compareRivalCandidates(first, second) {
  return (
    first.evaluation.scoreMs - second.evaluation.scoreMs ||
    first.evaluation.routeMetrics.distance -
      second.evaluation.routeMetrics.distance ||
    first.evaluation.routeMetrics.turns - second.evaluation.routeMetrics.turns ||
    second.proposal.cost - first.proposal.cost ||
    second.proposal.tearCost - first.proposal.tearCost
  );
}

function collectRivalCandidates(
  state,
  anchors,
  tools,
  owner,
  groupId,
  seed,
  planning,
) {
  const candidates = [];
  const random = createSeededRng(seed);

  outer: for (const anchor of anchors) {
    for (const tool of tools) {
      const startRotation = Math.floor(random() * tool.rotations);
      for (let offset = 0; offset < tool.rotations; offset += 1) {
        if (planning.evaluations >= planning.maxEvaluations) break outer;
        const turnIndex = (startRotation + offset) % tool.rotations;
        const proposal = groupProposal(tool, turnIndex, anchor, owner, groupId);
        planning.evaluations += 1;
        const evaluation = evaluateObstacleGroupPlacement(state, proposal);
        if (evaluation.ok) candidates.push({ proposal, evaluation });
      }
    }
  }

  return candidates;
}

function strongestCandidates(candidates, width) {
  const ordered = [...candidates].sort((first, second) =>
    compareRivalCandidates(second, first),
  );
  const shortlist = [];
  const perType = new Map();

  // Keep the beam diverse so a cheap two-crate combination is not crowded
  // out by several nearly identical, expensive tower placements.
  for (const candidate of ordered) {
    const type = candidate.proposal.type;
    const count = perType.get(type) ?? 0;
    if (count >= 2) continue;
    shortlist.push(candidate);
    perType.set(type, count + 1);
    if (shortlist.length >= width) return shortlist;
  }
  for (const candidate of ordered) {
    if (shortlist.includes(candidate)) continue;
    shortlist.push(candidate);
    if (shortlist.length >= width) break;
  }
  return shortlist;
}

function compareRivalPlans(first, second) {
  return (
    compareRivalCandidates(first.projected, second.projected) ||
    compareRivalCandidates(first.immediate, second.immediate) ||
    first.remainingGold - second.remainingGold ||
    first.remainingTears - second.remainingTears
  );
}

function chooseLookaheadRivalPlacement(state, round, spec, turn, planning) {
  const rootSeed = `${round}:${spec.id}:lookahead-v1:${turn}`;
  const tools = shuffleDeterministically(
    Object.values(TOOLS).filter((tool) => canAffordTool(tool, state)),
    `${rootSeed}:tools`,
  );
  if (tools.length === 0) return null;

  const anchors = candidateAnchors(state, `${rootSeed}:anchors`, spec.samples, true);
  const candidates = collectRivalCandidates(
    state,
    anchors,
    tools,
    spec.id,
    `${spec.id}-${turn}`,
    `${rootSeed}:rotations`,
    planning,
  );
  if (candidates.length === 0) return null;

  const beam = strongestCandidates(candidates, spec.lookaheadWidth);
  const plans = [];
  for (let index = 0; index < beam.length; index += 1) {
    if (planning.evaluations >= planning.maxEvaluations) break;
    const immediate = beam[index];
    planning.evaluations += 1;
    const placed = tryPlaceObstacleGroup(state, immediate.proposal);
    if (!placed.ok) continue;

    const nextState = placed.state;
    const branchSeed = `${rootSeed}:branch:${index}`;
    const nextTools = shuffleDeterministically(
      Object.values(TOOLS).filter((tool) => canAffordTool(tool, nextState)),
      `${branchSeed}:tools`,
    );
    let projected = immediate;
    let projectedCost = 0;
    let projectedTearCost = 0;

    if (nextTools.length > 0 && planning.evaluations < planning.maxEvaluations) {
      const nextAnchors = candidateAnchors(
        nextState,
        `${branchSeed}:anchors`,
        spec.lookaheadSamples,
        true,
      );
      const replies = collectRivalCandidates(
        nextState,
        nextAnchors,
        nextTools,
        spec.id,
        `${spec.id}-${turn + 1}`,
        `${branchSeed}:rotations`,
        planning,
      );
      const bestReply = strongestCandidates(replies, 1)[0];
      if (bestReply && compareRivalCandidates(bestReply, projected) > 0) {
        projected = bestReply;
        projectedCost = bestReply.proposal.cost;
        projectedTearCost = bestReply.proposal.tearCost;
      }
    }

    plans.push({
      immediate,
      projected,
      remainingGold: nextState.gold - projectedCost,
      remainingTears: nextState.tears - projectedTearCost,
    });
  }

  const bestPlan = plans.sort((first, second) =>
    compareRivalPlans(second, first),
  )[0];
  return bestPlan?.immediate.proposal ?? candidates[0].proposal;
}

function buildRival(base, round, spec, resources) {
  let state = createGameState({
    baseMap: base,
    startingGold: resources.gold,
    startingTears: resources.tears,
    obstacleCost: TOOLS.crate.cost,
    refundRate: 1,
    stepDurationMs: STEP_DURATION_MS,
    turnPenaltyMs: TURN_PENALTY_MS,
  });
  const random = createSeededRng(`${round}:${spec.id}:builder-v1`);
  const planning = {
    strategy: spec.strategy ?? "greedy",
    evaluations: 0,
    maxEvaluations: spec.maxEvaluations ?? Number.POSITIVE_INFINITY,
  };
  let turn = 0;

  while (turn < 30) {
    if (spec.strategy === "lookahead") {
      const proposal = chooseLookaheadRivalPlacement(
        state,
        round,
        spec,
        turn,
        planning,
      );
      if (!proposal) break;
      if (planning.evaluations >= planning.maxEvaluations) break;
      planning.evaluations += 1;
      const placed = tryPlaceObstacleGroup(state, proposal);
      if (!placed.ok) break;
      state = placed.state;
      turn += 1;
      continue;
    }

    const anchors = candidateAnchors(state, random, spec.samples);
    const toolOrder = shuffleDeterministically(Object.values(TOOLS), random).filter(
      (tool) => canAffordTool(tool, state),
    );
    if (toolOrder.length === 0) break;
    let best = null;

    for (const anchor of anchors) {
      for (const tool of toolOrder) {
        const startRotation = Math.floor(random() * tool.rotations);
        for (let offset = 0; offset < tool.rotations; offset += 1) {
          const turnIndex = (startRotation + offset) % tool.rotations;
          const proposal = groupProposal(
            tool,
            turnIndex,
            anchor,
            spec.id,
            `${spec.id}-${turn}`,
          );
          planning.evaluations += 1;
          const evaluation = evaluateObstacleGroupPlacement(state, proposal);
          if (!evaluation.ok) continue;
          const value =
            evaluation.scoreMs * 10_000 +
            evaluation.routeMetrics.distance * 100 +
            evaluation.routeMetrics.turns;
          if (!best || value > best.value) best = { proposal, value };
        }
      }
    }

    if (!best) break;
    planning.evaluations += 1;
    const placed = tryPlaceObstacleGroup(state, best.proposal);
    if (!placed.ok) break;
    state = placed.state;
    turn += 1;
  }

  return {
    ...spec,
    state,
    finished: false,
    aiStats: {
      strategy: planning.strategy,
      evaluations: planning.evaluations,
      maxEvaluations: Number.isFinite(planning.maxEvaluations)
        ? planning.maxEvaluations
        : null,
    },
  };
}

function buildRivals(base, seed, resources) {
  return RIVAL_SPECS.map((spec) => buildRival(base, seed, spec, resources));
}

function assertRivalFairness(entries, resources, sharedBaseMap) {
  const sharedVoidCells = JSON.stringify(sharedBaseMap.voidCells ?? []);
  const sharedSlowTowers = JSON.stringify(sharedBaseMap.baseSlowTowers ?? []);
  const sharedSpeedTowers = JSON.stringify(sharedBaseMap.baseSpeedTowers ?? []);
  const valid = entries.every(
    (entry) =>
      entry.state.startingGold === resources.gold &&
      entry.state.startingTears === resources.tears &&
      entry.state.gold >= 0 &&
      entry.state.tears >= 0 &&
      entry.state.tears <= resources.tears &&
      Array.isArray(entry.state.route) &&
      entry.state.route.length > 0 &&
      entry.state.mapShape === sharedBaseMap.mapShape &&
      JSON.stringify(entry.state.voidCells ?? []) === sharedVoidCells &&
      JSON.stringify(entry.state.endlessFeast ?? null) ===
        JSON.stringify(sharedBaseMap.endlessFeast ?? null) &&
      JSON.stringify(entry.state.baseSlowTowers ?? []) === sharedSlowTowers &&
      JSON.stringify(entry.state.baseSpeedTowers ?? []) === sharedSpeedTowers &&
      entry.state.scoreMs === entry.state.runnerSimulation?.travelTimeMs,
  );
  const planningValid = entries.every(
    (entry) =>
      entry.aiStats.maxEvaluations === null ||
      entry.aiStats.evaluations <= entry.aiStats.maxEvaluations,
  );
  document.body.dataset.rivalsValid = String(valid);
  document.body.dataset.rivalAiStats = JSON.stringify(
    entries.map((entry) => ({
      id: entry.id,
      ...entry.aiStats,
    })),
  );
  if (!valid) throw new Error("A rival violated the shared round resources or deterministic route rules.");
  if (!planningValid) throw new Error("A rival exceeded its planning evaluation budget.");
}

function currentPreview() {
  if (phase !== "build" || !hoverCell) return null;
  const cacheKey = `${playerState.revision}:${selectedToolId}:${rotation}:${hoverCell.x},${hoverCell.y}`;
  if (previewCache?.key === cacheKey) return previewCache.value;
  const tool = playerTool(selectedToolId);
  const proposal = tool.action === "remove-generated-object"
    ? { cells: [{ ...hoverCell }] }
    : groupProposal(tool, rotation, hoverCell, "player");
  const evaluation = tool.action === "remove-generated-object"
    ? tryRemoveGeneratedObject(playerState, hoverCell, { cost: tool.cost })
    : evaluateObstacleGroupPlacement(playerState, proposal);
  const value = { evaluation, proposal };
  previewCache = { key: cacheKey, value };
  return value;
}

function selectTool(toolId) {
  const tool = playerTool(toolId);
  if (
    !tool ||
    phase !== "build" ||
    !canAffordTool(tool, playerState)
  ) return;
  selectedToolId = toolId;
  rotation %= tool.rotations;
  previewCache = null;
  updateInterface(true);
  announceCursor();
  tone("select");
}

function ensureAffordableSelection() {
  if (canAffordTool(playerTool(selectedToolId), playerState)) return;
  const affordable = Object.keys(SELECTABLE_TOOLS)
    .map(playerTool)
    .find((tool) => canAffordTool(tool, playerState));
  if (affordable) {
    selectedToolId = affordable.id;
    rotation %= affordable.rotations;
    previewCache = null;
  }
}

function announceCursor() {
  if (document.activeElement !== dom.canvas) return;
  const cursorState = displayedContestant().state;
  const occupant = cursorState.obstacles.find(
    (entry) => entry.x === keyboardCell.x && entry.y === keyboardCell.y,
  );
  const rock = cursorState.baseRocks.some(
    (entry) => entry.x === keyboardCell.x && entry.y === keyboardCell.y,
  );
  const neutralSlowTower = (cursorState.baseSlowTowers ?? []).some(
    (entry) => entry.x === keyboardCell.x && entry.y === keyboardCell.y,
  );
  const neutralSpeedTower = (cursorState.baseSpeedTowers ?? []).some(
    (entry) => entry.x === keyboardCell.x && entry.y === keyboardCell.y,
  );
  const outsideShape = !isPlayableCell(cursorState, keyboardCell);
  const feast = cursorState.endlessFeast &&
    keyboardCell.x === cursorState.endlessFeast.x &&
    keyboardCell.y === cursorState.endlessFeast.y;
  const feastClearing = isEndlessFeastClearingCell(cursorState, keyboardCell);
  const special =
    keyboardCell.x === cursorState.start.x && keyboardCell.y === cursorState.start.y
      ? "entrance"
      : keyboardCell.x === cursorState.goal.x && keyboardCell.y === cursorState.goal.y
        ? "portal"
        : outsideShape
          ? `outside the ${MAP_SHAPE_LABELS[cursorState.mapShape] ?? cursorState.mapShape} field`
          : feast
            ? "Endless Feast mandatory checkpoint"
            : feastClearing
              ? "beside Endless Feast; at least one side must remain open"
              : neutralSlowTower
                ? `generated neutral Tower of Lament; Delete demolishes it for ${DEMOLISH_TOOL.cost} gold`
                : neutralSpeedTower
                  ? `generated neutral speed tower; Delete demolishes it for ${DEMOLISH_TOOL.cost} gold`
                  : occupant
                    ? `${occupant.groupType} obstacle; Delete removes it`
                    : rock
                      ? `generated rock; Delete demolishes it for ${DEMOLISH_TOOL.cost} gold`
                      : "empty";
  dom.cursorStatus.textContent = `Column ${keyboardCell.x + 1}, row ${keyboardCell.y + 1}: ${special}. ${playerTool(selectedToolId).name} selected.`;
}

function rotateTool() {
  const tool = playerTool(selectedToolId);
  if (phase !== "build" || tool.rotations === 1) return;
  rotation = (rotation + 1) % tool.rotations;
  previewCache = null;
  updateInterface(true);
  announceCursor();
  tone("select");
}

function placeAt(cell) {
  if (phase !== "build") return;
  const tool = playerTool(selectedToolId);
  if (tool.action === "remove-generated-object") {
    removeGeneratedAt(cell);
    return;
  }
  const proposal = groupProposal(
    tool,
    rotation,
    cell,
    "player",
    `player-${roundNumber}-${playerState.revision + 1}`,
  );
  const result = tryPlaceObstacleGroup(playerState, proposal);
  if (!result.ok) {
    showPlacementFailure(result.reason);
    tone("reject");
    return;
  }
  playerState = result.state;
  actionHistory.push({
    kind: "place-obstacle",
    previousState: result.previousState,
    toolName: tool.name,
  });
  ensureAffordableSelection();
  previewCache = null;
  const improvement =
    result.scoreDeltaMs > 0
      ? ` +${formatSeconds(result.scoreDeltaMs)}`
      : result.scoreDeltaMs < 0
        ? ` ${formatSeconds(result.scoreDeltaMs)}`
        : " Route held.";
  showToast(`${tool.name} placed.${improvement}`, "success");
  tone("place");
  updateInterface(true);
  announceCursor();
}

function removeAt(cell) {
  if (phase !== "build") return;
  const obstacle = playerState.obstacles.find(
    (entry) => entry.x === cell.x && entry.y === cell.y && entry.owner === "player",
  );
  if (!obstacle) return;
  const result = tryRemoveObstacleGroup(playerState, cell, { refundRate: 1 });
  if (!result.ok) return;
  playerState = result.state;
  const tool = Object.values(TOOLS).find(
    (entry) => (entry.groupType ?? entry.id) === result.removedObstacle.groupType,
  );
  actionHistory.push({
    kind: "remove-obstacle",
    previousState: result.previousState,
    toolName: tool?.name ?? "Obstacle",
  });
  previewCache = null;
  showToast(`Obstacle removed${refundCopy(result)}.`, "neutral");
  tone("remove");
  updateInterface(true);
  announceCursor();
}

function generatedObjectName(type) {
  if (type === "slow-tower") return "Neutral Tower of Lament";
  if (type === "speed-tower") return "Neutral speed tower";
  return "Rock";
}

function removeGeneratedAt(cell) {
  if (phase !== "build") return;
  const result = tryRemoveGeneratedObject(playerState, cell, {
    cost: DEMOLISH_TOOL.cost,
  });
  if (!result.ok) {
    showPlacementFailure(result.reason);
    tone("reject");
    return;
  }
  const objectName = generatedObjectName(result.removedObject.type);
  playerState = result.state;
  actionHistory.push({
    kind: "remove-generated-object",
    previousState: result.previousState,
    objectName,
    cost: result.cost,
  });
  ensureAffordableSelection();
  previewCache = null;
  showToast(`${objectName} demolished · ${result.cost} gold spent.`, "success");
  tone("remove");
  updateInterface(true);
  announceCursor();
}

function removeTargetAt(cell) {
  const ownedObstacle = playerState.obstacles.some(
    (entry) => entry.x === cell.x && entry.y === cell.y && entry.owner === "player",
  );
  if (ownedObstacle) removeAt(cell);
  else {
    const generatedObject = [
      ...playerState.baseRocks,
      ...(playerState.baseSlowTowers ?? []),
      ...(playerState.baseSpeedTowers ?? []),
    ].some((entry) => entry.x === cell.x && entry.y === cell.y);
    if (generatedObject) removeGeneratedAt(cell);
  }
}

function undoLast() {
  if (phase !== "build" || actionHistory.length === 0) return;
  const last = actionHistory.pop();
  playerState = last.previousState;
  previewCache = null;
  const message = last.kind === "place-obstacle"
    ? `${last.toolName} placement undone.`
    : last.kind === "remove-obstacle"
      ? `${last.toolName} removal undone.`
      : `${last.objectName} restored · ${last.cost} gold returned.`;
  showToast(message, "neutral");
  tone("remove");
  updateInterface(true);
  announceCursor();
}

function showPlacementFailure(reason) {
  const message = FAILURE_COPY[reason] ?? "That piece cannot be placed there.";
  window.clearTimeout(placementTipTimer);
  dom.placementTip.textContent = message;
  placementTipTimer = window.setTimeout(() => {
    if (dom.placementTip.textContent === message) dom.placementTip.textContent = "";
  }, 1700);
}

function showToast(message, kind = "neutral") {
  window.clearTimeout(toastTimer);
  dom.eventLog.innerHTML = `<div class="${kind}">${message}</div>`;
  dom.eventLog.classList.add("visible");
  toastTimer = window.setTimeout(() => {
    dom.eventLog.classList.remove("visible");
  }, 2200);
}

function challengeLink({ includeResult = false } = {}) {
  const rounds = phase === "welcome" ? selectedRoundCount() : totalRounds;
  return createChallengeUrl(window.location.href, {
    contestSeed,
    rounds,
    targetMs: includeResult && contestIsComplete()
      ? Math.round(cumulativeScoreFor("player"))
      : null,
  });
}

function isLocalChallengeLink() {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    window.location.hostname,
  );
}

async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the selection-based copy used by older browsers.
    }
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

async function copyChallengeLink(button, includeResult = false) {
  try {
    await writeClipboard(challengeLink({ includeResult }));
    const originalLabel = button.textContent;
    button.textContent = "Link copied";
    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1800);
    showToast(
      isLocalChallengeLink()
        ? "Challenge copied, but localhost only works on this computer. Publish the site before sending it."
        : includeResult && contestIsComplete()
          ? "Your score challenge is ready to send."
          : "Challenge link copied. Everyone will receive the same four-floor run and augment drafts.",
      isLocalChallengeLink() ? "neutral" : "success",
    );
  } catch {
    showToast("The browser blocked clipboard access. Copy the address from the URL bar instead.", "neutral");
  }
}

function formatClock(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function routeDistance(state) {
  return state.routeMetrics.distance ?? state.routeMetrics.steps;
}

function placedPieceCount(state) {
  return new Set(
    state.obstacles
      .map((obstacle) => obstacle.groupId ?? `cell:${cellKey(obstacle)}`),
  ).size;
}

function formatDistance(distance) {
  return Number(distance.toFixed(1)).toString();
}

function refundCopy(result) {
  const resources = [];
  if (result.refund > 0) resources.push(`${result.refund} gold`);
  if (result.tearRefund > 0) {
    resources.push(`${result.tearRefund} ${result.tearRefund === 1 ? "Tear" : "Tears"}`);
  }
  return resources.length > 0 ? ` · ${resources.join(" and ")} returned` : "";
}

function allContestants() {
  return [
    {
      id: "player",
      name: "You",
      color: "#efc75e",
      state: playerState,
      isPlayer: true,
    },
    ...rivals,
  ];
}

function displayedContestant() {
  return resolveSpectatedContestant(
    allContestants(),
    spectatedContestantId,
    phase === "run",
  );
}

function updateCanvasLabel(contestant = displayedContestant()) {
  if (!contestant || !baseMap) return;
  const state = contestant.state;
  const shapeLabel = MAP_SHAPE_LABELS[state.mapShape] ?? state.mapShape;
  const owner = contestant.isPlayer ? "your maze" : `${contestant.name}'s maze`;
  dom.canvas.setAttribute(
    "aria-label",
    `Viewing ${owner} on a ${shapeLabel} field, ${state.width} columns by ${state.height} rows, seed ${roundSeed}, ${state.endlessFeast ? "Endless Feast checkpoint present" : "no Endless Feast checkpoint"}, ${state.baseSlowTowers?.length ?? 0} neutral slow towers, ${state.baseSpeedTowers?.length ?? 0} neutral speed towers`,
  );
}

function selectSpectatedContestant(contestantId, announce = true) {
  if (phase !== "run") return false;
  const contestant = allContestants().find((entry) => entry.id === contestantId);
  if (!contestant) return false;
  const changed = spectatedContestantId !== contestant.id;
  spectatedContestantId = contestant.id;
  document.body.dataset.spectating = spectatedContestantId;
  updateCanvasLabel(contestant);
  lastCanvasDraw = 0;
  updateInterface(true);
  if (changed && announce) {
    showToast(
      contestant.isPlayer
        ? "Now spectating your maze."
        : `Now spectating ${contestant.name}'s maze.`,
      "neutral",
    );
    tone("select");
  }
  return true;
}

function slowApplicationCount(state) {
  return state.runnerSimulation?.slowApplications?.length ?? 0;
}

function speedApplicationCount(state) {
  return state.runnerSimulation?.speedApplications?.length ?? 0;
}

function cumulativeScoreFor(contestantId) {
  return cumulativeScores[contestantId] ?? 0;
}

function rankedCumulativeContestants() {
  return rankCumulativeScores(allContestants(), cumulativeScores);
}

function contestIsComplete() {
  return completedRounds >= totalRounds;
}

function recordCompletedRound() {
  cumulativeScores = addRoundScores(cumulativeScores, allContestants());
  completedRounds += 1;
  document.body.dataset.completedRounds = String(completedRounds);
  document.body.dataset.contestRounds = String(totalRounds);
  document.body.dataset.cumulativeScores = JSON.stringify(cumulativeScores);
}

function rankedContestants() {
  const sorted = [...allContestants()].sort(
    (first, second) =>
      second.state.scoreMs - first.state.scoreMs ||
      first.name.localeCompare(second.name),
  );
  let rank = 0;
  let prior = null;
  return sorted.map((contestant, index) => {
    if (!prior || contestant.state.scoreMs !== prior.state.scoreMs) {
      rank = index + 1;
    }
    prior = contestant;
    return { ...contestant, rank };
  });
}

function runningLeaderboardValues(contestant) {
  const elapsed = Math.min(runElapsedMs, contestant.state.scoreMs);
  const isSpectating = contestant.id === spectatedContestantId;
  return {
    detail: `${isSpectating ? "Watching · " : ""}${elapsed >= contestant.state.scoreMs ? "Finished" : "Runner moving…"} · ${formatSeconds(cumulativeScoreFor(contestant.id))} banked`,
    score: formatSeconds(elapsed),
  };
}

function leaderboardMarkup() {
  const showRanks = phase === "results";
  const contestants = showRanks ? rankedCumulativeContestants() : allContestants();
  return contestants
    .map((contestant) => {
      let detail = "Planning maze…";
      let score = "—";
      const canSpectate = phase === "run";
      const isSpectating = canSpectate && contestant.id === spectatedContestantId;
      const bankedScore = cumulativeScoreFor(contestant.id);
      if (phase === "build" && contestant.isPlayer) {
        detail = `${formatDistance(routeDistance(contestant.state))} tiles · ${contestant.state.gold} gold · ${formatSeconds(bankedScore)} banked`;
        score = formatSeconds(contestant.state.scoreMs);
      } else if (phase === "build") {
        detail = `Planning maze… · ${formatSeconds(bankedScore)} banked`;
      } else if (phase === "countdown") {
        detail = `${formatDistance(routeDistance(contestant.state))} tiles · ${formatSeconds(bankedScore)} banked`;
        score = "Ready";
      } else if (phase === "run") {
        ({ detail, score } = runningLeaderboardValues(contestant));
      } else if (phase === "results") {
        detail = `Floor ${roundNumber}: +${formatSeconds(contestant.state.scoreMs)} · ${completedRounds}/${totalRounds} cleared`;
        score = formatSeconds(contestant.totalScoreMs);
      }
      const rank = isSpectating ? "&#9673;" : showRanks ? contestant.rank : "·";
      const content = `
          <span class="rank">${rank}</span>
          <span class="player-dot" style="color:${contestant.color};background:${contestant.color}"></span>
          <span class="leader-info"><strong>${contestant.name}</strong><small>${detail}</small></span>
          <span class="leader-score">${score}</span>`;
      const spectateLabel = contestant.isPlayer
        ? "Spectate your maze"
        : `Spectate ${contestant.name}'s maze`;
      return canSpectate
        ? `<button class="leader-row spectate-button${contestant.isPlayer ? " you" : ""}${isSpectating ? " spectating" : ""}" type="button" data-spectate-id="${contestant.id}" aria-pressed="${isSpectating}" aria-label="${spectateLabel}">${content}</button>`
        : `<div class="leader-row${contestant.isPlayer ? " you" : ""}"${contestant.isPlayer ? ' aria-current="true"' : ""}>${content}</div>`;
    })
    .join("");
}

function leaderboardKey() {
  const stateKey = phase === "run"
    ? spectatedContestantId
    : phase === "build" || phase === "welcome"
      ? playerState.revision
      : completedRounds;
  return `${phase}:${roundNumber}:${stateKey}`;
}

function updateRunningLeaderboardValues() {
  const rows = new Map(
    [...dom.leaderboard.querySelectorAll("[data-spectate-id]")].map((row) => [
      row.dataset.spectateId,
      row,
    ]),
  );
  for (const contestant of allContestants()) {
    const row = rows.get(contestant.id);
    if (!row) continue;
    const values = runningLeaderboardValues(contestant);
    row.querySelector(".leader-info small").textContent = values.detail;
    row.querySelector(".leader-score").textContent = values.score;
  }
}

function updateLeaderboard() {
  const nextKey = leaderboardKey();
  if (nextKey !== leaderboardRenderKey) {
    const focusedSpectateId = dom.leaderboard.contains(document.activeElement)
      ? document.activeElement.dataset.spectateId
      : null;
    dom.leaderboard.innerHTML = leaderboardMarkup();
    leaderboardRenderKey = nextKey;
    if (focusedSpectateId) {
      [...dom.leaderboard.querySelectorAll("[data-spectate-id]")]
        .find((button) => button.dataset.spectateId === focusedSpectateId)
        ?.focus({ preventScroll: true });
    }
  }
  if (phase === "run") updateRunningLeaderboardValues();
}

function updateInterface(force = false) {
  const uiTick = phase === "run" ? Math.floor(runElapsedMs / 100) : Math.ceil(buildRemainingMs / 1000);
  if (!force && uiTick === lastUiTick) return;
  lastUiTick = uiTick;
  document.body.dataset.phase = phase;

  const viewedContestant = displayedContestant();
  const viewedState = viewedContestant.state;

  dom.gold.textContent = Math.round(viewedState.gold);
  dom.tears.textContent = Math.round(viewedState.tears ?? 0);
  dom.timer.textContent = phase === "build"
    ? formatClock(buildRemainingMs)
    : phase === "welcome"
      ? formatClock(currentFloor.buildDurationMs)
      : "0:00";
  const augmentNames = activeAugmentNames();
  dom.augmentValue.textContent = String(augmentNames.length);
  dom.activeAugmentChip.title = augmentNames.length > 0
    ? `Active augments: ${augmentNames.join(", ")}`
    : "No augments selected yet";
  const speedTowersConverted = selectedAugments.includes(AUGMENT_IDS.CORRUPT_SPEED);
  dom.speedTowerNote.hidden = speedTowersConverted;
  dom.speedTowerRule.hidden = speedTowersConverted;
  dom.slowTowerRule.innerHTML = selectedAugments.includes(AUGMENT_IDS.WIDE_LAMENT)
    ? "<b>Tower of Lament:</b> any adjacent tile, including diagonals, triggers 50% speed for 5 seconds, followed by its 5-second recharge."
    : "<b>Tower of Lament:</b> an orthogonally adjacent tile triggers 50% speed for 5 seconds, followed by its 5-second recharge.";
  dom.route.textContent = formatDistance(routeDistance(viewedState));
  dom.estimate.textContent = (viewedState.scoreMs / 1000).toFixed(1);
  dom.placed.textContent = placedPieceCount(viewedState);
  const baseline = initialPlayerState.routeMetrics;
  const extraDistance = routeDistance(viewedState) - (baseline.distance ?? baseline.steps);
  const slowingPulses = slowApplicationCount(viewedState);
  const speedBoosts = speedApplicationCount(viewedState);
  const meter = Math.min(
    100,
    Math.max(8, (viewedState.scoreMs / Math.max(1, initialPlayerState.scoreMs * 2.5)) * 100),
  );
  dom.scoreMeter.style.width = `${meter}%`;
  const scoreNotes = [];
  if (extraDistance > 0.005) scoreNotes.push(`${formatDistance(extraDistance)} extra tiles`);
  if (slowingPulses > 0) {
    scoreNotes.push(`${slowingPulses} slowing pulse${slowingPulses === 1 ? "" : "s"}`);
  }
  if (speedBoosts > 0) {
    scoreNotes.push(`${speedBoosts} speed boost${speedBoosts === 1 ? "" : "s"}`);
  }
  dom.scoreCaption.textContent =
    scoreNotes.length > 0
      ? `${viewedContestant.isPlayer ? "Current route" : `${viewedContestant.name}'s route`}: ${scoreNotes.join(" · ")}.`
      : viewedContestant.isPlayer
        ? "Build detours, add slowing pulses, and steer clear of speed boosts."
        : `${viewedContestant.name}'s route has no added distance or tower effects.`;

  if (phase === "build" || phase === "welcome") {
    dom.phaseKicker.textContent = `Floor ${roundNumber} of ${totalRounds} · ${currentFloor.width}×${currentFloor.height} · Build phase`;
    dom.phaseTitle.textContent = "Make their journey miserable.";
    const shapeName = (MAP_SHAPE_LABELS[playerState.mapShape] ?? playerState.mapShape).toLowerCase();
    dom.phaseDescription.textContent = playerState.endlessFeast
      ? `Route every runner through Endless Feast before the portal on this ${shapeName} field. You may build around it, but one side and both route legs must stay open.`
      : `Shape a route across this ${shapeName} field, but always leave one way from the gate to the portal. Every second adds to your run total.`;
    dom.runButton.innerHTML = 'Release runners <span aria-hidden="true">▶</span>';
    dom.standingNote.textContent = `Floor ${roundNumber}/${totalRounds}`;
  } else if (phase === "countdown") {
    dom.phaseKicker.textContent = `Floor ${roundNumber} of ${totalRounds} · Mazes locked`;
    dom.phaseTitle.textContent = "The runners take their marks.";
    dom.phaseDescription.textContent = "Every route is fixed. No more obstacles may be placed.";
    dom.runButton.textContent = "Mazes locked";
    dom.standingNote.textContent = "Ready";
  } else if (phase === "run") {
    dom.phaseKicker.textContent = `Floor ${roundNumber} of ${totalRounds} · Race underway`;
    dom.phaseTitle.textContent = viewedContestant.isPlayer
      ? "Every wasted second counts."
      : `Watching ${viewedContestant.name}'s maze.`;
    dom.phaseDescription.textContent = `${viewedContestant.isPlayer ? "Your" : `${viewedContestant.name}'s`} runner follows its deterministic shortest route. Choose any contestant to switch mazes.`;
    dom.runButton.textContent = "Runners moving";
    dom.standingNote.textContent = "Choose to watch";
  } else {
    dom.phaseKicker.textContent = contestIsComplete()
      ? `Run complete · ${totalRounds} floors`
      : `Floor ${roundNumber} of ${totalRounds} · Complete`;
    dom.phaseTitle.textContent = contestIsComplete() ? "The descent has spoken." : "The floor has spoken.";
    dom.phaseDescription.textContent = contestIsComplete()
      ? "The highest cumulative runner time wins the run."
      : "Choose one lasting augment before descending to the next floor.";
    dom.runButton.textContent = contestIsComplete() ? "Run complete" : "Floor complete";
    dom.standingNote.textContent = "Cumulative";
  }

  dom.mazeOwnerHeading.textContent = phase === "run" && !viewedContestant.isPlayer
    ? `${viewedContestant.name}'s maze`
    : "Your maze";
  dom.spectateHint.hidden = phase !== "run";
  dom.spectateFooterHint.hidden = phase !== "run";
  for (const hint of dom.buildHints) hint.hidden = phase === "run";
  if (phase === "run") {
    dom.mapNote.textContent = `Watching: ${viewedContestant.name}`;
  } else {
    dom.mapNote.innerHTML = 'Entrance <span aria-hidden="true">→</span> Portal';
  }

  const controlsLocked = phase !== "build";
  dom.runButton.disabled = controlsLocked;
  dom.undoButton.disabled = controlsLocked || actionHistory.length === 0;
  for (const card of dom.toolCards) {
    const tool = playerTool(card.dataset.tool);
    const selected = card.dataset.tool === selectedToolId;
    const locked = controlsLocked || !canAffordTool(tool, playerState);
    card.classList.toggle("selected", selected);
    card.classList.toggle("locked", locked);
    card.setAttribute("aria-pressed", String(selected));
    card.disabled = locked;
    card.setAttribute("aria-disabled", String(locked));
    const costLabel = card.querySelector("[data-tool-cost]");
    if (costLabel) costLabel.textContent = `${tool.cost} ◆`;
    if (tool.id === "slowTower") {
      card.title = selectedAugments.includes(AUGMENT_IDS.WIDE_LAMENT)
        ? "Costs 1 Tear. Slows a runner entering any of the eight adjacent tiles."
        : "Costs 1 Tear. Slows a runner entering an orthogonally adjacent tile.";
    }
  }
  dom.rotationHint.textContent = phase === "run"
    ? `Watching ${viewedContestant.name} · select a contestant to switch`
    : phase !== "build" && phase !== "welcome"
      ? "Mazes locked"
      : selectedToolId === DEMOLISH_TOOL.id
        ? `Select a generated object · ${DEMOLISH_TOOL.cost} gold`
        : playerTool(selectedToolId).rotations > 1
          ? "R to rotate"
          : "Choose a multi-tile piece to rotate";
  updateLeaderboard();
}

async function releaseRunners() {
  if (phase !== "build") return;
  phase = "countdown";
  buildRemainingMs = Math.max(0, buildDeadline - performance.now());
  hoverCell = null;
  previewCache = null;
  const token = ++phaseToken;
  updateInterface(true);
  tone("lock");

  for (const label of ["3", "2", "1"]) {
    if (token !== phaseToken) return;
    dom.phaseBanner.textContent = label;
    await delay(620);
  }
  if (token !== phaseToken) return;
  dom.phaseBanner.textContent = "Run!";
  phase = "run";
  runStartedAt = performance.now();
  runElapsedMs = 0;
  tone("run");
  updateInterface(true);
  window.setTimeout(() => {
    if (phase === "run") dom.phaseBanner.textContent = "";
  }, 900);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function finishRound() {
  if (phase !== "run") return;
  phase = "results";
  spectatedContestantId = "player";
  document.body.dataset.spectating = spectatedContestantId;
  updateCanvasLabel();
  recordCompletedRound();
  const roundRanking = rankedContestants();
  const roundWinners = roundRanking.filter((entry) => entry.rank === 1);
  const playerRoundResult = roundRanking.find((entry) => entry.isPlayer);
  const cumulativeRanking = rankedCumulativeContestants();
  const cumulativeWinners = cumulativeRanking.filter((entry) => entry.rank === 1);
  const playerCumulativeResult = cumulativeRanking.find((entry) => entry.isPlayer);
  const complete = contestIsComplete();
  const roundWon = roundWinners.some((entry) => entry.isPlayer);
  const contestWon = cumulativeWinners.some((entry) => entry.isPlayer);
  const names = (entries) => {
    const values = entries.map((entry) => entry.name);
    if (values.length <= 1) return values[0] ?? "Nobody";
    return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
  };

  dom.phaseBanner.textContent = complete ? "Run complete" : "Floor complete";
  document.body.dataset.contestComplete = String(complete);
  dom.resultEmblem.textContent = complete && contestWon ? "♛" : roundWon ? "♛" : "◆";

  if (complete) {
    const sharedContest = cumulativeWinners.length > 1;
    dom.resultEyebrow.textContent = `Run complete · ${totalRounds} floors cleared`;
    dom.resultTitle.textContent = contestWon
      ? sharedContest
        ? "You share the run victory."
        : "You conquered the descent."
      : sharedContest
        ? `${names(cumulativeWinners)} share the run.`
        : `${cumulativeWinners[0].name} conquers the run.`;
    dom.resultCopy.textContent = contestWon
      ? `Your runners accumulated ${formatSeconds(playerCumulativeResult.totalScoreMs)} across all ${completedRounds} floors${sharedContest ? ", tying for the highest total" : " — the highest cumulative time in the field"}.`
      : `Your cumulative time was ${formatSeconds(playerCumulativeResult.totalScoreMs)}, placing ${playerCumulativeResult.rank}${ordinalSuffix(playerCumulativeResult.rank)} overall. ${names(cumulativeWinners)} finished with ${formatSeconds(cumulativeWinners[0].totalScoreMs)}.`;
    dom.nextRoundButton.textContent = "Begin a new run";
    dom.replayRoundButton.textContent = "Replay final floor as a new run";
    dom.resultShareButton.textContent = "Copy my score challenge";
  } else {
    const sharedRound = roundWinners.length > 1;
    dom.resultEyebrow.textContent = `Floor ${roundNumber} of ${totalRounds} cleared`;
    dom.resultTitle.textContent = roundWon
      ? sharedRound
        ? "A hard-earned floor tie."
        : "You take the floor."
      : sharedRound
        ? `${names(roundWinners)} share the floor.`
        : `${roundWinners[0].name} takes the floor.`;
    dom.resultCopy.textContent = `You banked ${formatSeconds(playerRoundResult.state.scoreMs)} on this floor for ${formatSeconds(playerCumulativeResult.totalScoreMs)} total. ${names(cumulativeWinners)} ${cumulativeWinners.length === 1 ? "leads" : "lead"} the run with ${formatSeconds(cumulativeWinners[0].totalScoreMs)}.`;
    dom.nextRoundButton.textContent = "Choose an augment";
    dom.replayRoundButton.textContent = "Replay floor as a new run";
    dom.resultShareButton.textContent = "Copy challenge link";
  }

  dom.challengeResult.hidden = !complete || challengeTargetMs === null;
  if (complete && challengeTargetMs !== null) {
    const difference = playerCumulativeResult.totalScoreMs - challengeTargetMs;
    dom.challengeResult.textContent = difference > 0
      ? `Friend challenge beaten by ${formatSeconds(difference)}.`
      : difference === 0
        ? `You matched the ${formatSeconds(challengeTargetMs)} friend challenge exactly.`
        : `The friend challenge was ${formatSeconds(-difference)} out of reach.`;
    dom.challengeResult.classList.toggle("won", difference >= 0);
  }

  dom.resultBoard.innerHTML = cumulativeRanking
    .map(
      (entry) => `
        <div${entry.isPlayer ? ' class="you"' : ""}>
          <span>${entry.rank}</span>
          <span>${entry.name}<small>Floor ${roundNumber}: +${formatSeconds(entry.state.scoreMs)} · ${completedRounds}/${totalRounds} cleared</small></span>
          <strong>${formatSeconds(entry.totalScoreMs)}</strong>
        </div>`,
    )
    .join("");
  updateInterface(true);
  openModal(dom.resultModal, dom.nextRoundButton);
  tone((complete ? contestWon : roundWon) ? "win" : "finish");
}

function ordinalSuffix(value) {
  if (value % 100 >= 11 && value % 100 <= 13) return "th";
  return value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
}

function ensureAudio() {
  if (audioContext) return audioContext;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  audioContext = new AudioContext();
  return audioContext;
}

function tone(kind) {
  const audio = ensureAudio();
  if (!audio || audio.state === "suspended") audio?.resume();
  if (!audio) return;
  const notes = {
    select: [310, 0.035, 0.025],
    place: [170, 0.07, 0.045],
    remove: [130, 0.06, 0.035],
    reject: [78, 0.11, 0.045],
    start: [220, 0.1, 0.035],
    lock: [110, 0.18, 0.05],
    run: [330, 0.16, 0.05],
    finish: [180, 0.18, 0.045],
    win: [440, 0.25, 0.05],
  };
  const [frequency, duration, volume] = notes[kind] ?? notes.select;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = kind === "reject" ? "sawtooth" : "triangle";
  oscillator.frequency.setValueAtTime(frequency, audio.currentTime);
  if (kind === "win") oscillator.frequency.exponentialRampToValueAtTime(660, audio.currentTime + duration);
  gain.gain.setValueAtTime(volume, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + duration);
}

function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (dom.canvas.width !== width || dom.canvas.height !== height) {
    dom.canvas.width = width;
    dom.canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const paddingX = Math.max(22, rect.width * 0.045);
  const paddingY = Math.max(28, rect.height * 0.07);
  const boardState = renderState ?? displayedContestant().state;
  const gridWidth = boardState.width;
  const gridHeight = boardState.height;
  const cellSize = Math.min(
    (rect.width - paddingX * 2) / gridWidth,
    (rect.height - paddingY * 2) / gridHeight,
  );
  const boardWidth = cellSize * gridWidth;
  const boardHeight = cellSize * gridHeight;
  geometry = {
    width: rect.width,
    height: rect.height,
    cell: cellSize,
    left: (rect.width - boardWidth) / 2,
    top: (rect.height - boardHeight) / 2,
    boardWidth,
    boardHeight,
  };
  canvasNeedsResize = false;
}

function canvasCellFromPointer(event) {
  if (!geometry || canvasNeedsResize) resizeCanvas();
  const rect = dom.canvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  const x = Math.floor((localX - geometry.left) / geometry.cell);
  const y = Math.floor((localY - geometry.top) / geometry.cell);
  if (x < 0 || y < 0 || x >= playerState.width || y >= playerState.height) return null;
  return { x, y };
}

function cellCenter(cell) {
  return {
    x: geometry.left + (cell.x + 0.5) * geometry.cell,
    y: geometry.top + (cell.y + 0.5) * geometry.cell,
  };
}

function hashNoise(x, y, salt = 0) {
  let value = (x + 17) * 374761393 + (y + 31) * 668265263 + salt * 69069;
  value = (value ^ (value >>> 13)) * 1274126177;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function drawGround(now) {
  const { left, top, boardWidth, boardHeight, cell } = geometry;
  const voidKeys = new Set((renderState.voidCells ?? []).map(cellKey));
  const playableCells = [];
  for (let y = 0; y < renderState.height; y += 1) {
    for (let x = 0; x < renderState.width; x += 1) {
      if (!voidKeys.has(`${x},${y}`)) playableCells.push({ x, y });
    }
  }
  const gradient = context.createLinearGradient(left, top, left + boardWidth, top + boardHeight);
  gradient.addColorStop(0, "#435432");
  gradient.addColorStop(0.52, "#35452b");
  gradient.addColorStop(1, "#283721");
  context.fillStyle = "#0e130c";
  context.fillRect(0, 0, geometry.width, geometry.height);
  context.fillStyle = "rgba(3, 7, 3, .58)";
  context.fillRect(left, top, boardWidth, boardHeight);

  context.save();
  context.beginPath();
  for (const playable of playableCells) {
    context.rect(left + playable.x * cell, top + playable.y * cell, cell, cell);
  }
  context.shadowColor = "rgba(0,0,0,.8)";
  context.shadowBlur = 22;
  context.fillStyle = gradient;
  context.fill();
  context.restore();
  context.shadowBlur = 0;

  for (const playable of playableCells) {
    const noise = hashNoise(playable.x, playable.y, roundSeed.length);
    context.fillStyle = noise > 0.56 ? "rgba(196,176,108,.035)" : "rgba(4,18,5,.045)";
    context.fillRect(left + playable.x * cell, top + playable.y * cell, cell, cell);
    if (noise > 0.81) {
      context.fillStyle = "rgba(210,198,127,.16)";
      const px = left + (playable.x + 0.25 + noise * 0.4) * cell;
      const py = top + (playable.y + 0.32) * cell;
      context.fillRect(px, py, Math.max(1, cell * 0.035), Math.max(1, cell * 0.035));
    }
  }

  const vignette = context.createRadialGradient(
    geometry.width / 2,
    geometry.height / 2,
    Math.min(boardWidth, boardHeight) * 0.2,
    geometry.width / 2,
    geometry.height / 2,
    Math.max(boardWidth, boardHeight) * 0.65,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.34)");
  context.save();
  context.beginPath();
  for (const playable of playableCells) {
    context.rect(left + playable.x * cell, top + playable.y * cell, cell, cell);
  }
  context.clip();
  context.fillStyle = vignette;
  context.fillRect(left, top, boardWidth, boardHeight);
  context.restore();

  context.strokeStyle = "rgba(229,207,142,.14)";
  context.lineWidth = 1;
  context.beginPath();
  for (const playable of playableCells) {
    context.rect(
      Math.round(left + playable.x * cell) + 0.5,
      Math.round(top + playable.y * cell) + 0.5,
      cell,
      cell,
    );
  }
  context.stroke();

  context.strokeStyle = "rgba(222,169,78,.5)";
  context.lineWidth = 2;
  context.beginPath();
  const edgeDirections = [
    { x: 0, y: -1, from: [0, 0], to: [1, 0] },
    { x: 1, y: 0, from: [1, 0], to: [1, 1] },
    { x: 0, y: 1, from: [1, 1], to: [0, 1] },
    { x: -1, y: 0, from: [0, 1], to: [0, 0] },
  ];
  for (const playable of playableCells) {
    for (const edge of edgeDirections) {
      const neighborX = playable.x + edge.x;
      const neighborY = playable.y + edge.y;
      const neighborOutside =
        neighborX < 0 ||
        neighborY < 0 ||
        neighborX >= renderState.width ||
        neighborY >= renderState.height ||
        voidKeys.has(`${neighborX},${neighborY}`);
      if (!neighborOutside) continue;
      context.moveTo(
        left + (playable.x + edge.from[0]) * cell,
        top + (playable.y + edge.from[1]) * cell,
      );
      context.lineTo(
        left + (playable.x + edge.to[0]) * cell,
        top + (playable.y + edge.to[1]) * cell,
      );
    }
  }
  context.stroke();
  void now;
}

function drawRoute(now) {
  const route = renderState.route;
  if (!route?.length) return;
  context.save();
  context.beginPath();
  route.forEach((cell, index) => {
    const point = cellCenter(cell);
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.setLineDash([geometry.cell * 0.18, geometry.cell * 0.16]);
  context.lineDashOffset = -(now / 80) % (geometry.cell * 0.34);
  context.strokeStyle = "rgba(249,211,108,.62)";
  context.lineWidth = Math.max(2, geometry.cell * 0.1);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "rgba(239,181,55,.55)";
  context.shadowBlur = geometry.cell * 0.18;
  context.stroke();
  context.restore();
}

function drawRock(cell) {
  const { x, y } = cellCenter(cell);
  const size = geometry.cell * 0.36;
  const noise = hashNoise(cell.x, cell.y, 9);
  context.save();
  context.translate(x, y + size * 0.12);
  context.rotate((noise - 0.5) * 0.35);
  context.shadowColor = "rgba(0,0,0,.65)";
  context.shadowBlur = size * 0.35;
  context.shadowOffsetY = size * 0.25;
  context.beginPath();
  context.moveTo(-size, size * 0.45);
  context.lineTo(-size * 0.75, -size * 0.52);
  context.lineTo(-size * 0.15, -size);
  context.lineTo(size * 0.72, -size * 0.58);
  context.lineTo(size, size * 0.35);
  context.lineTo(size * 0.35, size * 0.82);
  context.closePath();
  const gradient = context.createLinearGradient(-size, -size, size, size);
  gradient.addColorStop(0, "#8b8a77");
  gradient.addColorStop(0.45, "#56594d");
  gradient.addColorStop(1, "#30372f");
  context.fillStyle = gradient;
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(215,207,167,.23)";
  context.lineWidth = Math.max(1, geometry.cell * 0.025);
  context.stroke();
  context.restore();
}

function drawCrate(cell) {
  const point = cellCenter(cell);
  const size = geometry.cell * 0.68;
  const left = point.x - size / 2;
  const top = point.y - size / 2;
  context.save();
  context.shadowColor = "rgba(0,0,0,.65)";
  context.shadowBlur = size * 0.2;
  context.shadowOffsetY = size * 0.12;
  const gradient = context.createLinearGradient(left, top, left + size, top + size);
  gradient.addColorStop(0, "#9b6530");
  gradient.addColorStop(0.55, "#68401f");
  gradient.addColorStop(1, "#3e2616");
  context.fillStyle = gradient;
  context.fillRect(left, top, size, size);
  context.shadowBlur = 0;
  context.strokeStyle = "#d19a52";
  context.lineWidth = Math.max(1.5, size * 0.07);
  context.strokeRect(left, top, size, size);
  context.beginPath();
  context.moveTo(left + size * 0.08, top + size * 0.08);
  context.lineTo(left + size * 0.92, top + size * 0.92);
  context.moveTo(left + size * 0.92, top + size * 0.08);
  context.lineTo(left + size * 0.08, top + size * 0.92);
  context.strokeStyle = "rgba(54,30,15,.8)";
  context.lineWidth = Math.max(2, size * 0.105);
  context.stroke();
  context.restore();
}

function drawFence(cell, obstacle) {
  const point = cellCenter(cell);
  const size = geometry.cell;
  const group = renderState.obstacles.filter((entry) => entry.groupId === obstacle.groupId);
  const horizontal = group.some((entry) => entry.y === cell.y && entry.x !== cell.x);
  context.save();
  context.translate(point.x, point.y);
  if (!horizontal) context.rotate(Math.PI / 2);
  context.shadowColor = "rgba(0,0,0,.7)";
  context.shadowBlur = size * 0.12;
  context.strokeStyle = "#4b2d17";
  context.lineWidth = size * 0.2;
  for (const offset of [-0.2, 0.2]) {
    context.beginPath();
    context.moveTo(-size * 0.5, size * offset);
    context.lineTo(size * 0.5, size * offset);
    context.stroke();
  }
  context.shadowBlur = 0;
  context.strokeStyle = "#a46c32";
  context.lineWidth = size * 0.1;
  for (const offset of [-0.2, 0.2]) {
    context.beginPath();
    context.moveTo(-size * 0.5, size * offset - 1);
    context.lineTo(size * 0.5, size * offset - 1);
    context.stroke();
  }
  context.fillStyle = "#79502a";
  context.fillRect(-size * 0.08, -size * 0.42, size * 0.16, size * 0.84);
  context.fillStyle = "#c18a45";
  context.fillRect(-size * 0.045, -size * 0.39, size * 0.04, size * 0.75);
  context.restore();
}

function drawTower(cell) {
  const point = cellCenter(cell);
  const size = geometry.cell * 0.72;
  const left = point.x - size / 2;
  const top = point.y - size / 2;
  context.save();
  context.shadowColor = "rgba(0,0,0,.7)";
  context.shadowBlur = size * 0.18;
  context.shadowOffsetY = size * 0.12;
  const gradient = context.createLinearGradient(left, top, left + size, top + size);
  gradient.addColorStop(0, "#81765d");
  gradient.addColorStop(1, "#393c35");
  context.fillStyle = gradient;
  context.fillRect(left, top + size * 0.14, size, size * 0.78);
  const tooth = size / 5;
  for (let index = 0; index < 5; index += 2) {
    context.fillRect(left + index * tooth, top, tooth, size * 0.28);
  }
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(225,211,168,.32)";
  context.lineWidth = Math.max(1, size * 0.035);
  context.strokeRect(left, top + size * 0.14, size, size * 0.78);
  context.fillStyle = "#171a17";
  context.beginPath();
  context.arc(point.x, top + size * 0.66, size * 0.13, Math.PI, 0);
  context.lineTo(point.x + size * 0.13, top + size * 0.91);
  context.lineTo(point.x - size * 0.13, top + size * 0.91);
  context.closePath();
  context.fill();
  context.restore();
}

function slowTowerEntries() {
  return [
    ...(renderState.baseSlowTowers ?? []).map((cell) => ({
      ...cell,
      id: `neutral:${cellKey(cell)}`,
      neutral: true,
    })),
    ...renderState.obstacles
      .filter((obstacle) => obstacle.groupType === "slow-tower")
      .map((obstacle) => ({
        ...obstacle,
        id: obstacle.groupId ?? `built:${cellKey(obstacle)}`,
        neutral: false,
      })),
  ];
}

function speedTowerEntries() {
  return (renderState.baseSpeedTowers ?? []).map((cell) => ({
    ...cell,
    id: `speed:${cellKey(cell)}`,
    neutral: true,
  }));
}

function drawSlowTowerInfluence(now) {
  const pulse = 0.035 + (Math.sin(now / 420) + 1) * 0.015;
  const influenceOffsets = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    ...(renderState.rules.slowTowerAffectsDiagonals
      ? [
          { x: 1, y: 1 },
          { x: 1, y: -1 },
          { x: -1, y: 1 },
          { x: -1, y: -1 },
        ]
      : []),
  ];
  context.save();
  for (const tower of slowTowerEntries()) {
    for (const offset of influenceOffsets) {
      const cell = { x: tower.x + offset.x, y: tower.y + offset.y };
      if (!isPlayableCell(renderState, cell)) continue;
      const x = geometry.left + cell.x * geometry.cell;
      const y = geometry.top + cell.y * geometry.cell;
      context.fillStyle = `rgba(119, 121, 230, ${pulse})`;
      context.fillRect(x + 2, y + 2, geometry.cell - 4, geometry.cell - 4);
      context.strokeStyle = "rgba(151, 166, 255, .18)";
      context.lineWidth = 1;
      context.strokeRect(x + 3.5, y + 3.5, geometry.cell - 7, geometry.cell - 7);
    }
  }
  if (phase === "run") {
    for (const application of renderState.runnerSimulation?.slowApplications ?? []) {
      const age = runElapsedMs - application.atMs;
      if (age < 0 || age > 420) continue;
      const amount = age / 420;
      const from = cellCenter(application.tower);
      const to = cellCenter(application.cell);
      context.strokeStyle = `rgba(174, 198, 255, ${0.9 * (1 - amount)})`;
      context.lineWidth = Math.max(2, geometry.cell * 0.07 * (1 - amount * 0.5));
      context.shadowColor = "rgba(100, 119, 255, .9)";
      context.shadowBlur = geometry.cell * 0.18;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.shadowBlur = 0;
    }
  }
  context.restore();
}

function drawSpeedTowerInfluence(now) {
  const pulse = 0.028 + (Math.sin(now / 300) + 1) * 0.018;
  context.save();
  for (const tower of speedTowerEntries()) {
    for (const offset of [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]) {
      const cell = { x: tower.x + offset.x, y: tower.y + offset.y };
      if (!isPlayableCell(renderState, cell)) continue;
      const x = geometry.left + cell.x * geometry.cell;
      const y = geometry.top + cell.y * geometry.cell;
      context.fillStyle = `rgba(94, 225, 141, ${pulse})`;
      context.fillRect(x + 2, y + 2, geometry.cell - 4, geometry.cell - 4);
      context.strokeStyle = "rgba(139, 244, 171, .2)";
      context.lineWidth = 1;
      context.strokeRect(x + 3.5, y + 3.5, geometry.cell - 7, geometry.cell - 7);
    }
  }
  if (phase === "run") {
    for (const application of renderState.runnerSimulation?.speedApplications ?? []) {
      const age = runElapsedMs - application.atMs;
      if (age < 0 || age > 420) continue;
      const amount = age / 420;
      const from = cellCenter(application.tower);
      const to = cellCenter(application.cell);
      context.strokeStyle = `rgba(156, 255, 181, ${0.92 * (1 - amount)})`;
      context.lineWidth = Math.max(2, geometry.cell * 0.075 * (1 - amount * 0.45));
      context.shadowColor = "rgba(68, 235, 137, .95)";
      context.shadowBlur = geometry.cell * 0.22;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.shadowBlur = 0;
    }
  }
  context.restore();
}

function drawSlowTower(cell, now) {
  const point = cellCenter(cell);
  const size = geometry.cell;
  const pulse = 1 + Math.sin(now / 310 + cell.x * 0.7 + cell.y) * 0.06;
  context.save();
  context.translate(point.x, point.y);
  context.shadowColor = "rgba(101, 126, 255, .72)";
  context.shadowBlur = size * 0.3 * pulse;
  context.fillStyle = "rgba(116, 130, 235, .25)";
  context.beginPath();
  context.arc(0, -size * 0.05, size * 0.34 * pulse, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;

  const baseGradient = context.createLinearGradient(-size * 0.3, 0, size * 0.3, size * 0.34);
  baseGradient.addColorStop(0, cell.neutral ? "#8c8b9a" : "#685d86");
  baseGradient.addColorStop(1, "#292838");
  context.fillStyle = baseGradient;
  context.beginPath();
  context.moveTo(-size * 0.31, size * 0.31);
  context.lineTo(-size * 0.23, size * 0.06);
  context.lineTo(size * 0.23, size * 0.06);
  context.lineTo(size * 0.31, size * 0.31);
  context.closePath();
  context.fill();
  context.strokeStyle = "rgba(206, 213, 255, .34)";
  context.lineWidth = Math.max(1, size * 0.025);
  context.stroke();

  const crystal = context.createLinearGradient(0, -size * 0.42, 0, size * 0.12);
  crystal.addColorStop(0, "#e0e4ff");
  crystal.addColorStop(0.45, "#8cbcff");
  crystal.addColorStop(1, "#6752bd");
  context.fillStyle = crystal;
  context.shadowColor = "rgba(132, 188, 255, .9)";
  context.shadowBlur = size * 0.2;
  context.beginPath();
  context.moveTo(0, -size * 0.44 * pulse);
  context.bezierCurveTo(size * 0.22, -size * 0.18, size * 0.18, size * 0.02, 0, size * 0.11);
  context.bezierCurveTo(-size * 0.18, size * 0.02, -size * 0.22, -size * 0.18, 0, -size * 0.44 * pulse);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(240, 244, 255, .78)";
  context.stroke();

  if (phase === "run") {
    const application = [...(renderState.runnerSimulation?.slowApplications ?? [])]
      .reverse()
      .find(
        (entry) =>
          entry.atMs <= runElapsedMs &&
          entry.tower.x === cell.x &&
          entry.tower.y === cell.y,
      );
    const cooldownMs = renderState.rules.slowTowerCooldownMs ?? 5_000;
    const remainingMs = application
      ? Math.max(0, application.atMs + cooldownMs - runElapsedMs)
      : 0;
    if (remainingMs > 0 && cooldownMs > 0) {
      const remainingRatio = remainingMs / cooldownMs;
      context.strokeStyle = "rgba(218, 224, 255, .92)";
      context.lineWidth = Math.max(2, size * 0.055);
      context.beginPath();
      context.arc(
        0,
        0,
        size * 0.42,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * remainingRatio,
      );
      context.stroke();
    }
  }
  context.restore();
}

function drawSpeedTower(cell, now) {
  const point = cellCenter(cell);
  const size = geometry.cell;
  const pulse = 1 + Math.sin(now / 230 + cell.x * 0.55 + cell.y * 0.8) * 0.07;
  context.save();
  context.translate(point.x, point.y);

  const aura = context.createRadialGradient(0, -size * 0.08, 0, 0, -size * 0.08, size * 0.48);
  aura.addColorStop(0, "rgba(151, 255, 174, .38)");
  aura.addColorStop(0.46, "rgba(64, 224, 132, .18)");
  aura.addColorStop(1, "rgba(40, 184, 112, 0)");
  context.fillStyle = aura;
  context.beginPath();
  context.arc(0, -size * 0.06, size * 0.48 * pulse, 0, Math.PI * 2);
  context.fill();

  context.shadowColor = "rgba(47, 231, 135, .7)";
  context.shadowBlur = size * 0.24 * pulse;
  const baseGradient = context.createLinearGradient(-size * 0.3, 0, size * 0.3, size * 0.34);
  baseGradient.addColorStop(0, "#718276");
  baseGradient.addColorStop(1, "#28352e");
  context.fillStyle = baseGradient;
  context.beginPath();
  context.moveTo(-size * 0.32, size * 0.31);
  context.lineTo(-size * 0.23, size * 0.05);
  context.lineTo(size * 0.23, size * 0.05);
  context.lineTo(size * 0.32, size * 0.31);
  context.closePath();
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(201, 255, 216, .36)";
  context.lineWidth = Math.max(1, size * 0.025);
  context.stroke();

  context.fillStyle = "#173e2b";
  context.fillRect(-size * 0.12, -size * 0.19, size * 0.24, size * 0.28);
  const crystal = context.createLinearGradient(0, -size * 0.45, 0, size * 0.04);
  crystal.addColorStop(0, "#eeffae");
  crystal.addColorStop(0.42, "#71f49c");
  crystal.addColorStop(1, "#20a96d");
  context.fillStyle = crystal;
  context.shadowColor = "rgba(123, 255, 168, .95)";
  context.shadowBlur = size * 0.22;
  context.beginPath();
  context.moveTo(0, -size * 0.46 * pulse);
  context.lineTo(size * 0.18, -size * 0.18);
  context.lineTo(size * 0.09, size * 0.04);
  context.lineTo(-size * 0.09, size * 0.04);
  context.lineTo(-size * 0.18, -size * 0.18);
  context.closePath();
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(239, 255, 220, .82)";
  context.stroke();

  context.rotate(now / 720);
  context.strokeStyle = "rgba(213, 255, 143, .86)";
  context.lineWidth = Math.max(1.5, size * 0.045);
  for (const angle of [0, Math.PI]) {
    context.save();
    context.rotate(angle);
    context.beginPath();
    context.moveTo(size * 0.24, -size * 0.08);
    context.lineTo(size * 0.36, 0);
    context.lineTo(size * 0.24, size * 0.08);
    context.stroke();
    context.restore();
  }
  context.restore();
}

function drawEndlessFeast(cell, now) {
  if (!cell) return;
  const point = cellCenter(cell);
  const size = geometry.cell;
  const pulse = 1 + Math.sin(now / 260) * 0.055;
  context.save();
  context.translate(point.x, point.y);

  const aura = context.createRadialGradient(0, 0, 0, 0, 0, size * 0.58);
  aura.addColorStop(0, "rgba(255, 210, 92, .3)");
  aura.addColorStop(0.55, "rgba(206, 105, 43, .14)");
  aura.addColorStop(1, "rgba(123, 48, 22, 0)");
  context.fillStyle = aura;
  context.beginPath();
  context.arc(0, 0, size * 0.58 * pulse, 0, Math.PI * 2);
  context.fill();

  context.shadowColor = "rgba(255, 177, 60, .72)";
  context.shadowBlur = size * 0.2 * pulse;
  context.fillStyle = "#6d351d";
  context.beginPath();
  context.ellipse(0, size * 0.05, size * 0.39, size * 0.3, 0, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "#d39b45";
  context.lineWidth = Math.max(1.5, size * 0.045);
  context.stroke();

  context.fillStyle = "#d9c28d";
  context.beginPath();
  context.ellipse(0, 0, size * 0.28, size * 0.2, 0, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgba(255, 239, 181, .75)";
  context.lineWidth = Math.max(1, size * 0.025);
  context.stroke();

  context.fillStyle = "#d68038";
  context.beginPath();
  context.ellipse(-size * 0.08, -size * 0.035, size * 0.13, size * 0.085, -0.35, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#7e3b21";
  context.stroke();

  context.fillStyle = "#8d3550";
  for (const [x, y] of [[0.09, -0.07], [0.16, -0.02], [0.08, 0.02], [0.15, 0.07]]) {
    context.beginPath();
    context.arc(size * x, size * y, size * 0.045, 0, Math.PI * 2);
    context.fill();
  }
  context.strokeStyle = "rgba(255, 214, 105, .82)";
  context.lineWidth = Math.max(1, size * 0.025);
  context.beginPath();
  context.arc(0, 0, size * 0.46 * pulse, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawObstacles(now) {
  for (const rock of renderState.baseRocks) drawRock(rock);
  for (const tower of renderState.baseSlowTowers ?? []) drawSlowTower({ ...tower, neutral: true }, now);
  for (const tower of renderState.baseSpeedTowers ?? []) drawSpeedTower({ ...tower, neutral: true }, now);
  drawEndlessFeast(renderState.endlessFeast, now);
  for (const obstacle of renderState.obstacles) {
    if (obstacle.groupType === "fence") drawFence(obstacle, obstacle);
    else if (obstacle.groupType === "tower") drawTower(obstacle);
    else if (obstacle.groupType === "slow-tower") drawSlowTower(obstacle, now);
    else drawCrate(obstacle);
  }
}

function drawEndpoint(cell, kind, now) {
  const point = cellCenter(cell);
  const size = geometry.cell;
  const pulse = 1 + Math.sin(now / 300) * 0.06;
  context.save();
  context.translate(point.x, point.y);
  if (kind === "start") {
    context.fillStyle = "rgba(107,170,88,.18)";
    context.strokeStyle = "#99cb74";
    context.lineWidth = Math.max(2, size * 0.07);
    context.beginPath();
    context.arc(0, 0, size * 0.34 * pulse, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#d9efb7";
    context.beginPath();
    context.moveTo(-size * 0.12, -size * 0.18);
    context.lineTo(size * 0.18, 0);
    context.lineTo(-size * 0.12, size * 0.18);
    context.closePath();
    context.fill();
  } else {
    const glow = context.createRadialGradient(0, 0, 0, 0, 0, size * 0.48);
    glow.addColorStop(0, "rgba(161,218,255,.88)");
    glow.addColorStop(0.35, "rgba(80,139,203,.45)");
    glow.addColorStop(1, "rgba(51,80,131,0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(0, 0, size * 0.48 * pulse, 0, Math.PI * 2);
    context.fill();
    context.rotate(now / 950);
    context.strokeStyle = "#a9d9f4";
    context.lineWidth = Math.max(2, size * 0.06);
    context.beginPath();
    context.arc(0, 0, size * 0.29, 0.35, Math.PI * 1.55);
    context.stroke();
  }
  context.restore();
}

function drawRunner() {
  if (phase !== "run" && phase !== "results") return;
  const animationDuration =
    renderState.runnerSimulation?.exactTravelTimeMs ?? renderState.scoreMs;
  const position = getRunnerPositionAtTime(
    renderState.runnerSimulation,
    Math.min(runElapsedMs, animationDuration),
  );
  if (!position) return;
  const point = cellCenter(position);
  const size = geometry.cell;
  const insatiablyHungry = position.insatiablyHungry === true;
  context.save();
  context.translate(point.x, point.y);
  if (insatiablyHungry) {
    const hungerPulse = 1 + Math.sin(runElapsedMs / 125) * 0.08;
    context.strokeStyle = "rgba(255, 174, 72, .82)";
    context.fillStyle = "rgba(159, 65, 30, .16)";
    context.lineWidth = Math.max(2, size * 0.045);
    context.beginPath();
    context.arc(0, 0, size * 0.43 * hungerPulse, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  if (position.slowed) {
    const slowPulse = 1 + Math.sin(runElapsedMs / 150) * 0.08;
    context.strokeStyle = "rgba(153, 181, 255, .88)";
    context.fillStyle = "rgba(91, 78, 183, .22)";
    context.lineWidth = Math.max(2, size * 0.055);
    context.beginPath();
    context.arc(0, 0, size * 0.33 * slowPulse, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "rgba(209, 215, 255, .86)";
    for (let index = 0; index < 3; index += 1) {
      const angle = runElapsedMs / 430 + (index * Math.PI * 2) / 3;
      context.beginPath();
      context.arc(
        Math.cos(angle) * size * 0.31,
        Math.sin(angle) * size * 0.22,
        size * 0.035,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.fillStyle = "rgba(226, 231, 255, .94)";
    context.font = `800 ${Math.max(8, size * 0.16)}px ui-sans-serif, system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.shadowColor = "rgba(35, 28, 83, .9)";
    context.shadowBlur = 4;
    context.fillText("SLOWED 50%", 0, -size * (position.spedUp ? 0.54 : 0.39));
    context.shadowBlur = 0;
  }
  if (position.spedUp) {
    const speedPulse = 1 + Math.sin(runElapsedMs / 105) * 0.09;
    context.strokeStyle = "rgba(155, 255, 174, .92)";
    context.lineWidth = Math.max(2, size * 0.05);
    context.beginPath();
    context.arc(0, 0, size * 0.38 * speedPulse, -Math.PI * 0.72, Math.PI * 0.72);
    context.stroke();
    context.fillStyle = "rgba(189, 255, 148, .78)";
    for (let index = 0; index < 3; index += 1) {
      const y = (index - 1) * size * 0.12;
      const trail = ((runElapsedMs / 7 + index * size * 0.2) % (size * 0.42)) - size * 0.21;
      context.fillRect(-size * 0.48 - trail, y, size * 0.19, Math.max(1.5, size * 0.025));
    }
    context.fillStyle = "rgba(221, 255, 191, .96)";
    context.font = `800 ${Math.max(8, size * 0.16)}px ui-sans-serif, system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.shadowColor = "rgba(16, 70, 39, .95)";
    context.shadowBlur = 4;
    context.fillText("HASTED +100%", 0, -size * 0.39);
    context.shadowBlur = 0;
  }
  if (insatiablyHungry) {
    const activeStatusCount = Number(position.slowed) + Number(position.spedUp);
    context.fillStyle = "rgba(255, 219, 150, .97)";
    context.font = `800 ${Math.max(8, size * 0.16)}px ui-sans-serif, system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.shadowColor = "rgba(91, 32, 13, .98)";
    context.shadowBlur = 5;
    context.fillText(
      "Insatiable Hunger",
      0,
      -size * (0.39 + activeStatusCount * 0.15),
    );
    context.shadowBlur = 0;
  }
  context.rotate(position.angle + Math.PI / 2);
  context.shadowColor = "rgba(0,0,0,.7)";
  context.shadowBlur = size * 0.14;
  context.fillStyle = renderContestant?.isPlayer
    ? "#a43f2d"
    : renderContestant?.color ?? "#a43f2d";
  context.beginPath();
  context.moveTo(0, size * 0.28);
  context.lineTo(-size * 0.2, -size * 0.05);
  context.lineTo(0, -size * 0.2);
  context.lineTo(size * 0.2, -size * 0.05);
  context.closePath();
  context.fill();
  context.shadowBlur = 0;
  context.fillStyle = "#e6c594";
  context.beginPath();
  context.arc(0, -size * 0.2, size * 0.13, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#f5d16c";
  context.lineWidth = Math.max(1.5, size * 0.045);
  context.beginPath();
  context.arc(0, -size * 0.2, size * 0.17, Math.PI * 1.05, Math.PI * 1.95);
  context.stroke();
  context.restore();
}

function drawPlacementGhost() {
  const preview = currentPreview();
  if (!preview) return;
  const valid = preview.evaluation.ok;
  context.save();
  context.fillStyle = valid ? "rgba(127,190,91,.28)" : "rgba(212,76,57,.3)";
  context.strokeStyle = valid ? "#a8db7d" : "#ef8069";
  context.lineWidth = Math.max(2, geometry.cell * 0.055);
  context.setLineDash([geometry.cell * 0.15, geometry.cell * 0.09]);
  for (const cell of preview.proposal.cells) {
    const x = geometry.left + cell.x * geometry.cell;
    const y = geometry.top + cell.y * geometry.cell;
    context.fillRect(x + 2, y + 2, geometry.cell - 4, geometry.cell - 4);
    context.strokeRect(x + 3, y + 3, geometry.cell - 6, geometry.cell - 6);
  }
  context.restore();
}

function draw(now) {
  renderContestant = displayedContestant();
  renderState = renderContestant.state;
  if (!geometry || canvasNeedsResize) resizeCanvas();
  const animationTime = reducedMotion.matches ? 0 : now;
  context.clearRect(0, 0, geometry.width, geometry.height);
  drawGround(animationTime);
  drawSlowTowerInfluence(animationTime);
  drawSpeedTowerInfluence(animationTime);
  drawRoute(animationTime);
  drawObstacles(animationTime);
  drawEndpoint(renderState.start, "start", animationTime);
  drawEndpoint(renderState.goal, "goal", animationTime);
  drawPlacementGhost();
  drawRunner();
}

function animationFrame(now) {
  if (phase === "build") {
    buildRemainingMs = Math.max(0, buildDeadline - now);
    if (buildRemainingMs <= 0) releaseRunners();
  } else if (phase === "run") {
    runElapsedMs = Math.max(0, now - runStartedAt);
    const longest = Math.max(...allContestants().map((entry) => entry.state.scoreMs));
    if (runElapsedMs >= longest + 500) finishRound();
  }
  updateInterface();
  const drawInterval = reducedMotion.matches
    ? 80
    : phase === "run"
      ? 16
      : phase === "build"
        ? 32
        : 100;
  if (canvasNeedsResize || now - lastCanvasDraw >= drawInterval) {
    draw(now);
    lastCanvasDraw = now;
  }
  window.requestAnimationFrame(animationFrame);
}

dom.toolCards.forEach((card) => {
  card.addEventListener("click", () => selectTool(card.dataset.tool));
});
dom.leaderboard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-spectate-id]");
  if (!button || !dom.leaderboard.contains(button)) return;
  selectSpectatedContestant(button.dataset.spectateId);
});
dom.runButton.addEventListener("click", releaseRunners);
dom.undoButton.addEventListener("click", undoLast);
dom.startButton.addEventListener("click", () => {
  totalRounds = selectedRoundCount();
  updateStartButtonLabel(totalRounds);
  document.body.dataset.contestRounds = String(totalRounds);
  closeModal(dom.welcomeModal);
  beginBuild();
});
dom.nextRoundButton.addEventListener("click", () => {
  closeModal(dom.resultModal, false);
  dom.phaseBanner.textContent = "";
  if (contestIsComplete()) {
    isSharedChallenge = false;
    challengeTargetMs = null;
    dom.roundCount.disabled = true;
    dom.roundCountHelp.textContent = "Four floors. Each grows by 2×2 cells and grants 20 more build seconds.";
    dom.challengeTarget.hidden = true;
    document.body.dataset.sharedChallenge = "false";
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = "";
    cleanUrl.hash = "";
    window.history.replaceState(null, "", cleanUrl);
    prepareContest(makeSeed(), true);
    openModal(dom.welcomeModal, dom.startButton);
  } else {
    openAugmentDraft();
  }
});
dom.replayRoundButton.addEventListener("click", () => {
  const seed = roundSeed;
  closeModal(dom.resultModal, false);
  dom.phaseBanner.textContent = "";
  prepareContest(seed, false);
  window.requestAnimationFrame(() => dom.canvas.focus());
  tone("start");
});
dom.roundCount.addEventListener("change", () => {
  updateStartButtonLabel(selectedRoundCount());
});
dom.shareChallengeButton.addEventListener("click", (event) => {
  copyChallengeLink(event.currentTarget, contestIsComplete());
});
dom.welcomeShareButton.addEventListener("click", (event) => {
  copyChallengeLink(event.currentTarget);
});
dom.resultShareButton.addEventListener("click", (event) => {
  copyChallengeLink(event.currentTarget, contestIsComplete());
});
dom.augmentChoices.addEventListener("click", (event) => {
  const button = event.target.closest("[data-augment]");
  if (!button || !dom.augmentChoices.contains(button)) return;
  chooseAugment(button.dataset.augment);
});

dom.canvas.addEventListener("pointermove", (event) => {
  if (pointerGesture?.id === event.pointerId) {
    pointerGesture.distance = Math.hypot(
      event.clientX - pointerGesture.startX,
      event.clientY - pointerGesture.startY,
    );
  }
  if (event.pointerType === "touch") return;
  hoverCell = canvasCellFromPointer(event);
  if (hoverCell) keyboardCell = { ...hoverCell };
  previewCache = null;
});
dom.canvas.addEventListener("pointerleave", () => {
  if (document.activeElement !== dom.canvas) hoverCell = null;
  previewCache = null;
});
dom.canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  pointerGesture = {
    id: event.pointerId,
    pointerType: event.pointerType,
    startX: event.clientX,
    startY: event.clientY,
    distance: 0,
  };
  if (event.pointerType !== "touch") dom.canvas.setPointerCapture?.(event.pointerId);
});
dom.canvas.addEventListener("pointerup", (event) => {
  if (!pointerGesture || pointerGesture.id !== event.pointerId) return;
  const gesture = pointerGesture;
  pointerGesture = null;
  if (gesture.distance > 9) return;
  const cell = canvasCellFromPointer(event);
  if (!cell) return;
  const occupiedByPlayer = playerState.obstacles.some(
    (entry) => entry.x === cell.x && entry.y === cell.y && entry.owner === "player",
  );
  if (gesture.pointerType === "touch" && occupiedByPlayer) removeAt(cell);
  else placeAt(cell);
});
dom.canvas.addEventListener("pointercancel", (event) => {
  if (pointerGesture?.id === event.pointerId) pointerGesture = null;
});
dom.canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const cell = canvasCellFromPointer(event);
  if (cell) removeTargetAt(cell);
});
dom.canvas.addEventListener("focus", () => {
  hoverCell = { ...keyboardCell };
  previewCache = null;
  announceCursor();
});
dom.canvas.addEventListener("blur", () => {
  hoverCell = null;
  previewCache = null;
});

window.addEventListener("keydown", (event) => {
  if (openDialog()) {
    trapModalFocus(event);
    return;
  }
  if (
    phase === "run" &&
    event.key >= "1" &&
    event.key <= "4" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    event.preventDefault();
    selectSpectatedContestant(allContestants()[Number(event.key) - 1]?.id);
    return;
  }
  if (event.key >= "1" && event.key <= "5" && !event.ctrlKey && !event.metaKey) {
    selectTool(Object.keys(SELECTABLE_TOOLS)[Number(event.key) - 1]);
    return;
  }
  if (event.key.toLowerCase() === "r") {
    rotateTool();
    return;
  }
  if (event.key.toLowerCase() === "u" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z")) {
    event.preventDefault();
    undoLast();
    return;
  }
  if (document.activeElement !== dom.canvas) return;
  const movement = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }[event.key];
  if (movement) {
    event.preventDefault();
    keyboardCell = {
      x: Math.max(0, Math.min(playerState.width - 1, keyboardCell.x + movement[0])),
      y: Math.max(0, Math.min(playerState.height - 1, keyboardCell.y + movement[1])),
    };
    hoverCell = { ...keyboardCell };
    previewCache = null;
    announceCursor();
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    placeAt(keyboardCell);
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    removeTargetAt(keyboardCell);
  }
});

window.addEventListener("resize", () => {
  canvasNeedsResize = true;
});
new ResizeObserver(() => {
  canvasNeedsResize = true;
}).observe(dom.canvas);

const skipIntro = query.has("skipIntro");
dom.roundCount.min = String(RUN_FLOORS);
dom.roundCount.max = String(RUN_FLOORS);
dom.roundCount.value = String(totalRounds);
dom.roundCount.disabled = true;
dom.roundCountHelp.textContent = isSharedChallenge
  ? "Challenge depth is locked: every friend receives the same four-floor run."
  : "Four floors. Each grows by 2×2 cells and grants 20 more build seconds.";
dom.challengeTarget.hidden = challengeTargetMs === null;
if (challengeTargetMs !== null) {
  dom.challengeTarget.textContent = `Friend challenge: beat ${formatSeconds(challengeTargetMs)} across all ${totalRounds} floors.`;
}
document.body.dataset.sharedChallenge = String(isSharedChallenge);
updateStartButtonLabel(totalRounds);
if (skipIntro) dom.welcomeModal.classList.remove("open");
prepareContest(requestedSeed() ?? makeSeed(), !skipIntro);
if (skipIntro) {
  window.requestAnimationFrame(() => dom.canvas.focus());
} else {
  openModal(dom.welcomeModal, dom.startButton);
}
resizeCanvas();
window.requestAnimationFrame(animationFrame);
document.body.dataset.appReady = "true";
