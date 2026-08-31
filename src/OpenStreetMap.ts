import {
  Color3,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  PBRMaterial,
  PolygonMeshBuilder,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector2,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import type { BaseTexture } from "@babylonjs/core";
import { VectorTile, VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import earcut from "earcut";
import {
  combineHorizontalExclusionMasks,
  HorizontalExclusionMask,
  lonLatToScene,
  sceneToLonLat,
  PolygonExclusionMask,
  sampleElevation,
  SEA_LEVEL_METERS,
} from "./Geo";
import type { TerrainData } from "./TerrainData";
import type { TileBounds } from "./WorldGrid";
import {
  BuildingDetailLevel,
  BuildingSource,
  LonLat,
  planBuilding,
} from "./BuildingPlanner";
import { ProceduralBuildingRenderer } from "./procedural/ProceduralBuildingRenderer";
import {
  createWaterSurfaceMaterial,
  prepareWaterSurfaceMesh,
} from "./Water";
import {
  planRoad,
  RoadPlan,
  RoadSurface,
  RoadVisualStyle,
} from "./RoadPlanner";
import { conformTerrainToRoads as stampRoadTerrain } from "./RoadTerrain";
import { conformTerrainToBuildings as stampBuildingTerrain } from "./BuildingTerrain";
import { createOpenStreetMapLandCover } from "./OpenStreetMapLandCover";
import type { LandCoverSampler } from "./WorldCover";
import type { TerrainLakeSource } from "./TerrainLakePolygons";
import { createRoadsideConceptFeatures } from "./OpenStreetMapBarriers";
import type { BarrierFeature } from "./OpenStreetMapBarriers";

export interface MapTile {
  x: number;
  y: number;
  zoom: number;
  data: VectorTile;
}

/** Enough separation to avoid z-fighting without making roads hover. */
const ROAD_SURFACE_CLEARANCE_METERS = 0.025;
const ROAD_SHOULDER_CLEARANCE_METERS = 0.012;
/** Polygon offset makes terrain-conforming roads render as decals over the ground. */
const ROAD_SURFACE_DEPTH_BIAS = -2;
const ROAD_SHOULDER_DEPTH_BIAS = -1;
const BRIDGE_DECK_THICKNESS_METERS = 0.32;
const BRIDGE_EDGE_WIDTH_METERS = 0.45;
const BRIDGE_TERRAIN_CLEARANCE_METERS = 0.15;
const BRIDGE_WATER_CLEARANCE_METERS = 3;
const WATERWAY_SURFACE_CLEARANCE_METERS = 0.08;
const ROAD_TEXTURE_SIZE = 128;
/** A deliberately non-round span keeps gravel repeats from lining up with road sampling. */
const LOOSE_ROAD_TEXTURE_REPEAT_METERS = 6.7;

type RoadMaterialStyle = RoadVisualStyle | "pavedShoulder" | "unpavedShoulder" | "bridgeDeck";

interface RoadSource {
  id: string;
  paths: LonLat[][];
  properties: Readonly<Record<string, unknown>>;
}

const buildingSourceCache = new WeakMap<VectorTile, readonly BuildingSource[]>();
const roadSourceCache = new WeakMap<VectorTile, readonly RoadSource[]>();

interface MapLayerOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  skyReflection?: BaseTexture | null;
  showRoofs?: boolean;
  /** Provider elevations retained before coastline shaping for bridge clearance. */
  preCarvingElevations?: Float32Array;
  /** Creates the layer hidden so partially built meshes never flash on screen. */
  startDisabled?: boolean;
}

interface MapClipBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface RoadSegment {
  start: { x: number; z: number };
  end: { x: number; z: number };
  halfWidth: number;
}

class RoadExclusionMask implements HorizontalExclusionMask {
  private readonly cells = new Map<string, RoadSegment[]>();
  private readonly cellSize: number;

  constructor(segments: RoadSegment[], cellSize: number) {
    this.cellSize = cellSize;
    for (const segment of segments) {
      const minimumX = Math.floor((Math.min(segment.start.x, segment.end.x) - segment.halfWidth) / cellSize);
      const maximumX = Math.floor((Math.max(segment.start.x, segment.end.x) + segment.halfWidth) / cellSize);
      const minimumZ = Math.floor((Math.min(segment.start.z, segment.end.z) - segment.halfWidth) / cellSize);
      const maximumZ = Math.floor((Math.max(segment.start.z, segment.end.z) + segment.halfWidth) / cellSize);
      for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
        for (let cellX = minimumX; cellX <= maximumX; cellX++) {
          const key = `${cellX},${cellZ}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(segment);
          else this.cells.set(key, [segment]);
        }
      }
    }
  }

  intersects(x: number, z: number, radius: number): boolean {
    const minimumX = Math.floor((x - radius) / this.cellSize);
    const maximumX = Math.floor((x + radius) / this.cellSize);
    const minimumZ = Math.floor((z - radius) / this.cellSize);
    const maximumZ = Math.floor((z + radius) / this.cellSize);
    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        const segments = this.cells.get(`${cellX},${cellZ}`);
        if (!segments) continue;
        for (const segment of segments) {
          const clearance = segment.halfWidth + radius;
          if (pointSegmentDistanceSquared(x, z, segment.start, segment.end) <= clearance * clearance) {
            return true;
          }
        }
      }
    }
    return false;
  }
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
  private static readonly ZOOM = 14;
  private static readonly TILE_URL = "https://tiles.openfreemap.org/planet/latest";
  private static readonly cache = new Map<string, Promise<VectorTile | undefined>>();

  /** Adds the deterministic roadside concept to villa quarters before the
   * barrier renderer receives the mapped and generated frontage together. */
  static createRoadsideFeatures(tiles: readonly MapTile[]): BarrierFeature[] {
    const buildings = tiles.flatMap((tile) => buildingSources(tile));
    const roads = tiles.flatMap((tile) => roadSources(tile));
    return createRoadsideConceptFeatures(buildings, roads);
  }

  /** Fills sparse OSM lamp coverage with deterministic road-based lamps. */
  static createInferredStreetLampFeatures(
    tiles: readonly MapTile[],
    bounds: TerrainData["bounds"],
    meshWidth: number,
    meshDepth: number,
    metersPerUnit: number,
  ): BarrierFeature[] {
    const features: BarrierFeature[] = [];
    let nextId = -10_000_000;
    for (const tile of tiles) {
      for (const source of roadSources(tile)) {
        const roadClass = String(source.properties.class ?? "").toLowerCase();
        const spacing = roadClass === "primary" || roadClass === "secondary" ? 32
          : roadClass === "tertiary" ? 38
          : roadClass === "residential" || roadClass === "living_street" ? 44
          : roadClass === "unclassified" ? 58 : 0;
        if (!spacing) continue;
        for (const path of source.paths) {
          let distance = spacing * 0.5;
          for (let index = 1; index < path.length; index++) {
            const start = lonLatToScene(path[index - 1][0], path[index - 1][1], bounds, meshWidth, meshDepth);
            const end = lonLatToScene(path[index][0], path[index][1], bounds, meshWidth, meshDepth);
            const lengthMeters = Math.hypot(end.x - start.x, end.z - start.z) * metersPerUnit;
            while (distance < lengthMeters) {
              const amount = distance / Math.max(lengthMeters, 0.001);
              const point = sceneToLonLat(
                start.x + (end.x - start.x) * amount,
                start.z + (end.z - start.z) * amount,
                bounds, meshWidth, meshDepth,
              );
              features.push({
                id: nextId--,
                type: "lamp_pole",
                coordinates: [[point.lon, point.lat]],
                tags: { source: "inferred", highway: "street_lamp" },
              });
              distance += spacing;
            }
            distance -= lengthMeters;
          }
        }
      }
    }
    return features;
  }

  static async fetch(bounds: TileBounds, zoom = this.ZOOM): Promise<MapTile[]> {
    const northWest = tileFor(bounds.lonWest, bounds.latNorth, zoom);
    // Terrain bounds commonly end exactly on a slippy-tile boundary. Treat the
    // east and south edges as exclusive so we do not fetch an unused extra row
    // and column of vector tiles.
    const southEast = tileFor(bounds.lonEast - 1e-10, bounds.latSouth + 1e-10, zoom);
    const requests: Array<Promise<MapTile | undefined>> = [];
    for (let x = northWest.x; x <= southEast.x; x++) {
      for (let y = northWest.y; y <= southEast.y; y++) {
        requests.push(this.fetchTile(x, y, zoom));
      }
    }
    return (await Promise.all(requests)).filter((tile): tile is MapTile => tile !== undefined);
  }

  static async createLayer(
    scene: Scene,
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<MapFeatureLayer> {
    const root = new TransformNode("mapFeatures", scene);
    if (options.startDisabled) root.setEnabled(false);
    const buildings: Mesh[] = [];
    const roadMeshes: Record<RoadVisualStyle, Mesh[]> = {
      marked: [],
      paved: [],
      pedestrian: [],
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
    const renderOptions = {
      ...options,
      neighboringBuildingFootprints: tiles.flatMap((tile) =>
        buildingSources(tile).map((source) => source.polygon)),
    };

    for (const tile of tiles) {
      for (const source of buildingSources(tile)) {
        await yieldControl?.();
        const mesh = ProceduralBuildingRenderer.createDetailed(
          scene,
          planBuilding(source),
          terrain,
          renderOptions,
        );
        if (mesh) buildings.push(mesh);
        await yieldControl?.();
      }
      await yieldControl?.();
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel) continue;
        const target = roadMeshes[appearance.visualStyle];
        for (const line of source.paths) {
          const created = createRoad(scene, line, terrain, options, appearance);
          target.push(...created.surfaces);
          roadShoulders[appearance.surface].push(...created.shoulders);
          bridgeDecks.push(...created.bridgeDecks);
          if (appearance.structure === "surface" || appearance.structure === "ford") {
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
      forEachFeature(tile, "waterway", (feature) => {
        if (truthy(feature.properties.intermittent)) return;
        const widthMeters = waterwayWidthMeters(feature.properties.class);
        if (widthMeters === undefined) return;
        for (const line of lines(feature, tile)) {
          waterways.push(...createWaterway(scene, line, terrain, options, widthMeters));
        }
      });
      await yieldControl?.();
    }

    for (const junction of createRoadJunctions(
      scene,
      junctionCandidates,
      terrain,
      options,
    )) {
      roadMeshes[junction.visualStyle].push(junction.mesh);
    }

    const meshes = [
      ProceduralBuildingRenderer.merge(buildings, "buildings", root),
      mergeRoads(roadShoulders.paved, "pavedRoadShoulders", "pavedShoulder", root),
      mergeRoads(roadShoulders.unpaved, "unpavedRoadShoulders", "unpavedShoulder", root),
      mergeRoads(bridgeDecks, "bridgeDecks", "bridgeDeck", root),
      mergeRoads(roadMeshes.marked, "markedRoads", "marked", root),
      mergeRoads(roadMeshes.paved, "pavedRoads", "paved", root),
      mergeRoads(roadMeshes.pedestrian, "pedestrianRoads", "pedestrian", root),
      mergeRoads(roadMeshes.unpaved, "unpavedRoads", "unpaved", root),
      mergeRoads(roadMeshes.ford, "fordRoads", "ford", root),
      mergeWaterways(waterways, root, options),
    ].filter((mesh): mesh is Mesh => mesh !== undefined);
    // Source meshes are disabled as soon as they are constructed so yielding
    // between feature batches cannot expose them at the scene origin. The
    // merged meshes can now be enabled safely: a streamed layer's disabled
    // root keeps them hidden until Game applies the tile offset and commits it.
    for (const mesh of meshes) mesh.setEnabled(true);
    return {
      root,
      meshes,
      lakePolygons,
      counts: {
        buildings: buildings.length,
        roads: Object.values(roadMeshes).reduce((sum, meshes) => sum + meshes.length, 0),
        water: lakePolygons.length + waterways.length,
      },
    };
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
    const results: TerrainLakeSource[] = [];
    const clipPadding = Math.max(0, options.clipPadding ?? 0);
    const clipBounds = {
      minX: -options.meshWidth / 2 - clipPadding,
      maxX: options.meshWidth / 2 + clipPadding,
      minZ: -options.meshDepth / 2 - clipPadding,
      maxZ: options.meshDepth / 2 + clipPadding,
    };
    const project = ([lon, lat]: LonLat) =>
      lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth);
    for (const tile of tiles) {
      forEachFeature(tile, "water", (feature, featureIndex) => {
        if (feature.properties.class === "ocean" || truthy(feature.properties.intermittent)) return;
        const waterPolygons = polygonRings(feature, tile);
        for (let polygonIndex = 0; polygonIndex < waterPolygons.length; polygonIndex++) {
          const rings = waterPolygons[polygonIndex];
          const outline = clipPolygon(withoutClosingPoint(rings[0]).map(project), clipBounds);
          if (outline.length < 3) continue;
          const sourceId = waterFeatureSourceId(feature, tile, featureIndex, polygonIndex);
          const holes = rings.slice(1)
            .map((ring) => clipPolygon(withoutClosingPoint(ring).map(project), clipBounds))
            .filter((ring) => ring.length >= 3 && pointInPolygon(ring[0], outline));
          results.push({ sourceId, outline, holes });
        }
      });
    }
    return results;
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
    const buildings: Mesh[] = [];
    const renderOptions = {
      ...options,
      neighboringBuildingFootprints: tiles.flatMap((tile) =>
        buildingSources(tile).map((source) => source.polygon)),
    };
    for (const tile of tiles) {
      for (const source of buildingSources(tile)) {
        await yieldControl?.();
        const plan = planBuilding(source);
        const mesh = detail === "far"
          ? ProceduralBuildingRenderer.createFar(scene, plan, terrain, renderOptions)
          : ProceduralBuildingRenderer.createDetailed(scene, plan, terrain, renderOptions);
        if (mesh) buildings.push(mesh);
        await yieldControl?.();
      }
      await yieldControl?.();
    }

    const merged = ProceduralBuildingRenderer.merge(buildings, name, root);
    const meshes = merged ? [merged] : [];
    for (const mesh of meshes) mesh.setEnabled(true);
    return { root, meshes, count: buildings.length };
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
      unpaved: [],
      ford: [],
    };
    let count = 0;
    for (const tile of tiles) {
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel) continue;
        count++;
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
          appearance.widthMeters / 2 + appearance.shoulderWidthMeters
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
    const buildings = [];
    for (const tile of tiles) {
      for (const source of buildingSources(tile)) {
        const project = ([lon, lat]: LonLat) =>
          lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth);
        buildings.push({
          outer: source.polygon.outer.map(project),
          holes: source.polygon.holes.map((hole) => hole.map(project)),
        });
      }
      await yieldControl?.();
    }
    return combineHorizontalExclusionMasks([
      roadMask,
      new PolygonExclusionMask(
        buildings,
        Math.max(0.25, 20 / options.metersPerUnit),
      ),
    ]);
  }

  static async conformTerrainToRoads(
    tiles: MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
    yieldControl?: () => Promise<void>,
  ): Promise<number> {
    const paths = [];
    for (const tile of tiles) {
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel || appearance.structure === "bridge") continue;
        for (const coordinates of source.paths) {
          const scenePoints = coordinates.map(([lon, lat]) =>
            lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
          );
          for (const points of clipPolyline(
            scenePoints,
            options.meshWidth / 2,
            options.meshDepth / 2,
          )) {
            paths.push({
              points,
              widthMeters: appearance.widthMeters,
              shoulderWidthMeters: appearance.shoulderWidthMeters,
              structure: appearance.structure,
            });
          }
        }
      }
      await yieldControl?.();
    }
    return stampRoadTerrain(terrain, paths, options, yieldControl);
  }

  static async conformTerrainToBuildings(
    tiles: MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
    yieldControl?: () => Promise<void>,
  ): Promise<number> {
    const footprints = [];
    for (const tile of tiles) {
      for (const source of buildingSources(tile)) {
        footprints.push({
          outline: source.polygon.outer.map(([lon, lat]) =>
            lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
          ),
        });
      }
      await yieldControl?.();
    }
    return stampBuildingTerrain(terrain, footprints, options, yieldControl);
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
    let request = this.cache.get(key);
    if (!request) {
      request = fetch(`${this.TILE_URL}/${key}.pbf`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`Map tile request failed (${response.status}).`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return bytes.length ? new VectorTile(new PbfReader(bytes)) : undefined;
        }).catch((error: unknown) => {
          this.cache.delete(key);
          throw error;
        });
      this.cache.set(key, request);
    }
    const data = await request;
    return data ? { x, y, zoom, data } : undefined;
  }
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

function buildingSources(tile: MapTile): readonly BuildingSource[] {
  const cached = buildingSourceCache.get(tile.data);
  if (cached) return cached;
  const sources: BuildingSource[] = [];
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
      sources.push({
        id: featureSourceId("building", feature, tile, featureIndex, polygonIndex),
        polygon: { outer: rings[0], holes: rings.slice(1) },
        properties: { ...feature.properties },
      });
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
  const renderWidthMeters = detail === "far"
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
  const sampleSpacing = detail === "far"
    ? Math.max(terrainSampleSpacing, 12 / options.metersPerUnit)
    : terrainSampleSpacing;
  const paths = clippedPaths.map((path) => resamplePath(path, sampleSpacing));
  const surfaces: Mesh[] = [];
  const shoulders: Mesh[] = [];
  const bridgeDecks: Mesh[] = [];
  for (const path of paths) {
    const bridgeElevations = appearance.structure === "bridge"
      ? bridgeElevationProfile(path, terrain, options)
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
        -BRIDGE_DECK_THICKNESS_METERS,
        bridgeElevations,
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
): Mesh[] {
  const meshes: Mesh[] = [];
  let left: Vector3[] = [];
  let right: Vector3[] = [];
  const finishPath = (): void => {
    if (left.length >= 2) {
      // Asphalt/gravel grain is projected from the tile's scene coordinates so
      // two ribbons that cross sample the same texture phase at the crossing.
      // Marked roads keep their strip UVs because the dashed centre marking is
      // encoded in the texture's across-road axis.
      const uvs = visualStyle === "marked"
        ? roadUvs(left, right, options.metersPerUnit, visualStyle)
        : worldPositionRoadUvs(left, right, options.metersPerUnit, visualStyle);
      meshes.push(stageMapMesh(
        MeshBuilder.CreateRibbon("road", { pathArray: [left, right], uvs }, scene),
      ));
    }
    left = [];
    right = [];
  };
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = (-dz / length) * halfWidth;
    const offsetZ = (dx / length) * halfWidth;
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
): number[] {
  if (points.length === 0) return [];
  const observations = points.map((point) => {
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
    const obstacle = water && options.preCarvingElevations
      ? sampleElevation(
        terrain,
        point.x,
        point.z,
        options.meshWidth,
        options.meshDepth,
        options.preCarvingElevations,
      )
      : ground;
    return { obstacle, clearance: water ? BRIDGE_WATER_CLEARANCE_METERS : BRIDGE_TERRAIN_CLEARANCE_METERS };
  });
  const startElevation = observations[0].obstacle;
  const endElevation = observations[observations.length - 1].obstacle;
  const baseline = observations.map((_, index) => {
    const amount = index / Math.max(1, observations.length - 1);
    return startElevation + (endElevation - startElevation) * amount;
  });
  const lift = observations.reduce(
    (maximum, observation, index) =>
      Math.max(maximum, observation.obstacle + observation.clearance - baseline[index]),
    0,
  );
  return baseline.map((elevation) => elevation + lift);
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
    const clipped = clipPolygon(circle, clipBounds);
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
  if (candidates.every((candidate) => candidate.visualStyle === "unpaved")) return "unpaved";
  if (candidates.every((candidate) => candidate.visualStyle === "pedestrian")) return "pedestrian";
  return "paved";
}

function createWaterway(
  scene: Scene,
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
  widthMeters: number,
): Mesh[] {
  const points = coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
  );
  const paths = clipPolyline(points, options.meshWidth / 2, options.meshDepth / 2);
  const sampleSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  ) / 2;
  return paths.flatMap((path) => createWaterwayMeshes(
    scene,
    resamplePath(path, sampleSpacing),
    terrain,
    options,
    widthMeters / options.metersPerUnit / 2,
  ));
}

function createWaterwayMeshes(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: MapLayerOptions,
  halfWidth: number,
): Mesh[] {
  if (points.length < 2) return [];
  const left: Vector3[] = [];
  const right: Vector3[] = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = (-dz / length) * halfWidth;
    const offsetZ = (dx / length) * halfWidth;
    const elevation = Math.min(
      sampleElevation(terrain, points[index].x + offsetX, points[index].z + offsetZ, options.meshWidth, options.meshDepth),
      sampleElevation(terrain, points[index].x - offsetX, points[index].z - offsetZ, options.meshWidth, options.meshDepth),
    );
    const y = (elevation + WATERWAY_SURFACE_CLEARANCE_METERS) / options.metersPerUnit;
    left.push(new Vector3(points[index].x + offsetX, y, points[index].z + offsetZ));
    right.push(new Vector3(points[index].x - offsetX, y, points[index].z - offsetZ));
  }
  return [stageMapMesh(MeshBuilder.CreateRibbon(
    "waterway",
    { pathArray: [left, right], uvs: roadUvs(left, right, options.metersPerUnit, "paved") },
    scene,
  ))];
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
  const repeatMeters = visualStyle === "unpaved" || visualStyle === "ford"
    ? LOOSE_ROAD_TEXTURE_REPEAT_METERS
    : 4;
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
  const repeatMeters = visualStyle === "unpaved" || visualStyle === "ford"
    ? LOOSE_ROAD_TEXTURE_REPEAT_METERS
    : 4;
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

function resamplePath(
  points: Array<{ x: number; z: number }>,
  maximumSpacing: number,
): Array<{ x: number; z: number }> {
  if (points.length < 2 || maximumSpacing <= 0) return points;
  const sampled = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / maximumSpacing));
    for (let step = 1; step <= steps; step++) {
      const amount = step / steps;
      sampled.push({
        x: start.x + (end.x - start.x) * amount,
        z: start.z + (end.z - start.z) * amount,
      });
    }
  }
  return sampled;
}

function pointSegmentDistanceSquared(
  x: number,
  z: number,
  start: { x: number; z: number },
  end: { x: number; z: number },
): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared));
  const offsetX = x - (start.x + dx * amount);
  const offsetZ = z - (start.z + dz * amount);
  return offsetX * offsetX + offsetZ * offsetZ;
}

function clipPolygon(
  points: Array<{ x: number; z: number }>,
  bounds: MapClipBounds,
): Array<{ x: number; z: number }> {
  const edges: Array<{
    inside: (point: { x: number; z: number }) => boolean;
    intersect: (start: { x: number; z: number }, end: { x: number; z: number }) => { x: number; z: number };
  }> = [
    { inside: (p) => p.x >= bounds.minX, intersect: (a, b) => atX(a, b, bounds.minX) },
    { inside: (p) => p.x <= bounds.maxX, intersect: (a, b) => atX(a, b, bounds.maxX) },
    { inside: (p) => p.z >= bounds.minZ, intersect: (a, b) => atZ(a, b, bounds.minZ) },
    { inside: (p) => p.z <= bounds.maxZ, intersect: (a, b) => atZ(a, b, bounds.maxZ) },
  ];
  let output = points;
  for (const edge of edges) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index++) {
      const start = input[(index + input.length - 1) % input.length];
      const end = input[index];
      const startInside = edge.inside(start);
      const endInside = edge.inside(end);
      if (endInside) {
        if (!startInside) output.push(edge.intersect(start, end));
        output.push(end);
      } else if (startInside) {
        output.push(edge.intersect(start, end));
      }
    }
  }
  return output;
}

function pointInPolygon(
  point: { x: number; z: number },
  polygon: readonly { x: number; z: number }[],
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.z > point.z) !== (b.z > point.z) &&
        point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function clipPolyline(
  points: Array<{ x: number; z: number }>,
  halfWidth: number,
  halfDepth: number,
): Array<Array<{ x: number; z: number }>> {
  const paths: Array<Array<{ x: number; z: number }>> = [];
  let current: Array<{ x: number; z: number }> | undefined;
  for (let index = 1; index < points.length; index++) {
    const segment = clipSegment(points[index - 1], points[index], halfWidth, halfDepth);
    if (!segment) {
      current = undefined;
      continue;
    }
    if (!current || !samePoint(current[current.length - 1], segment[0])) {
      current = [segment[0], segment[1]];
      paths.push(current);
    } else {
      current.push(segment[1]);
    }
  }
  return paths;
}

function clipSegment(
  start: { x: number; z: number },
  end: { x: number; z: number },
  halfWidth: number,
  halfDepth: number,
): [{ x: number; z: number }, { x: number; z: number }] | undefined {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let minimum = 0;
  let maximum = 1;
  const tests: Array<[number, number]> = [
    [-dx, start.x + halfWidth],
    [dx, halfWidth - start.x],
    [-dz, start.z + halfDepth],
    [dz, halfDepth - start.z],
  ];
  for (const [direction, distance] of tests) {
    if (direction === 0) {
      if (distance < 0) return undefined;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return undefined;
  }
  return [
    { x: start.x + minimum * dx, z: start.z + minimum * dz },
    { x: start.x + maximum * dx, z: start.z + maximum * dz },
  ];
}

function atX(
  start: { x: number; z: number },
  end: { x: number; z: number },
  x: number,
): { x: number; z: number } {
  const amount = (x - start.x) / (end.x - start.x);
  return { x, z: start.z + amount * (end.z - start.z) };
}

function atZ(
  start: { x: number; z: number },
  end: { x: number; z: number },
  z: number,
): { x: number; z: number } {
  const amount = (z - start.z) / (end.z - start.z);
  return { x: start.x + amount * (end.x - start.x), z };
}

function signedArea(points: Array<{ x: number; z: number }>): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.z - next.x * points[index].z;
  }
  return area / 2;
}

function samePoint(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

function tileFor(longitude: number, latitude: number, zoom: number): { x: number; y: number } {
  const scale = 2 ** zoom;
  const latitudeRadians = latitude * Math.PI / 180;
  return {
    x: Math.floor((longitude + 180) / 360 * scale),
    y: Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale),
  };
}

function mergeRoads(
  meshes: Mesh[],
  name: string,
  visualStyle: RoadMaterialStyle,
  parent: TransformNode,
): Mesh | undefined {
  if (meshes.length === 0) return undefined;
  const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
  if (!result) return undefined;
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
  result.material = createWaterSurfaceMaterial(result.getScene(), {
    name: "waterwayMaterial",
    width: options.meshWidth,
    height: options.meshDepth,
    metersPerUnit: options.metersPerUnit,
    skyReflection: options.skyReflection,
  });
  prepareWaterSurfaceMesh(result);
  result.isPickable = false;
  result.parent = parent;
  return result;
}
function createRoadMaterial(scene: Scene, name: string, visualStyle: RoadMaterialStyle): StandardMaterial {
  const material = new StandardMaterial(`${name}Material`, scene);
  switch (visualStyle) {
    case "unpaved": material.diffuseColor = new Color3(0.43, 0.42, 0.38); break;
    case "marked": material.diffuseColor = new Color3(0.72, 0.72, 0.68); break;
    case "pedestrian": material.diffuseColor = new Color3(0.38, 0.36, 0.33); break;
    case "ford": material.diffuseColor = new Color3(0.28, 0.32, 0.31); break;
    case "pavedShoulder": material.diffuseColor = new Color3(0.3, 0.29, 0.27); break;
    case "unpavedShoulder": material.diffuseColor = new Color3(0.38, 0.37, 0.34); break;
    case "bridgeDeck": material.diffuseColor = new Color3(0.16, 0.17, 0.17); break;
    default: material.diffuseColor = new Color3(0.2, 0.21, 0.2); break;
  }
  const looseSurface = visualStyle === "unpaved" || visualStyle === "unpavedShoulder";
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
    relief.level = 0.24;
    material.bumpTexture = relief;
  }
  return material;
}

/** Small deterministic texture: coarse aggregate for gravel, fine grain for asphalt. */
function createRoadTexture(
  scene: Scene,
  name: string,
  visualStyle: RoadMaterialStyle,
  gammaSpace: boolean,
): RawTexture {
  const pixels = new Uint8Array(ROAD_TEXTURE_SIZE * ROAD_TEXTURE_SIZE * 4);
  for (let y = 0; y < ROAD_TEXTURE_SIZE; y++) {
    for (let x = 0; x < ROAD_TEXTURE_SIZE; x++) {
      const offset = (y * ROAD_TEXTURE_SIZE + x) * 4;
      const fine = hashNoise(x, y);
      const coarse = hashNoise(Math.floor(x / 4), Math.floor(y / 4));
      // Periodic value noise crosses the wrapped edges smoothly. Several
      // incommensurate scales read as varied aggregate without the old square
      // four-pixel clumps advertising each texture tile.
      const gravelBroad = tiledRoadNoise(x, y, 7, 0x45d9f3b);
      const gravelCluster = tiledRoadNoise(x, y, 23, 0x119de1f3);
      const gravelGrain = tiledRoadNoise(x, y, 53, 0x3449f5);
      const centerMark = visualStyle === "marked" &&
        Math.abs(y - (ROAD_TEXTURE_SIZE - 1) / 2) <= 1.25 &&
        x < ROAD_TEXTURE_SIZE * 0.58;
      const value = centerMark
        ? 235
        : visualStyle === "marked"
          ? 55 + Math.round((fine - 0.5) * 10)
          : visualStyle === "unpaved" || visualStyle === "unpavedShoulder"
            ? 164 + Math.round(
              (gravelBroad - 0.5) * 14 +
              (gravelCluster - 0.5) * 24 +
              (gravelGrain - 0.5) * 12
            )
            : visualStyle === "pedestrian"
              ? 185 + Math.round((fine - 0.5) * 18 + (coarse - 0.5) * 8)
              : visualStyle === "ford"
                ? 132 + Math.round((fine - 0.5) * 28 + (coarse - 0.5) * 12)
                : visualStyle === "pavedShoulder"
                  ? 148 + Math.round((fine - 0.5) * 28 + (coarse - 0.5) * 10)
                  : visualStyle === "bridgeDeck"
                    ? 118 + Math.round((fine - 0.5) * 16)
                    : 175 + Math.round((fine - 0.5) * 24);
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
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
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 12;
  return texture;
}

function hashNoise(x: number, y: number): number {
  let hash = Math.imul(x ^ 0x6d2b79f5, 0x1b873593) ^ Math.imul(y ^ 0x85ebca6b, 0xc2b2ae35);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 0xffffffff;
}

/** Seamless smooth noise whose lattice repeats exactly at the texture boundary. */
function tiledRoadNoise(x: number, y: number, frequency: number, seed: number): number {
  const sampleX = (x / ROAD_TEXTURE_SIZE) * frequency;
  const sampleY = (y / ROAD_TEXTURE_SIZE) * frequency;
  const cellX = Math.floor(sampleX);
  const cellY = Math.floor(sampleY);
  const fractionX = sampleX - cellX;
  const fractionY = sampleY - cellY;
  const smoothX = fractionX * fractionX * (3 - 2 * fractionX);
  const smoothY = fractionY * fractionY * (3 - 2 * fractionY);
  const wrapped = (value: number): number => (value + frequency) % frequency;
  const topLeft = hashNoise(wrapped(cellX) ^ seed, wrapped(cellY));
  const topRight = hashNoise(wrapped(cellX + 1) ^ seed, wrapped(cellY));
  const bottomLeft = hashNoise(wrapped(cellX) ^ seed, wrapped(cellY + 1));
  const bottomRight = hashNoise(wrapped(cellX + 1) ^ seed, wrapped(cellY + 1));
  const top = topLeft + (topRight - topLeft) * smoothX;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * smoothX;
  return top + (bottom - top) * smoothY;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
