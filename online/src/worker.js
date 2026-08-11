import { DurableObject } from "cloudflare:workers";
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

const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_MESSAGE_BYTES = 240_000;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "mazing-contest-lobbies" });
    }
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
        submitMaze(this.room, playerId, input.snapshot);
      } else if (input.type === "next-ready") {
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
    expireLobbyBuild(this.room);
    await this.save();
    this.broadcastSnapshots();
  }
}
