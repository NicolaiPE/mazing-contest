import { DurableObject } from "cloudflare:workers";
import { RUN_FLOORS } from "../../src/roguelike.js";
import {
  LOBBY_PHASES,
  connectLobbyPlayer,
  createLobbyState,
  expireLobbyBuild,
  markPlayerReadyForNextFloor,
  publicLobbyState,
  removeLobbyPlayer,
  setLobbyReady,
  startLobbyRun,
  submitMaze,
  updateMazeDraft,
} from "./lobby-state.js";
import {
  LEADERBOARD_MODES,
  createLeaderboardState,
  leaderboardEntries,
  submitLeaderboardEntry,
} from "./leaderboard-state.js";

const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_MESSAGE_BYTES = 240_000;
const MAX_LEADERBOARD_REQUEST_BYTES = 4_000;

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function randomCode(length = 12) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(36).padStart(2, "0")).join("").slice(0, length);
}

function allowedOrigin(request, env) {
  const configured = String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.length === 0) return true;
  return configured.includes(request.headers.get("Origin"));
}

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function addCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleLeaderboardRequest(request, env) {
  if (!allowedOrigin(request, env)) {
    return jsonResponse({ error: "Origin is not allowed." }, 403);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  const stub = env.LEADERBOARD.getByName("global");
  let internalRequest;
  if (request.method === "GET") {
    const mode = new URL(request.url).searchParams.get("mode") ?? LEADERBOARD_MODES.SOLO;
    internalRequest = new Request(`https://leaderboard.internal/?mode=${encodeURIComponent(mode)}`);
  } else if (request.method === "POST") {
    const serialized = await request.text();
    if (serialized.length > MAX_LEADERBOARD_REQUEST_BYTES) {
      return addCors(jsonResponse({ error: "Leaderboard entry is too large." }, 413), request);
    }
    let entry;
    try {
      entry = JSON.parse(serialized);
    } catch {
      return addCors(jsonResponse({ error: "Leaderboard entry must be valid JSON." }, 400), request);
    }
    internalRequest = new Request("https://leaderboard.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entry, mode: LEADERBOARD_MODES.SOLO }),
    });
  } else {
    return addCors(jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET, POST, OPTIONS" }), request);
  }
  return addCors(await stub.fetch(internalRequest), request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "mazing-contest-lobbies" });
    }
    if (url.pathname === "/leaderboard") return handleLeaderboardRequest(request, env);
    const match = url.pathname.match(/^\/lobbies\/([A-Z2-9]{6})$/);
    if (!match) return jsonResponse({ error: "Not found." }, 404);
    if (!allowedOrigin(request, env)) return jsonResponse({ error: "Origin is not allowed." }, 403);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected a WebSocket upgrade." }, 426);
    }
    const stub = env.LOBBIES.getByName(match[1]);
    return stub.fetch(request);
  },
};

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.room = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = await this.ctx.storage.get("room") ?? null;
    });
  }

  connectedPlayerIds() {
    return [...new Set(
      this.ctx.getWebSockets()
        .filter((socket) => socket.readyState === 1)
        .map((socket) => socket.deserializeAttachment()?.playerId)
        .filter(Boolean),
    )];
  }

  async save() {
    if (this.room) await this.ctx.storage.put("room", this.room);
    else await this.ctx.storage.delete("room");
  }

  async publishOnlineLeaderboardIfComplete() {
    if (
      !this.room ||
      this.room.phase !== LOBBY_PHASES.REVEAL ||
      this.room.floor !== RUN_FLOORS ||
      this.room.leaderboardPublishedAt
    ) return false;
    const playedAt = this.room.revealAt ?? Date.now();
    const entries = this.room.players
      .filter((player) => player.leaderboardEligible)
      .map((player) => ({
        id: `online:${this.room.code}:${this.room.runStartedAt}:${player.id}`,
        mode: LEADERBOARD_MODES.ONLINE,
        playerName: player.name,
        scoreMs: player.totalScoreMs,
        seed: this.room.contestSeed,
      }));
    try {
      const stub = this.env.LEADERBOARD.getByName("global");
      const responses = await Promise.all(entries.map((entry) => stub.fetch(new Request(
        "https://leaderboard.internal/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        },
      ))));
      if (responses.some((response) => !response.ok)) throw new Error("Leaderboard rejected an online score.");
      this.room.leaderboardPublishedAt = playedAt;
      return true;
    } catch (error) {
      console.error("Could not publish online leaderboard scores.", error);
      return false;
    }
  }

  send(socket, value) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      // A closing peer will be removed by webSocketClose.
    }
  }

  sendError(socket, error) {
    this.send(socket, {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  snapshotFor(playerId) {
    return {
      type: "snapshot",
      serverTime: Date.now(),
      youId: playerId,
      room: publicLobbyState(this.room, this.connectedPlayerIds(), playerId),
    };
  }

  broadcastSnapshots() {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const playerId = socket.deserializeAttachment()?.playerId;
      if (playerId) this.send(socket, this.snapshotFor(playerId));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.pathname.split("/").filter(Boolean).at(-1)?.toUpperCase();
    const name = url.searchParams.get("name");
    const token = url.searchParams.get("token");
    const create = url.searchParams.get("create") === "1";
    if (!ROOM_CODE_PATTERN.test(code ?? "") || !TOKEN_PATTERN.test(token ?? "")) {
      return jsonResponse({ error: "Invalid lobby code or reconnect token." }, 400);
    }
    if (!this.room && !create) return jsonResponse({ error: "Lobby not found." }, 404);
    const playerId = this.room?.players.find((player) => player.token === token)?.id
      ?? `p-${randomCode()}`;
    try {
      if (!this.room) {
        this.room = createLobbyState({
          code,
          hostToken: token,
          hostName: name,
          hostId: playerId,
        });
      } else {
        connectLobbyPlayer(this.room, { token, name, playerId });
      }
    } catch (error) {
      return jsonResponse({ error: error.message }, 409);
    }

    for (const existing of this.ctx.getWebSockets()) {
      if (existing.deserializeAttachment()?.playerId === playerId) {
        existing.close(4001, "Reconnected from another tab");
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId });
    await this.save();
    this.send(server, this.snapshotFor(playerId));
    this.broadcastSnapshots();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_BYTES) {
      this.sendError(socket, "Lobby message is too large or is not text.");
      return;
    }
    const playerId = socket.deserializeAttachment()?.playerId;
    if (!playerId || !this.room) return;
    let input;
    try {
      input = JSON.parse(message);
      if (!input || typeof input.type !== "string") throw new TypeError("Message type is required.");
      if (input.type === "ready") {
        setLobbyReady(this.room, playerId, input.ready);
      } else if (input.type === "start") {
        const deadline = startLobbyRun(this.room, playerId, {
          contestSeed: input.contestSeed,
          connectedPlayerIds: this.connectedPlayerIds(),
        });
        await this.ctx.storage.setAlarm(deadline);
      } else if (input.type === "maze-sync") {
        updateMazeDraft(this.room, playerId, input.snapshot);
        await this.save();
        this.send(socket, { type: "maze-synced", revision: input.snapshot?.state?.revision ?? 0 });
        return;
      } else if (input.type === "submit-maze") {
        const revealed = submitMaze(this.room, playerId, input.snapshot);
        if (revealed) await this.publishOnlineLeaderboardIfComplete();
      } else if (input.type === "next-ready") {
        await this.publishOnlineLeaderboardIfComplete();
        const result = markPlayerReadyForNextFloor(this.room, playerId, input.augmentIds ?? []);
        if (result.deadline) await this.ctx.storage.setAlarm(result.deadline);
      } else if (input.type === "leave") {
        removeLobbyPlayer(this.room, playerId);
        if (this.room.players.length === 0) this.room = null;
        await this.save();
        socket.close(1000, "Player left lobby");
        if (this.room) this.broadcastSnapshots();
        return;
      } else if (input.type === "ping") {
        this.send(socket, { type: "pong", serverTime: Date.now() });
        return;
      } else {
        throw new RangeError("Unknown lobby message type.");
      }
      await this.save();
      this.broadcastSnapshots();
    } catch (error) {
      this.sendError(socket, error);
    }
  }

  async webSocketClose(socket, code, reason) {
    socket.close(code, reason);
    if (this.room) this.broadcastSnapshots();
  }

  async webSocketError(socket) {
    socket.close(1011, "Lobby connection failed");
    if (this.room) this.broadcastSnapshots();
  }

  async alarm() {
    if (!this.room || this.room.phase !== LOBBY_PHASES.BUILD) return;
    const revealed = expireLobbyBuild(this.room);
    if (revealed) await this.publishOnlineLeaderboardIfComplete();
    await this.save();
    this.broadcastSnapshots();
  }
}

export class Leaderboard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = createLeaderboardState();
    this.ctx.blockConcurrencyWhile(async () => {
      this.state = await this.ctx.storage.get("leaderboard") ?? createLeaderboardState();
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET") {
        const mode = url.searchParams.get("mode") ?? LEADERBOARD_MODES.SOLO;
        return jsonResponse({ mode, entries: leaderboardEntries(this.state, mode) });
      }
      if (request.method === "POST") {
        const result = submitLeaderboardEntry(this.state, await request.json());
        if (result.inserted) await this.ctx.storage.put("leaderboard", this.state);
        return jsonResponse(result, result.inserted ? 201 : 200);
      }
      return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET, POST" });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
}
