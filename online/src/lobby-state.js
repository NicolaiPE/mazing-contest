import {
  AUGMENTS,
  RUN_FLOORS,
  augmentTierForDraft,
  floorConfig,
  hasAugmentDraftAfterFloor,
} from "../../src/roguelike.js";
import { deriveContestRoundSeed, normalizeChallengeSeed } from "../../src/challenge.js";

export const MAX_LOBBY_PLAYERS = 4;
export const MAX_MAZE_SNAPSHOT_BYTES = 220_000;
export const LOBBY_PHASES = Object.freeze({
  LOBBY: "lobby",
  BUILD: "build",
  REVEAL: "reveal",
});

const PLAYER_COLORS = Object.freeze(["#efc75e", "#7f9d55", "#d6783d", "#9b78b4"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!name) throw new RangeError("Player name is required.");
  return name;
}

function playerById(room, playerId) {
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) throw new RangeError("Player is not part of this lobby.");
  return player;
}

function expectedRoundShape(room) {
  const config = floorConfig(room.floor);
  return {
    seed: deriveContestRoundSeed(room.contestSeed, room.floor),
    width: config.width,
    height: config.height,
  };
}

function normalizeAugmentIds(value) {
  if (!Array.isArray(value)) throw new TypeError("augmentIds must be an array.");
  const normalized = value.map(String);
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError("augmentIds must not contain duplicates.");
  }
  if (normalized.some((augmentId) => !AUGMENTS[augmentId])) {
    throw new RangeError("augmentIds contains an unknown augment.");
  }
  return normalized;
}

export function validateMazeSnapshot(room, player, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Maze snapshot must be an object.");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_MAZE_SNAPSHOT_BYTES) {
    throw new RangeError("Maze snapshot is too large.");
  }
  const state = value.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Maze snapshot state is required.");
  }
  const expected = expectedRoundShape(room);
  if (
    value.floor !== room.floor ||
    state.seed !== expected.seed ||
    state.width !== expected.width ||
    state.height !== expected.height
  ) {
    throw new RangeError("Maze snapshot does not match the active floor.");
  }
  const augmentIds = normalizeAugmentIds(value.augmentIds ?? []);
  if (JSON.stringify(augmentIds) !== JSON.stringify(player.augmentIds)) {
    throw new RangeError("Maze snapshot augments do not match the lobby state.");
  }
  if (
    !Number.isFinite(state.scoreMs) ||
    state.scoreMs < 0 ||
    state.scoreMs > 86_400_000 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.obstacles) ||
    state.obstacles.length > 1_000
  ) {
    throw new RangeError("Maze snapshot contains invalid score or obstacle data.");
  }
  return clone({
    floor: room.floor,
    augmentIds,
    state,
    submittedAt: value.submittedAt ?? null,
  });
}

export function createLobbyState({ code, hostToken, hostName, hostId, now = Date.now() }) {
  return {
    version: 1,
    code,
    phase: LOBBY_PHASES.LOBBY,
    hostId,
    contestSeed: null,
    runStartedAt: null,
    leaderboardPublishedAt: null,
    floor: 0,
    buildDeadline: null,
    revealAt: null,
    createdAt: now,
    updatedAt: now,
    players: [createPlayer({ id: hostId, token: hostToken, name: hostName, index: 0, now })],
  };
}

function createPlayer({ id, token, name, index, now }) {
  return {
    id,
    token,
    name: normalizedName(name),
    color: PLAYER_COLORS[index % PLAYER_COLORS.length],
    ready: false,
    augmentIds: [],
    totalScoreMs: 0,
    leaderboardEligible: true,
    draft: null,
    submission: null,
    nextReady: false,
    joinedAt: now,
    lastSeenAt: now,
  };
}

export function connectLobbyPlayer(room, { token, name, playerId, now = Date.now() }) {
  let player = room.players.find((entry) => entry.token === token);
  if (player) {
    player.name = normalizedName(name);
    player.lastSeenAt = now;
    room.updatedAt = now;
    return { player, reconnected: true };
  }
  if (room.phase !== LOBBY_PHASES.LOBBY) {
    throw new RangeError("This run has already started.");
  }
  if (room.players.length >= MAX_LOBBY_PLAYERS) {
    throw new RangeError("This lobby is full.");
  }
  player = createPlayer({
    id: playerId,
    token,
    name,
    index: room.players.length,
    now,
  });
  room.players.push(player);
  room.updatedAt = now;
  return { player, reconnected: false };
}

export function setLobbyReady(room, playerId, ready, now = Date.now()) {
  if (room.phase !== LOBBY_PHASES.LOBBY) throw new RangeError("The lobby is not waiting.");
  playerById(room, playerId).ready = Boolean(ready);
  room.updatedAt = now;
}

export function removeLobbyPlayer(room, playerId, now = Date.now()) {
  if (room.phase !== LOBBY_PHASES.LOBBY) {
    throw new RangeError("Players cannot be removed during an active run.");
  }
  const index = room.players.findIndex((player) => player.id === playerId);
  if (index < 0) return false;
  room.players.splice(index, 1);
  if (room.hostId === playerId) room.hostId = room.players[0]?.id ?? null;
  room.updatedAt = now;
  return true;
}

function startFloor(room, floorNumber, now) {
  const config = floorConfig(floorNumber);
  room.phase = LOBBY_PHASES.BUILD;
  room.floor = floorNumber;
  room.buildDeadline = now + config.buildDurationMs;
  room.revealAt = null;
  room.updatedAt = now;
  for (const player of room.players) {
    player.ready = false;
    player.draft = null;
    player.submission = null;
    player.nextReady = false;
  }
  return room.buildDeadline;
}

export function startLobbyRun(
  room,
  playerId,
  { contestSeed, connectedPlayerIds, now = Date.now() },
) {
  if (room.phase !== LOBBY_PHASES.LOBBY) throw new RangeError("A run is already active.");
  if (room.hostId !== playerId) throw new RangeError("Only the host can start the run.");
  const connected = new Set(connectedPlayerIds);
  if (room.players.length < 2) throw new RangeError("At least two players are required.");
  if (room.players.some((player) => !connected.has(player.id) || !player.ready)) {
    throw new RangeError("Every player must be connected and ready.");
  }
  room.contestSeed = normalizeChallengeSeed(contestSeed);
  if (!room.contestSeed) throw new RangeError("A contest seed is required.");
  room.runStartedAt = now;
  room.leaderboardPublishedAt = null;
  for (const player of room.players) {
    player.augmentIds = [];
    player.totalScoreMs = 0;
    player.leaderboardEligible = true;
  }
  return startFloor(room, 1, now);
}

export function updateMazeDraft(room, playerId, snapshot, now = Date.now()) {
  if (room.phase !== LOBBY_PHASES.BUILD) throw new RangeError("The floor is not accepting builds.");
  const player = playerById(room, playerId);
  if (player.submission) throw new RangeError("This maze is already locked.");
  player.draft = validateMazeSnapshot(room, player, snapshot);
  player.lastSeenAt = now;
  room.updatedAt = now;
}

function revealIfReady(room, now) {
  if (!room.players.every((player) => player.submission)) return false;
  room.phase = LOBBY_PHASES.REVEAL;
  room.buildDeadline = null;
  room.revealAt = now;
  room.updatedAt = now;
  for (const player of room.players) {
    if (player.submission.forfeit) {
      player.leaderboardEligible = false;
    } else {
      player.totalScoreMs += player.submission.state.scoreMs;
    }
  }
  return true;
}

export function submitMaze(room, playerId, snapshot, now = Date.now()) {
  if (room.phase !== LOBBY_PHASES.BUILD) throw new RangeError("The floor is not accepting submissions.");
  const player = playerById(room, playerId);
  if (player.submission) return revealIfReady(room, now);
  const validated = validateMazeSnapshot(room, player, snapshot ?? player.draft);
  validated.submittedAt = now;
  player.draft = validated;
  player.submission = validated;
  player.lastSeenAt = now;
  room.updatedAt = now;
  return revealIfReady(room, now);
}

export function expireLobbyBuild(room, now = Date.now()) {
  if (room.phase !== LOBBY_PHASES.BUILD) return false;
  for (const player of room.players) {
    if (player.submission) continue;
    player.submission = player.draft
      ? { ...clone(player.draft), submittedAt: now }
      : { floor: room.floor, augmentIds: [...player.augmentIds], state: null, submittedAt: now, forfeit: true };
  }
  return revealIfReady(room, now);
}

function validateNextAugments(room, player, value) {
  const next = normalizeAugmentIds(value);
  const current = player.augmentIds;
  if (hasAugmentDraftAfterFloor(room.floor)) {
    if (next.length !== current.length + 1 || current.some((id) => !next.includes(id))) {
      throw new RangeError("Choose exactly one new augment.");
    }
    const added = next.find((id) => !current.includes(id));
    if (AUGMENTS[added].tier !== augmentTierForDraft(room.floor)) {
      throw new RangeError("The chosen augment has the wrong tier.");
    }
  } else if (JSON.stringify(next) !== JSON.stringify(current)) {
    throw new RangeError("No augment is available after this floor.");
  }
  return next;
}

function resetToLobby(room, now) {
  room.phase = LOBBY_PHASES.LOBBY;
  room.contestSeed = null;
  room.runStartedAt = null;
  room.leaderboardPublishedAt = null;
  room.floor = 0;
  room.buildDeadline = null;
  room.revealAt = null;
  room.updatedAt = now;
  for (const player of room.players) {
    player.ready = false;
    player.augmentIds = [];
    player.totalScoreMs = 0;
    player.leaderboardEligible = true;
    player.draft = null;
    player.submission = null;
    player.nextReady = false;
  }
}

export function markPlayerReadyForNextFloor(room, playerId, augmentIds, now = Date.now()) {
  if (room.phase !== LOBBY_PHASES.REVEAL) throw new RangeError("The floor has not been revealed.");
  const player = playerById(room, playerId);
  player.augmentIds = validateNextAugments(room, player, augmentIds);
  player.nextReady = true;
  player.lastSeenAt = now;
  room.updatedAt = now;
  if (!room.players.every((entry) => entry.nextReady)) return { advanced: false };
  if (room.floor >= RUN_FLOORS) {
    resetToLobby(room, now);
    return { advanced: true, lobbyReset: true, deadline: null };
  }
  const deadline = startFloor(room, room.floor + 1, now);
  return { advanced: true, lobbyReset: false, deadline };
}

export function publicLobbyState(room, connectedPlayerIds = [], viewerId = null) {
  const connected = new Set(connectedPlayerIds);
  const reveal = room.phase === LOBBY_PHASES.REVEAL
    ? room.players.map((player) => ({
        playerId: player.id,
        snapshot: clone(player.submission),
      }))
    : null;
  const viewer = room.players.find((player) => player.id === viewerId);
  return {
    version: room.version,
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    contestSeed: room.contestSeed,
    floor: room.floor,
    roundSeed: room.floor > 0 && room.contestSeed
      ? deriveContestRoundSeed(room.contestSeed, room.floor)
      : null,
    buildDeadline: room.buildDeadline,
    revealAt: room.revealAt,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      ready: player.ready,
      connected: connected.has(player.id),
      augmentIds: [...player.augmentIds],
      totalScoreMs: player.totalScoreMs,
      submitted: Boolean(player.submission),
      nextReady: player.nextReady,
    })),
    ownDraft: viewer?.draft ? clone(viewer.draft) : null,
    reveal,
  };
}
