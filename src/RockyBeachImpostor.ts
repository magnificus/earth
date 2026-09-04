import {
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  type ImpostorAssetLease,
  type ImpostorVariant,
} from "./Impostor";
import { createVertexColorCaptureMaterial } from "./procedural/ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";
import { computeWeldedNormals } from "./RockGeometry";

const SOURCE_HEIGHT = 0.62;
const CAPTURE_DIAMETER = 5.2;
const STONE_COUNT = 112;
const STONE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0.38, 0.39, 0.38],
  [0.46, 0.45, 0.41],
  [0.34, 0.36, 0.37],
  [0.5, 0.44, 0.36],
  [0.29, 0.31, 0.3],
];

export function rockyBeachRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}

const rockyBeachImpostors = createImpostorAssetProvider({
  name: "rockyBeachImpostor",
  queryPrefix: "rocky-beach-impostor",
  createSource: (scene, variant) => createRockyBeachSource(scene, false, variant.seed),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: AXISYMMETRIC_IMPOSTOR_FACES,
  rotationallySymmetric: true,
  rotationalSymmetryOrder: 4,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
    verticalSamples: { default: 5, minimum: 1, maximum: 12 },
    resolution: { default: 128, minimum: 48, maximum: 512 },
  },
});

export function acquireRockyBeachImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return rockyBeachImpostors.acquireAssets(scene, undefined, variant);
}

/** Builds a dense, low pebble-and-stone patch to bake into one atlas card. */
function createRockyBeachSource(
  scene: Scene,
  liveLighting = false,
  seed = 0x524f434b,
): Mesh {
  const random = createSeededRandom(seed);
  const base = MeshBuilder.CreateIcoSphere(
    "rockyBeachStoneTemplate",
    { radius: 1, subdivisions: 1, flat: false },
    scene,
  );
  const basePositions = base.getVerticesData(VertexBuffer.PositionKind)!;
  const baseIndices = base.getIndices()!;
  base.dispose(false, true);

  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  for (let stone = 0; stone < STONE_COUNT; stone++) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * (CAPTURE_DIAMETER * 0.43);
    const centerX = Math.cos(angle) * radius;
    const centerZ = Math.sin(angle) * radius;
    const large = random() < 0.13;
    const stoneRadius = large
      ? 0.2 + random() * 0.25
      : 0.055 + Math.pow(random(), 1.7) * 0.18;
    const scaleX = stoneRadius * (0.78 + random() * 0.55);
    const scaleY = stoneRadius * (0.38 + random() * 0.38);
    const scaleZ = stoneRadius * (0.78 + random() * 0.55);
    const yaw = random() * Math.PI * 2;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const vertexOffset = positions.length / 3;
    const palette = STONE_COLORS[Math.floor(random() * STONE_COLORS.length)];
    const brightness = 0.82 + random() * 0.3;

    for (let index = 0; index < basePositions.length; index += 3) {
      const sourceX = basePositions[index];
      const sourceY = basePositions[index + 1];
      const sourceZ = basePositions[index + 2];
      const localX = sourceX * scaleX;
      const localZ = sourceZ * scaleZ;
      const warp = 1 + 0.08 * Math.sin(sourceX * 5.1 + sourceZ * 7.3 + stone);
      positions.push(
        centerX + (localX * cosine - localZ * sine) * warp,
        -SOURCE_HEIGHT / 2 + scaleY * (0.48 + sourceY * 0.72),
        centerZ + (localX * sine + localZ * cosine) * warp,
      );
      const upward = sourceY * 0.08;
      colors.push(
        Math.min(1, palette[0] * (brightness + upward)),
        Math.min(1, palette[1] * (brightness + upward)),
        Math.min(1, palette[2] * (brightness + upward)),
        1,
      );
    }
    for (const index of baseIndices) indices.push(vertexOffset + index);
  }

  const normals = computeWeldedNormals(positions, indices);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  const rocks = new Mesh("rockyBeachImpostorProceduralSource", scene);
  data.applyToMesh(rocks);
  rocks.isPickable = false;
  rocks.useVertexColors = true;
  rocks.material = createVertexColorCaptureMaterial(
    scene,
    "rockyBeachImpostorSourceMaterial",
    liveLighting,
  );
  return rocks;
}

/** Uses the captured patch geometry up close without introducing an external asset. */
export function createRockyBeachModel(scene: Scene, renderHeight: number, seed?: number): Mesh {
  const rocks = createRockyBeachSource(scene, true, seed);
  rocks.name = "rockyBeachModels";
  const positions = rocks.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Rocky beach model has no position data.");
  const scale = renderHeight / SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + renderHeight / 2;
    positions[index + 2] *= scale;
  }
  rocks.setVerticesData(VertexBuffer.PositionKind, positions);
  rocks.refreshBoundingInfo();
  if (rocks.material instanceof ShaderMaterial) {
    rocks.material.setFloat("modelHeight", renderHeight);
  }
  return rocks;
}
