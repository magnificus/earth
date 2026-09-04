import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { NoiseProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/noiseProceduralTexture";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { createSeededRandom } from "./Random";
import { computeWeldedNormals } from "./RockGeometry";
import type { TerrainData } from "./TerrainData";
import {
  createPlacementGrid,
  packInstanceMatrices,
  type VegetationPlacementOptions,
} from "./VegetationPlacement";
import { LandCoverClass } from "./WorldCover";
import type { LandCoverSampler } from "./WorldCover";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";
import { habitatField } from "./HabitatNoise";
import type { HabitatFieldSpec } from "./HabitatNoise";

export interface RockFieldResult {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
  setFade(fade: number): void;
}

const ROCK_VARIANTS = 3;
const SHORE_PROBE_METERS = 7;
/**
 * Shore boulders come in formations with clear stretches between them, on the
 * same world-anchored footing as the inland scatter. Multiplying by the stand
 * rather than thresholding it lets a formation thin out at its margins instead
 * of ending on a contour line. Calibrated to the mean the old threshold gave.
 */
const SHORE_HABITAT: HabitatFieldSpec = {
  patchMeters: 38,
  abundanceMeters: 1200,
  barrenShare: 0.1,
  richestCoverage: 0.85,
};
const SHORE_FORMATION_CHANCE = 0.55;
/**
 * Stony ground comes in fields. A flat land-cover scatter dusts every hillside
 * in the world equally, so nothing reads as a boulder field and nothing reads
 * as clear.
 */
const HABITAT: HabitatFieldSpec = {
  patchMeters: 150,
  abundanceMeters: 2000,
  barrenShare: 0.34,
  richestCoverage: 0.95,
};

/** Ground that is stony by nature thins out but never clears completely. */
const STONY_COVERS: ReadonlySet<LandCoverClass> = new Set([
  LandCoverClass.Bare,
  LandCoverClass.MossAndLichen,
  LandCoverClass.SnowAndIce,
]);
const STONY_FLOOR = 0.4;
const SHORE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const ROCK_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0.43, 0.42, 0.38],
  [0.36, 0.39, 0.39],
  [0.48, 0.44, 0.36],
];
const MOSS_COLOR: readonly [number, number, number] = [0.25, 0.32, 0.13];

const INLAND_OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.05,
  [LandCoverClass.Shrubland]: 0.09,
  [LandCoverClass.Grassland]: 0.015,
  [LandCoverClass.Cropland]: 0.008,
  [LandCoverClass.Bare]: 0.22,
  [LandCoverClass.SnowAndIce]: 0.12,
  [LandCoverClass.Wetland]: 0.07,
  [LandCoverClass.Mangrove]: 0.055,
  [LandCoverClass.MossAndLichen]: 0.2,
};

const MOSS_CHANCE: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.58,
  [LandCoverClass.Shrubland]: 0.38,
  [LandCoverClass.Grassland]: 0.25,
  [LandCoverClass.Cropland]: 0.1,
  [LandCoverClass.Bare]: 0.08,
  [LandCoverClass.SnowAndIce]: 0.04,
  [LandCoverClass.Wetland]: 0.5,
  [LandCoverClass.Mangrove]: 0.62,
  [LandCoverClass.MossAndLichen]: 0.78,
};

interface RockPlacementContext {
  terrain: TerrainData;
  landCover: LandCoverSampler;
  exclusionMask: VegetationPlacementOptions["exclusionMask"];
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  waterLineMeters: number;
  random: () => number;
  buckets: Matrix[][];
}

interface ShoreDirection {
  /** Unit vector following the local shoreline. */
  tangentX: number;
  tangentZ: number;
  /** Unit vector pointing from land toward water. */
  waterX: number;
  waterZ: number;
}

/** Places partly buried boulders on suitable natural ground. */
export async function createRockField(
  scene: Scene,
  terrain: TerrainData,
  options: VegetationPlacementOptions,
): Promise<RockFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x524f434b,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = 8,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    yieldControl,
    startDisabled = false,
  } = options;
  const root = new TransformNode("rockField", scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const habitat = habitatField("rocks", modelVariantSeed, HABITAT);
  const shoreHabitat = habitatField("rockShores", modelVariantSeed, SHORE_HABITAT);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const buckets = Array.from({ length: ROCK_VARIANTS * 2 }, () => [] as Matrix[]);

  if (landCover) {
    const placement: RockPlacementContext = {
      terrain,
      landCover,
      exclusionMask,
      meshWidth,
      meshDepth,
      metersPerUnit,
      waterLineMeters,
      random,
      buckets,
    };
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.08 + random() * 0.84) * cellWidth;
        const z = meshDepth / 2 - (row + 0.08 + random() * 0.84) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const cover = landCover.sample(lon, lat);
        if (cover === LandCoverClass.Water || cover === LandCoverClass.BuiltUp) continue;

        const shore = shorelineDirection(
          landCover,
          terrain,
          x,
          z,
          meshWidth,
          meshDepth,
          metersPerUnit,
        );
        if (shore) {
          const formation = shoreHabitat.sample(lon, lat);
          if (
            formation > 0 &&
            random() < Math.min(
              1,
              SHORE_FORMATION_CHANCE * formation *
                Math.max(0, densityScale?.(x, z) ?? 1),
            )
          ) {
            addShoreFormation(placement, shore, x, z);
          }
          // Shore rocks belong to formations; do not mix in the even inland scatter.
          continue;
        }

        const stand = habitat.sample(lon, lat);
        const field = STONY_COVERS.has(cover)
          ? STONY_FLOOR + stand * (1 - STONY_FLOOR)
          : stand;
        if (field <= 0) continue;

        const occupancy = Math.min(
          1,
          (INLAND_OCCUPANCY[cover] ?? 0) * field * 1.8 *
            Math.max(0, densityScale?.(x, z) ?? 1),
        );
        if (random() > occupancy) continue;

        // Mostly hand-sized stones, with a long tail into isolated boulders.
        addRock(placement, x, z, 0.22 + Math.pow(random(), 2.1) * 1.65);
      }
      await yieldControl?.();
    }
  }

  let material: StandardMaterial | undefined;
  const meshes: Mesh[] = [];
  let count = 0;
  for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
    for (let mossIndex = 0; mossIndex < 2; mossIndex++) {
      const matrices = buckets[variant * 2 + mossIndex];
      if (matrices.length === 0) continue;
      const rock = createRockMesh(scene, variant, mossIndex === 1);
      rock.parent = root;
      rock.material = material ??= createRockMaterial(scene);
      rock.isPickable = false;
      rock.receiveShadows = true;
      rock.thinInstanceSetBuffer(
        "matrix",
        await packInstanceMatrices(matrices, yieldControl),
        16,
        true,
      );
      rock.thinInstanceRefreshBoundingInfo(true);
      rock.freezeWorldMatrix();
      meshes.push(rock);
      count += matrices.length;
      await yieldControl?.();
    }
  }

  return {
    root,
    meshes,
    count,
    setFade: (fade: number) => {
      const visibility = Math.max(0, Math.min(1, fade));
      for (const mesh of meshes) mesh.visibility = visibility;
    },
  };
}

/** Estimates the local shoreline tangent from nearby land-cover samples. */
function shorelineDirection(
  landCover: LandCoverSampler,
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
  metersPerUnit: number,
): ShoreDirection | undefined {
  const probe = SHORE_PROBE_METERS / metersPerUnit;
  const water = SHORE_DIRECTIONS.map(([directionX, directionZ]) => {
    const location = sceneToLonLat(
      x + directionX * probe,
      z + directionZ * probe,
      terrain.bounds,
      meshWidth,
      meshDepth,
    );
    return landCover.sample(location.lon, location.lat) === LandCoverClass.Water ? 1 : 0;
  });
  const waterX = water[1] - water[0];
  const waterZ = water[3] - water[2];
  const length = Math.hypot(waterX, waterZ);
  if (length === 0) return undefined;
  return {
    tangentX: -waterZ / length,
    tangentZ: waterX / length,
    waterX: waterX / length,
    waterZ: waterZ / length,
  };
}

/** Adds one dense, irregular chain parallel to the sampled water boundary. */
function addShoreFormation(
  context: RockPlacementContext,
  shore: ShoreDirection,
  anchorX: number,
  anchorZ: number,
): void {
  const { metersPerUnit, random } = context;
  const lengthMeters = 12 + random() * 18;
  const spacingMeters = 1.15 + random() * 0.8;
  const count = Math.max(6, Math.round(lengthMeters / spacingMeters));
  const inlandOffsetMeters = 0.8 + random() * 2.2;
  for (let index = 0; index < count; index++) {
    const progress = count === 1 ? 0 : index / (count - 1) - 0.5;
    const alongMeters = progress * lengthMeters + (random() - 0.5) * spacingMeters * 0.65;
    const acrossMeters = inlandOffsetMeters + (random() - 0.5) * 2.4;
    const x = anchorX + (
      shore.tangentX * alongMeters - shore.waterX * acrossMeters
    ) / metersPerUnit;
    const z = anchorZ + (
      shore.tangentZ * alongMeters - shore.waterZ * acrossMeters
    ) / metersPerUnit;
    const radiusMeters = 0.18 + Math.pow(random(), 1.7) * 1.15;
    addRock(context, x, z, radiusMeters, 0.12);
  }
}

/** Validates one candidate and appends its transform to the matching render bucket. */
function addRock(
  context: RockPlacementContext,
  x: number,
  z: number,
  radiusMeters: number,
  mossBonus = 0,
): boolean {
  const {
    terrain,
    landCover,
    exclusionMask,
    meshWidth,
    meshDepth,
    metersPerUnit,
    waterLineMeters,
    random,
    buckets,
  } = context;
  if (Math.abs(x) > meshWidth / 2 || Math.abs(z) > meshDepth / 2) return false;
  const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
  const cover = landCover.sample(lon, lat);
  if (cover === LandCoverClass.Water || cover === LandCoverClass.BuiltUp) return false;

  const halfFootprint = radiusMeters * (0.72 + random() * 0.42) / metersPerUnit;
  if (exclusionMask?.intersects(x, z, halfFootprint)) return false;
  if (!isTerrainFootprintAbove(
    terrain,
    x,
    z,
    halfFootprint,
    halfFootprint,
    meshWidth,
    meshDepth,
    waterLineMeters,
  )) return false;

  const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
  const scaleX = radiusMeters * (0.82 + random() * 0.5) / metersPerUnit;
  const scaleY = radiusMeters * (0.5 + random() * 0.5) / metersPerUnit;
  const scaleZ = radiusMeters * (0.82 + random() * 0.5) / metersPerUnit;
  const deepSet = random() < 0.3;
  const burial = deepSet ? 0.72 + random() * 0.16 : 0.38 + random() * 0.28;
  const centerY = elevation / metersPerUnit + scaleY * (1 - burial * 2);
  const rotation = Quaternion.RotationYawPitchRoll(
    random() * Math.PI * 2,
    (random() - 0.5) * 0.34,
    (random() - 0.5) * 0.34,
  );
  const mossChance = Math.min(0.9, (MOSS_CHANCE[cover] ?? 0.12) + mossBonus);
  const mossy = random() < mossChance;
  const variant = Math.min(ROCK_VARIANTS - 1, Math.floor(random() * ROCK_VARIANTS));
  buckets[variant * 2 + (mossy ? 1 : 0)].push(Matrix.Compose(
    new Vector3(scaleX, scaleY, scaleZ),
    rotation,
    new Vector3(x, centerY, z),
  ));
  return true;
}

function createRockMaterial(scene: Scene): StandardMaterial {
  const material = new StandardMaterial("rockMaterial", scene);
  material.diffuseColor = Color3.White();
  material.ambientColor = new Color3(0.16, 0.17, 0.14);
  material.specularColor = new Color3(0.055, 0.06, 0.05);
  material.specularPower = 18;

  // One shared procedural texture gives every thin-instance bucket the same
  // scale of stone grain without adding image assets or per-rock materials.
  const grain = new NoiseProceduralTexture("rockGrain", 256, scene);
  grain.octaves = 4;
  grain.persistence = 0.72;
  grain.brightness = 0.82;
  grain.animationSpeedFactor = 0;
  grain.uScale = 3.8;
  grain.vScale = 3.8;
  // NoiseProceduralTexture is grayscale, not a tangent-space normal map.
  // Feeding it through the bump slot bends every normal toward the same
  // diagonal and makes highlights flip as the camera moves. Keep it as subtle
  // albedo grain and let the mesh normals describe the stone's surface.
  material.detailMap.texture = grain;
  material.detailMap.diffuseBlendLevel = 0.2;
  material.detailMap.bumpLevel = 0;
  material.detailMap.isEnabled = true;
  material.freeze();
  return material;
}

/** Builds an asymmetrically deformed, smoothly shaded stone with optional top moss. */
function createRockMesh(scene: Scene, variant: number, mossy: boolean): Mesh {
  const rock = MeshBuilder.CreateIcoSphere(
    `rock-${variant}-${mossy ? "mossy" : "bare"}`,
    { radius: 1, subdivisions: 3, flat: false },
    scene,
  );
  const positions = rock.getVerticesData(VertexBuffer.PositionKind)!;
  const indices = rock.getIndices()!;
  const random = createSeededRandom(0x726f636b ^ Math.imul(variant + 1, 0x9e3779b9));
  const stretchX = 0.88 + random() * 0.22;
  const stretchZ = 0.88 + random() * 0.22;
  const offsetX = (random() - 0.5) * 0.18;
  const offsetZ = (random() - 0.5) * 0.18;
  const lobePhase = random() * Math.PI * 2;
  const ridgePhase = random() * Math.PI * 2;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    const angle = Math.atan2(z, x);
    const equator = Math.sqrt(Math.max(0, 1 - y * y));
    const broadLobes = Math.sin(angle * 2 + lobePhase) * 0.065 +
      Math.sin(angle * 3 - ridgePhase) * 0.035;
    // Longitude is undefined at the poles. Fade angular deformation out there
    // so duplicated ico-sphere pole vertices stay coincident and share a sane
    // normal instead of forming tiny spikes with divergent highlights.
    const crownVariation = Math.sin(angle * 4 + ridgePhase + y * 2.2) * 0.035 * equator;
    const radialWarp = 1 + broadLobes * equator + crownVariation * (0.4 + 0.6 * equator);
    const lowerBulge = 1 + Math.max(0, -y) * 0.1;
    positions[index] = (x * stretchX * lowerBulge + offsetX * (1 - y * y)) * radialWarp;
    positions[index + 1] = y * (0.9 + crownVariation) - 0.035 * (1 - y * y);
    positions[index + 2] = (z * stretchZ * lowerBulge + offsetZ * (1 - y * y)) * radialWarp;
  }
  const normals = computeWeldedNormals(positions, indices);
  const colors = new Float32Array((positions.length / 3) * 4);
  const stone = ROCK_COLORS[variant];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const y = positions[vertex * 3 + 1];
    const upward = normals[vertex * 3 + 1];
    const patch = Math.sin(
      positions[vertex * 3] * 5.7 + positions[vertex * 3 + 2] * 7.9 + variant,
    );
    const hasMoss = mossy && upward > 0.35 && y + patch * 0.14 > 0.12;
    const shade = 0.88 + 0.1 * upward + patch * 0.025;
    const color = hasMoss ? MOSS_COLOR : stone;
    colors[vertex * 4] = color[0] * shade;
    colors[vertex * 4 + 1] = color[1] * shade;
    colors[vertex * 4 + 2] = color[2] * shade;
    colors[vertex * 4 + 3] = 1;
  }
  rock.updateVerticesData(VertexBuffer.PositionKind, positions);
  rock.updateVerticesData(VertexBuffer.NormalKind, normals);
  rock.setVerticesData(VertexBuffer.ColorKind, colors);
  rock.useVertexColors = true;
  rock.hasVertexAlpha = false;
  rock.refreshBoundingInfo();
  return rock;
}
