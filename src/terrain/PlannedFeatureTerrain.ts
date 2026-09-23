import { visitTerrainRaster } from "./TerrainRaster";
import { sampleElevation } from "../world/Geo";
import { smoothstep } from "../core/MathUtils";
import {
  averagePoint,
  distanceToRing,
  PlanarCellIndex,
  pointBounds,
  pointInRing,
  type PlanarPoint,
} from "../core/PlanarGeometry";
import { roadGradeAmount } from "../roads/RoadAndBuildingPlanner";
import type {
  PlannedBuildingSite,
  PlannedRoadPolygon,
  PlanningPoint,
  RoadAndBuildingPlan,
} from "../roads/RoadAndBuildingPlanner";
import type { TerrainData } from "./TerrainData";
import type { SharedValueMap } from "../core/OwnedValueCache";
import type { StreamingTrace } from "../diagnostics/StreamingDiagnostics";

export interface PlannedFeatureTerrainOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  /** Stable pad height shared by every tile touched by one building. */
  sharedBuildingElevations?: SharedValueMap<string, number>;
  onBuildingPadsComplete?: () => void;
}

interface RoadGrade {
  road: PlannedRoadPolygon;
  startElevation: number;
  endElevation: number;
}

interface BuildingGrade {
  site: PlannedBuildingSite;
  elevation: number;
}

// Limit excavation into natural hills, while allowing low ground to be filled
// to the road grade. Building earthwork is replaced by the final road pass.
const MAX_ROAD_CUT_METERS = 1;

/** Levels building pads, then applies road grades from the original terrain. */
export async function conformTerrainToPlannedFeatures(
  terrain: TerrainData,
  plan: RoadAndBuildingPlan,
  options: PlannedFeatureTerrainOptions,
  yieldControl?: () => Promise<void>,
  trace?: StreamingTrace,
): Promise<number> {
  if (plan.roads.length === 0 && plan.buildingSites.length === 0) {
    options.onBuildingPadsComplete?.();
    return 0;
  }
  trace?.stage("road grade sampling and terrain copy", "synchronous");
  const original = terrain.elevations.slice();
  const sampleSpacing = Math.max(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  );
  const rasterMargin = sampleSpacing * Math.SQRT2;
  const roadBlendWidth = Math.max(1.5 * sampleSpacing, 2 / options.metersPerUnit);
  // Every corner of a raster cell intersecting a footprint must be protected,
  // including the diagonally opposite corner of a cell containing a small house.
  const buildingFlatMargin = Math.max(rasterMargin, 1 / options.metersPerUnit);
  const buildingBlendWidth = Math.max(sampleSpacing * 1.5, 3 / options.metersPerUnit);

  const roads: RoadGrade[] = plan.roads
    .filter((road) => road.structure === "surface" || road.structure === "ford")
    .map((road) => ({
      road,
      startElevation: elevationAt(terrain, road.centerline[0], options, original),
      endElevation: elevationAt(terrain, road.centerline[1], options, original),
    }));
  const buildings: BuildingGrade[] = [];
  trace?.stage("building grade sampling");
  for (const site of plan.buildingSites) {
    const points = [averagePoint(site.outline), ...site.outline]
      .filter((point) => withinTerrain(point, options));
    const elevations = points
      .map((point) => elevationAt(terrain, point, options, original))
      .sort((a, b) => a - b);
    const sampledElevation = elevations[Math.floor(elevations.length / 2)];
    if (elevations.length > 0 && sampledElevation > 0) {
      let elevation = options.sharedBuildingElevations?.get(site.sourceId);
      if (elevation === undefined) {
        elevation = sampledElevation;
        options.sharedBuildingElevations?.set(site.sourceId, elevation);
      }
      buildings.push({
        site,
        elevation,
      });
    }
    await yieldControl?.();
  }

  trace?.stage("road and building spatial indexes", "synchronous");
  const cellSize = Math.max(sampleSpacing * 4, 12 / options.metersPerUnit);
  const roadCells = new PlanarCellIndex<RoadGrade>(cellSize);
  for (const grade of roads) {
    roadCells.add(grade, pointBounds(grade.road.outline),
      rasterMargin + grade.road.shoulderWidthMeters / options.metersPerUnit + roadBlendWidth);
  }
  const buildingCells = new PlanarCellIndex<BuildingGrade>(cellSize);
  for (const grade of buildings) {
    buildingCells.add(grade, pointBounds(grade.site.outline), buildingFlatMargin + buildingBlendWidth);
  }
  let modified = 0;
  const touched = new Uint8Array(original.length);
  // Finish every building pad before aligning the road bed and its shoulders.
  trace?.stage("building pad raster shaping");
  await visitTerrainRaster(terrain, options, (index, x, z) => {
    const sample = { x, z };
    const buildingTarget = strongestBuildingTarget(
      sample,
      buildingCells.queryPoint(sample),
      buildingFlatMargin,
      buildingBlendWidth,
    );
    if (!buildingTarget) return;

    terrain.elevations[index] = original[index] +
      (buildingTarget.elevation - original[index]) * buildingTarget.weight;
    touched[index] = 1;
    modified++;
  }, yieldControl);
  options.onBuildingPadsComplete?.();
  trace?.stage("road grade raster shaping");
  await visitTerrainRaster(terrain, options, (index, x, z) => {
    const sample = { x, z };
    const roadTarget = strongestRoadTarget(
      sample, roadCells.queryPoint(sample), rasterMargin, roadBlendWidth, options.metersPerUnit,
    );
    if (!roadTarget) return;
    // Sample grades from the original terrain so building pad edges cannot
    // introduce bumps. Fill depressions fully, including those deeper than
    // the excavation limit, then blend into the completed building pass.
    const roadElevation = Math.max(original[index] - MAX_ROAD_CUT_METERS, roadTarget.elevation);
    const elevation = terrain.elevations[index];
    terrain.elevations[index] = elevation + (roadElevation - elevation) * roadTarget.weight;
    if (!touched[index]) modified++;
  }, yieldControl);
  trace?.stage("planned terrain elevation range", "synchronous");
  updateElevationRange(terrain);
  return modified;
}

function strongestRoadTarget(
  sample: PlanarPoint,
  roads: readonly RoadGrade[],
  flatMargin: number,
  blendWidth: number,
  metersPerUnit: number,
): { elevation: number; weight: number; inside: boolean } | undefined {
  let result: { elevation: number; weight: number; distance: number; inside: boolean } | undefined;
  for (const grade of roads) {
    const inside = pointInRing(sample, grade.road.outline);
    const distance = inside
      ? 0
      : distanceToRing(sample, grade.road.outline);
    // Shoulders share their carriageway's grade, including at junctions.
    const roadFlatMargin = flatMargin + grade.road.shoulderWidthMeters / metersPerUnit;
    const outer = roadFlatMargin + blendWidth;
    if (distance >= outer) continue;
    const weight = distance <= roadFlatMargin ? 1 : 1 - smoothstep(roadFlatMargin, outer, distance);
    if (result && (weight < result.weight || (weight === result.weight && distance >= result.distance))) continue;
    const amount = roadGradeAmount(grade.road, sample);
    result = {
      elevation: grade.startElevation + (grade.endElevation - grade.startElevation) * amount,
      weight,
      distance,
      inside,
    };
  }
  return result;
}

function strongestBuildingTarget(
  sample: PlanarPoint,
  buildings: readonly BuildingGrade[],
  flatMargin: number,
  blendWidth: number,
): { elevation: number; weight: number; inside: boolean } | undefined {
  let weightedElevation = 0;
  let totalWeight = 0;
  let strongest = 0;
  let insideAny = false;
  let protectedElevation = Infinity;
  const outer = flatMargin + blendWidth;
  for (const grade of buildings) {
    const inside = pointInRing(sample, grade.site.outline);
    const distance = inside
      ? 0
      : distanceToRing(sample, grade.site.outline);
    if (distance >= outer) continue;
    const weight = distance <= flatMargin ? 1 : 1 - smoothstep(flatMargin, outer, distance);
    if (distance <= flatMargin) {
      protectedElevation = Math.min(protectedElevation, grade.elevation);
    }
    weightedElevation += grade.elevation * weight;
    totalWeight += weight;
    strongest = Math.max(strongest, weight);
    insideAny ||= inside;
  }
  // Where pads overlap, the lower floor is the hard ceiling. Averaging their
  // heights would bury that floor even when both pads have full influence.
  if (protectedElevation < Infinity) {
    return { elevation: protectedElevation, weight: 1, inside: insideAny };
  }
  return totalWeight > 0
    ? { elevation: weightedElevation / totalWeight, weight: strongest, inside: insideAny }
    : undefined;
}

function elevationAt(
  terrain: TerrainData,
  point: PlanningPoint,
  options: PlannedFeatureTerrainOptions,
  elevations: Float32Array,
): number {
  return sampleElevation(
    terrain,
    point.x,
    point.z,
    options.meshWidth,
    options.meshDepth,
    elevations,
  );
}

function withinTerrain(point: PlanningPoint, options: PlannedFeatureTerrainOptions): boolean {
  return Math.abs(point.x) <= options.meshWidth / 2 && Math.abs(point.z) <= options.meshDepth / 2;
}

function updateElevationRange(terrain: TerrainData): void {
  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of terrain.elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
}
