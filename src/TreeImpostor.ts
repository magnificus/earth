import {
  Mesh,
  Scene,
  VertexBuffer,
} from "@babylonjs/core";
import {
  measureFoliageTextures,
  createTreeModelMaterial,
  TREE_SPECIES,
  TREE_SPECIES_LIST,
  TreeSpecies,
} from "./procedural/ProceduralTree";
import {
  setVertexColorModelHeight,
} from "./procedural/ProceduralCaptureMaterial";
import {
  createImpostorAssetProvider,
  IMPOSTOR_CUBE_FACES,
  ImpostorAssetLease,
  ImpostorAssets,
  ImpostorVariant,
} from "./Impostor";
import type { TreeSeasonAppearance } from "./TreeSeason";
import { bakeTreeExposure } from "./DirectionalExposure";
import { TreeModelGeometryCache } from "./TreeModelGeometryCache";

const treeModelCaches = new WeakMap<Scene, TreeModelGeometryCache>();

export interface TreeImpostorVariant extends ImpostorVariant {
  season?: TreeSeasonAppearance;
}

export type TreeImpostorAssets = ImpostorAssets;
export { IMPOSTOR_CUBE_FACES as TREE_IMPOSTOR_FACES } from "./Impostor";

function createTreeProvider(species: TreeSpecies) {
  const tree = TREE_SPECIES[species];
  return createImpostorAssetProvider({
    name: `${species}TreeImpostor`,
    directionalExposure: true,
    seasonalFoliage: true,
    queryPrefix: species === "birch" ? "tree-impostor" : `${species}-tree-impostor`,
    createSource: (scene, variant) => {
      const treeVariant = variant as TreeImpostorVariant;
      const parts = tree.create(
        scene,
        {
          ...(treeVariant.seed === undefined ? {} : { seed: treeVariant.seed }),
          season: treeVariant.season,
        },
      );
      return [parts.log, parts.branches];
    },
    sourceHeight: tree.sourceHeight,
    captureDiameter: tree.captureDiameter,
    boundsPadding: 1.04,
    preserveCaptureAspectRatio: true,
    minimumResolutionWidth: 64,
    faces: IMPOSTOR_CUBE_FACES,
    sampling: {
      horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
      verticalSamples: { default: 5, minimum: 1, maximum: 10 },
      resolution: { default: 192, minimum: 64, maximum: 256 },
    },
  });
}

const treeImpostors = Object.fromEntries(
  TREE_SPECIES_LIST.map((species) => [species, createTreeProvider(species)]),
) as Record<TreeSpecies, ReturnType<typeof createTreeProvider>>;

/** Shares one tree atlas capture per scene and capture-attribute combination. */
export async function getTreeImpostorAssets(
  scene: Scene,
  horizontalSamples = treeImpostors.birch.getDefaultSampling().horizontalSamples,
  verticalSamples = treeImpostors.birch.getDefaultSampling().verticalSamples,
  resolution = treeImpostors.birch.getDefaultSampling().resolution,
  species: TreeSpecies = "birch",
  variant?: TreeImpostorVariant,
): Promise<TreeImpostorAssets> {
  // The capture source is foliage geometry, so its cards need the leaf image's
  // proportions before this species is built and baked into an atlas.
  await measureFoliageTextures();
  return treeImpostors[species].getAssets(scene, {
    horizontalSamples,
    verticalSamples,
    resolution,
  }, variant);
}

/** Acquires a regional tree atlas until its streamed field is disposed. */
export async function acquireTreeImpostorAssets(
  scene: Scene,
  species: TreeSpecies,
  variant: TreeImpostorVariant,
  cooperative = true,
): Promise<ImpostorAssetLease> {
  await measureFoliageTextures();
  return treeImpostors[species].acquireAssets(scene, undefined, variant, { cooperative });
}

/** Builds the original procedural geometry at the requested rendered height. */
export async function createTreeModels(
  scene: Scene,
  renderHeight: number,
  species: TreeSpecies = "birch",
  seed?: number,
  season?: TreeSeasonAppearance,
): Promise<Mesh[]> {
  await measureFoliageTextures();
  const treeDefinition = TREE_SPECIES[species];
  let cache = treeModelCaches.get(scene);
  if (!cache) {
    cache = new TreeModelGeometryCache();
    treeModelCaches.set(scene, cache);
    scene.onDisposeObservable.addOnce(() => treeModelCaches.delete(scene));
  }
  // Height is applied after retrieval: mature trees and saplings can share a bake.
  const key = JSON.stringify([species, seed ?? null, season ?? null]);
  const meshes = await cache.create(key, scene, async () => {
    const parts = treeDefinition.create(scene, {
      name: `${species}TreeModels`,
      liveLighting: true,
      season,
      ...(seed === undefined ? {} : { seed }),
    });
    const meshes = [parts.log, parts.branches];
    meshes.forEach((mesh) => { mesh.isVisible = false; });
    try {
      await bakeTreeExposure(meshes);
    } catch (error) {
      const materials = new Set(meshes.map((mesh) => mesh.material));
      meshes.forEach((mesh) => mesh.dispose(false, false));
      materials.forEach((material) => material?.dispose(true, false));
      throw error;
    }
    return meshes;
  });
  const material = createTreeModelMaterial(scene, `${species}TreeModels`, species);
  material.options.defines.push("#define TREE_EXPOSURE");
  material.options.attributes.push("sunExposureLow", "sunExposureHigh");
  const renderScale = renderHeight / treeDefinition.sourceHeight;
  for (const mesh of meshes) {
    mesh.material = material;
    scaleTreeMesh(mesh, renderScale, renderHeight / 2, renderHeight);
  }
  return meshes;
}

/** Builds only the species trunk, centered so it can be rotated onto the ground. */
export async function createTreeLogModel(
  scene: Scene,
  renderHeight: number,
  species: TreeSpecies,
  seed?: number,
  season?: TreeSeasonAppearance,
): Promise<Mesh> {
  await measureFoliageTextures();
  const treeDefinition = TREE_SPECIES[species];
  const parts = treeDefinition.create(scene, {
    name: `${species}FallenLog`,
    liveLighting: true,
    season,
    ...(seed === undefined ? {} : { seed }),
  });
  parts.branches.dispose(false, false);
  scaleTreeMesh(parts.log, renderHeight / treeDefinition.sourceHeight, 0, renderHeight);
  return parts.log;
}

function scaleTreeMesh(
  mesh: Mesh,
  scale: number,
  yOffset: number,
  modelHeight: number,
): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Procedural tree part has no position data.");
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + yOffset;
    positions[index + 2] *= scale;
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.refreshBoundingInfo({ updatePositionsArray: false });
  setVertexColorModelHeight(mesh, modelHeight);
}
