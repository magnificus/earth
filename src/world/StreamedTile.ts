import type { AbstractMesh, Mesh, TransformNode } from "@babylonjs/core";
import { OpenStreetMap } from "./OpenStreetMap";
import type { MapTile } from "./OpenStreetMap";
import type { RockFieldResult } from "../vegetation/RockField";
import type { TerrainData } from "../terrain/TerrainData";
import type { RoadAndBuildingPlan } from "../roads/RoadAndBuildingPlanner";
import { disposeTerrainMesh } from "../terrain/TerrainMaterial";
import { disposeTerrainLakeLayer } from "../terrain/TerrainLakeSurface";
import type { TerrainLakeLayer } from "../terrain/TerrainLakeSurface";
import type { VegetationFieldResult } from "../vegetation/VegetationField";
import type { WorldTileId } from "./WorldGrid";
import type { WorldCover } from "./WorldCover";
import type { HorizontalExclusionMask } from "./Geo";
import { traceStreamingSynchronous } from "../diagnostics/StreamingDiagnostics";
import type { TileGeneration } from "./TileGeneration";

export const VEGETATION_FIELD_KINDS = [
  "treeField",
  "saplingField",
  "grassField",
  "tallPlantField",
  "wheatField",
  "rockyBeachField",
  "bushField",
  "fernField",
] as const;

export type VegetationFieldKind = typeof VEGETATION_FIELD_KINDS[number];

/** One streamed world tile and every scene resource it owns. */
export interface StreamedTile extends Partial<Record<VegetationFieldKind, VegetationFieldResult>> {
  id: WorldTileId;
  key: string;
  /** Revision of the settings baked into this tile's geometry. */
  sceneryRevision: number;
  terrainData: TerrainData;
  landCover?: WorldCover;
  preCarvingElevations: Float32Array;
  mapTiles?: Promise<MapTile[]>;
  lakeContextTiles?: Promise<MapTile[]>;
  roadAndBuildingPlan: RoadAndBuildingPlan;
  generationStages: TileGeneration;
  captureGeneration: boolean;
  terrain: Mesh;
  meshWidth: number;
  meshDepth: number;
  offsetX: number;
  offsetZ: number;
  nativeTerrain: boolean;
  rockField?: RockFieldResult;
  mapFeatures?: TransformNode;
  barrierField?: VegetationFieldResult;
  lakeSurfaces?: TerrainLakeLayer;
  lakeExclusionMask?: HorizontalExclusionMask;
  riverExclusionMask?: HorizontalExclusionMask;
  farBuildings?: TransformNode;
  farRoads?: TransformNode;
  farTreeField?: VegetationFieldResult;
  detailed: boolean;
  lastNeededMilliseconds: number;
  detailLastNeededMilliseconds: number;
  lodResolved: boolean;
  sharedElevationOwner: object;
  /** Releases edge/feature values once no streamed tile needs them. */
  releaseSharedElevations: () => void;
}

/** Map features fade through per-mesh visibility; 1 restores the opaque path. */
export function setMapLayerFade(root: TransformNode, fade: number): void {
  if (root.isDisposed()) return;
  for (const mesh of root.getChildMeshes(false)) mesh.visibility = fade;
}

/**
 * Meshes that opted out of Babylon's bounding sync (thin-instance LOD fields)
 * keep their local bounds, but the world-space copy used for frustum culling
 * must still follow the mesh whenever its world matrix changes.
 */
function syncUnmanagedBoundingInfo(mesh: AbstractMesh): void {
  if (!mesh.doNotSyncBoundingInfo) return;
  mesh.getBoundingInfo().update(mesh.getWorldMatrix());
}

export function setFrozenMeshOffset(mesh: Mesh, x: number, z: number): void {
  const wasFrozen = mesh.isWorldMatrixFrozen;
  if (wasFrozen) mesh.unfreezeWorldMatrix();
  mesh.position.x = x;
  mesh.position.z = z;
  mesh.computeWorldMatrix(true);
  syncUnmanagedBoundingInfo(mesh);
  if (wasFrozen) mesh.freezeWorldMatrix();
}

export function setTransformNodeOffset(root: TransformNode, x: number, z: number): void {
  const frozenChildren = root.getChildMeshes(false).filter((mesh) => mesh.isWorldMatrixFrozen);
  frozenChildren.forEach((mesh) => mesh.unfreezeWorldMatrix());
  root.position.x = x;
  root.position.z = z;
  root.computeWorldMatrix(true);
  root.getChildMeshes(false).forEach((mesh) => {
    mesh.computeWorldMatrix(true);
    syncUnmanagedBoundingInfo(mesh);
  });
  frozenChildren.forEach((mesh) => mesh.freezeWorldMatrix());
}

export function disposeTileDetail(record: StreamedTile): void {
  traceStreamingSynchronous(`tile=${record.key} dispose detail`, () => disposeTileDetailResources(record));
}

function disposeTileDetailResources(record: StreamedTile): void {
  for (const kind of VEGETATION_FIELD_KINDS) {
    record[kind]?.root.dispose(false, false);
    record[kind] = undefined;
  }
  record.rockField?.root.dispose(false, true);
  record.rockField = undefined;
  if (record.mapFeatures) OpenStreetMap.disposeLayer(record.mapFeatures);
  record.mapFeatures = undefined;
  record.barrierField = undefined;
  record.detailed = false;
}

export function disposeStreamedTile(record: StreamedTile): void {
  traceStreamingSynchronous(`tile=${record.key} dispose tile`, () => disposeStreamedTileResources(record));
}

function disposeStreamedTileResources(record: StreamedTile): void {
  record.releaseSharedElevations();
  disposeTileDetail(record);
  record.farTreeField?.root.dispose(false, false);
  record.farTreeField = undefined;
  if (record.farBuildings) OpenStreetMap.disposeLayer(record.farBuildings);
  record.farBuildings = undefined;
  if (record.farRoads) OpenStreetMap.disposeLayer(record.farRoads);
  record.farRoads = undefined;
  if (record.lakeSurfaces) disposeTerrainLakeLayer(record.lakeSurfaces);
  record.lakeSurfaces = undefined;
  disposeTerrainMesh(record.terrain);
}
