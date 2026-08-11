import { normalizeLobbyServerUrl } from "./online-lobby.js";

export const LEADERBOARD_MODES = Object.freeze({
  SOLO: "solo",
  ONLINE: "online",
});

const MODE_VALUES = new Set(Object.values(LEADERBOARD_MODES));

function normalizeMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!MODE_VALUES.has(mode)) throw new RangeError("Leaderboard mode must be solo or online.");
  return mode;
}

export function createLeaderboardEntryId() {
  if (typeof crypto.randomUUID === "function") return `solo:${crypto.randomUUID()}`;
  const values = new Uint8Array(20);
  crypto.getRandomValues(values);
  return `solo:${[...values].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function leaderboardApiUrl(serverUrl, mode) {
  const normalizedServer = normalizeLobbyServerUrl(serverUrl);
  if (!normalizedServer) throw new RangeError("A valid leaderboard server URL is required.");
  const url = new URL(`${normalizedServer}/`);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/leaderboard`;
  url.searchParams.set("mode", normalizeMode(mode));
  return url.href;
}

async function responseJson(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Leaderboard request failed (${response.status}).`);
  return value;
}

export async function fetchLeaderboard(serverUrl, mode, request = fetch) {
  const response = await request(leaderboardApiUrl(serverUrl, mode), {
    headers: { Accept: "application/json" },
  });
  const value = await responseJson(response);
  return Array.isArray(value.entries) ? value.entries : [];
}

export async function submitSoloLeaderboardEntry(serverUrl, entry, request = fetch) {
  const response = await request(leaderboardApiUrl(serverUrl, LEADERBOARD_MODES.SOLO), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...entry, mode: LEADERBOARD_MODES.SOLO }),
  });
  return responseJson(response);
}
