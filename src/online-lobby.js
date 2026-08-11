const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_PLAYER_NAME_LENGTH = 24;

export const DEFAULT_LOBBY_SERVER_URL =
  "https://mazing-contest-lobbies.mazingcontest.workers.dev";

export function normalizeLobbyCode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
  return normalized.length === ROOM_CODE_LENGTH ? normalized : null;
}

export function normalizePlayerName(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_PLAYER_NAME_LENGTH);
  return normalized || null;
}

export function normalizeLobbyServerUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!new Set(["http:", "https:", "ws:", "wss:"]).has(url.protocol)) {
    return null;
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

function randomValues(length) {
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return values;
}

export function createLobbyCode() {
  return [...randomValues(ROOM_CODE_LENGTH)]
    .map((value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length])
    .join("");
}

export function createReconnectToken() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return [...randomValues(24)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function createOnlineInviteUrl(baseUrl, { serverUrl, roomCode }) {
  const normalizedServer = normalizeLobbyServerUrl(serverUrl);
  const normalizedCode = normalizeLobbyCode(roomCode);
  if (!normalizedServer) throw new RangeError("A valid lobby server URL is required.");
  if (!normalizedCode) throw new RangeError("A six-character lobby code is required.");
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  url.searchParams.set("lobby", normalizedCode);
  url.searchParams.set("server", normalizedServer);
  return url.href;
}

export function lobbyWebSocketUrl(serverUrl, { roomCode, playerName, token, create = false }) {
  const normalizedServer = normalizeLobbyServerUrl(serverUrl);
  const normalizedCode = normalizeLobbyCode(roomCode);
  const normalizedName = normalizePlayerName(playerName);
  if (!normalizedServer) throw new RangeError("A valid lobby server URL is required.");
  if (!normalizedCode) throw new RangeError("A six-character lobby code is required.");
  if (!normalizedName) throw new RangeError("A player name is required.");
  if (!String(token ?? "").trim()) throw new RangeError("A reconnect token is required.");

  const url = new URL(normalizedServer);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/lobbies/${normalizedCode}`;
  url.searchParams.set("name", normalizedName);
  url.searchParams.set("token", String(token));
  if (create) url.searchParams.set("create", "1");
  return url.href;
}

export class LobbyConnection {
  constructor(options) {
    this.options = { ...options };
    this.socket = null;
    this.closedIntentionally = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = 0;
  }

  connect() {
    this.closedIntentionally = false;
    window.clearTimeout(this.reconnectTimer);
    const url = lobbyWebSocketUrl(this.options.serverUrl, this.options);
    this.options.onStatus?.("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.options.onStatus?.("connected");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      try {
        this.options.onMessage?.(JSON.parse(event.data));
      } catch {
        this.options.onError?.("The lobby sent an unreadable message.");
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.options.onStatus?.("error");
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closedIntentionally) {
        this.options.onStatus?.("disconnected");
        return;
      }
      this.options.onStatus?.("reconnecting");
      this.options.onDisconnect?.(event);
      const delay = Math.min(10_000, 500 * (2 ** this.reconnectAttempt));
      this.reconnectAttempt += 1;
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    });
  }

  send(type, payload = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type, ...payload }));
    return true;
  }

  close() {
    this.closedIntentionally = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Player left lobby");
    this.socket = null;
    this.options.onStatus?.("disconnected");
  }
}
