export function resolveSpectatedContestant(
  contestants,
  selectedId,
  spectatingEnabled = true,
) {
  if (!Array.isArray(contestants) || contestants.length === 0) return null;
  const player = contestants.find((contestant) => contestant.isPlayer) ?? contestants[0];
  if (!spectatingEnabled) return player;
  return contestants.find((contestant) => contestant.id === selectedId) ?? player;
}
