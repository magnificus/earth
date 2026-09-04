import assert from "node:assert/strict";
import test from "node:test";

const { terrainTextureCoordinates } = await import("../src/TerrainTextureCoordinates.ts");

test("anchors adjacent terrain texture coordinates to the shared world frame", () => {
  const meshWidth = 25;
  const meshDepth = 25;
  const metersPerUnit = 12;

  const westEastEdge = terrainTextureCoordinates(
    1, 0.4, meshWidth, meshDepth, metersPerUnit, 0, 0,
  );
  const eastWestEdge = terrainTextureCoordinates(
    0, 0.4, meshWidth, meshDepth, metersPerUnit, meshWidth, 0,
  );
  assert.deepEqual(westEastEdge, eastWestEdge);

  const northSouthEdge = terrainTextureCoordinates(
    0.6, 0, meshWidth, meshDepth, metersPerUnit, 0, 0,
  );
  const southNorthEdge = terrainTextureCoordinates(
    0.6, 1, meshWidth, meshDepth, metersPerUnit, 0, -meshDepth,
  );
  assert.deepEqual(northSouthEdge, southNorthEdge);
});
