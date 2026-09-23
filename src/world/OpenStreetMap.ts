import { mapGridRange } from "../core/GridSampling";
import { ResourceCache } from "../core/ResourceCache";
import { BuildingTrace } from "../buildings/BuildingDiagnostics";
import type { BuildingPlanningWorker } from "../buildings/BuildingPlanningWorker";
import { createFrameBudgetYielder } from "../diagnostics/FrameBudget";
import { yieldToNearbyInteriors } from "../procedural/InteriorStreaming";
import { DIRT_ROAD_EDGE_KIND, DIRT_ROAD_EDGE_ALPHA_GLSL, dirtRoadEdgeCoordinates } from "../roads/DirtRoadEdges";
import { CustomMaterial } from "@babylonjs/materials/custom/customMaterial.js";
import { SnowCoverPlugin } from "../rendering/SnowCover";
import { mergeBuildingSourceGroups } from "../buildings/CompositeBuildings";
import { inferBuildingUse, type BuildingUseContext } from "../buildings/BuildingUseInference";
import type { SharedValueMap } from "../core/OwnedValueCache";
import {
  Color3,
  Material,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  PBRMaterial,
  PolygonMeshBuilder,
  RawTexture,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector2,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import type { BaseTexture } from "@babylonjs/core";
import { VectorTile, VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import earcut from "earcut";
import {
  combineHorizontalExclusionMasks,
  clipPolyline,
  type HorizontalExclusionMask,
  lonLatToScene,
  PolygonExclusionMask,
  SegmentExclusionMask as RoadExclusionMask,
  type HorizontalSegment as RoadSegment,
  resamplePath,
  sampleElevation,
  SEA_LEVEL_METERS,
} from "./Geo";
import { ROAD_TEXTURE_SIZE, roadTexturePixels, type RoadMaterialStyle } from "./RoadTexturePixels";
import type { TerrainData } from "../terrain/TerrainData";
import { worldTileAtLocation, type TileBounds } from "./WorldGrid";
import { buildingBelongsToWorldTile } from "../buildings/BuildingTileOwnership";
import {
  type BuildingDetailLevel,
  type BuildingSource,
  type LonLat,
  planBuilding,
} from "../buildings/BuildingPlanner";
import { ProceduralBuildingRenderer } from "../procedural/ProceduralBuildingRenderer";
import {
  createWaterSurfaceMaterial,
  bindWaterMaterial,
  isSharedWaterMaterial,
  prepareWaterSurfaceMesh,
} from "../water/Water";
import {
  planRoad,
  type RoadPlan,
  type RoadSurface,
  type RoadVisualStyle,
  roadVegetationShoulderMeters,
} from "../roads/RoadPlanner";
import {
  planRoadsAndBuildings,
  roadGradeAmount,
  type JunctionArm,
  type PlannedRoadPolygon,
  type RoadAndBuildingPlan,
} from "../roads/RoadAndBuildingPlanner";
import { conformTerrainToPlannedFeatures } from "../terrain/PlannedFeatureTerrain";
import type { RoadPlanningInput } from "../roads/RoadPlanningTask";
import type { StreamingTrace } from "../diagnostics/StreamingDiagnostics";
import { clipToBounds, signedArea, pointBounds, type PlanarBounds, type PlanarPoint } from "../core/PlanarGeometry";
import { conformDecalPolygonAsync } from "../terrain/TerrainSurface";
import type { TerrainSurface } from "../terrain/TerrainSurface";
import { createOpenStreetMapLandCover } from "./OpenStreetMapLandCover";
import type { LandCoverSampler } from "./WorldCover";
import type { TerrainLakeSource } from "../terrain/TerrainLakePolygons";
import { collectPreparedLakePolygons, prepareLakeCandidate, type LakeCollectionInput } from "../water/LakeCollectionTask";
import { isSurfaceWaterFeature } from "../water/WaterFeatureVisibility";
import { riverChannelDepth, riverFlowSign, riverSurfaceFrame, riverSurfaceLevels } from "../water/RiverSurface";
import { bridgeProfile } from "../roads/BridgeProfile";

export interface MapTile {
  x: number;
  y: number;
  zoom: number;
  data: VectorTile;
}

// Finish the current building, then flush the merge batch without reducing detail.
const BUILDING_MERGE_VERTEX_BUDGET = 32_000;

/** Enough separation to avoid z-fighting without making roads hover. */
const ROAD_SURFACE_CLEARANCE_METERS = 0.025;
const ROAD_SHOULDER_CLEARANCE_METERS = 0.012;
/** Polygon offset makes terrain-conforming roads render as decals over the ground. */
const ROAD_SURFACE_DEPTH_BIAS = -2;
const ROAD_SHOULDER_DEPTH_BIAS = -1;
const BRIDGE_DECK_THICKNESS_METERS = 0.32;
const BRIDGE_EDGE_WIDTH_METERS = 0.45;
const BRIDGE_WATER_CLEARANCE_METERS = 3;
// Planned roads use depth bias as decals, so waterways only need enough height
// to clear the exact terrain surface. Keeping this below the carriageway's
// physical clearance also gives roads deterministic precedence at crossings.
const WATERWAY_SURFACE_CLEARANCE_METERS = 0.02;

/** A deliberately non-round span keeps gravel repeats from lining up with road sampling. */
const LOOSE_ROAD_TEXTURE_REPEAT_METERS = 6.7;

interface RoadSource {
  id: string;
  paths: LonLat[][];
  properties: Readonly<Record<string, unknown>>;
}

const buildingSourceCache = new WeakMap<VectorTile, readonly BuildingSource[]>();
interface BuildingSourceCacheNode {
  children: WeakMap<VectorTile, BuildingSourceCacheNode>;
  sources?: readonly BuildingSource[];
  pending?: Promise<void>;
}
const compositeBuildingSourceCache: BuildingSourceCacheNode = { children: new WeakMap() };
const roadSourceCache = new WeakMap<VectorTile, readonly RoadSource[]>();

interface MapLayerOptions {
  onBuildingPlan?: (plan: ReturnType<typeof planBuilding>) => void;
  onBuildingsCreated?: (meshes: Mesh[]) => void;
  buildingPlanningWorker?: Pick<BuildingPlanningWorker, "plan">;
  isCancelled?: () => boolean;
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  skyReflection?: BaseTexture | null;
  showRoofs?: boolean;
  /** Snow depth in [0, 1] on the tile; roofs grow slabs of matching thickness. */
  snowCover?: number;
  /** Provider elevations retained before coastline shaping for bridge clearance. */
  preCarvingElevations?: Float32Array;
  /** Creates the layer hidden so partially built meshes never flash on screen. */
  startDisabled?: boolean;
  /** Shared geometry plan prepared before terrain construction. */
  planning?: RoadAndBuildingPlan;
  /** Stable pad height shared by every tile touched by one building. */
  sharedBuildingElevations?: SharedValueMap<string, number>;
  /** The rendered ground, so terrain-conforming decals cannot sink into it. */
  terrainSurface?: TerrainSurface;
}

export interface MapFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  lakePolygons: TerrainLakeSource[];
  counts: { buildings: number; roads: number; water: number };
}

interface CreatedRoad {
  surfaces: Mesh[];
  shoulders: Mesh[];
  bridgeDecks: Mesh[];
  paths: Array<Array<{ x: number; z: number }>>;
}

interface RoadJunctionCandidate {
  sourceId: string;
  point: { x: number; z: number };
  halfWidth: number;
  layer: number;
  visualStyle: RoadVisualStyle;
}

export interface BuildingFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
}

export interface RoadFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
}

export class OpenStreetMap {
  /** Provider features are decoded only when an explicit debug capture requests them. */
  static captureTileSources(tiles: readonly MapTile[]): unknown[] {
    return tiles.map(tile => ({ x: tile.x, y: tile.y, zoom: tile.zoom,
      layers: Object.fromEntries(Object.entries(tile.data?.layers ?? {}).map(([name, layer]) =>
        [name, Array.from({ length: layer.length }, (_, index) =>
          layer.feature(index).toGeoJSON(tile.x, tile.y, tile.zoom))])),
    }));
  }

  static collectWaterwaySegments(
    tiles: MapTile[],
    terrain: TerrainData,
    options: { meshWidth: number; meshDepth: number; metersPerUnit: number },
  ): import('./Geo').HorizontalSegment[] {
    const segments: import('./Geo').HorizontalSegment[] = [];
    for (const tile of tiles) {
      forEachFeature(tile, "waterway", (feature) => {
        if (!isSurfaceWaterFeature(feature.properties)) return;
        const widthMeters = waterwayWidthMeters(feature.properties.class);
        if (widthMeters === undefined) return;
        for (const line of lines(feature, tile)) {
          const points = line.map(([lon, lat]) => lonLatToScene(
            lon, lat, terrain.bounds, options.meshWidth, options.meshDepth,
          ));
          for (let index = 1; index < points.length; index++) {
            segments.push({ start: points[index - 1], end: points[index],
              halfWidth: widthMeters / options.metersPerUnit / 2 });
          }
        }
      });
    }
    return segments;
  }

  private static readonly ZOOM = 14;
  private static readonly TILE_URL = "https://tiles.openfreemap.org/planet/latest";
  private static readonly cache = new ResourceCache<{ data: VectorTile | undefined; bytes: number }>(
    16 * 1024 * 1024, (tile) => tile.bytes,
  );

  static async fetch(bounds: TileBounds, zoom = this.ZOOM): Promise<MapTile[]> {
    const northWest = worldTileAtLocation(bounds.latNorth, bounds.lonWest, zoom);
    // Terrain bounds commonly end exactly on a slippy-tile boundary. Treat the
    // east and south edges as exclusive so we do not fetch an unused extra row
    // and column of vector tiles.
    const southEast = worldTileAtLocation(bounds.latSouth + 1e-10, bounds.lonEast - 1e-10, zoom);
    const requests = mapGridRange(northWest.x, southEast.x, northWest.y, southEast.y,
      (x, y) => this.fetchTile(x, y, zoom));
    return (await Promise.all(requests)).filter((tile): tile is MapTile => tile !== undefined);
  }

  static async createLayer(
    scene: Scene,
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<MapFeatureLayer> {
    return BuildingTrace.runAsync(`tile=${JSON.stringify(terrain.worldTile)} map layer`, async (trace) => {
      trace.stage("layer setup/lakes/building sources");
      const root = new TransformNode("mapFeatures", scene);
      if (options.startDisabled) root.setEnabled(false);
      const roadMeshes: Record<RoadVisualStyle, Mesh[]> = {
        marked: [],
        paved: [],
        pedestrian: [],
        dirt: [],
        unpaved: [],
        ford: [],
      };
      const roadShoulders: Record<RoadSurface, Mesh[]> = {
        paved: [],
        unpaved: [],
      };
      const bridgeDecks: Mesh[] = [];
      const junctionCandidates: RoadJunctionCandidate[] = [];
      const lakePolygons = this.collectLakePolygons(tiles, terrain, options);
      const waterways: Mesh[] = [];
      const riverGeometry = collectRiverGeometry(tiles, terrain, options);
      try {
        if (options.planning) {
          trace.stage("planned road/shoulder geometry");
          const plannedMeshes = await createPlannedRoadMeshes(scene, options.planning.roads, terrain, options, yieldControl);
          for (const visualStyle of Object.keys(plannedMeshes) as RoadVisualStyle[]) {
            const mesh = plannedMeshes[visualStyle];
            if (mesh) roadMeshes[visualStyle].push(mesh);
          }
          const plannedShoulders = await createPlannedShoulderMeshes(
            scene,
            options.planning.shoulders,
            terrain,
            options,
            yieldControl,
          );
          for (const surface of Object.keys(plannedShoulders) as RoadSurface[]) {
            const mesh = plannedShoulders[surface];
            if (mesh) roadShoulders[surface].push(mesh);
          }
        }
      } catch (error) {
        for (const mesh of [...Object.values(roadMeshes).flat(), ...Object.values(roadShoulders).flat()]) mesh.dispose();
        root.dispose();
        throw error;
      }

      const buildings = await createBuildingBatches(
        scene, tiles, terrain, options, "detailed", root, "buildings", yieldControl,
      ).catch((error) => {
        for (const mesh of [...Object.values(roadMeshes).flat(), ...Object.values(roadShoulders).flat()]) {
          if (!mesh.isDisposed()) mesh.dispose();
        }
        root.dispose();
        throw error;
      });
      options.onBuildingsCreated?.(buildings.meshes);
      trace.stage("roads/waterways including frame yields");
      for (const tile of tiles) {
        await yieldControl?.();
        for (const source of roadSources(tile)) {
          const appearance = planRoad(source.properties);
          if (!appearance || appearance.isTunnel) continue;
          if (options.planning && appearance.structure !== "bridge") continue;
          const target = roadMeshes[appearance.visualStyle];
          for (const line of source.paths) {
            const created = createRoad(scene, line, terrain, options, appearance, "detailed");
            target.push(...created.surfaces);
            if (appearance.visualStyle !== "dirt") {
              roadShoulders[appearance.surface].push(...created.shoulders);
            }
            bridgeDecks.push(...created.bridgeDecks);
            if (!options.planning &&
                (appearance.structure === "surface" || appearance.structure === "ford")) {
              for (const path of created.paths) {
                if (path.length < 2) continue;
                for (const point of [path[0], path[path.length - 1]]) {
                  junctionCandidates.push({
                    sourceId: source.id,
                    point,
                    halfWidth: appearance.widthMeters / options.metersPerUnit / 2,
                    layer: appearance.layer,
                    visualStyle: appearance.visualStyle,
                  });
                }
              }
            }
          }
        }
        await yieldControl?.();
      }
      for (const data of riverGeometry) {
        const mesh = new Mesh("waterway", scene);
        data.applyToMesh(mesh, false);
        mesh.isPickable = false;
        waterways.push(stageMapMesh(mesh));
        await yieldControl?.();
      }

      trace.stage("road junction geometry");
      for (const junction of createRoadJunctions(
        scene,
        junctionCandidates,
        terrain,
        options,
      )) {
        roadMeshes[junction.visualStyle].push(junction.mesh);
      }

      trace.stage("final building/road/water merges (inclusive)");
      const meshes = [
        ...buildings.meshes,
        mergeRoads(roadShoulders.paved, "pavedRoadShoulders", "pavedShoulder", root),
        mergeRoads(roadShoulders.unpaved, "unpavedRoadShoulders", "unpavedShoulder", root),
        mergeRoads(bridgeDecks, "bridgeDecks", "bridgeDeck", root),
        mergeRoads(roadMeshes.marked, "markedRoads", "marked", root),
        mergeRoads(roadMeshes.paved, "pavedRoads", "paved", root),
        mergeRoads(roadMeshes.pedestrian, "pedestrianRoads", "pedestrian", root),
        mergeRoads(roadMeshes.dirt, "dirtRoads", "dirt", root),
        mergeRoads(roadMeshes.unpaved, "unpavedRoads", "unpaved", root),
        mergeRoads(roadMeshes.ford, "fordRoads", "ford", root),
        mergeWaterways(waterways, root, options),
      ].filter((mesh): mesh is Mesh => mesh !== undefined);
      // Source meshes are disabled as soon as they are constructed so yielding
      // between feature batches cannot expose them at the scene origin. The
      // merged meshes can now be enabled safely: a streamed layer's disabled
      // root keeps them hidden until Game applies the tile offset and commits it.
      trace.stage("enable staged meshes");
      for (const mesh of meshes) mesh.setEnabled(true);
      return {
        root,
        meshes,
        lakePolygons,
        counts: {
          buildings: buildings.count,
          roads: Object.values(roadMeshes).reduce((sum, meshes) => sum + meshes.length, 0),
          water: lakePolygons.length + waterways.length,
        },
      };
    });
  }

  /** Projects map features once so terrain, meshes, and placement share one plan. */
  static planRoadsAndBuildings(
    tiles: readonly MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
    trace?: StreamingTrace,
  ): RoadAndBuildingPlan {
    const input = this.prepareRoadAndBuildingInputs(tiles, terrain, options, trace);
    trace?.stage("road and building planner", "synchronous");
    return planRoadsAndBuildings(input.roads, input.buildings, input.options);
  }

  /** Only projected, cloneable geometry crosses the worker boundary. */
  static prepareRoadAndBuildingInputs(
    tiles: readonly MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit"> & { includeShoulders?: boolean },
    trace?: StreamingTrace,
  ): RoadPlanningInput {
    trace?.stage("road source projection and clipping", "synchronous");
    const project = ([lon, lat]: LonLat) =>
      lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth);
    const roads = tiles.flatMap((tile) => roadSources(tile).flatMap((source) => {
      const appearance = planRoad(source.properties);
      return appearance ? [{
        id: source.id,
        // Grade each application-tile section from the elevations at its own
        // boundary crossings. Keeping an off-tile source segment here makes
        // both tiles clamp different endpoints and produces a visible lip.
        paths: source.paths.flatMap((path) => clipPolyline(
          path.map(project),
          options.meshWidth / 2,
          options.meshDepth / 2,
        )),
        appearance,
      }] : [];
    }));
    trace?.stage("building source composition and projection", "synchronous");
    const buildings = compositeBuildingSources(tiles).map((source) => ({
      id: source.id,
      outline: source.polygon.outer.map(project),
      holes: source.polygon.holes.map((hole) => hole.map(project)),
    }));
    return { roads, buildings, options: {
      meshWidth: options.meshWidth, meshDepth: options.meshDepth, metersPerUnit: options.metersPerUnit,
      includeShoulders: options.includeShoulders ?? true,
    } };
  }

  static async prepareBuildingComposition(
    tiles: readonly MapTile[],
    compose: (sources: readonly BuildingSource[]) => Promise<readonly BuildingSource[]>,
  ): Promise<void> {
    const cached = buildingCompositionCacheNode(tiles);
    if (cached.sources) return;
    if (!cached.pending) {
      cached.pending = compose(tiles.flatMap(tile => buildingSources(tile))).then(sources => {
        cached.sources = sources;
      }).finally(() => { cached.pending = undefined; });
    }
    await cached.pending;
  }

  static conformTerrainToPlan(
    planning: RoadAndBuildingPlan,
    terrain: TerrainData,
    options: Pick<
      MapLayerOptions,
      "meshWidth" | "meshDepth" | "metersPerUnit" | "sharedBuildingElevations"
    > & { onBuildingPadsComplete?: () => void },
    yieldControl?: () => Promise<void>,
    trace?: StreamingTrace,
  ): Promise<number> {
    return conformTerrainToPlannedFeatures(terrain, planning, options, yieldControl, trace);
  }

  /** Projects and clips authoritative OSM lake rings into this terrain tile. */
  static collectLakePolygons(
    tiles: readonly MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth"> & {
      /** Extra world-space margin retained for terrain deformation only. */
      clipPadding?: number;
    },
  ): TerrainLakeSource[] {
    return collectPreparedLakePolygons(this.prepareLakeCollection(tiles, terrain, options));
  }

  static prepareLakeCollection(
    tiles: readonly MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth"> & { clipPadding?: number; withoutObstacles?: boolean },
  ): LakeCollectionInput {
    const candidates: LakeCollectionInput["candidates"][number][] = [];
    const clipPadding = Math.max(0, options.clipPadding ?? 0);
    const clipBounds = {
      minX: -options.meshWidth / 2 - clipPadding,
      maxX: options.meshWidth / 2 + clipPadding,
      minZ: -options.meshDepth / 2 - clipPadding,
      maxZ: options.meshDepth / 2 + clipPadding,
    };
    const project = ([lon, lat]: LonLat) =>
      lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth);
    const cellSize = Math.max(options.meshWidth, options.meshDepth) / 8;
    for (const tile of tiles) {
      forEachFeature(tile, "water", (feature, featureIndex) => {
        if (feature.properties.class === "ocean" || !isSurfaceWaterFeature(feature.properties)) return;
        const waterPolygons = polygonRings(feature, tile);
        for (let polygonIndex = 0; polygonIndex < waterPolygons.length; polygonIndex++) {
          const rings = waterPolygons[polygonIndex];
          const water = {
            sourceId: waterFeatureSourceId(feature, tile, featureIndex, polygonIndex),
            outline: withoutClosingPoint(rings[0]).map(project),
            holes: rings.slice(1).map((ring) => withoutClosingPoint(ring).map(project)),
          };
          const candidate = prepareLakeCandidate(water, clipBounds);
          if (candidate) candidates.push(candidate);
        }
      });
    }
    // Test against full water outlines, not the tile-clipped portion: overlap
    // fractions in the worker deliberately describe the entire provider polygon.
    const waterBounds = candidates.map(({ water }) => pointBounds(water.outline));
    const metersPerUnit = terrain.groundWidthMeters / options.meshWidth;
    // Most terrain tiles contain no lake. Avoid decoding/projecting obstacles at all for those tiles.
    const withObstacles = candidates.length > 0 && !options.withoutObstacles;
    return {
      candidates, cellSize, metersPerUnit,
      // The worker subtracts footprints cumulatively, so overlaps and duplicates
      // already count once. Composing entire provider tiles here adds a long
      // main-thread polygon union (and building-use inference) for no benefit.
      buildings: withObstacles ? tiles.flatMap((tile) => lakeBuildingFootprints(tile)
        .filter((polygon) => sourceOverlapsWater(polygon[0], project, waterBounds))
        .map((polygon) => ({
        outline: polygon[0].map(project), holes: polygon.slice(1).map((hole) => hole.map(project)),
      }))) : [],
      roads: withObstacles ? tiles.flatMap((tile) => roadSources(tile).flatMap((source) => {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.structure !== "surface" || appearance.layer !== 0) return [];
        const halfWidth = appearance.widthMeters / (2 * metersPerUnit);
        const paths = source.paths.filter((path) => sourceOverlapsWater(path, project, waterBounds, halfWidth));
        return paths.length ? [{ paths: paths.map((path) => path.map(project)), appearance }] : [];
      })) : [],
    };
  }

  static async createBuildingLayer(
    scene: Scene,
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    detail: BuildingDetailLevel,
    yieldControl?: () => Promise<void>,
  ): Promise<BuildingFeatureLayer> {
    const name = detail === "far" ? "farBuildings" : "detailedBuildings";
    const root = new TransformNode(name, scene);
    if (options.startDisabled) root.setEnabled(false);
    const buildings = await createBuildingBatches(
      scene, tiles, terrain, options, detail, root, name, yieldControl,
    ).catch((error) => {
      root.dispose();
      throw error;
    });
    for (const mesh of buildings.meshes) mesh.setEnabled(true);
    return { root, ...buildings };
  }

  /** Keeps road surfaces visible beyond the full map-feature detail rings. */
  static async createRoadLayer(
    scene: Scene,
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<RoadFeatureLayer> {
    const root = new TransformNode("farRoads", scene);
    if (options.startDisabled) root.setEnabled(false);
    const roadMeshes: Record<RoadVisualStyle, Mesh[]> = {
      marked: [],
      paved: [],
      pedestrian: [],
      dirt: [],
      unpaved: [],
      ford: [],
    };
    let count = 0;
    if (options.planning) {
      const plannedMeshes = await createPlannedRoadMeshes(scene, options.planning.roads, terrain, options, yieldControl)
        .catch((error) => { root.dispose(); throw error; });
      for (const visualStyle of Object.keys(plannedMeshes) as RoadVisualStyle[]) {
        const mesh = plannedMeshes[visualStyle];
        if (mesh) roadMeshes[visualStyle].push(mesh);
      }
      count = new Set(options.planning.roads.map((road) => road.sourceId)).size;
    }
    for (const tile of tiles) {
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel) continue;
        if (options.planning && appearance.structure !== "bridge") continue;
        if (!options.planning || appearance.structure === "bridge") count++;
        for (const line of source.paths) {
          const created = createRoad(scene, line, terrain, options, appearance, "far");
          roadMeshes[appearance.visualStyle].push(...created.surfaces);
        }
      }
      await yieldControl?.();
    }
    const meshes = [
      mergeRoads(roadMeshes.marked, "farMarkedRoads", "marked", root),
      mergeRoads(roadMeshes.paved, "farPavedRoads", "paved", root),
      mergeRoads(roadMeshes.pedestrian, "farPedestrianRoads", "pedestrian", root),
      mergeRoads(roadMeshes.dirt, "farDirtRoads", "dirt", root),
      mergeRoads(roadMeshes.unpaved, "farUnpavedRoads", "unpaved", root),
      mergeRoads(roadMeshes.ford, "farFordRoads", "ford", root),
    ].filter((mesh): mesh is Mesh => mesh !== undefined);
    for (const mesh of meshes) mesh.setEnabled(true);
    return { root, meshes, count };
  }

  static async createRoadExclusionMask(
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<HorizontalExclusionMask> {
    const segments: RoadSegment[] = [];
    for (const tile of tiles) {
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel) continue;
        const halfWidth = (
          appearance.widthMeters / 2 + roadVegetationShoulderMeters(appearance)
        ) / options.metersPerUnit;
        for (const coordinates of source.paths) {
          const points = coordinates.map(([lon, lat]) =>
            lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
          );
          for (let index = 1; index < points.length; index++) {
            segments.push({ start: points[index - 1], end: points[index], halfWidth });
          }
        }
      }
      await yieldControl?.();
    }
    return new RoadExclusionMask(segments, Math.max(0.25, 20 / options.metersPerUnit));
  }

  /** Keeps vegetation clear of both road surfaces and occupied building footprints. */
  static async createVegetationExclusionMask(
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<HorizontalExclusionMask> {
    const roadMask = await this.createRoadExclusionMask(
      tiles,
      terrain,
      options,
      yieldControl,
    );
    const buildings = options.planning
      ? options.planning.buildingSites.map((site) => ({
        outer: site.outline,
        holes: site.holes,
      }))
      : [];
    if (!options.planning) {
      for (const source of compositeBuildingSources(tiles)) {
        const project = ([lon, lat]: LonLat) =>
          lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth);
        buildings.push({
          outer: source.polygon.outer.map(project),
          holes: source.polygon.holes.map((hole) => hole.map(project)),
        });
        await yieldControl?.();
      }
    }
    return combineHorizontalExclusionMasks([
      roadMask,
      new PolygonExclusionMask(
        buildings,
        Math.max(0.25, 20 / options.metersPerUnit),
      ),
    ]);
  }

  static createLandCoverSampler(
    tiles: readonly MapTile[],
    fallback: LandCoverSampler | undefined,
  ): LandCoverSampler | undefined {
    return createOpenStreetMapLandCover(tiles, fallback);
  }

  /** Disposes a streamed layer without taking down its scene-owned sky map. */
  static disposeLayer(root: TransformNode): void {
    for (const mesh of root.getChildMeshes(false)) {
      if (mesh.material && isSharedWaterMaterial(mesh.material)) {
        mesh.dispose(false, false);
        continue;
      }
      if (mesh.material && sharedRoadMaterials.has(mesh.material)) {
        mesh.material = null;
        continue;
      }
      // Hedge renderers own their materials and atlas leases. Dispose their
      // meshes without textures before recursive map cleanup can destroy the
      // shadow/cloud maps and atlases still used by other vegetation fields.
      if (mesh.material instanceof ShaderMaterial) {
        mesh.dispose(false, false);
        continue;
      }
      const materials = mesh.material instanceof MultiMaterial
        ? mesh.material.subMaterials
        : [mesh.material];
      for (const material of materials) {
        if (material instanceof PBRMaterial || material instanceof StandardMaterial) {
          material.reflectionTexture = null;
        }
      }
    }
    root.dispose(false, true);
  }

  private static async fetchTile(x: number, y: number, zoom: number): Promise<MapTile | undefined> {
    const key = `${zoom}/${x}/${y}`;
    const request = this.cache.getOrCreate(key, () => fetch(`${this.TILE_URL}/${key}.pbf`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`Map tile request failed (${response.status}).`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { data: bytes.length ? new VectorTile(new PbfReader(bytes)) : undefined, bytes: bytes.byteLength };
        }));
    const { data } = await request;
    return data ? { x, y, zoom, data } : undefined;
  }
}

async function createBuildingBatches(
  scene: Scene,
  tiles: MapTile[],
  terrain: TerrainData,
  options: MapLayerOptions,
  detail: BuildingDetailLevel,
  root: TransformNode,
  name: string,
  yieldControl?: () => Promise<void>,
): Promise<{ meshes: Mesh[]; count: number }> {
  return BuildingTrace.runAsync(`tile=${JSON.stringify(terrain.worldTile)} ${detail} building layer`, async (trace) => {
    trace.stage("layer setup/building sources");
    const buildings: Mesh[] = [];
    const meshes: Mesh[] = [];
    let count = 0;
    let chunkVertices = 0;
    const renderOptions = {
      ...options,
      renderWholeBuildingFootprints: true,
      neighboringBuildingFootprints: compositeBuildingSources(tiles).map((source) => source.polygon),
    };
    const prioritizeInteriors = (yieldBudget?: () => Promise<void>) => async (): Promise<void> => {
      await yieldBudget?.();
      await yieldToNearbyInteriors(scene, options.isCancelled);
      if (options.isCancelled?.()) throw new DOMException("Building layer cancelled", "AbortError");
    };
    const yieldBuilding = prioritizeInteriors(yieldControl);
    const yieldDetailedBuilding = prioritizeInteriors(yieldControl ?? createFrameBudgetYielder());
    try {
      for (const source of compositeBuildingSources(tiles)) {
        if (options.isCancelled?.()) throw new DOMException("Building layer cancelled", "AbortError");
        trace.stage("building ownership");
        if (!buildingBelongsToWorldTile(source.polygon, terrain.worldTile)) continue;
        trace.stage("frame yield before building");
        await yieldBuilding();
        trace.stage(`building=${source.id} plan/geometry/merge (inclusive)`);
        const plan = BuildingTrace.run(`building=${source.id} semantic plan`, () => planBuilding(source));
        options.onBuildingPlan?.(plan);
        const mesh = detail === "far"
          ? ProceduralBuildingRenderer.createFar(scene, plan, terrain, renderOptions)
          : options.buildingPlanningWorker
            ? await ProceduralBuildingRenderer.createDetailedAsync(scene, plan, terrain, renderOptions,
              options.buildingPlanningWorker, yieldDetailedBuilding, options.isCancelled)
            : ProceduralBuildingRenderer.createDetailed(scene, plan, terrain, renderOptions);
        if (mesh) {
          buildings.push(mesh);
          count++;
          chunkVertices += mesh.getTotalVertices();
          // Bound merge copies and GPU uploads instead of duplicating a whole
          // dense city tile in memory in one uninterrupted merge.
          if (chunkVertices >= BUILDING_MERGE_VERTEX_BUDGET) {
            const chunk = ProceduralBuildingRenderer.merge(buildings, name, root, true, options.snowCover ?? 0);
            if (chunk) {
              chunk.setEnabled(false);
              meshes.push(chunk);
            }
            buildings.length = 0;
            chunkVertices = 0;
          }
        }
        trace.stage("frame yield after building");
        await yieldBuilding();
      }

      trace.stage("final merge (inclusive)");
      const merged = ProceduralBuildingRenderer.merge(buildings, name, root, true, options.snowCover ?? 0);
      if (merged) {
        merged.setEnabled(false);
        meshes.push(merged);
      }
      return { meshes, count };
    } catch (error) {
      for (const mesh of [...buildings, ...meshes]) if (!mesh.isDisposed()) mesh.dispose();
      throw error;
    }
  });
}

function forEachFeature(
  tile: MapTile,
  layerName: string,
  visit: (feature: VectorTileFeature, index: number) => void,
): void {
  const layer = tile.data.layers[layerName];
  if (!layer) return;
  for (let index = 0; index < layer.length; index++) visit(layer.feature(index), index);
}

const lakeBuildingFootprintCache = new WeakMap<VectorTile, LonLat[][][]>();
const sourceCornerCache = new WeakMap<readonly LonLat[], readonly [LonLat, LonLat]>();

/** Mercator projection is monotonic on each axis. Two cached geographic
 * corners suffice to reject unrelated obstacles before allocating/projecting
 * all their vertices and cloning those vertices into the lake worker.
 */
function sourceOverlapsWater(
  path: readonly LonLat[], project: (point: LonLat) => PlanarPoint,
  waterBounds: readonly PlanarBounds[], padding = 0,
): boolean {
  if (!path.length) return false;
  let corners = sourceCornerCache.get(path);
  if (!corners) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of path) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    corners = [[minLon, minLat], [maxLon, maxLat]];
    sourceCornerCache.set(path, corners);
  }
  const a = project(corners[0]), b = project(corners[1]);
  const minX = Math.min(a.x, b.x) - padding, maxX = Math.max(a.x, b.x) + padding;
  const minZ = Math.min(a.z, b.z) - padding, maxZ = Math.max(a.z, b.z) + padding;
  return waterBounds.some((water) => minX <= water.maxX && maxX >= water.minX &&
    minZ <= water.maxZ && maxZ >= water.minZ);
}

function lakeBuildingFootprints(tile: MapTile): LonLat[][][] {
  const cached = lakeBuildingFootprintCache.get(tile.data);
  if (cached) return cached;
  const polygons: LonLat[][][] = [];
  forEachFeature(tile, "building", (feature) => {
    if (truthy(feature.properties.hide_3d)) return;
    for (const rings of polygonRings(feature, tile)) {
      if (rings.length) polygons.push(rings);
    }
  });
  lakeBuildingFootprintCache.set(tile.data, polygons);
  return polygons;
}

function buildingCompositionCacheNode(tiles: readonly MapTile[]): BuildingSourceCacheNode {
  // Each application tile receives a fresh provider-array wrapper. Key by the
  // immutable data sequence so adjacent tiles reuse the expensive composition.
  let cached = compositeBuildingSourceCache;
  for (const tile of tiles) {
    let next = cached.children.get(tile.data);
    if (!next) {
      next = { children: new WeakMap() };
      cached.children.set(tile.data, next);
    }
    cached = next;
  }
  return cached;
}

function compositeBuildingSources(tiles: readonly MapTile[]): readonly BuildingSource[] {
  const cached = buildingCompositionCacheNode(tiles);
  if (cached.sources) return cached.sources;
  return BuildingTrace.run(`provider tiles=${tiles.map((tile) => `${tile.zoom}/${tile.x}/${tile.y}`).join(",")} sources`, (trace) => {
    trace.stage("decode/features/use inference");
    const groups = tiles.map((tile) => buildingSources(tile));
    trace.stage(`merge overlapping footprints count=${groups.reduce((count, group) => count + group.length, 0)}`);
    const sources = mergeBuildingSourceGroups(groups);
    cached.sources = sources;
    return sources;
  });
}

function buildingSources(tile: MapTile): readonly BuildingSource[] {
  const cached = buildingSourceCache.get(tile.data);
  if (cached) return cached;
  const sources: BuildingSource[] = [];
  const points: BuildingUseContext["points"][number][] = [];
  const areas: BuildingUseContext["areas"][number][] = [];
  forEachFeature(tile, "poi", (feature) => {
    const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
    const positions = geometry.type === "Point" ? [geometry.coordinates]
      : geometry.type === "MultiPoint" ? geometry.coordinates : [];
    for (const position of positions) points.push({ position: position as LonLat, properties: feature.properties });
  });
  forEachFeature(tile, "landuse", (feature) => {
    for (const rings of polygonRings(feature, tile)) {
      if (rings.length) areas.push({ polygon: { outer: rings[0], holes: rings.slice(1) }, properties: feature.properties });
    }
  });
  const context: BuildingUseContext = { points, areas };
  forEachFeature(tile, "building", (feature, featureIndex) => {
    if (truthy(feature.properties.hide_3d)) return;
    const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
    const sourcePolygons = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    for (let polygonIndex = 0; polygonIndex < sourcePolygons.length; polygonIndex++) {
      const rings = sourcePolygons[polygonIndex] as LonLat[][];
      if (rings.length === 0) continue;
      sources.push(inferBuildingUse({
        id: featureSourceId("building", feature, tile, featureIndex, polygonIndex),
        polygon: { outer: rings[0], holes: rings.slice(1) },
        properties: { ...feature.properties },
      }, context));
    }
  });
  buildingSourceCache.set(tile.data, sources);
  return sources;
}

function roadSources(tile: MapTile): readonly RoadSource[] {
  const cached = roadSourceCache.get(tile.data);
  if (cached) return cached;
  const sources: RoadSource[] = [];
  forEachFeature(tile, "transportation", (feature, featureIndex) => {
    const paths = lines(feature, tile);
    if (paths.length === 0) return;
    sources.push({
      id: featureSourceId("road", feature, tile, featureIndex),
      paths,
      properties: { ...feature.properties },
    });
  });
  roadSourceCache.set(tile.data, sources);
  return sources;
}

function featureSourceId(
  kind: string,
  feature: VectorTileFeature,
  tile: MapTile,
  featureIndex: number,
  part = 0,
): string {
  const id = feature.id === undefined
    ? `${tile.x}/${tile.y}/${featureIndex}`
    : String(feature.id);
  return `${kind}/${tile.zoom}/${id}/${part}`;
}

/** OSM water IDs remain stable when one lake is clipped into provider tiles. */
function waterFeatureSourceId(
  feature: VectorTileFeature,
  tile: MapTile,
  featureIndex: number,
  part: number,
): string {
  return feature.id === undefined
    ? featureSourceId("water", feature, tile, featureIndex, part)
    : `water/${tile.zoom}/${String(feature.id)}`;
}

function polygonRings(feature: VectorTileFeature, tile: MapTile): LonLat[][][] {
  const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
  if (geometry.type === "Polygon") return [geometry.coordinates as LonLat[][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as LonLat[][][];
  return [];
}

function withoutClosingPoint(ring: LonLat[]): LonLat[] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

function lines(feature: VectorTileFeature, tile: MapTile): LonLat[][] {
  const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
  if (geometry.type === "LineString") return [geometry.coordinates as LonLat[]];
  if (geometry.type === "MultiLineString") return geometry.coordinates as LonLat[][];
  return [];
}

/** Batches disjoint planned polygons so their shared edges cannot z-fight. */
async function createPlannedRoadMeshes(
  scene: Scene,
  roads: readonly PlannedRoadPolygon[],
  terrain: TerrainData,
  options: MapLayerOptions,
  yieldControl?: () => Promise<void>,
): Promise<Partial<Record<RoadVisualStyle, Mesh>>> {
  const byStyle: Record<RoadVisualStyle, PlannedRoadPolygon[]> = {
    marked: [],
    paved: [],
    pedestrian: [],
    dirt: [],
    unpaved: [],
    ford: [],
  };
  for (const road of roads) {
    if (road.structure !== "bridge") byStyle[road.visualStyle].push(road);
  }
  const result: Partial<Record<RoadVisualStyle, Mesh>> = {};
  try {
    for (const style of Object.keys(byStyle) as RoadVisualStyle[]) {
      if (byStyle[style].length > 0) {
        result[style] = await createPlannedRoadBatch(scene, byStyle[style], terrain, options,
          ROAD_SURFACE_CLEARANCE_METERS, false, yieldControl);
      }
    }
  } catch (error) {
    for (const mesh of Object.values(result)) mesh?.dispose();
    throw error;
  }
  return result;
}

async function createPlannedShoulderMeshes(
  scene: Scene,
  roads: readonly PlannedRoadPolygon[],
  terrain: TerrainData,
  options: MapLayerOptions,
  yieldControl?: () => Promise<void>,
): Promise<Partial<Record<RoadSurface, Mesh>>> {
  const bySurface: Record<RoadSurface, PlannedRoadPolygon[]> = { paved: [], unpaved: [] };
  for (const road of roads) {
    if (road.structure !== "bridge" && road.visualStyle !== "dirt") {
      bySurface[road.surface].push(road);
    }
  }
  const result: Partial<Record<RoadSurface, Mesh>> = {};
  try {
    for (const surface of Object.keys(bySurface) as RoadSurface[]) {
      if (bySurface[surface].length > 0) {
        result[surface] = await createPlannedRoadBatch(
          scene,
          bySurface[surface],
          terrain,
          options,
          ROAD_SHOULDER_CLEARANCE_METERS,
          true,
          yieldControl,
        );
      }
    }
  } catch (error) {
    for (const mesh of Object.values(result)) mesh?.dispose();
    throw error;
  }
  return result;
}

async function createPlannedRoadBatch(
  scene: Scene,
  roads: readonly PlannedRoadPolygon[],
  terrain: TerrainData,
  options: MapLayerOptions,
  clearanceMeters = ROAD_SURFACE_CLEARANCE_METERS,
  forceWorldUvs = false,
  yieldControl?: () => Promise<void>,
): Promise<Mesh> {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const dirtEdges: number[] = [];
  const groundNormalVertices: number[] = [];
  const clearance = clearanceMeters / options.metersPerUnit;
  for (const road of roads) {
    await yieldControl?.();
    const outline = signedArea(road.outline) >= 0
      ? road.outline
      : [...road.outline].reverse();
    if (outline.length < 3) continue;
    const grade = plannedRoadGrade(road, terrain, options);
    // Splitting the carriageway along the ground's own triangles keeps the
    // road surface from ever cutting through the terrain it decorates.
    const rings = await conformDecalPolygonAsync(
      outline,
      (point) => grade(point) / options.metersPerUnit,
      clearance,
      options.terrainSurface,
      road.structure === "surface" || road.structure === "ford",
      yieldControl,
    );
    for (const ring of rings) {
      await yieldControl?.();
      const vertexOffset = positions.length / 3;
      for (const point of ring) {
        if (options.terrainSurface && (road.structure === "surface" || road.structure === "ford")) {
          groundNormalVertices.push(positions.length / 3);
        }
        positions.push(point.x, point.y, point.z);
        const uv = plannedRoadUv(point, road, options.metersPerUnit, forceWorldUvs);
        uvs.push(uv.x, uv.y);
        if (road.visualStyle === "dirt") {
          dirtEdges.push(...dirtRoadEdgeCoordinates(point, road, options.metersPerUnit));
        }
      }
      const localIndices = earcut(ring.flatMap((point) => [point.x, point.z]));
      for (let index = 0; index < localIndices.length; index += 3) {
        // Babylon's left-handed ground/ribbon convention uses this winding for
        // the face visible from above. Reversing it makes the whole road batch
        // back-facing and therefore invisible with the default material culling.
        indices.push(
          vertexOffset + localIndices[index],
          vertexOffset + localIndices[index + 1],
          vertexOffset + localIndices[index + 2],
        );
      }
    }
  }
  const normals: number[] = [];
  await yieldControl?.();
  VertexData.ComputeNormals(positions, indices, normals);
  // Fragment vertices are duplicated for UVs and polygon boundaries. Sampling
  // one ground normal field keeps lighting continuous across all road batches.
  for (const vertex of groundNormalVertices) {
    if (vertex % 128 === 0) await yieldControl?.();
    const offset = vertex * 3;
    const normal = options.terrainSurface!.normalAt({ x: positions[offset], z: positions[offset + 2] });
    normals[offset] = normal.x;
    normals[offset + 1] = normal.y;
    normals[offset + 2] = normal.z;
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.uvs = uvs;
  await yieldControl?.();
  const mesh = new Mesh("plannedRoadSurface", scene);
  vertexData.applyToMesh(mesh, false);
  if (dirtEdges.length > 0) mesh.setVerticesData(DIRT_ROAD_EDGE_KIND, dirtEdges, false, 3);
  mesh.isPickable = false;
  return stageMapMesh(mesh);
}

/** The planned longitudinal grade of one carriageway polygon, in meters. */
function plannedRoadGrade(
  road: PlannedRoadPolygon,
  terrain: TerrainData,
  options: MapLayerOptions,
): (point: { x: number; z: number }) => number {
  const startElevation = sampleElevation(
    terrain,
    road.centerline[0].x,
    road.centerline[0].z,
    options.meshWidth,
    options.meshDepth,
  );
  const endElevation = sampleElevation(
    terrain,
    road.centerline[1].x,
    road.centerline[1].z,
    options.meshWidth,
    options.meshDepth,
  );
  return (point) => startElevation +
    (endElevation - startElevation) * roadGradeAmount(road, point);
}

function plannedRoadUv(
  point: { x: number; z: number },
  road: PlannedRoadPolygon,
  metersPerUnit: number,
  forceWorldUvs = false,
): { x: number; y: number } {
  const repeatMeters = road.visualStyle === "dirt" || road.visualStyle === "unpaved" || road.visualStyle === "ford"
    ? LOOSE_ROAD_TEXTURE_REPEAT_METERS
    : 4;
  if (forceWorldUvs || road.visualStyle !== "marked") {
    const scale = metersPerUnit / repeatMeters;
    return { x: point.x * scale, y: point.z * scale };
  }
  const axis = road.textureAxis ?? road.centerline;
  const dx = axis[1].x - axis[0].x;
  const dz = axis[1].z - axis[0].z;
  const lengthSquared = dx * dx + dz * dz;
  const length = Math.sqrt(lengthSquared);
  if (length <= 1e-8) return { x: 0, y: 0.5 };
  const projected = (
    (point.x - axis[0].x) * dx + (point.z - axis[0].z) * dz
  ) / lengthSquared;
  // A junction disc borrows the widest approach's axis and straddles that
  // approach's end, so half of it projects outside the piece. Left unclamped,
  // its strip runs on continuously into the next piece of the same road.
  const amount = road.junctionArms
    ? projected
    : Math.max(0, Math.min(1, projected));
  const across = ((point.x - axis[0].x) * -dz + (point.z - axis[0].z) * dx) / length;
  const isJoin = Math.hypot(
    road.centerline[1].x - road.centerline[0].x,
    road.centerline[1].z - road.centerline[0].z,
  ) <= 1e-8;
  // Junction markings follow the widest approach. Bend wedges use a
  // radial coordinate to keep the centre marking off the outside edge.
  const acrossUv = road.junctionArms
    ? junctionAcrossUv(point, road.junctionArms, metersPerUnit)
    : isJoin
      ? radialJoinUv(point, road)
      : 0.5 + across * metersPerUnit / Math.max(0.01, road.widthMeters);
  return {
    x: (road.startDistance + amount * length) * metersPerUnit / repeatMeters,
    y: Math.max(0, Math.min(1, acrossUv)),
  };
}

function radialJoinUv(
  point: { x: number; z: number },
  road: PlannedRoadPolygon,
): number {
  const center = road.centerline[0];
  const radius = Math.max(1e-8, ...road.outline.map((vertex) =>
    Math.hypot(vertex.x - center.x, vertex.z - center.z)
  ));
  const distance = Math.hypot(point.x - center.x, point.z - center.z);
  return 0.5 + 0.5 * distance / radius;
}

/**
 * Across-strip coordinate inside a marked junction disc. Follow only the
 * widest road so its centre line runs straight through while side roads'
 * markings stop at the disc.
 */
function junctionAcrossUv(
  point: { x: number; z: number },
  arms: ReadonlyArray<JunctionArm>,
  metersPerUnit: number,
): number {
  const considered = arms.slice(0, 1);
  let nearest = Infinity;
  for (const arm of considered) {
    const dx = arm.axis[1].x - arm.axis[0].x;
    const dz = arm.axis[1].z - arm.axis[0].z;
    const length = Math.hypot(dx, dz);
    if (length <= 1e-8) continue;
    const lateral = Math.abs(
      (point.x - arm.axis[0].x) * -dz + (point.z - arm.axis[0].z) * dx,
    ) / length;
    nearest = Math.min(nearest, lateral * metersPerUnit / Math.max(0.01, arm.widthMeters));
  }
  return nearest === Infinity ? 0.5 : 0.5 + nearest;
}

function createRoad(
  scene: Scene,
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
  appearance: RoadPlan,
  detail: "detailed" | "far" = "detailed",
): CreatedRoad {
  const points = coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
  );
  const renderWidthMeters = detail === "far" && appearance.structure !== "bridge"
    ? Math.max(appearance.widthMeters, 3)
    : appearance.widthMeters;
  const halfWidth = renderWidthMeters / options.metersPerUnit / 2;
  const clippedPaths = clipPolyline(
    points,
    options.meshWidth / 2,
    options.meshDepth / 2,
  );
  const terrainSampleSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  ) / 2;
  const sampleSpacing = appearance.structure === "bridge"
    ? Math.min(terrainSampleSpacing, 4 / options.metersPerUnit)
    : detail === "far" ? Math.max(terrainSampleSpacing, 12 / options.metersPerUnit) : terrainSampleSpacing;
  const paths = clippedPaths.map((path) => resamplePath(path, sampleSpacing));
  const surfaces: Mesh[] = [];
  const shoulders: Mesh[] = [];
  const bridgeDecks: Mesh[] = [];
  for (const path of paths) {
    const bridgeElevations = appearance.structure === "bridge"
      ? bridgeElevationProfile(path, terrain, options,
        halfWidth + BRIDGE_EDGE_WIDTH_METERS / options.metersPerUnit)
      : undefined;
    surfaces.push(...createRoadMeshes(
      scene,
      path,
      terrain,
      options,
      halfWidth,
      appearance.visualStyle,
      ROAD_SURFACE_CLEARANCE_METERS,
      bridgeElevations,
    ));
    if (detail === "far") {
      continue;
    } else if (bridgeElevations) {
      bridgeDecks.push(...createRoadMeshes(
        scene,
        path,
        terrain,
        options,
        halfWidth + BRIDGE_EDGE_WIDTH_METERS / options.metersPerUnit,
        "paved",
        0,
        bridgeElevations,
        BRIDGE_DECK_THICKNESS_METERS / options.metersPerUnit,
      ));
    } else {
      shoulders.push(...createRoadMeshes(
        scene,
        path,
        terrain,
        options,
        halfWidth + appearance.shoulderWidthMeters / options.metersPerUnit,
        appearance.surface,
        ROAD_SHOULDER_CLEARANCE_METERS,
      ));
    }
  }
  return { surfaces, shoulders, bridgeDecks, paths };
}

function createRoadMeshes(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: MapLayerOptions,
  halfWidth: number,
  visualStyle: RoadVisualStyle,
  clearanceMeters: number,
  centerElevations?: readonly number[],
  deckThickness = 0,
): Mesh[] {
  const meshes: Mesh[] = [];
  let left: Vector3[] = [];
  let right: Vector3[] = [];
  const finishPath = (): void => {
    if (left.length >= 2) {
      if (deckThickness > 0) {
        const bottomLeft = left.map(point => point.subtract(new Vector3(0, deckThickness, 0)));
        const bottomRight = right.map(point => point.subtract(new Vector3(0, deckThickness, 0)));
        const shell = MeshBuilder.CreateRibbon("bridgeShell", {
          pathArray: [left, right, bottomRight, bottomLeft], closeArray: true,
          sideOrientation: Mesh.DOUBLESIDE,
        }, scene);
        shell.convertToFlatShadedMesh();
        meshes.push(stageMapMesh(shell));
        for (const index of [0, left.length - 1]) {
          meshes.push(stageMapMesh(MeshBuilder.CreateRibbon("bridgeEnd", {
            pathArray: [[left[index], right[index]], [bottomLeft[index], bottomRight[index]]],
            sideOrientation: Mesh.DOUBLESIDE,
          }, scene)));
        }
        left = [];
        right = [];
        return;
      }
      // Only markings need an across-road coordinate. World-projected dirt
      // grain stays continuous through bends and connecting road pieces.
      const uvs = visualStyle === "marked"
        ? roadUvs(left, right, options.metersPerUnit, visualStyle)
        : worldPositionRoadUvs(left, right, options.metersPerUnit, visualStyle);
      const mesh = MeshBuilder.CreateRibbon("road", { pathArray: [left, right], uvs }, scene);
      if (visualStyle === "dirt") {
        const distances = [0];
        for (let index = 1; index < left.length; index++) {
          distances.push(distances[index - 1] + Math.hypot(
            (left[index].x + right[index].x - left[index - 1].x - right[index - 1].x) / 2,
            (left[index].z + right[index].z - left[index - 1].z - right[index - 1].z) / 2,
          ));
        }
        const total = distances[distances.length - 1];
        const width = halfWidth * 2;
        const edges = [1, -1].flatMap((side) => distances.flatMap((distance) =>
          total <= width * 2 ? [0, 0, 0] : [side, distance / width, (total - distance) / width]
        ));
        mesh.setVerticesData(DIRT_ROAD_EDGE_KIND, edges, false, 3);
      }
      meshes.push(stageMapMesh(mesh));
    }
    left = [];
    right = [];
  };
  for (let index = 0; index < points.length; index++) {
    const { offsetX, offsetZ } = pathRibbonOffset(points, index, halfWidth);
    // Roads are planar across their width. Sample the centerline once and
    // use that elevation for both edges; sampling each edge independently
    // reintroduces the terrain's cross-slope and lets one edge clip through.
    const centerElevation = centerElevations?.[index] ?? sampleElevation(
      terrain,
      points[index].x,
      points[index].z,
      options.meshWidth,
      options.meshDepth,
    );
    left.push(new Vector3(
      points[index].x + offsetX,
      (centerElevation + clearanceMeters) / options.metersPerUnit,
      points[index].z + offsetZ,
    ));
    right.push(new Vector3(
      points[index].x - offsetX,
      (centerElevation + clearanceMeters) / options.metersPerUnit,
      points[index].z - offsetZ,
    ));
  }
  finishPath();
  return meshes;
}

function bridgeElevationProfile(
  points: readonly { x: number; z: number }[],
  terrain: TerrainData,
  options: MapLayerOptions,
  halfWidth: number,
): number[] {
  if (points.length === 0) return [];
  const offsets = points.map((_, index) => pathRibbonOffset(points, index, halfWidth));
  const observations = points.map((point, index) => {
    const ground = sampleElevation(
      terrain,
      point.x,
      point.z,
      options.meshWidth,
      options.meshDepth,
    );
    const water = sampleTerrainWaterMask(
      terrain,
      point.x,
      point.z,
      options.meshWidth,
      options.meshDepth,
    ) || ground <= SEA_LEVEL_METERS;
    const { offsetX, offsetZ } = offsets[index];
    const edgeGround = Math.max(...[-1, 1].map(side => sampleElevation(terrain,
      point.x + side * offsetX, point.z + side * offsetZ, options.meshWidth, options.meshDepth)));
    // Land endpoints meet their approach; the slab embeds into each abutment.
    const interior = index > 0 && index < points.length - 1;
    return Math.max(ground, interior ? edgeGround + BRIDGE_DECK_THICKNESS_METERS : ground,
      water ? SEA_LEVEL_METERS + BRIDGE_WATER_CLEARANCE_METERS + BRIDGE_DECK_THICKNESS_METERS : -Infinity);
  });
  return bridgeProfile(points, observations);
}

function sampleTerrainWaterMask(
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
): boolean {
  if (!terrain.waterMask) return false;
  const u = x / meshWidth + 0.5;
  const v = 0.5 - z / meshDepth;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const column = Math.round(u * (terrain.width - 1));
  const row = Math.round(v * (terrain.height - 1));
  return terrain.waterMask[row * terrain.width + column] === 1;
}

function createRoadJunctions(
  scene: Scene,
  candidates: readonly RoadJunctionCandidate[],
  terrain: TerrainData,
  options: MapLayerOptions,
): Array<{ mesh: Mesh; visualStyle: RoadVisualStyle }> {
  const tolerance = Math.max(1e-6, 0.25 / options.metersPerUnit);
  const groups = new Map<string, RoadJunctionCandidate[]>();
  for (const candidate of candidates) {
    const key = [
      Math.round(candidate.point.x / tolerance),
      Math.round(candidate.point.z / tolerance),
      candidate.layer,
    ].join("/");
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const clipBounds = {
    minX: -options.meshWidth / 2,
    maxX: options.meshWidth / 2,
    minZ: -options.meshDepth / 2,
    maxZ: options.meshDepth / 2,
  };
  const junctions: Array<{ mesh: Mesh; visualStyle: RoadVisualStyle }> = [];
  for (const group of groups.values()) {
    if (new Set(group.map((candidate) => candidate.sourceId)).size < 2) continue;
    const center = group[0].point;
    const radius = Math.max(...group.map((candidate) => candidate.halfWidth)) +
      0.08 / options.metersPerUnit;
    const circle = Array.from({ length: 16 }, (_, index) => {
      const angle = index / 16 * Math.PI * 2;
      return {
        x: center.x + Math.cos(angle) * radius,
        z: center.z + Math.sin(angle) * radius,
      };
    });
    const clipped = clipToBounds(circle, clipBounds);
    if (clipped.length < 3) continue;
    if (signedArea(clipped) < 0) clipped.reverse();
    const mesh = new PolygonMeshBuilder(
      "roadJunction",
      clipped.map(({ x, z }) => new Vector2(x, z)),
      scene,
      earcut,
    ).build(true);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) {
      mesh.dispose();
      continue;
    }
    for (let index = 0; index < positions.length; index += 3) {
      positions[index + 1] = (
        sampleElevation(
          terrain,
          positions[index],
          positions[index + 2],
          options.meshWidth,
          options.meshDepth,
        ) + ROAD_SURFACE_CLEARANCE_METERS
      ) / options.metersPerUnit;
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    mesh.refreshBoundingInfo();
    junctions.push({
      mesh: stageMapMesh(mesh),
      visualStyle: junctionVisualStyle(group),
    });
  }
  return junctions;
}

function junctionVisualStyle(candidates: readonly RoadJunctionCandidate[]): RoadVisualStyle {
  if (candidates.some((candidate) => candidate.visualStyle === "ford")) return "ford";
  if (candidates.every((candidate) => candidate.visualStyle === "dirt")) return "dirt";
  if (candidates.every((candidate) => candidate.visualStyle === "unpaved")) return "unpaved";
  if (candidates.every((candidate) => candidate.visualStyle === "pedestrian")) return "pedestrian";
  return "paved";
}

function collectRiverGeometry(
  tiles: MapTile[],
  terrain: TerrainData,
  options: MapLayerOptions,
): VertexData[] {
  const geometry: VertexData[] = [];
  for (const tile of tiles) forEachFeature(tile, "waterway", feature => {
    if (!isSurfaceWaterFeature(feature.properties)) return;
    const width = waterwayWidthMeters(feature.properties.class);
    if (width === undefined) return;
    for (const line of lines(feature, tile)) geometry.push(...waterwayGeometry(line, terrain, options, width));
  });
  return geometry;
}

function waterwayGeometry(
  coordinates: LonLat[], terrain: TerrainData, options: MapLayerOptions, widthMeters: number,
): VertexData[] {
  const points = coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
  );
  const paths = clipPolyline(points, options.meshWidth / 2, options.meshDepth / 2);
  const sampleSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  ) / 2;
  return paths.flatMap((path) => createWaterwayVertexData(
    resamplePath(path, sampleSpacing),
    terrain,
    options,
    widthMeters / options.metersPerUnit / 2,
  ));
}

function createWaterwayVertexData(
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: MapLayerOptions,
  halfWidth: number,
): VertexData[] {
  if (points.length < 2) return [];
  const left: Array<{ x: number; z: number }> = [];
  const right: Array<{ x: number; z: number }> = [];
  for (let index = 0; index < points.length; index++) {
    const { offsetX, offsetZ } = pathRibbonOffset(points, index, halfWidth);
    left.push({ x: points[index].x + offsetX, z: points[index].z + offsetZ });
    right.push({ x: points[index].x - offsetX, z: points[index].z - offsetZ });
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const tangents: number[] = [];
  const clearance = WATERWAY_SURFACE_CLEARANCE_METERS / options.metersPerUnit;
  const groundHeight = (point: { x: number; z: number }) => sampleElevation(
    terrain,
    point.x,
    point.z,
    options.meshWidth,
    options.meshDepth,
  ) / options.metersPerUnit;
  const flowSign = riverFlowSign(points, groundHeight);
  const waterDepth = riverChannelDepth(halfWidth * options.metersPerUnit) * 0.6 / options.metersPerUnit;
  const levels = riverSurfaceLevels(points, groundHeight, Math.max(halfWidth * 2, 6 / options.metersPerUnit));
  let distanceMeters = 0;
  for (let index = 0; index < points.length; index++) {
    const previous = Math.max(0, index - 1);
    const next = Math.min(points.length - 1, index + 1);
    const dx = points[next].x - points[previous].x;
    const dz = points[next].z - points[previous].z;
    const span = Math.hypot(dx, dz) || 1;
    const slope = (levels[next] - levels[previous]) / span;
    const magnitude = Math.hypot(slope, 1);
    const normal = { x: -dx / span * slope / magnitude, y: 1 / magnitude,
      z: -dz / span * slope / magnitude };
    const segment = Math.min(index, points.length - 2);
    for (const point of [left[index], right[index]]) {
      // A cross-section has one water level; the terrain intersects it as a bank.
      positions.push(point.x, levels[index] + waterDepth + clearance, point.z);
      normals.push(normal.x, normal.y, normal.z);
      const frame = riverSurfaceFrame(point, left[segment], right[segment],
        left[segment + 1], right[segment + 1], 0, 1,
        halfWidth * 2 * options.metersPerUnit, normal, flowSign);
      uvs.push(frame.u, distanceMeters * flowSign);
      tangents.push(...frame.tangent);
    }
    if (index < points.length - 1) {
      const outline = [left[index], left[index + 1], right[index + 1], right[index]];
      const corners = [index * 2, index * 2 + 2, index * 2 + 3, index * 2 + 1];
      for (const corner of earcut(outline.flatMap(point => [point.x, point.z]))) indices.push(corners[corner]);
      distanceMeters += Math.hypot(points[index + 1].x - points[index].x,
        points[index + 1].z - points[index].z) * options.metersPerUnit;
    }
  }
  if (positions.length === 0) return [];
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.uvs = uvs;
  vertexData.tangents = tangents;
  return [vertexData];
}

function waterwayWidthMeters(value: unknown): number | undefined {
  switch (String(value ?? "").toLowerCase()) {
    case "river": return 12;
    case "canal": return 5;
    case "stream": return 2;
    case "drain": return 1.2;
    case "ditch": return 0.8;
    default: return undefined;
  }
}

/** Gives road textures a stable real-world scale after ribbons are merged. */
function roadUvs(
  left: Vector3[],
  right: Vector3[],
  metersPerUnit: number,
  visualStyle: RoadVisualStyle,
): Vector2[] {
  const repeatMeters = roadTextureRepeatMeters(visualStyle);
  const leftUvs = [new Vector2(0, 0)];
  const rightUvs = [new Vector2(0, 1)];
  let distanceMeters = 0;
  for (let index = 1; index < left.length; index++) {
    const previousX = (left[index - 1].x + right[index - 1].x) / 2;
    const previousZ = (left[index - 1].z + right[index - 1].z) / 2;
    const x = (left[index].x + right[index].x) / 2;
    const z = (left[index].z + right[index].z) / 2;
    distanceMeters += Math.hypot(x - previousX, z - previousZ) * metersPerUnit;
    const u = distanceMeters / repeatMeters;
    leftUvs.push(new Vector2(u, 0));
    rightUvs.push(new Vector2(u, 1));
  }
  return [...leftUvs, ...rightUvs];
}

/** Projects road grain in scene/world XZ, avoiding visible texture restarts at overlaps. */
function worldPositionRoadUvs(
  left: Vector3[],
  right: Vector3[],
  metersPerUnit: number,
  visualStyle: RoadVisualStyle,
): Vector2[] {
  const repeatMeters = roadTextureRepeatMeters(visualStyle);
  const scale = metersPerUnit / repeatMeters;
  return [
    ...left.map((point) => new Vector2(point.x * scale, point.z * scale)),
    ...right.map((point) => new Vector2(point.x * scale, point.z * scale)),
  ];
}

/** Keeps a newly registered Babylon mesh out of render lists while its tile is assembled. */
function stageMapMesh<T extends Mesh>(mesh: T): T {
  mesh.setEnabled(false);
  return mesh;
}

function mergeRoads(
  meshes: Mesh[],
  name: string,
  visualStyle: RoadMaterialStyle,
  parent: TransformNode,
): Mesh | undefined {
  if (meshes.length === 0) return undefined;
  // Babylon's standard merge drops custom attributes. Preserve them in the
  // same vertex order, and give standalone junction meshes solid coverage.
  const dirtEdges = visualStyle === "dirt" ? meshes.flatMap((mesh) =>
    Array.from(mesh.getVerticesData(DIRT_ROAD_EDGE_KIND) ?? new Float32Array(mesh.getTotalVertices() * 3))
  ) : undefined;
  const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
  if (!result) return undefined;
  if (dirtEdges) result.setVerticesData(DIRT_ROAD_EDGE_KIND, dirtEdges, false, 3);
  result.name = name;
  result.material = createRoadMaterial(result.getScene(), name, visualStyle);
  result.parent = parent;
  return result;
}

function mergeWaterways(
  meshes: Mesh[],
  parent: TransformNode,
  options: MapLayerOptions,
): Mesh | undefined {
  if (meshes.length === 0) return undefined;
  const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
  if (!result) return undefined;
  result.name = "waterways";
  const material = createWaterSurfaceMaterial(result.getScene(), {
    name: "waterwayMaterial",
    width: options.meshWidth,
    height: options.meshDepth,
    metersPerUnit: options.metersPerUnit,
    skyReflection: options.skyReflection,
    kind: "river",
  });
  prepareWaterSurfaceMesh(result);
  bindWaterMaterial(result, material, options.metersPerUnit, 'river');
  result.isPickable = false;
  result.parent = parent;
  return result;
}
const roadMaterials = new WeakMap<Scene, Map<RoadMaterialStyle, StandardMaterial>>();
const sharedRoadMaterials = new WeakSet<Material>();

function createRoadMaterial(scene: Scene, name: string, visualStyle: RoadMaterialStyle): StandardMaterial {
  let materials = roadMaterials.get(scene);
  if (!materials) {
    materials = new Map();
    roadMaterials.set(scene, materials);
  }
  const cached = materials.get(visualStyle);
  if (cached) return cached;
  const material = visualStyle === "dirt"
    ? createDirtRoadMaterial(scene, `${name}Material`)
    : new StandardMaterial(`${name}Material`, scene);
  // Roads are not plowed: they take the same snow as the ground around them
  // and rise with it, so they stay flush with the raised terrain.
  new SnowCoverPlugin(material, { displace: true });
  switch (visualStyle) {
    case "dirt": material.diffuseColor = new Color3(0.42, 0.39, 0.33); break;
    case "unpaved": material.diffuseColor = new Color3(0.43, 0.42, 0.38); break;
    case "marked": material.diffuseColor = new Color3(0.72, 0.72, 0.68); break;
    case "pedestrian": material.diffuseColor = new Color3(0.38, 0.36, 0.33); break;
    case "ford": material.diffuseColor = new Color3(0.28, 0.32, 0.31); break;
    case "pavedShoulder": material.diffuseColor = new Color3(0.3, 0.29, 0.27); break;
    case "unpavedShoulder": material.diffuseColor = new Color3(0.38, 0.37, 0.34); break;
    case "bridgeDeck": material.diffuseColor = new Color3(0.16, 0.17, 0.17); break;
    default: material.diffuseColor = new Color3(0.2, 0.21, 0.2); break;
  }
  const looseSurface = visualStyle === "dirt" || visualStyle === "unpaved" || visualStyle === "unpavedShoulder";
  material.specularColor = looseSurface
    ? new Color3(0.008, 0.008, 0.006)
    : visualStyle === "ford"
      ? new Color3(0.08, 0.09, 0.085)
      : new Color3(0.018, 0.02, 0.018);
  material.specularPower = looseSurface ? 8 : visualStyle === "ford" ? 48 : 20;
  if (visualStyle !== "bridgeDeck") {
    const depthBias = visualStyle === "pavedShoulder" || visualStyle === "unpavedShoulder"
      ? ROAD_SHOULDER_DEPTH_BIAS
      : ROAD_SURFACE_DEPTH_BIAS;
    material.zOffset = depthBias;
    material.zOffsetUnits = depthBias;
  }
  const texture = createRoadTexture(scene, `${name}Texture`, visualStyle, true);
  material.diffuseTexture = texture;
  if (looseSurface) {
    const relief = createRoadTexture(scene, `${name}Relief`, visualStyle, false);
    relief.level = visualStyle === "dirt" ? 0.12 : 0.24;
    material.bumpTexture = relief;
  }
  materials.set(visualStyle, material);
  sharedRoadMaterials.add(material);
  material.onDisposeObservable.addOnce(() => materials.delete(visualStyle));
  return material;
}

function createDirtRoadMaterial(scene: Scene, name: string): CustomMaterial {
  const material = new CustomMaterial(name, scene);
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.AddAttribute(DIRT_ROAD_EDGE_KIND);
  material.Vertex_Definitions(`
    attribute vec3 ${DIRT_ROAD_EDGE_KIND};
    varying vec3 vDirtRoadEdge;
  `);
  material.Vertex_MainEnd(`vDirtRoadEdge = ${DIRT_ROAD_EDGE_KIND};`);
  material.Fragment_Definitions("varying vec3 vDirtRoadEdge;");
  material.Fragment_Custom_Alpha(DIRT_ROAD_EDGE_ALPHA_GLSL);
  return material;
}

/** Small deterministic texture: coarse aggregate for gravel, fine grain for asphalt. */
function createRoadTexture(
  scene: Scene,
  name: string,
  visualStyle: RoadMaterialStyle,
  gammaSpace: boolean,
): RawTexture {
  const pixels = roadTexturePixels(visualStyle);
  const texture = RawTexture.CreateRGBATexture(
    pixels,
    ROAD_TEXTURE_SIZE,
    ROAD_TEXTURE_SIZE,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = name;
  texture.gammaSpace = gammaSpace;
  texture.hasAlpha = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 12;
  return texture;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function pathRibbonOffset(points: readonly { x: number; z: number }[], index: number, halfWidth: number) {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const dx = next.x - previous.x;
  const dz = next.z - previous.z;
  const length = Math.hypot(dx, dz) || 1;
  const offsetX = (-dz / length) * halfWidth;
  const offsetZ = (dx / length) * halfWidth;
  return { offsetX, offsetZ };
}

function roadTextureRepeatMeters(visualStyle: RoadVisualStyle): number {
  return visualStyle === "dirt" || visualStyle === "unpaved" || visualStyle === "ford"
    ? LOOSE_ROAD_TEXTURE_REPEAT_METERS : 4;
}
