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
} from "@babylonjs/core";
import {
  HorizontalExclusionMask,
  lonLatToScene,
  sampleElevation,
} from "./Geo";
import { acquireBushImpostorAssets, createBushModel } from "./BushImpostor";
import { createVegetationFieldRenderers } from "./VegetationFieldRenderers";
import { createVegetationFieldResult } from "./VegetationField";
import type { VegetationFieldResult } from "./VegetationField";
import type { TerrainData } from "./TerrainData";
import type { TileBounds } from "./WorldGrid";
import type { BuildingSource } from "./BuildingPlanner";
import { normalizeBuildingClass } from "./BuildingPlanner";
import { SimplexNoise2D } from "./SimplexNoise";

/** A generated residential frontage concept, used when detailed OSM barriers
 * are absent or incomplete around a villa quarter. */
export const ROADSIDE_CONCEPT = "roadside" as const;
export type RoadsideConcept = typeof ROADSIDE_CONCEPT;

export type RoadsideBuildingSource = BuildingSource;

export interface RoadsideRoadSource {
  id: string;
  paths: Array<Array<readonly [number, number]>>;
  properties: Readonly<Record<string, unknown>>;
}

export type BarrierType =
  | "hedge"
  | "fence"
  | "wall"
  | "guard_rail"
  | "jersey_barrier"
  | "cable_barrier"
  | "retaining_wall"
  | "lamp_pole";

export interface BarrierFeature {
  id: number;
  type: BarrierType;
  coordinates: Array<readonly [number, number]>;
  tags: Readonly<Record<string, string>>;
}

export interface BarrierLayerOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  startDisabled?: boolean;
}

export interface BarrierFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
  hedgeField?: VegetationFieldResult;
}

const ROADSIDE_REGION_NOISE = new SimplexNoise2D(0x7a61d2);

/**
 * Fills the most common missing detail in mapped villa quarters: a loose
 * roadside boundary around detached homes. The broad noise field makes whole
 * pockets hedge-heavy, while a smaller share becomes fence-heavy or remains
 * open. Every generated property has a deliberate road-facing gap.
 */
export function createRoadsideConceptFeatures(
  buildings: readonly RoadsideBuildingSource[],
  roads: readonly RoadsideRoadSource[],
): BarrierFeature[] {
  const result: BarrierFeature[] = [];
  for (const building of buildings) {
    const kind = normalizeBuildingClass(
      building.properties.class ?? building.properties.building,
    );
    const rawKind = String(
      building.properties.building ?? building.properties.class ?? "",
    ).toLowerCase();
    if (kind !== "residential" ||
        (!/(^|_)(house|detached|semidetached_house|bungalow|villa)(_|$)/.test(rawKind) &&
          rawKind !== "residential")) continue;
    const ring = withoutClosingLonLat(building.polygon.outer);
    if (ring.length < 4) continue;
    const center = lonLatCentroid(ring);
    const regional = ROADSIDE_REGION_NOISE.sample(center[0] * 220, center[1] * 220);
    if (regional < -0.38) continue;
    const nearestRoad = nearestRoadDistanceMeters(center, roads);
    if (nearestRoad > 42) continue;

    const style: BarrierType = regional > -0.04 ? "hedge" : "fence";
    const scale = 1.32;
    const boundary = ring.map(([lon, lat]) => [
      center[0] + (lon - center[0]) * scale,
      center[1] + (lat - center[1]) * scale,
    ] as readonly [number, number]);
    const gateEdge = nearestBoundaryEdge(boundary, roads);
    const gateWidth = 3.4 + (stableUnit(building.id) * 1.8);
    for (let index = 0; index < boundary.length; index++) {
      const start = boundary[index];
      const end = boundary[(index + 1) % boundary.length];
      const length = distanceMeters(start, end);
      if (index !== gateEdge || length <= gateWidth + 2) {
        result.push(roadsideFeature(building.id, index, style, [start, end]));
        continue;
      }
      const inset = 0.18 + stableUnit(`${building.id}:inset:${index}`) * 0.16;
      const gapStart = inset + (length - gateWidth) * 0.5;
      const gapEnd = gapStart + gateWidth;
      const first = interpolateLonLat(start, end, gapStart / length);
      const second = interpolateLonLat(start, end, gapEnd / length);
      result.push(roadsideFeature(building.id, index, style, [start, first]));
      result.push(roadsideFeature(building.id, index + 1000, style, [second, end]));
    }
  }
  return result;
}

function roadsideFeature(
  buildingId: string,
  edge: number,
  type: BarrierType,
  coordinates: Array<readonly [number, number]>,
): BarrierFeature {
  return {
    id: stableInteger(`${ROADSIDE_CONCEPT}:${buildingId}:${edge}`),
    type,
    coordinates,
    tags: { concept: ROADSIDE_CONCEPT, source: "procedural" },
  };
}

function withoutClosingLonLat(points: readonly (readonly [number, number])[]): Array<readonly [number, number]> {
  if (points.length > 1 && points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1]) return points.slice(0, -1);
  return [...points];
}

function lonLatCentroid(points: readonly (readonly [number, number])[]): readonly [number, number] {
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function distanceMeters(a: readonly [number, number], b: readonly [number, number]): number {
  const latScale = 111_320;
  const lonScale = latScale * Math.cos(((a[1] + b[1]) * 0.5) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * lonScale, (b[1] - a[1]) * latScale);
}

function interpolateLonLat(
  a: readonly [number, number], b: readonly [number, number], amount: number,
): readonly [number, number] {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount];
}

function nearestBoundaryEdge(
  boundary: readonly (readonly [number, number])[],
  roads: readonly RoadsideRoadSource[],
): number {
  let bestEdge = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let edge = 0; edge < boundary.length; edge++) {
    const midpoint = interpolateLonLat(boundary[edge], boundary[(edge + 1) % boundary.length], 0.5);
    const distance = nearestRoadDistanceMeters(midpoint, roads);
    if (distance < bestDistance) { bestDistance = distance; bestEdge = edge; }
  }
  return bestEdge;
}

function nearestRoadDistanceMeters(
  point: readonly [number, number], roads: readonly RoadsideRoadSource[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const road of roads) for (const path of road.paths) {
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1];
      const b = path[index];
      const amount = nearestSegmentAmount(point, a, b);
      nearest = Math.min(nearest, distanceMeters(point, interpolateLonLat(a, b, amount)));
    }
  }
  return nearest;
}

function nearestSegmentAmount(
  point: readonly [number, number], a: readonly [number, number], b: readonly [number, number],
): number {
  const cos = Math.cos(point[1] * Math.PI / 180);
  const ax = a[0] * cos; const bx = b[0] * cos; const px = point[0] * cos;
  const ay = a[1]; const by = b[1]; const py = point[1];
  const dx = bx - ax; const dy = by - ay;
  return Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
}

function stableUnit(value: string): number {
  return (stableInteger(value) >>> 0) / 0x1_0000_0000;
}

function stableInteger(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return hash | 0;
}

interface OverpassResponse {
  elements?: unknown[];
}

interface BarrierAppearance {
  style: "hedge" | "woodFence" | "chainlink" | "guardRail" | "wall" | "noiseBarrier" | "jerseyBarrier" | "lampPole";
  heightMeters: number;
}

interface HorizontalSegment {
  start: { x: number; z: number };
  end: { x: number; z: number };
  halfWidth: number;
}

/** OSM line-detail omitted by the general-purpose OpenMapTiles schema. */
export class OpenStreetMapBarriers {
  private static readonly QUERY_ZOOM = 14;
  private static readonly DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
  private static readonly cache = new Map<string, Promise<BarrierFeature[]>>();

  /**
   * Loads the zoom-14 parent of an application tile. Four level-16 terrain
   * tiles therefore share one compact request and one cached response.
   */
  static fetch(bounds: TileBounds): Promise<BarrierFeature[]> {
    const tile = tileFor(bounds.lonWest + 1e-10, bounds.latNorth - 1e-10, this.QUERY_ZOOM);
    const key = `${this.QUERY_ZOOM}/${tile.x}/${tile.y}`;
    let request = this.cache.get(key);
    if (!request) {
      const queryBounds = tileBounds(tile.x, tile.y, this.QUERY_ZOOM);
      request = this.fetchRegion(queryBounds).catch((error: unknown) => {
        // Barriers are optional scene detail. Retain an empty cached result so
        // one unavailable public endpoint cannot trigger a retry storm as the
        // four child terrain tiles finish loading.
        console.warn(`OpenStreetMap barriers unavailable for ${key}; the layer was skipped.`, error);
        return [];
      });
      this.cache.set(key, request);
    }
    return request;
  }

  static async createLayer(
    scene: Scene,
    features: readonly BarrierFeature[],
    terrain: TerrainData,
    options: BarrierLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<BarrierFeatureLayer> {
    const root = new TransformNode("barriers", scene);
    if (options.startDisabled) root.setEnabled(false);
    const byStyle = new Map<BarrierAppearance["style"], Mesh[]>();
    const hedgeMatrices: Matrix[] = [];
    let count = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
      const feature = features[featureIndex];
      const appearance = barrierAppearance(feature);
      const projected = feature.coordinates.map(([lon, lat]) =>
        lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
      );
      if (feature.type === "lamp_pole") {
        const point = projected[0];
        if (!point || point.x < -options.meshWidth / 2 || point.x > options.meshWidth / 2 ||
            point.z < -options.meshDepth / 2 || point.z > options.meshDepth / 2) continue;
        const mesh = createLampPole(scene, point, terrain, options, appearance.heightMeters);
        const lamps = byStyle.get("lampPole");
        if (lamps) lamps.push(mesh);
        else byStyle.set("lampPole", [mesh]);
        count++;
        continue;
      }
      const clipped = clipPolyline(projected, options.meshWidth / 2, options.meshDepth / 2);
      let rendered = false;
      for (const path of clipped) {
        const sampled = resamplePath(path, 2 / options.metersPerUnit);
        const mesh = appearance.style === "hedge"
          ? undefined
          : appearance.style === "woodFence"
            ? createFence(scene, sampled, terrain, options, appearance.heightMeters)
            : appearance.style === "chainlink"
              ? createChainlinkFence(scene, sampled, terrain, options, appearance.heightMeters)
            : createBarrierRibbon(scene, sampled, terrain, options, appearance.heightMeters, appearance.style);
        if (appearance.style === "hedge") {
          hedgeMatrices.push(...createHedgeMatrices(sampled, terrain, options, appearance.heightMeters));
          rendered = sampled.length >= 2;
          continue;
        }
        if (!mesh) continue;
        const meshes = byStyle.get(appearance.style);
        if (meshes) meshes.push(mesh);
        else byStyle.set(appearance.style, [mesh]);
        rendered = true;
      }
      if (rendered) count++;
      if ((featureIndex + 1) % 24 === 0) await yieldControl?.();
    }

    const meshes: Mesh[] = [];
    let hedgeField: VegetationFieldResult | undefined;
    if (hedgeMatrices.length > 0) {
      const hedgeRoot = new TransformNode("hedgerowBushes", scene);
      hedgeRoot.parent = root;
      const renderers = await createVegetationFieldRenderers(scene, {
        rootName: "hedgerowBushRenderers",
        impostorName: "hedgerowBushImpostors",
        renderHeight: 1.6 / options.metersPerUnit,
        loadAssets: () => acquireBushImpostorAssets(scene, { key: "default" }),
        createModel: () => createBushModel(scene, 1.6 / options.metersPerUnit),
      });
      renderers.root.parent = hedgeRoot;
      hedgeField = await createVegetationFieldResult(
        renderers.root,
        [renderers.impostor],
        [renderers.model],
        packMatrices(hedgeMatrices),
        options.metersPerUnit,
        "auto",
        undefined,
        yieldControl,
      );
      /*
       * The normal vegetation field owns both representations and performs
       * the model/impostor transition. The barrier root still owns the field
       * through this child, so disposal remains tied to the mapped feature.
       */
      meshes.push(...hedgeField.meshes);
    }
    /* Keep the field available to Game so hedges receive normal LOD updates. */
    const hedgeFieldResult = hedgeField;
    for (const [style, sources] of byStyle) {
      const merged = sources.length === 1 ? sources[0] : Mesh.MergeMeshes(sources, true, true);
      if (!merged) continue;
      merged.name = `${style}Barriers`;
      merged.material = createBarrierMaterial(scene, style);
      merged.isPickable = false;
      merged.parent = root;
      merged.setEnabled(true);
      meshes.push(merged);
    }
    return { root, meshes, count, hedgeField: hedgeFieldResult };
  }

  /** Prevents procedurally placed trees and shrubs from crossing solid mapped barriers. */
  static createExclusionMask(
    features: readonly BarrierFeature[],
    terrain: TerrainData,
    options: Pick<BarrierLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
  ): HorizontalExclusionMask {
    const segments: HorizontalSegment[] = [];
    for (const feature of features) {
      const projected = feature.coordinates.map(([lon, lat]) =>
        lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
      );
      const clearanceMeters = feature.type === "hedge" ? 0.9 : 0.35;
      for (const path of clipPolyline(projected, options.meshWidth / 2, options.meshDepth / 2)) {
        for (let index = 1; index < path.length; index++) {
          segments.push({
            start: path[index - 1],
            end: path[index],
            halfWidth: clearanceMeters / options.metersPerUnit,
          });
        }
      }
    }
    return new SegmentExclusionMask(segments, 12 / options.metersPerUnit);
  }

  private static async fetchRegion(bounds: TileBounds): Promise<BarrierFeature[]> {
    const endpoint = typeof document === "undefined"
      ? this.DEFAULT_ENDPOINT
      : document.querySelector<HTMLMetaElement>('meta[name="overpass-url"]')?.content ||
        this.DEFAULT_ENDPOINT;
    const bbox = [bounds.latSouth, bounds.lonWest, bounds.latNorth, bounds.lonEast].join(",");
    // Request barrier ways generically and filter to the supported types while
    // parsing. This keeps the union query valid across Overpass instances.
    const query = `[out:json][timeout:15];(way["barrier"](${bbox});node["highway"="street_lamp"](${bbox}););out tags geom qt;`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ data: query }),
    });
    if (!response.ok) throw new Error(`Overpass request failed (${response.status}).`);
    const payload = await response.json() as OverpassResponse;
    return parseBarrierFeatures(payload.elements);
  }
}

function parseBarrierFeatures(elements: unknown): BarrierFeature[] {
  if (!Array.isArray(elements)) return [];
  const features: BarrierFeature[] = [];
  for (const value of elements) {
    if (!value || typeof value !== "object") continue;
    const element = value as Record<string, unknown>;
    if ((element.type !== "way" && element.type !== "node") || !Number.isFinite(element.id)) continue;
    if (!element.tags || typeof element.tags !== "object") continue;
    const rawTags = element.tags as Record<string, unknown>;
    const type = rawTags.barrier;
    const isLampPole = element.type === "node" && rawTags.highway === "street_lamp";
    if ((!isLampPole && !isBarrierType(type)) ||
        (!isLampPole && !Array.isArray(element.geometry))) continue;
    const coordinates: Array<readonly [number, number]> = [];
    if (isLampPole) {
      const { lon, lat } = element as { lon?: unknown; lat?: unknown };
      if (typeof lon === "number" && Number.isFinite(lon) &&
          typeof lat === "number" && Number.isFinite(lat)) {
        coordinates.push([lon, lat]);
      }
    } else {
      for (const point of element.geometry as unknown[]) {
        if (!point || typeof point !== "object") continue;
        const { lon, lat } = point as { lon?: unknown; lat?: unknown };
        if (typeof lon === "number" && Number.isFinite(lon) &&
            typeof lat === "number" && Number.isFinite(lat)) {
          coordinates.push([lon, lat]);
        }
      }
    }
    if (coordinates.length < (isLampPole ? 1 : 2)) continue;
    const tags: Record<string, string> = {};
    for (const [key, tagValue] of Object.entries(rawTags)) {
      if (typeof tagValue === "string") tags[key] = tagValue;
    }
    features.push({ id: element.id as number, type: isLampPole ? "lamp_pole" : type as BarrierType, coordinates, tags });
  }
  return features;
}

function isBarrierType(value: unknown): value is BarrierType {
  return value === "hedge" || value === "fence" || value === "wall" ||
    value === "guard_rail" || value === "jersey_barrier" ||
    value === "cable_barrier" || value === "retaining_wall";
}

function barrierAppearance(feature: BarrierFeature): BarrierAppearance {
  if (feature.type === "lamp_pole") {
    return { style: "lampPole", heightMeters: positiveMeters(feature.tags.height) ?? 6.5 };
  }
  const taggedHeight = positiveMeters(feature.tags.height);
  switch (feature.type) {
    case "hedge": return { style: "hedge", heightMeters: taggedHeight ?? 1.6 };
    case "fence": return {
      style: isWoodFence(feature) ? "woodFence" : "chainlink",
      heightMeters: taggedHeight ?? 1.5,
    };
    case "guard_rail": return { style: "guardRail", heightMeters: taggedHeight ?? 0.78 };
    case "cable_barrier": return { style: "chainlink", heightMeters: taggedHeight ?? 0.85 };
    case "jersey_barrier": return { style: "jerseyBarrier", heightMeters: taggedHeight ?? 0.82 };
    case "retaining_wall": return { style: "wall", heightMeters: taggedHeight ?? 1.5 };
    case "wall": return {
      style: feature.tags.wall === "noise_barrier" ? "noiseBarrier" : "wall",
      heightMeters: taggedHeight ?? (feature.tags.wall === "noise_barrier" ? 3 : 1.8),
    };
  }
}

/** OSM material tagging is sparse, so an ordinary fence defaults to metal mesh. */
function isWoodFence(feature: BarrierFeature): boolean {
  const material = (feature.tags.material ?? "").toLowerCase();
  const fenceType = (feature.tags.fence_type ?? "").toLowerCase();
  return material.includes("wood") || fenceType.includes("wood") || fenceType.includes("paling") ||
    fenceType.includes("board") || fenceType.includes("privacy");
}

function positiveMeters(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 12) : undefined;
}

/** Small, non-instanced street lamp geometry. Lamp nodes are sparse enough that
 * a real mesh is clearer and cheaper than introducing a second impostor atlas. */
function createLampPole(
  scene: Scene,
  point: { x: number; z: number },
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Mesh {
  const unitHeight = heightMeters / options.metersPerUnit;
  const ground = sampleElevation(terrain, point.x, point.z, options.meshWidth, options.meshDepth) /
    options.metersPerUnit;
  const pole = MeshBuilder.CreateCylinder("lampPole", {
    height: unitHeight,
    diameter: 0.12 / options.metersPerUnit,
    tessellation: 8,
  }, scene);
  pole.position.set(point.x, ground + unitHeight / 2, point.z);

  const armLength = 0.8 / options.metersPerUnit;
  const arm = MeshBuilder.CreateCylinder("lampPoleArm", {
    height: armLength,
    diameter: 0.09 / options.metersPerUnit,
    tessellation: 8,
  }, scene);
  arm.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 2);
  arm.position.set(point.x + armLength / 2, ground + unitHeight - 0.18 / options.metersPerUnit, point.z);

  const fixture = MeshBuilder.CreateSphere("lampFixture", {
    diameter: 0.24 / options.metersPerUnit,
    segments: 6,
  }, scene);
  fixture.position.set(point.x + armLength, ground + unitHeight - 0.3 / options.metersPerUnit, point.z);

  const mesh = Mesh.MergeMeshes([pole, arm, fixture], true, true);
  if (!mesh) throw new Error("Could not create lamp pole mesh.");
  mesh.setEnabled(false);
  return mesh;
}

function createHedgeMatrices(
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Matrix[] {
  if (points.length < 2) return [];
  const matrices: Matrix[] = [];
  const spacing = 0.86 / options.metersPerUnit;
  const across = [-0.32, 0, 0.32].map((offset) => offset / options.metersPerUnit);
  const burialDepth = 0.12 / options.metersPerUnit;
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(length / spacing));
    const normalX = length > 0 ? -dz / length : 0;
    const normalZ = length > 0 ? dx / length : 0;
    const yaw = Math.atan2(dx, dz);
    for (let step = 0; step < steps; step++) {
      const amount = (step + 0.5) / steps;
      const centerX = start.x + dx * amount;
      const centerZ = start.z + dz * amount;
      const ground = sampleElevation(terrain, centerX, centerZ, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      across.forEach((offset, acrossIndex) => {
        const scale = 0.58 + ((index * 17 + step * 7 + Math.round(offset * 100)) % 5) * 0.028;
        // Keep each bush's orientation stable while avoiding a visible repeating
        // three-angle pattern along the hedge line.
        const instanceSeed = index * 92821 + step * 68917 + acrossIndex * 283;
        const rotationJitter = Math.sin(instanceSeed) * 0.18;
        matrices.push(Matrix.Compose(
          new Vector3(
            scale,
            (heightMeters / 1.6) * (0.86 + scale * 0.38),
            scale,
          ),
          new Vector3(0, yaw + rotationJitter, 0).toQuaternion(),
          new Vector3(centerX + normalX * offset, ground - burialDepth, centerZ + normalZ * offset),
        ));
      });
    }
  }
  return matrices;
}

function packMatrices(matrices: readonly Matrix[]): Float32Array {
  const packed = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => matrix.copyToArray(packed, index * 16));
  return packed;
}

function createFence(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const parts: Mesh[] = [];
  const postSpacing = 2 / options.metersPerUnit;
  const railHeights = [0.42, 0.92].map((height) => height * heightMeters / 1.5 / options.metersPerUnit);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length === 0) continue;
      const yaw = Math.atan2(dx, dz);
    const steps = Math.max(1, Math.ceil(length / postSpacing));
    for (let step = 0; step <= steps; step++) {
      const amount = Math.min(1, step / steps);
      const x = start.x + dx * amount;
      const z = start.z + dz * amount;
      const ground = sampleElevation(terrain, x, z, options.meshWidth, options.meshDepth) / options.metersPerUnit;
      const post = MeshBuilder.CreateCylinder("fencePost", {
        height: heightMeters / options.metersPerUnit,
        diameter: 0.11 / options.metersPerUnit,
        tessellation: 6,
      }, scene);
      post.position.set(x, ground + heightMeters / options.metersPerUnit / 2, z);
      parts.push(post);
    }
    for (const railHeight of railHeights) {
      const amount = 0.5;
      const x = start.x + dx * amount;
      const z = start.z + dz * amount;
      const ground = sampleElevation(terrain, x, z, options.meshWidth, options.meshDepth) / options.metersPerUnit;
      const rail = MeshBuilder.CreateCylinder("fenceRail", {
        height: length + 0.04 / options.metersPerUnit,
        diameter: 0.09 / options.metersPerUnit,
        tessellation: 6,
      }, scene);
      // Cylinders are authored along local Y. Rotate that axis directly onto
      // the horizontal segment direction; Euler rotations here twist rails
      // onto the wrong diagonal for most fence headings.
      rail.rotationQuaternion = Quaternion.RotationAxis(
        new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
        Math.PI / 2,
      );
      rail.position.set(x, ground + railHeight, z);
      parts.push(rail);
    }
  }
  const mesh = Mesh.MergeMeshes(parts, true, true);
  if (!mesh) return undefined;
  mesh.setEnabled(false);
  return mesh;
}

function createChainlinkFence(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const parts: Mesh[] = [];
  const postSpacing = 2 / options.metersPerUnit;
  const meshSpacing = 0.22 / options.metersPerUnit;
  const wireDiameter = 0.018 / options.metersPerUnit;

  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length === 0) continue;
    const yaw = Math.atan2(dx, dz);
    const steps = Math.max(1, Math.ceil(length / postSpacing));
    for (let step = 0; step <= steps; step++) {
      const amount = Math.min(1, step / steps);
      const x = start.x + dx * amount;
      const z = start.z + dz * amount;
      const ground = sampleElevation(terrain, x, z, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      const post = MeshBuilder.CreateCylinder("chainlinkPost", {
        height: heightMeters / options.metersPerUnit,
        diameter: 0.055 / options.metersPerUnit,
        tessellation: 6,
      }, scene);
      post.position.set(x, ground + heightMeters / options.metersPerUnit / 2, z);
      parts.push(post);
    }

    const panelSteps = Math.max(1, Math.ceil(length / meshSpacing));
    const panelStep = length / panelSteps;
    const panelHeight = heightMeters / options.metersPerUnit;
    for (let step = 0; step < panelSteps; step++) {
      const distance = step * panelStep;
      const nextDistance = (step + 1) * panelStep;
      const base = pointAlong(start, end, distance / length);
      const next = pointAlong(start, end, nextDistance / length);
      const baseGround = sampleElevation(terrain, base.x, base.z, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      const nextGround = sampleElevation(terrain, next.x, next.z, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      for (let row = 0; row < Math.ceil(panelHeight / meshSpacing); row++) {
        const low = row * meshSpacing;
        const high = Math.min(panelHeight, low + meshSpacing);
        if (high <= low) continue;
        parts.push(createWire(scene, base.x, baseGround + low, base.z, next.x, nextGround + high, next.z, wireDiameter));
        parts.push(createWire(scene, base.x, baseGround + high, base.z, next.x, nextGround + low, next.z, wireDiameter));
      }
    }
  }
  const mesh = Mesh.MergeMeshes(parts, true, true);
  if (!mesh) return undefined;
  mesh.setEnabled(false);
  return mesh;
}

function pointAlong(start: { x: number; z: number }, end: { x: number; z: number }, amount: number) {
  return { x: start.x + (end.x - start.x) * amount, z: start.z + (end.z - start.z) * amount };
}

function createWire(
  scene: Scene,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  diameter: number,
): Mesh {
  const start = new Vector3(startX, startY, startZ);
  const end = new Vector3(endX, endY, endZ);
  const direction = end.subtract(start);
  const wire = MeshBuilder.CreateCylinder("chainlinkWire", {
    height: direction.length(),
    diameter,
    tessellation: 5,
  }, scene);
  wire.position = start.add(end).scale(0.5);
  wire.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), direction.normalize(), new Quaternion());
  return wire;
}

function createBarrierRibbon(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
  style: BarrierAppearance["style"],
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const groundClearance = style === "guardRail" ? 0.42 : 0.025;
  const visibleHeight = style === "guardRail" ? 0.34 : heightMeters;
  const bottom: Vector3[] = [];
  const top: Vector3[] = [];
  for (const point of points) {
    const ground = sampleElevation(
      terrain,
      point.x,
      point.z,
      options.meshWidth,
      options.meshDepth,
    );
    bottom.push(new Vector3(
      point.x,
      (ground + groundClearance) / options.metersPerUnit,
      point.z,
    ));
    top.push(new Vector3(
      point.x,
      (ground + groundClearance + visibleHeight) / options.metersPerUnit,
      point.z,
    ));
  }
  const mesh = MeshBuilder.CreateRibbon("barrier", { pathArray: [bottom, top] }, scene);
  mesh.setEnabled(false);
  return mesh;
}

function createBarrierMaterial(scene: Scene, style: BarrierAppearance["style"]): StandardMaterial {
  const material = new StandardMaterial(`${style}BarrierMaterial`, scene);
  material.backFaceCulling = false;
  material.specularColor = new Color3(0.03, 0.03, 0.03);
  switch (style) {
    case "hedge":
      material.diffuseColor = new Color3(0.12, 0.27, 0.075);
      break;
    case "woodFence":
      material.diffuseColor = new Color3(0.28, 0.18, 0.1);
      break;
    case "chainlink":
      material.diffuseColor = new Color3(0.36, 0.38, 0.37);
      material.specularColor = new Color3(0.2, 0.21, 0.2);
      break;
    case "guardRail":
      material.diffuseColor = new Color3(0.48, 0.5, 0.49);
      material.specularColor = new Color3(0.28, 0.29, 0.28);
      break;
    case "noiseBarrier":
      material.diffuseColor = new Color3(0.38, 0.42, 0.35);
      break;
    case "jerseyBarrier":
      material.diffuseColor = new Color3(0.49, 0.48, 0.45);
      break;
    case "lampPole":
      material.diffuseColor = new Color3(0.12, 0.14, 0.14);
      material.specularColor = new Color3(0.22, 0.24, 0.24);
      break;
    case "wall":
      material.diffuseColor = new Color3(0.37, 0.35, 0.31);
      break;
  }
  return material;
}

class SegmentExclusionMask implements HorizontalExclusionMask {
  private readonly cells = new Map<string, HorizontalSegment[]>();

  constructor(segments: readonly HorizontalSegment[], private readonly cellSize: number) {
    for (const segment of segments) {
      const minimumX = Math.floor((Math.min(segment.start.x, segment.end.x) - segment.halfWidth) / cellSize);
      const maximumX = Math.floor((Math.max(segment.start.x, segment.end.x) + segment.halfWidth) / cellSize);
      const minimumZ = Math.floor((Math.min(segment.start.z, segment.end.z) - segment.halfWidth) / cellSize);
      const maximumZ = Math.floor((Math.max(segment.start.z, segment.end.z) + segment.halfWidth) / cellSize);
      for (let z = minimumZ; z <= maximumZ; z++) {
        for (let x = minimumX; x <= maximumX; x++) {
          const key = `${x},${z}`;
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
        for (const segment of this.cells.get(`${cellX},${cellZ}`) ?? []) {
          const clearance = radius + segment.halfWidth;
          if (pointSegmentDistanceSquared(x, z, segment.start, segment.end) <= clearance * clearance) {
            return true;
          }
        }
      }
    }
    return false;
  }
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

function tileBounds(x: number, y: number, zoom: number): TileBounds {
  const scale = 2 ** zoom;
  return {
    lonWest: x / scale * 360 - 180,
    lonEast: (x + 1) / scale * 360 - 180,
    latNorth: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI,
    latSouth: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / scale))) * 180 / Math.PI,
  };
}
