/** Maps a tile-local ground UV into continuous, metre-scaled world coordinates. */
export function terrainTextureCoordinates(
  u: number,
  v: number,
  meshWidth: number,
  meshDepth: number,
  metersPerUnit: number,
  worldOffsetX = 0,
  worldOffsetZ = 0,
): [number, number] {
  return [
    (u * meshWidth + worldOffsetX) * metersPerUnit,
    (v * meshDepth + worldOffsetZ) * metersPerUnit,
  ];
}
