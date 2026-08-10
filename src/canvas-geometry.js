/** Calculates a square-cell board that stays clear of the arena's visual frame. */
export function fitBoardGeometry(
  viewWidth,
  viewHeight,
  gridWidth,
  gridHeight,
  pixelRatio = 1,
) {
  if (
    !Number.isFinite(viewWidth) ||
    !Number.isFinite(viewHeight) ||
    viewWidth <= 0 ||
    viewHeight <= 0
  ) {
    throw new RangeError("Canvas dimensions must be positive numbers.");
  }
  if (
    !Number.isSafeInteger(gridWidth) ||
    !Number.isSafeInteger(gridHeight) ||
    gridWidth <= 0 ||
    gridHeight <= 0
  ) {
    throw new RangeError("Grid dimensions must be positive safe integers.");
  }
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new RangeError("pixelRatio must be a positive number.");
  }

  const paddingX = Math.min(
    viewWidth * 0.25,
    Math.max(36, viewWidth * 0.05),
  );
  const paddingY = Math.min(
    viewHeight * 0.25,
    Math.max(36, viewHeight * 0.07),
  );
  const rawCellSize = Math.min(
    Math.max(0, viewWidth - paddingX * 2) / gridWidth,
    Math.max(0, viewHeight - paddingY * 2) / gridHeight,
  );
  const snappedCellSize = Math.floor(rawCellSize * pixelRatio) / pixelRatio;
  const cellSize = snappedCellSize > 0 ? snappedCellSize : rawCellSize;
  const boardWidth = cellSize * gridWidth;
  const boardHeight = cellSize * gridHeight;
  const left = (viewWidth - boardWidth) / 2;
  const top = (viewHeight - boardHeight) / 2;

  return {
    width: viewWidth,
    height: viewHeight,
    cell: cellSize,
    left,
    top,
    right: left + boardWidth,
    bottom: top + boardHeight,
    boardWidth,
    boardHeight,
    gridWidth,
    gridHeight,
  };
}
