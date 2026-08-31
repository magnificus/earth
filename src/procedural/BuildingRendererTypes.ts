import type { BaseTexture, Color3, Mesh, Vector3 } from "@babylonjs/core";
import type { BuildingPlan, BuildingPolygon, BuildingRoofShape } from "../BuildingPlanner";
import type { BuildingLayout } from "../BuildingLayoutPlanner";
import type { ApartmentLayout } from "../ApartmentLayoutPlanner";
import type { Opening2D, Point2D } from "../FloorPlan";

export interface BuildingRenderOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  skyReflection?: BaseTexture | null;
  showRoofs?: boolean;
  /** Other footprints in the current map batch, used to detect party walls. */
  neighboringBuildingFootprints?: readonly BuildingPolygon[];
  /** Optional precomputed neighborhood roof decisions for stable batch rendering. */
  residentialRoofShapes?: ReadonlyMap<string, BuildingRoofShape>;
}

export interface BuildingAppearance {
  wall: Color3;
  roof: Color3;
  trim: Color3;
}

export interface PreparedBuildingFootprint {
  outline: ScenePoint[];
  holes: ScenePoint[][];
  baseElevation: number;
}

export interface ScenePoint {
  x: number;
  z: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface DetailedBuildingParts {
  parts: Mesh[];
  windowCount: number;
  floorCount: number;
  stairFlightCount: number;
  entranceEdgeIndex: number;
  stairEdgeIndex?: number;
  stairEdgeIndices: number[];
  stairFlightCenters: ScenePoint[];
  windowStyleId: string;
  windowRegion: string;
  plannedInterior: boolean;
}

export interface PlannedInterior {
  building: BuildingLayout;
  apartments: ApartmentLayout[];
}

export interface InteriorPlanningAttempt {
  input: Parameters<typeof import("../BuildingLayoutPlanner").planBuildingLayout>[0];
  interior?: PlannedInterior;
  failure?: string;
}

export interface PendingBuildingInterior {
  center: Vector3;
  radiusMeters: number;
  load: () => Mesh | undefined;
}

export interface LoadedBuildingInterior {
  center: Vector3;
  pending: PendingBuildingInterior;
  mesh: Mesh;
}

export interface StairLayout {
  edgeIndex: number;
  start: ScenePoint;
  direction: ScenePoint;
  inward: ScenePoint;
  runMeters: number;
  widthMeters: number;
}

export interface EntranceClearance {
  edgeIndex: number;
  centerMeters: number;
  widthMeters: number;
}

export interface WindowGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
  colors: number[];
}

export interface BuildingShadowRange {
  indexStart: number;
  indexCount: number;
}

export type { BuildingPlan, ApartmentLayout, BuildingLayout, Opening2D, Point2D };
