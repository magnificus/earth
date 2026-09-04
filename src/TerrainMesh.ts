import {
  Mesh,
  MeshBuilder,
  Scene,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import { sceneToLonLat, SEA_LEVEL_METERS, sinkSubmergedElevation } from "./Geo";
import { varyGroundColor } from "./GroundVariation";
import {
  createTerrainMaterial,
  isSharedTerrainMaterial,
} from "./TerrainMaterial";
import {
  createTerrainSkirtGeometry,
  stitchTerrainMeshEdges,
} from "./TerrainStitching";
import { landCoverSurfaceColor } from "./WorldCover";
import type { LandCoverClass, LandCoverSampler } from "./WorldCover";
import { yieldToNextFrame } from "./FrameBudget";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";
import type { FrameBudgetYielder } from "./FrameBudget";
import { terrainTextureCoordinates } from "./TerrainTextureCoordinates";

const GROUND_COVER_BLEND_METERS = 12;
const FAR_TILE_SUBDIVISIONS = 32;
const TERRAIN_SKIRT_OVERLAP_METERS = 0.5;
const TERRAIN_SKIRT_SURFACE_DROP_METERS = 0.02;

export interface TerrainMeshOptions {
  meshWidth: number;
  meshDepth: number;
  subdivisions: number;
  metersPerUnit: number;
  /** Tile-center position in the stable scene frame, used to keep texture phase continuous. */
  worldOffsetX?: number;
  worldOffsetZ?: number;
  landCover?: LandCoverSampler;
  yieldControl?: FrameBudgetYielder;
  snowCovered?: boolean;
  /** World-level seed for the ground color bands, not the per-tile seed. */
  worldSeed?: number;
}

interface TerrainMeshMetadata {
  surfaceColors?: Float32Array;
  skirt?: Mesh;
  snowCovered: boolean;
}

/** Builds the renderable mesh and material for one processed terrain tile. */
export async function createTerrainMesh(
  scene: Scene,
  name: string,
  terrain: TerrainData,
  options: TerrainMeshOptions,
): Promise<Mesh> {
  const {
    meshWidth,
    meshDepth,
    subdivisions,
    metersPerUnit,
    worldOffsetX = 0,
    worldOffsetZ = 0,
    landCover,
    yieldControl,
    snowCovered = false,
    worldSeed = DEFAULT_WORLD_SEED,
  } = options;

  // Ground creation allocates and uploads the initial flat vertex buffers.
  // Give it a fresh post-render slice when this is a streamed tile.
  await yieldToNextFrame(yieldControl);
  const ground = MeshBuilder.CreateGround(
    name,
    { width: meshWidth, height: meshDepth, subdivisions, updatable: true },
    scene,
  );
  // A cooperative build renders frames while the vertices are still flat;
  // the caller re-enables the mesh when it commits the finished terrain.
  if (yieldControl) ground.setEnabled(false);

  const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
  const uvs = ground.getVerticesData(VertexBuffer.UVKind)!;
  const indices = ground.getIndices()!;
  const { elevations, width: elevationWidth, height: elevationHeight } = terrain;
  const verticesPerRow = subdivisions + 1;
  const surfaceColors = landCover
    ? new Float32Array((positions.length / 3) * 4)
    : undefined;
  // Retain the sampled classes so variation does not have to resample the raster.
  const coverClasses = landCover
    ? new Uint8Array(positions.length / 3)
    : undefined;

  for (let row = 0; row < verticesPerRow; row++) {
    for (let column = 0; column < verticesPerRow; column++) {
      const u = column / subdivisions;
      const v = row / subdivisions;
      const pixelX = u * (elevationWidth - 1);
      const pixelY = v * (elevationHeight - 1);
      const x0 = Math.floor(pixelX);
      const y0 = Math.floor(pixelY);
      const x1 = Math.min(x0 + 1, elevationWidth - 1);
      const y1 = Math.min(y0 + 1, elevationHeight - 1);
      const fractionX = pixelX - x0;
      const fractionY = pixelY - y0;
      const elevation00 = elevations[y0 * elevationWidth + x0];
      const elevation10 = elevations[y0 * elevationWidth + x1];
      const elevation01 = elevations[y1 * elevationWidth + x0];
      const elevation11 = elevations[y1 * elevationWidth + x1];
      const interpolatedElevation =
        elevation00 * (1 - fractionX) * (1 - fractionY) +
        elevation10 * fractionX * (1 - fractionY) +
        elevation01 * (1 - fractionX) * fractionY +
        elevation11 * fractionX * fractionY;
      // Classified coastlines already contain their shallow-to-deep profile.
      const elevation = terrain.waterMask
        ? interpolatedElevation
        : sinkSubmergedElevation(interpolatedElevation);

      const vertexIndex = row * verticesPerRow + column;
      positions[vertexIndex * 3 + 1] = elevation / metersPerUnit;
      // Anchor UVs to the same stable frame as the meshes. Restarting at zero
      // on every tile creates a phase jump wherever its size is not an exact
      // multiple of the texture repeat.
      const textureCoordinates = terrainTextureCoordinates(
        uvs[vertexIndex * 2],
        uvs[vertexIndex * 2 + 1],
        meshWidth,
        meshDepth,
        metersPerUnit,
        worldOffsetX,
        worldOffsetZ,
      );
      uvs[vertexIndex * 2] = textureCoordinates[0];
      uvs[vertexIndex * 2 + 1] = textureCoordinates[1];

      if (surfaceColors && landCover) {
        const { lon, lat } = sceneToLonLat(
          positions[vertexIndex * 3],
          positions[vertexIndex * 3 + 2],
          terrain.bounds,
          meshWidth,
          meshDepth,
        );
        const coverClass = landCover.sample(lon, lat);
        const color = landCoverSurfaceColor(coverClass);
        const colorIndex = vertexIndex * 4;
        surfaceColors[colorIndex] = color[0];
        surfaceColors[colorIndex + 1] = color[1];
        surfaceColors[colorIndex + 2] = color[2];
        surfaceColors[colorIndex + 3] = 1;
        coverClasses![vertexIndex] = coverClass;
      }
    }
    await yieldControl?.();
  }

  stitchTerrainMeshEdges(
    positions,
    subdivisions,
    Math.min(FAR_TILE_SUBDIVISIONS, subdivisions),
  );

  if (surfaceColors && coverClasses) {
    const metersPerVertex = Math.min(
      terrain.groundWidthMeters / subdivisions,
      terrain.groundHeightMeters / subdivisions,
    );
    await smoothVertexColors(
      surfaceColors,
      verticesPerRow,
      Math.max(1, Math.round(GROUND_COVER_BLEND_METERS / metersPerVertex)),
      yieldControl,
    );
    await applyGroundVariation(surfaceColors, coverClasses, positions, terrain, {
      meshWidth,
      meshDepth,
      metersPerVertex,
      worldSeed,
    }, yieldControl);
  }

  await yieldToNextFrame(yieldControl);
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  // Upload positions before normals so Babylon refreshes the formerly flat bounds.
  await yieldToNextFrame(yieldControl);
  ground.updateVerticesData(VertexBuffer.PositionKind, positions, true);
  await yieldToNextFrame(yieldControl);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  await yieldToNextFrame(yieldControl);
  ground.updateVerticesData(VertexBuffer.UVKind, uvs);

  const skirtGeometry = createTerrainSkirtGeometry(
    positions,
    uvs,
    subdivisions,
    Math.min(SEA_LEVEL_METERS - 1, terrain.minElevation - 1) / metersPerUnit,
    surfaceColors,
    TERRAIN_SKIRT_OVERLAP_METERS / metersPerUnit,
    TERRAIN_SKIRT_SURFACE_DROP_METERS / metersPerUnit,
  );
  const skirt = new Mesh(`${name} skirt`, scene);
  const skirtVertexData = new VertexData();
  skirtVertexData.positions = skirtGeometry.positions;
  skirtVertexData.uvs = skirtGeometry.uvs;
  skirtVertexData.indices = skirtGeometry.indices;
  const skirtNormals = new Float32Array(skirtGeometry.positions.length);
  for (let index = 1; index < skirtNormals.length; index += 3) skirtNormals[index] = 1;
  skirtVertexData.normals = skirtNormals;
  if (skirtGeometry.colors) skirtVertexData.colors = skirtGeometry.colors;
  skirtVertexData.applyToMesh(skirt);
  skirt.parent = ground;
  skirt.isPickable = false;
  skirt.checkCollisions = false;
  ground.metadata = {
    surfaceColors,
    skirt,
    snowCovered,
  } satisfies TerrainMeshMetadata;
  ground.freezeWorldMatrix();

  await yieldToNextFrame(yieldControl);
  applyDefaultTerrainMaterial(scene, ground);
  return ground;
}

/** Rebuilds a terrain tile's shared material from its mesh metadata. */
export function applyDefaultTerrainMaterial(scene: Scene, terrain: Mesh): void {
  disposeTerrainAppearance(terrain);
  const metadata = terrain.metadata as TerrainMeshMetadata | null;
  const colors = metadata?.surfaceColors;
  const snowCovered = Boolean(metadata?.snowCovered);
  if (colors && !snowCovered) {
    terrain.setVerticesData(VertexBuffer.ColorKind, colors);
    terrain.useVertexColors = true;
  } else {
    terrain.removeVerticesData(VertexBuffer.ColorKind);
    terrain.useVertexColors = false;
  }
  const material = createTerrainMaterial(scene, {
    usesLandCoverTint: Boolean(colors),
    snowCovered,
  });
  terrain.material = material;
  const skirt = metadata?.skirt;
  if (skirt) {
    skirt.material = material;
    skirt.useVertexColors = Boolean(colors) && !snowCovered;
  }
}

function disposeTerrainAppearance(terrain: Mesh): void {
  const material = terrain.material;
  if (material && !isSharedTerrainMaterial(material)) material.dispose(true, true);
  terrain.material = null;
}

async function applyGroundVariation(
  colors: Float32Array,
  coverClasses: Uint8Array,
  positions: Float32Array | number[],
  terrain: TerrainData,
  options: {
    meshWidth: number;
    meshDepth: number;
    metersPerVertex: number;
    worldSeed: number;
  },
  yieldControl?: () => Promise<void>,
): Promise<void> {
  for (let index = 0; index < coverClasses.length; index++) {
    const { lon, lat } = sceneToLonLat(
      positions[index * 3],
      positions[index * 3 + 2],
      terrain.bounds,
      options.meshWidth,
      options.meshDepth,
    );
    const target = index * 4;
    const [red, green, blue] = varyGroundColor(
      [colors[target], colors[target + 1], colors[target + 2]],
      lon,
      lat,
      coverClasses[index] as LandCoverClass,
      options.metersPerVertex,
      options.worldSeed,
    );
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
    if ((index & 511) === 511) await yieldControl?.();
  }
}

async function smoothVertexColors(
  colors: Float32Array,
  rowSize: number,
  radius: number,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  const horizontal = new Float32Array(colors.length);
  const vertexCount = colors.length / 4;

  for (let row = 0; row < rowSize; row++) {
    for (let column = 0; column < rowSize; column++) {
      const target = (row * rowSize + column) * 4;
      const start = Math.max(0, column - radius);
      const end = Math.min(rowSize - 1, column + radius);
      const count = end - start + 1;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let sample = start; sample <= end; sample++) {
          sum += colors[(row * rowSize + sample) * 4 + channel];
        }
        horizontal[target + channel] = sum / count;
      }
      horizontal[target + 3] = 1;
    }
    await yieldControl?.();
  }

  for (let index = 0; index < vertexCount; index++) {
    const row = Math.floor(index / rowSize);
    const column = index % rowSize;
    const start = Math.max(0, row - radius);
    const end = Math.min(rowSize - 1, row + radius);
    const count = end - start + 1;
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      for (let sample = start; sample <= end; sample++) {
        sum += horizontal[(sample * rowSize + column) * 4 + channel];
      }
      colors[index * 4 + channel] = sum / count;
    }
    colors[index * 4 + 3] = 1;
    if (index % rowSize === rowSize - 1) await yieldControl?.();
  }
}
