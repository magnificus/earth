import {
  BaseTexture,
  Color3,
  Material,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  PBRMaterial,
  PolygonMeshBuilder,
  Scene,
  StandardMaterial,
  SubMesh,
  TransformNode,
  Vector2,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import earcut from "earcut";
import { lonLatToScene, sampleElevation, SEA_LEVEL_METERS } from "../Geo";
import { clamp01 } from "../MathUtils";
import type { BuildingPlan, BuildingPolygon, LonLat } from "../BuildingPlanner";
import { planBuildingLayout, type BuildingLayout } from "../BuildingLayoutPlanner";
import { planApartmentLayout, type ApartmentLayout } from "../ApartmentLayoutPlanner";
import { segmentsIntersect, type Opening2D, type Point2D, type PolygonLayout } from "../FloorPlan";
import {
  captureEncounteredBuildingLayout,
  retainCurrentBuildingLayoutCaptures,
} from "../BuildingLayoutDebugCapture";
import { buildingWindowStyle, type BuildingWindowStyle } from "../BuildingWindowStyle";
import { buildingProfile } from "../BuildingProfile";
import { SimplexNoise2D } from "../SimplexNoise";
import type { TerrainData } from "../TerrainData";
import type {
  BuildingAppearance,
  BuildingRenderOptions,
  BuildingShadowRange,
  Bounds,
  DetailedBuildingParts,
  EntranceClearance,
  InteriorPlanningAttempt,
  LoadedBuildingInterior,
  PendingBuildingInterior,
  PlannedInterior,
  PreparedBuildingFootprint,
  ScenePoint,
  StairLayout,
  WindowGeometry,
} from "./BuildingRendererTypes";
import {
  BUILDING_DOOR_HEIGHT_METERS,
  BUILDING_DOOR_WIDTH_METERS,
  BUILDING_FLOOR_THICKNESS_METERS,
  BUILDING_GROUND_OVERLAP_METERS,
  BUILDING_INTERIOR_CHECK_INTERVAL_MS,
  BUILDING_INTERIOR_LOAD_DISTANCE_METERS,
  BUILDING_INTERIOR_UNLOAD_DISTANCE_METERS,
  BUILDING_INTERIORS_PER_CHECK,
  BUILDING_REFLECTIVE_MARKER_ALPHA,
  BUILDING_ROOF_EAVE_CLEARANCE_METERS,
  BUILDING_ROOF_OVERHANG_METERS,
  BUILDING_ROOF_TRIM_METERS,
  BUILDING_GUTTER_DROP_METERS,
  BUILDING_GUTTER_RADIUS_METERS,
  BUILDING_STAIR_MAX_RUN_METERS,
  BUILDING_STAIR_MIN_RUN_METERS,
  BUILDING_STAIR_WALL_CLEARANCE_METERS,
  BUILDING_STAIR_WIDTH_METERS,
  BUILDING_WALL_THICKNESS_METERS,
  BUILDING_WINDOW_CLOSE_ALPHA,
  BUILDING_WINDOW_EDGE_CLEARANCE_METERS,
  BUILDING_WINDOW_HEAD_CLEARANCE_METERS,
  BUILDING_WINDOW_CLEAR_DISTANCE_METERS,
  BUILDING_WINDOW_OPAQUE_DISTANCE_METERS,
} from "./BuildingRendererConstants";

export type { BuildingRenderOptions } from "./BuildingRendererTypes";

// One broad, world-geographic field makes nearby homes share dormer regions.
const DORMER_REGION_NOISE = new SimplexNoise2D(0x5d0e3f);
const RESIDENTIAL_ROOF_NEIGHBORHOOD_METERS = 180;
const RESIDENTIAL_PITCHED_ROOF_SHARE = 0.68;

/** Compiles semantic building plans into deterministic Babylon geometry. */
export class ProceduralBuildingRenderer {
  static createDetailed(
    scene: Scene,
    plan: BuildingPlan,
    terrain: TerrainData,
    options: BuildingRenderOptions,
  ): Mesh | undefined {
    const prepared = prepareBuildingFootprint(plan.footprint, terrain, options);
    if (!prepared) return undefined;

    const appearance = buildingAppearance(plan);
    // Courtyard footprints cannot use the enterable shell: that path builds
    // floors and roofs from the outer ring alone. Keep these buildings as one
    // faithful mass so a real building inside a courtyard does not appear to
    // sit on top of a second, incorrectly filled building.
    if (prepared.holes.length > 0) {
      captureUnplannedBuilding(plan, prepared, options, "Courtyard footprints use the massing renderer.");
      return createCourtyardBuilding(scene, plan, prepared, options, appearance);
    }
    const areaSquareMeters = Math.abs(signedArea(prepared.outline)) * options.metersPerUnit ** 2;
    const towerBlend = highRiseBlend(plan.heightMeters);
    if (seededUnit(plan.detailSeed ^ 0x4d3a91) < towerBlend) {
      captureUnplannedBuilding(plan, prepared, options, "High-rise buildings use the tower renderer.");
      return createHighRiseBuilding(scene, plan, prepared, options, appearance, towerBlend);
    }
    const roofShape = resolvedRoofShape(plan, prepared.outline, areaSquareMeters, options);
    const roofHeightMeters = roofShape === "flat"
      ? 0
      : plan.roofHeightMeters === undefined
        ? inferredRoofHeight(prepared.outline, areaSquareMeters, options, plan.detailSeed)
        : Math.min(
          plan.roofHeightMeters,
          Math.max(0, plan.heightMeters - Math.max(3, plan.minimumHeightMeters)),
        );
    // Provider heights rarely include usable roof metadata. Only subtract a
    // mapped roof height; inferred construction sits above the mapped massing.
    const wallTopElevation = prepared.baseElevation + plan.heightMeters -
      (plan.roofHeightMeters === undefined ? 0 : roofHeightMeters);
    const sharedFacadeEdges = findSharedFacadeEdges(
      plan.footprint, prepared.outline, terrain, options,
    );
    // Keep the roof seated on the wall cap. The trim is already thick enough
    // to provide the small eave clearance; lifting the roof independently
    // leaves a visible gap along the long facades and mismatches gable ends.
    const roofEaveElevation = wallTopElevation + Math.max(
      0,
      BUILDING_ROOF_EAVE_CLEARANCE_METERS - BUILDING_ROOF_TRIM_METERS,
    );
    const detailed = createEnterableBuilding(
      scene,
      plan,
      prepared.outline,
      prepared.baseElevation,
      wallTopElevation,
      options,
      appearance,
      "exterior",
      sharedFacadeEdges,
    );
    const parts = detailed.parts;
    const showRoofs = options.showRoofs !== false;
    if (showRoofs && roofShape === "gabled") {
      const gable = createGableEndWalls(
        scene,
        prepared.outline,
        wallTopElevation,
        wallTopElevation + roofHeightMeters,
        options,
        appearance.wall,
      );
      if (gable) parts.push(gable);
    }
    const trim = showRoofs && createRoofTrim(
      scene,
      prepared.outline,
      wallTopElevation,
      options,
      appearance.trim,
      plan.detailSeed,
    );
    if (trim) parts.push(trim);

    if (showRoofs && roofHeightMeters > 0) {
      const roof = createPitchedRoof(
        scene,
        prepared.outline,
        roofEaveElevation,
        roofEaveElevation + roofHeightMeters,
        roofShape,
        options,
        appearance.roof,
        plan.detailSeed,
      );
      if (roof) parts.push(roof);
      const gutters = createRoofGutters(
        scene,
        prepared.outline,
        roofEaveElevation,
        roofShape,
        options,
        appearance.trim,
        plan.detailSeed,
      );
      if (gutters) parts.push(gutters);
      if (plan.buildingClass === "residential" && roofShape === "gabled") {
        const dormers = createResidentialDormers(
          scene,
          plan,
          prepared.outline,
          roofEaveElevation,
          roofHeightMeters,
          options,
          appearance,
        );
        if (dormers) parts.push(dormers);
      }
    } else if (showRoofs) {
      const rooftop = createRooftopVolume(
        scene,
        plan,
        prepared.outline,
        wallTopElevation,
        areaSquareMeters,
        options,
        appearance,
      );
      if (rooftop) parts.push(rooftop);
    }
    if (showRoofs && plan.buildingClass === "residential" && roofHeightMeters > 0) {
      const chimney = createResidentialChimney(
        scene,
        prepared.outline,
        roofEaveElevation + roofHeightMeters,
        options,
        appearance,
        plan.detailSeed,
      );
      if (chimney) parts.push(chimney);
    }

    normalizeBuildingMergeAttributes(parts);
    const merged = Mesh.MergeMeshes(parts, false, true);
    if (!merged) {
      for (const part of parts) part.dispose(false, true);
      return undefined;
    }
    for (const part of parts) part.dispose(false, true);
    const interiorCenter = averagePoint(prepared.outline);
    const interiorRadiusMeters = Math.max(...prepared.outline.map((point) =>
      Math.hypot(point.x - interiorCenter.x, point.z - interiorCenter.z) * options.metersPerUnit,
    ));
    merged.metadata = {
      buildingId: plan.id,
      buildingClass: plan.buildingClass,
      enterable: true,
      windowCount: detailed.windowCount,
      windowStyleId: detailed.windowStyleId,
      windowRegion: detailed.windowRegion,
      plannedInterior: detailed.plannedInterior,
      interiorFloorCount: detailed.floorCount,
      stairFlightCount: detailed.stairFlightCount,
      entranceEdgeIndex: detailed.entranceEdgeIndex,
      stairEdgeIndex: detailed.stairEdgeIndex,
      stairEdgeIndices: detailed.stairEdgeIndices,
      stairFlightCenters: detailed.stairFlightCenters,
      metersPerUnit: options.metersPerUnit,
      skyReflection: options.skyReflection,
      interiorsLoaded: false,
      pendingInterior: {
        // Use the footprint radius when deciding proximity. A camera can be
        // inside a large building while still being far from its centroid.
        center: new Vector3(
          interiorCenter.x,
          (prepared.baseElevation + wallTopElevation) / (2 * options.metersPerUnit),
          interiorCenter.z,
        ),
        radiusMeters: interiorRadiusMeters,
        load: () => createInteriorMesh(
          scene,
          plan,
          prepared.outline,
          prepared.baseElevation,
          wallTopElevation,
          options,
          appearance,
        ),
      } satisfies PendingBuildingInterior,
    };
    return stageBuildingMesh(merged);
  }

  /** Keeps the distant compiler to colored massing without roof detail. */
  static createFar(
    scene: Scene,
    plan: BuildingPlan,
    terrain: TerrainData,
    options: BuildingRenderOptions,
  ): Mesh | undefined {
    const prepared = prepareBuildingFootprint(plan.footprint, terrain, options);
    if (!prepared) return undefined;
    const bottomElevation = plan.minimumHeightMeters > 0
      ? prepared.baseElevation + plan.minimumHeightMeters
      : terrain.minElevation - BUILDING_GROUND_OVERLAP_METERS;
    const mesh = createBuildingPrism(
      scene,
      prepared.outline,
      prepared.baseElevation + plan.heightMeters,
      bottomElevation,
      options,
      prepared.holes,
    );
    colorBuildingMass(mesh, buildingAppearance(plan));
    return mesh;
  }

  static merge(meshes: Mesh[], name: string, parent: TransformNode): Mesh | undefined {
    if (meshes.length === 0) return undefined;
    const buildingIds = meshes
      .map((mesh) => mesh.metadata?.buildingId)
      .filter((id): id is string => typeof id === "string");
    const metersPerUnit = Number(meshes[0].metadata?.metersPerUnit);
    const skyReflection = meshes.find((mesh) => mesh.metadata?.skyReflection)?.metadata
      ?.skyReflection as BaseTexture | null | undefined;
    const pendingInteriors = meshes
      .map((mesh) => mesh.metadata?.pendingInterior as PendingBuildingInterior | undefined)
      .filter((pending): pending is PendingBuildingInterior => pending !== undefined);
    const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
    if (!result) return undefined;
    const material = new StandardMaterial(`${name}Material`, result.getScene());
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.025, 0.025, 0.025);
    material.specularPower = 16;
    material.backFaceCulling = false;
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    result.useVertexColors = true;
    result.hasVertexAlpha = true;
    result.name = name;
    result.material = material;
    result.parent = parent;
    result.checkCollisions = name === "buildings" || name === "detailedBuildings";
    retainCurrentBuildingLayoutCaptures(buildingIds, result);
    if (Number.isFinite(metersPerUnit)) {
      const shadowRanges = configureBuildingSurfaceMaterials(
        result,
        metersPerUnit,
        material,
        skyReflection,
      );
      if (name === "buildings" || name === "detailedBuildings") {
        createBuildingShadowCaster(result, parent, shadowRanges);
      }
      configureLazyInteriors(result, parent, pendingInteriors, metersPerUnit);
    }
    return result;
  }
}

function captureUnplannedBuilding(
  plan: BuildingPlan,
  prepared: PreparedBuildingFootprint,
  options: BuildingRenderOptions,
  fallbackReason: string,
): void {
  const project = (point: ScenePoint): Point2D => ({
    x: point.x * options.metersPerUnit,
    y: point.z * options.metersPerUnit,
  });
  captureEncounteredBuildingLayout({
    id: plan.id,
    buildingClass: plan.buildingClass,
    heightMeters: plan.heightMeters,
    levels: plan.levels,
    geographicFootprint: plan.footprint,
    plannerInput: {
      buildingType: "house",
      buildingPolygon: {
        outer: prepared.outline.map(project),
        holes: prepared.holes.map((hole) => hole.map(project)),
      },
      openings: [],
    },
    facadeOpenings: [],
    fallbackReason,
  });
}

function createCourtyardBuilding(
  scene: Scene,
  plan: BuildingPlan,
  prepared: PreparedBuildingFootprint,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
): Mesh {
  const bottomElevation = plan.minimumHeightMeters > 0
    ? prepared.baseElevation + plan.minimumHeightMeters
    : prepared.baseElevation - BUILDING_GROUND_OVERLAP_METERS;
  const mesh = createBuildingPrism(
    scene,
    prepared.outline,
    prepared.baseElevation + plan.heightMeters,
    bottomElevation,
    options,
    prepared.holes,
  );
  colorBuildingMass(mesh, appearance);
  mesh.metadata = {
    buildingId: plan.id,
    enterable: false,
    complexFootprint: true,
    courtyardCount: prepared.holes.length,
    metersPerUnit: options.metersPerUnit,
    skyReflection: options.skyReflection,
  };
  return mesh;
}

function highRiseBlend(heightMeters: number): number {
  const height01 = clamp01((heightMeters - 22) / 58);
  return height01 * height01 * (3 - 2 * height01);
}

function createHighRiseBuilding(
  scene: Scene,
  plan: BuildingPlan,
  prepared: PreparedBuildingFootprint,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
  towerBlend: number,
): Mesh {
  const bottomElevation = plan.minimumHeightMeters > 0
    ? prepared.baseElevation + plan.minimumHeightMeters
    : prepared.baseElevation - BUILDING_GROUND_OVERLAP_METERS;
  const mesh = createBuildingPrism(
    scene,
    prepared.outline,
    prepared.baseElevation + plan.heightMeters,
    bottomElevation,
    options,
  );
  const glass = mixColor(
    appearance.wall,
    new Color3(0.32, 0.48, 0.56),
    0.48 + towerBlend * 0.32,
  );
  colorReflectiveBuildingMass(mesh, glass, appearance.roof);
  mesh.metadata = {
    buildingId: plan.id,
    enterable: false,
    highRise: true,
    highRiseBlend: towerBlend,
    metersPerUnit: options.metersPerUnit,
    skyReflection: options.skyReflection,
  };
  return mesh;
}

function createInteriorMesh(
  scene: Scene,
  plan: BuildingPlan,
  outline: ScenePoint[],
  baseElevation: number,
  topElevation: number,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
): Mesh | undefined {
  const interior = createEnterableBuilding(
    scene,
    plan,
    outline,
    baseElevation,
    topElevation,
    options,
    appearance,
    "interior",
  );
  const merged = Mesh.MergeMeshes(interior.parts, false, true);
  if (!merged) {
    for (const part of interior.parts) part.dispose(false, true);
    return undefined;
  }
  for (const part of interior.parts) part.dispose(false, true);
  merged.metadata = { metersPerUnit: options.metersPerUnit };
  return stageBuildingMesh(merged);
}

/**
 * Builds a hollow near-field shell. Facades are assembled around real window
 * and doorway apertures, while floor slabs make the volume read as an interior
 * from both the entrance and the windows.
 */
function createEnterableBuilding(
  scene: Scene,
  plan: BuildingPlan,
  outline: ScenePoint[],
  baseElevation: number,
  topElevation: number,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
  part: "exterior" | "interior",
  blockedFacadeEdges: ReadonlySet<number> = new Set(),
): DetailedBuildingParts {
  const usableHeight = Math.max(0, topElevation - baseElevation);
  const profile = buildingProfile(plan.buildingClass);
  // A partial story is not another floor. Rounding made ordinary 4.7-6.1 m
  // houses grow a second facade row when no level count was mapped.
  const requestedFloors = plan.levels ?? Math.floor(usableHeight / 3.1);
  const floorsThatFit = Math.max(1, Math.floor(usableHeight / 2.4));
  const floorCount = Math.max(1, Math.min(
    profile.maximumInteriorFloors,
    Math.round(requestedFloors),
    floorsThatFit,
  ));
  const storyHeight = usableHeight / floorCount;
  const windowStyle = buildingWindowStyle(plan);
  const glass = varyColor(
    new Color3(...windowStyle.glass),
    seededUnit(plan.detailSeed ^ 0x45f3a921) * 0.1,
    0,
  );
  const entranceEdge = longestPolygonEdge(outline, blockedFacadeEdges);
  const entranceEdgeLengthMeters = pointDistance(
    outline[entranceEdge],
    outline[(entranceEdge + 1) % outline.length],
  ) * options.metersPerUnit;
  const entranceBayCount = facadeBayCount(
    entranceEdgeLengthMeters,
    windowStyle,
  );
  const entranceBayWidth = entranceEdgeLengthMeters / entranceBayCount;
  const entranceClearance: EntranceClearance = {
    edgeIndex: entranceEdge,
    centerMeters: (Math.floor(entranceBayCount / 2) + 0.5) * entranceBayWidth,
    widthMeters: Math.min(BUILDING_DOOR_WIDTH_METERS, entranceBayWidth * 0.64),
  };
  // The doorway is the only façade opening the building planner needs.  Once
  // its shells exist, choose windows from the apartment-facing exterior walls;
  // this keeps circulation and stair walls opaque by construction.
  const entranceOpenings = plannedEntranceOpenings(
    outline, entranceEdge, windowStyle, options,
  );
  const planningAttempt = profile.interiorLayout === "rooms"
    ? createPlannedInterior(outline, entranceOpenings, options)
    : undefined;
  const plannedInterior = planningAttempt?.interior;
  const facadeOpenings = plannedFacadeOpenings(
    plan, outline, storyHeight, entranceEdge, windowStyle, options,
    plannedInterior?.building,
    blockedFacadeEdges,
  );
  if (plannedInterior) {
    const apartmentPlanning = planApartmentLayouts(
      plannedInterior.building,
      facadeOpenings,
      plan.detailSeed,
    );
    plannedInterior.apartments = apartmentPlanning.apartments;
    if (apartmentPlanning.failure) planningAttempt.failure = apartmentPlanning.failure;
  }
  if (part === "exterior" && planningAttempt) {
    captureEncounteredBuildingLayout({
      id: plan.id,
      buildingClass: plan.buildingClass,
      heightMeters: plan.heightMeters,
      levels: plan.levels,
      geographicFootprint: plan.footprint,
      plannerInput: planningAttempt.input,
      facadeOpenings,
      buildingLayout: plannedInterior?.building,
      apartmentLayouts: plannedInterior?.apartments,
      fallbackReason: planningAttempt.failure,
    });
  } else if (part === "exterior") {
    captureEncounteredBuildingLayout({
      id: plan.id,
      buildingClass: plan.buildingClass,
      heightMeters: plan.heightMeters,
      levels: plan.levels,
      geographicFootprint: plan.footprint,
      plannerInput: plannerInputFromOutline(outline, facadeOpenings, options),
      facadeOpenings,
      fallbackReason: `The ${plan.buildingClass} profile uses an open interior.`,
    });
  }
  const plannedStairs = plannedInterior
    ? stairLayoutsFromPlan(plannedInterior.building, options, floorCount - 1, plan.detailSeed)
    : [];
  const stairs = profile.hasStairs && floorCount > 1
    ? plannedStairs.length > 0
      ? plannedStairs
      : findStairLayouts(outline, options, entranceClearance, floorCount - 1, plan.detailSeed)
    : [];
  const parts: Mesh[] = [];
  const windows: WindowGeometry = { positions: [], indices: [], normals: [], colors: [] };
  let windowCount = 0;

  if (part === "interior") {
    const floorColor = mixColor(appearance.wall, new Color3(0.34, 0.31, 0.27), 0.48);
    for (let floor = 0; floor < floorCount; floor++) {
      const slabBottom = baseElevation + floor * storyHeight;
      const slab = createBuildingPrism(
        scene,
        outline,
        slabBottom + BUILDING_FLOOR_THICKNESS_METERS,
        slabBottom,
        options,
        floor > 0 && stairs[floor - 1]
          ? [stairOpening(stairs[floor - 1], options)]
          : undefined,
      );
      setSolidVertexColor(slab, floorColor);
      parts.push(slab);
    }

    if (stairs.length > 0) {
      for (let floor = 0; floor < stairs.length; floor++) {
        createStairFlight(
          parts,
          scene,
          stairs[floor],
          baseElevation + floor * storyHeight,
          storyHeight,
          floor % 2 === 1,
          options,
          floorColor,
        );
      }
    }

    if (plannedInterior) {
      const wallColor = mixColor(appearance.wall, new Color3(0.82, 0.79, 0.72), 0.18);
      for (let floor = 0; floor < floorCount; floor++) {
        addPlannedInteriorWalls(
          parts,
          scene,
          plannedInterior,
          baseElevation + floor * storyHeight + BUILDING_FLOOR_THICKNESS_METERS,
          storyHeight - BUILDING_FLOOR_THICKNESS_METERS,
          options,
          wallColor,
        );
      }
    }
  }

  // Facade bays are intentionally split around openings, but the outside
  // corners belong to the footprint rather than to either adjacent wall.
  // Build those corners once per story from the shared outline vertices so
  // the two wall runs meet with one continuous mitered outer edge.
  if (part === "exterior") {
    for (let floor = 0; floor < floorCount; floor++) {
      addFacadeCorners(
        parts,
        scene,
        outline,
        baseElevation + floor * storyHeight,
        storyHeight,
        options,
        appearance.wall,
      );
    }
  }

  for (let edgeIndex = 0; part === "exterior" && edgeIndex < outline.length; edgeIndex++) {
    const start = outline[edgeIndex];
    const end = outline[(edgeIndex + 1) % outline.length];
    const edgeLengthMeters = pointDistance(start, end) * options.metersPerUnit;
    if (edgeLengthMeters < 0.35) continue;
    const bayCount = facadeBayCount(edgeLengthMeters, windowStyle);
    const bayWidth = edgeLengthMeters / bayCount;

    if (blockedFacadeEdges.has(edgeIndex)) {
      for (let floor = 0; floor < floorCount; floor++) {
        addFacadePanel(parts, scene, start, end, edgeLengthMeters, 0,
          edgeLengthMeters, baseElevation + floor * storyHeight, storyHeight,
          options, appearance.wall);
      }
      continue;
    }

    for (let floor = 0; floor < floorCount; floor++) {
      const storyBottom = baseElevation + floor * storyHeight;
      for (let bay = 0; bay < bayCount; bay++) {
        const isEntrance = floor === 0 && edgeIndex === entranceEdge &&
          bay === Math.floor(bayCount / 2);
        const bayStart = bay * bayWidth;
        if (isEntrance) {
          const doorWidth = Math.min(BUILDING_DOOR_WIDTH_METERS, bayWidth * 0.64);
          const doorHeight = Math.min(BUILDING_DOOR_HEIGHT_METERS, storyHeight - 0.28);
          if (doorHeight > 0.35) {
            addApertureFacade(parts, scene, start, end, edgeLengthMeters, bayStart, bayWidth,
              storyBottom, storyHeight, doorWidth, doorHeight, 0, options, appearance.wall);
          } else {
            addFacadePanel(parts, scene, start, end, edgeLengthMeters, bayStart,
              bayWidth, storyBottom, storyHeight, options, appearance.wall);
          }
          continue;
        }
        const windowSeed = plan.detailSeed ^ (edgeIndex * 0x1f123bb5) ^
          (floor * 0x45d9f3b) ^ (bay * 0x119de1f3);
        const blankBay = bayCount > 2 && !isEntrance &&
          seededUnit(windowSeed ^ 0x68bc21eb) < windowStyle.blankBayChance;
        if (blankBay) {
          addFacadePanel(parts, scene, start, end, edgeLengthMeters, bayStart,
            bayWidth, storyBottom, storyHeight, options, appearance.wall);
          continue;
        }
        const apertureWidth = windowStyle.widthMeters;
        const apertureHeight = windowStyle.heightMeters;
        const sillHeight = windowStyle.sillMeters;
        const windowFits = bayWidth >= apertureWidth + BUILDING_WINDOW_EDGE_CLEARANCE_METERS * 2 &&
          storyHeight >= sillHeight + apertureHeight + BUILDING_WINDOW_HEAD_CLEARANCE_METERS;
        const plannedOpening = facadeOpenings.find((opening) =>
          opening.id === `window-${edgeIndex}-${bay}`
        );
        if (windowFits && (!plannedInterior || !plannedOpening ||
            !plannedInteriorBlocksOpening(plannedInterior, plannedOpening))) {
          const apertureOffset = (bayWidth - apertureWidth) / 2;
          addApertureFacade(parts, scene, start, end, edgeLengthMeters, bayStart, bayWidth,
            storyBottom, storyHeight, apertureWidth, apertureHeight, sillHeight,
            options, appearance.wall, apertureOffset);
          addWindowQuad(windows, start, end, edgeLengthMeters,
            bayStart + apertureOffset, apertureWidth,
            storyBottom + sillHeight, apertureHeight, options, glass,
            BUILDING_WINDOW_CLOSE_ALPHA, -windowStyle.recessMeters);
          addWindowMullions(
            windows, start, end, edgeLengthMeters, bayStart + apertureOffset,
            storyBottom + sillHeight, windowStyle, options, appearance.trim,
          );
          windowCount++;
        } else {
          addFacadePanel(parts, scene, start, end, edgeLengthMeters, bayStart,
            bayWidth, storyBottom, storyHeight, options, appearance.wall);
        }
      }
    }
  }

  const windowMesh = createWindowMesh(scene, windows);
  if (windowMesh) parts.push(windowMesh);

  return {
    parts,
    windowCount,
    floorCount,
    stairFlightCount: stairs.length,
    entranceEdgeIndex: entranceEdge,
    stairEdgeIndex: stairs[0]?.edgeIndex,
    stairEdgeIndices: stairs.map((stair) => stair.edgeIndex),
    stairFlightCenters: stairs.map(stairCenter),
    windowStyleId: windowStyle.id,
    windowRegion: windowStyle.region,
    plannedInterior: plannedInterior !== undefined,
  };
}

function facadeBayCount(edgeLengthMeters: number, style: BuildingWindowStyle): number {
  return Math.max(1, Math.min(16, Math.round(edgeLengthMeters / style.baySpacingMeters)));
}

function plannedFacadeOpenings(
  plan: BuildingPlan,
  outline: readonly ScenePoint[],
  storyHeight: number,
  entranceEdge: number,
  windowStyle: BuildingWindowStyle,
  options: BuildingRenderOptions,
  buildingLayout?: BuildingLayout,
  blockedFacadeEdges: ReadonlySet<number> = new Set(),
): Opening2D[] {
  const openings: Opening2D[] = [];
  for (let edgeIndex = 0; edgeIndex < outline.length; edgeIndex++) {
    const start = outline[edgeIndex];
    const end = outline[(edgeIndex + 1) % outline.length];
    const edgeLengthMeters = pointDistance(start, end) * options.metersPerUnit;
    if (edgeLengthMeters < 0.35) continue;
    if (blockedFacadeEdges.has(edgeIndex)) continue;
    const bayCount = facadeBayCount(edgeLengthMeters, windowStyle);
    const bayWidth = edgeLengthMeters / bayCount;
    for (let bay = 0; bay < bayCount; bay++) {
      const isEntrance = edgeIndex === entranceEdge && bay === Math.floor(bayCount / 2);
      if (isEntrance) {
        const width = Math.min(BUILDING_DOOR_WIDTH_METERS, bayWidth * 0.64);
        openings.push(openingAlongSceneEdge(
          "building-entrance", "door", start, end,
          bay * bayWidth + (bayWidth - width) / 2, width, options,
        ));
        continue;
      }
      const windowSeed = plan.detailSeed ^ (edgeIndex * 0x1f123bb5) ^
        (bay * 0x119de1f3);
      const blankBay = bayCount > 2 &&
        seededUnit(windowSeed ^ 0x68bc21eb) < windowStyle.blankBayChance;
      const windowFits = bayWidth >= windowStyle.widthMeters +
          BUILDING_WINDOW_EDGE_CLEARANCE_METERS * 2 &&
        storyHeight >= windowStyle.sillMeters + windowStyle.heightMeters +
          BUILDING_WINDOW_HEAD_CLEARANCE_METERS;
      if (!blankBay && windowFits) {
        const window = openingAlongSceneEdge(
          `window-${edgeIndex}-${bay}`, "window", start, end,
          bay * bayWidth + (bayWidth - windowStyle.widthMeters) / 2,
          windowStyle.widthMeters, options,
        );
        if (!buildingLayout || facadeOpeningServesApartment(window, buildingLayout)) {
          openings.push(window);
        }
      }
    }
  }
  return openings;
}

function plannedEntranceOpenings(
  outline: readonly ScenePoint[],
  entranceEdge: number,
  windowStyle: BuildingWindowStyle,
  options: BuildingRenderOptions,
): Opening2D[] {
  const start = outline[entranceEdge];
  const end = outline[(entranceEdge + 1) % outline.length];
  const edgeLengthMeters = pointDistance(start, end) * options.metersPerUnit;
  const bayCount = facadeBayCount(edgeLengthMeters, windowStyle);
  const bayWidth = edgeLengthMeters / bayCount;
  const bay = Math.floor(bayCount / 2);
  const width = Math.min(BUILDING_DOOR_WIDTH_METERS, bayWidth * 0.64);
  return [openingAlongSceneEdge(
    "building-entrance", "door", start, end,
    bay * bayWidth + (bayWidth - width) / 2, width, options,
  )];
}

function openingAlongSceneEdge(
  id: string,
  type: "door" | "window",
  start: ScenePoint,
  end: ScenePoint,
  offsetMeters: number,
  widthMeters: number,
  options: BuildingRenderOptions,
): Opening2D {
  const direction = unitDirection(start, end);
  const point = (offset: number): Point2D => ({
    x: start.x * options.metersPerUnit + direction.x * offset,
    y: start.z * options.metersPerUnit + direction.z * offset,
  });
  return { id, type, start: point(offsetMeters), end: point(offsetMeters + widthMeters) };
}

function createPlannedInterior(
  outline: readonly ScenePoint[],
  facadeOpenings: readonly Opening2D[],
  options: BuildingRenderOptions,
): InteriorPlanningAttempt {
  const input = plannerInputFromOutline(outline, facadeOpenings, options);
  try {
    const building = planBuildingLayout(input);
    return {
      input,
      interior: { building, apartments: [] },
    };
  } catch (error) {
    // Courtyards and malformed or unusually narrow footprints retain the
    // proven open interior until their topology receives a dedicated planner.
    return { input, failure: errorMessage(error) };
  }
}

function planApartmentLayouts(
  building: BuildingLayout,
  facadeOpenings: readonly Opening2D[],
  buildingSeed: number,
): { apartments: ApartmentLayout[]; failure?: string } {
  const failures: string[] = [];
  const apartments = building.rooms
    .filter((room) => room.type === "apartment")
    .flatMap((room, apartmentIndex) => {
      try {
        return [planApartmentLayout({
          apartmentPolygon: room.polygon,
          minimumRoomAreaSquareMeters: apartmentRoomAreaTarget(
            buildingSeed,
            apartmentIndex,
          ),
          openings: [...(building.openings ?? []), ...facadeOpenings]
            .filter((opening) => openingTouchesBoundary(opening, room.polygon.outer)),
        })];
      } catch (error) {
        failures.push(`${room.id}: ${errorMessage(error)}`);
        return [];
      }
    });
  return {
    apartments,
    failure: failures.length > 0
      ? `Apartment planning failed for ${failures.join("; ")}`
      : undefined,
  };
}

function apartmentRoomAreaTarget(buildingSeed: number, apartmentIndex: number): number {
  // Keep the 12-30 m² variation bounded and deterministic: room proportions change by
  // building and apartment, but a rebuild never produces a different layout.
  const variation = seededUnit(buildingSeed ^ (apartmentIndex * 0x1f123bb5) ^ 0x3c6ef372);
  return 12 + variation * 18;
}

function plannerInputFromOutline(
  outline: readonly ScenePoint[],
  facadeOpenings: readonly Opening2D[],
  options: BuildingRenderOptions,
): Parameters<typeof planBuildingLayout>[0] {
  return {
    buildingPolygon: {
      outer: outline.map((point) => ({
        x: point.x * options.metersPerUnit,
        y: point.z * options.metersPerUnit,
      })),
    },
    buildingType: "house",
    openings: facadeOpenings.filter((opening) => opening.type === "door"),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plannedInteriorBlocksOpening(
  interior: PlannedInterior,
  opening: Opening2D,
): boolean {
  const stair = interior.building.rooms.find((room) => room.type === "stairs");
  if (stair && openingTouchesBoundary(opening, stair.polygon.outer)) return true;
  const layouts: readonly PolygonLayout[] = [interior.building, ...interior.apartments];
  return layouts.some((layout) => layout.rooms.some((room) => {
    const polygon = room.polygon.outer;
    return polygon.some((start, index) => {
      const end = polygon[(index + 1) % polygon.length];
      if (segmentOnPolygonBoundary(start, end, layout.boundary.outer)) return false;
      return segmentsIntersect(start, end, opening.start, opening.end);
    });
  }));
}

function openingTouchesBoundary(opening: Opening2D, polygon: readonly Point2D[]): boolean {
  const center = {
    x: (opening.start.x + opening.end.x) / 2,
    y: (opening.start.y + opening.end.y) / 2,
  };
  return polygon.some((start, index) =>
    pointOnSegment2D(center, start, polygon[(index + 1) % polygon.length])
  );
}

function facadeOpeningServesApartment(opening: Opening2D, layout: BuildingLayout): boolean {
  return layout.rooms.some((room) => room.type === "apartment" &&
    openingTouchesBoundary(opening, room.polygon.outer));
}

function pointOnSegment2D(point: Point2D, start: Point2D, end: Point2D): boolean {
  const cross = (end.x - start.x) * (point.y - start.y) -
    (end.y - start.y) * (point.x - start.x);
  if (Math.abs(cross) > 1e-5) return false;
  return point.x >= Math.min(start.x, end.x) - 1e-5 &&
    point.x <= Math.max(start.x, end.x) + 1e-5 &&
    point.y >= Math.min(start.y, end.y) - 1e-5 &&
    point.y <= Math.max(start.y, end.y) + 1e-5;
}

export function stairLayoutFromPlan(
  layout: BuildingLayout,
  options: BuildingRenderOptions,
): StairLayout | undefined {
  return stairLayoutCandidatesFromPlan(layout, options)[0];
}

function stairLayoutsFromPlan(
  layout: BuildingLayout,
  options: BuildingRenderOptions,
  flightCount: number,
  detailSeed: number,
): StairLayout[] {
  const candidates = stairLayoutCandidatesFromPlan(layout, options);
  const layouts: StairLayout[] = [];
  for (let flight = 0; flight < flightCount; flight++) {
    const available = candidates.filter((candidate) =>
      layouts.every((placed) => !stairLayoutsOverlap(candidate, placed, options)));
    if (available.length === 0) break;
    const choiceIndex = Math.floor(
      seededUnit(detailSeed ^ (flight * 0x1b873593) ^ 0x6d2b79f5) * available.length,
    );
    layouts.push(available[Math.min(choiceIndex, available.length - 1)]);
  }
  return layouts;
}

function stairLayoutCandidatesFromPlan(
  layout: BuildingLayout,
  options: BuildingRenderOptions,
): StairLayout[] {
  const stair = layout.rooms.find((room) => room.type === "stairs");
  if (!stair) return [];
  const points = stair.polygon.outer;
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  const candidates: { edge: readonly [Point2D, Point2D]; start: number; run: number; width: number }[] = [];
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const edgeLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (edgeLength < BUILDING_STAIR_MIN_RUN_METERS + 0.4) continue;
    const direction = { x: (end.x - start.x) / edgeLength, y: (end.y - start.y) / edgeLength };
    let inward = { x: -direction.y, y: direction.x };
    if ((center.x - (start.x + end.x) / 2) * inward.x +
        (center.y - (start.y + end.y) / 2) * inward.y < 0) {
      inward = { x: -inward.x, y: -inward.y };
    }
    const maxRun = Math.min(BUILDING_STAIR_MAX_RUN_METERS, edgeLength - 0.4);
    for (let run = maxRun; run >= BUILDING_STAIR_MIN_RUN_METERS; run -= 0.1) {
      const alongStarts = [0.2, (edgeLength - run) / 2, edgeLength - run - 0.2]
        .filter((along) => along >= 0.2 && along + run <= edgeLength - 0.2);
      for (let width = BUILDING_STAIR_WIDTH_METERS; width >= 0.75; width -= 0.05) {
        for (const alongStart of alongStarts) {
          const acrossStart = BUILDING_STAIR_WALL_CLEARANCE_METERS;
          const corners = [
            [alongStart, acrossStart], [alongStart + run, acrossStart],
            [alongStart + run, acrossStart + width], [alongStart, acrossStart + width],
          ].map(([along, across]) => ({
            x: start.x + direction.x * along + inward.x * across,
            y: start.y + direction.y * along + inward.y * across,
          }));
          if (!corners.every((point) => pointInPolygonInclusive(point, points))) continue;
          candidates.push({ edge: [start, end] as const, start: alongStart, run, width });
        }
      }
    }
  }
  candidates.sort((first, second) => second.run * second.width - first.run * first.width);
  return candidates.map((candidate) => {
    const edgeLength = Math.hypot(candidate.edge[1].x - candidate.edge[0].x, candidate.edge[1].y - candidate.edge[0].y);
    const directionMeters = {
      x: (candidate.edge[1].x - candidate.edge[0].x) / edgeLength,
      y: (candidate.edge[1].y - candidate.edge[0].y) / edgeLength,
    };
    let inwardMeters = { x: -directionMeters.y, y: directionMeters.x };
    if ((center.x - (candidate.edge[0].x + candidate.edge[1].x) / 2) * inwardMeters.x +
        (center.y - (candidate.edge[0].y + candidate.edge[1].y) / 2) * inwardMeters.y < 0) {
      inwardMeters = { x: -inwardMeters.x, y: -inwardMeters.y };
    }
    const startMeters = {
      x: candidate.edge[0].x + directionMeters.x * candidate.start + inwardMeters.x *
        (BUILDING_STAIR_WALL_CLEARANCE_METERS + candidate.width / 2),
      y: candidate.edge[0].y + directionMeters.y * candidate.start + inwardMeters.y *
        (BUILDING_STAIR_WALL_CLEARANCE_METERS + candidate.width / 2),
    };
    return {
      edgeIndex: -1,
      start: { x: startMeters.x / options.metersPerUnit, z: startMeters.y / options.metersPerUnit },
      direction: { x: directionMeters.x, z: directionMeters.y },
      inward: { x: inwardMeters.x, z: inwardMeters.y },
      runMeters: candidate.run,
      widthMeters: candidate.width,
    };
  });
}

function pointInPolygonInclusive(point: Point2D, polygon: readonly Point2D[]): boolean {
  return polygon.some((start, index) => pointOnSegment2D(
    point,
    start,
    polygon[(index + 1) % polygon.length],
  )) || pointInPolygon(
    { x: point.x, z: point.y },
    polygon.map(({ x, y }) => ({ x, z: y })),
  );
}

function addPlannedInteriorWalls(
  parts: Mesh[],
  scene: Scene,
  interior: PlannedInterior,
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
): void {
  addLayoutWalls(parts, scene, interior.building, bottomElevation, heightMeters, options, color);
  for (const apartment of interior.apartments) {
    addLayoutWalls(parts, scene, apartment, bottomElevation, heightMeters, options, color);
  }
}

function addLayoutWalls(
  parts: Mesh[],
  scene: Scene,
  layout: PolygonLayout,
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
): void {
  const edges = new Map<string, readonly [Point2D, Point2D]>();
  for (const room of layout.rooms) {
    const polygon = room.polygon.outer;
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      if (segmentOnPolygonBoundary(start, end, layout.boundary.outer)) continue;
      const key = canonicalSegmentKey(start, end);
      if (!edges.has(key)) edges.set(key, [start, end]);
    }
  }
  for (const [start, end] of edges.values()) {
    addInteriorWall(parts, scene, start, end, layout.openings ?? [],
      bottomElevation, heightMeters, options, color);
  }
}

function segmentOnPolygonBoundary(
  start: Point2D,
  end: Point2D,
  boundary: readonly Point2D[],
): boolean {
  return boundary.some((edgeStart, index) => {
    const edgeEnd = boundary[(index + 1) % boundary.length];
    return pointOnSegment2D(start, edgeStart, edgeEnd) && pointOnSegment2D(end, edgeStart, edgeEnd);
  });
}

function canonicalSegmentKey(start: Point2D, end: Point2D): string {
  const pointKey = (point: Point2D): string => `${point.x.toFixed(5)},${point.y.toFixed(5)}`;
  const first = pointKey(start);
  const second = pointKey(end);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function addInteriorWall(
  parts: Mesh[],
  scene: Scene,
  start: Point2D,
  end: Point2D,
  openings: readonly Opening2D[],
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
): void {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 0.05) return;
  // A clipped room edge can cross the exterior entrance without containing
  // both doorway endpoints. Do not put an opaque panel across that opening.
  if (openings.some((opening) => opening.type === "door" &&
      segmentsIntersect(start, end, opening.start, opening.end) &&
      !(pointOnSegment2D(opening.start, start, end) &&
        pointOnSegment2D(opening.end, start, end)))) return;
  const direction = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const doors = openings
    .filter((opening) => opening.type === "door" &&
      pointOnSegment2D(opening.start, start, end) && pointOnSegment2D(opening.end, start, end))
    .map((opening) => {
      const first = (opening.start.x - start.x) * direction.x +
        (opening.start.y - start.y) * direction.y;
      const second = (opening.end.x - start.x) * direction.x +
        (opening.end.y - start.y) * direction.y;
      return { minimum: Math.max(0, Math.min(first, second)), maximum: Math.min(length, Math.max(first, second)) };
    })
    .filter((door) => door.maximum - door.minimum > 0.2)
    .sort((a, b) => a.minimum - b.minimum);
  const sceneStart = { x: start.x / options.metersPerUnit, z: start.y / options.metersPerUnit };
  const sceneEnd = { x: end.x / options.metersPerUnit, z: end.y / options.metersPerUnit };
  let cursor = 0;
  const doorHeight = Math.min(BUILDING_DOOR_HEIGHT_METERS, heightMeters - 0.12);
  for (const door of doors) {
    addFacadePanel(parts, scene, sceneStart, sceneEnd, length, cursor,
      door.minimum - cursor, bottomElevation, heightMeters, options, color);
    addFacadePanel(parts, scene, sceneStart, sceneEnd, length, door.minimum,
      door.maximum - door.minimum, bottomElevation + doorHeight,
      heightMeters - doorHeight, options, color);
    cursor = Math.max(cursor, door.maximum);
  }
  addFacadePanel(parts, scene, sceneStart, sceneEnd, length, cursor,
    length - cursor, bottomElevation, heightMeters, options, color);
}

function addFacadeCorners(
  parts: Mesh[],
  scene: Scene,
  outline: ScenePoint[],
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
): void {
  const halfThickness = BUILDING_WALL_THICKNESS_METERS / 2 / options.metersPerUnit;
  for (let index = 0; index < outline.length; index++) {
    const previous = outline[(index + outline.length - 1) % outline.length];
    const vertex = outline[index];
    const next = outline[(index + 1) % outline.length];
    const previousDirection = unitDirection(previous, vertex);
    const nextDirection = unitDirection(vertex, next);
    // Concave vertices are internal corners; the adjacent wall panels already
    // cover them and a convex miter would incorrectly fill the courtyard.
    const turn = previousDirection.x * nextDirection.z -
      previousDirection.z * nextDirection.x;
    if (turn <= 1e-5) continue;

    const previousNormal = outwardNormal(previousDirection);
    const nextNormal = outwardNormal(nextDirection);
    const outerMiter = intersectLines(
      addPoint(vertex, scalePoint(previousNormal, halfThickness)),
      previousDirection,
      addPoint(vertex, scalePoint(nextNormal, halfThickness)),
      nextDirection,
    );
    if (!outerMiter) continue;

    const corner = [
      vertex,
      addPoint(vertex, scalePoint(previousNormal, halfThickness)),
      outerMiter,
      addPoint(vertex, scalePoint(nextNormal, halfThickness)),
    ];
    const mesh = createBuildingPrism(
      scene,
      corner,
      bottomElevation + heightMeters,
      bottomElevation,
      options,
    );
    setSolidVertexColor(mesh, color);
    parts.push(mesh);
  }
}

function unitDirection(start: ScenePoint, end: ScenePoint): ScenePoint {
  const length = pointDistance(start, end) || 1;
  return { x: (end.x - start.x) / length, z: (end.z - start.z) / length };
}

function outwardNormal(direction: ScenePoint): ScenePoint {
  return { x: direction.z, z: -direction.x };
}

function scalePoint(point: ScenePoint, scale: number): ScenePoint {
  return { x: point.x * scale, z: point.z * scale };
}

function addPoint(first: ScenePoint, second: ScenePoint): ScenePoint {
  return { x: first.x + second.x, z: first.z + second.z };
}

function intersectLines(
  firstPoint: ScenePoint,
  firstDirection: ScenePoint,
  secondPoint: ScenePoint,
  secondDirection: ScenePoint,
): ScenePoint | undefined {
  const cross = firstDirection.x * secondDirection.z -
    firstDirection.z * secondDirection.x;
  if (Math.abs(cross) < 1e-6) return undefined;
  const delta = { x: secondPoint.x - firstPoint.x, z: secondPoint.z - firstPoint.z };
  const amount = (delta.x * secondDirection.z - delta.z * secondDirection.x) / cross;
  return addPoint(firstPoint, scalePoint(firstDirection, amount));
}

function addWindowQuad(
  geometry: WindowGeometry,
  edgeStart: ScenePoint,
  edgeEnd: ScenePoint,
  edgeLengthMeters: number,
  offsetMeters: number,
  widthMeters: number,
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
  alpha = BUILDING_WINDOW_CLOSE_ALPHA,
  depthOffsetMeters = 0,
): void {
  const directionX = (edgeEnd.x - edgeStart.x) * options.metersPerUnit / edgeLengthMeters;
  const directionZ = (edgeEnd.z - edgeStart.z) * options.metersPerUnit / edgeLengthMeters;
  const outwardX = directionZ;
  const outwardZ = -directionX;
  const offset = (BUILDING_WALL_THICKNESS_METERS * 0.56 + depthOffsetMeters) /
    options.metersPerUnit;
  const x0 = edgeStart.x + directionX * offsetMeters / options.metersPerUnit + outwardX * offset;
  const z0 = edgeStart.z + directionZ * offsetMeters / options.metersPerUnit + outwardZ * offset;
  const x1 = x0 + directionX * widthMeters / options.metersPerUnit;
  const z1 = z0 + directionZ * widthMeters / options.metersPerUnit;
  const y0 = bottomElevation / options.metersPerUnit;
  const y1 = (bottomElevation + heightMeters) / options.metersPerUnit;
  const first = geometry.positions.length / 3;
  geometry.positions.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0);
  geometry.indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
  for (let vertex = 0; vertex < 4; vertex++) {
    geometry.normals.push(outwardX, 0, outwardZ);
    // Alpha below one marks window vertices for the proximity updater.
    geometry.colors.push(color.r, color.g, color.b, alpha);
  }
}

function addWindowMullions(
  geometry: WindowGeometry,
  edgeStart: ScenePoint,
  edgeEnd: ScenePoint,
  edgeLengthMeters: number,
  windowOffsetMeters: number,
  bottomElevation: number,
  style: BuildingWindowStyle,
  options: BuildingRenderOptions,
  color: Color3,
): void {
  const frameDepth = -style.recessMeters + 0.012;
  for (const fraction of style.verticalBars) {
    addWindowQuad(
      geometry, edgeStart, edgeEnd, edgeLengthMeters,
      windowOffsetMeters + style.widthMeters * fraction - style.frameWidthMeters / 2,
      style.frameWidthMeters, bottomElevation, style.heightMeters, options, color, 1, frameDepth,
    );
  }
  for (const fraction of style.horizontalBars) {
    addWindowQuad(
      geometry, edgeStart, edgeEnd, edgeLengthMeters, windowOffsetMeters,
      style.widthMeters,
      bottomElevation + style.heightMeters * fraction - style.frameWidthMeters / 2,
      style.frameWidthMeters, options, color, 1, frameDepth,
    );
  }
}

function addApertureFacade(
  parts: Mesh[],
  scene: Scene,
  edgeStart: ScenePoint,
  edgeEnd: ScenePoint,
  edgeLengthMeters: number,
  bayStart: number,
  bayWidth: number,
  storyBottom: number,
  storyHeight: number,
  apertureWidth: number,
  apertureHeight: number,
  apertureBottom: number,
  options: BuildingRenderOptions,
  color: Color3,
  apertureOffset = (bayWidth - apertureWidth) / 2,
): void {
  const leftWidth = Math.max(0, apertureOffset);
  const rightWidth = Math.max(0, bayWidth - apertureOffset - apertureWidth);
  addFacadePanel(parts, scene, edgeStart, edgeEnd, edgeLengthMeters, bayStart,
    leftWidth, storyBottom, storyHeight, options, color);
  addFacadePanel(parts, scene, edgeStart, edgeEnd, edgeLengthMeters,
    bayStart + apertureOffset + apertureWidth, rightWidth,
    storyBottom, storyHeight, options, color);
  addFacadePanel(parts, scene, edgeStart, edgeEnd, edgeLengthMeters,
    bayStart + apertureOffset, apertureWidth, storyBottom,
    apertureBottom, options, color);
  addFacadePanel(parts, scene, edgeStart, edgeEnd, edgeLengthMeters,
    bayStart + apertureOffset, apertureWidth,
    storyBottom + apertureBottom + apertureHeight,
    storyHeight - apertureBottom - apertureHeight, options, color);
}

function createWindowMesh(scene: Scene, geometry: WindowGeometry): Mesh | undefined {
  if (geometry.indices.length === 0) return undefined;
  const mesh = stageBuildingMesh(new Mesh("buildingWindows", scene));
  const data = new VertexData();
  data.positions = geometry.positions;
  data.indices = geometry.indices;
  data.normals = geometry.normals;
  data.colors = geometry.colors;
  data.uvs = new Array<number>((geometry.positions.length / 3) * 2).fill(0);
  data.applyToMesh(mesh);
  mesh.useVertexColors = true;
  return mesh;
}

function addFacadePanel(
  parts: Mesh[],
  scene: Scene,
  edgeStart: ScenePoint,
  edgeEnd: ScenePoint,
  edgeLengthMeters: number,
  offsetMeters: number,
  widthMeters: number,
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
  thicknessMeters = BUILDING_WALL_THICKNESS_METERS,
  outwardOffsetMeters = 0,
): void {
  if (widthMeters <= 0.02 || heightMeters <= 0.02) return;
  const directionX = (edgeEnd.x - edgeStart.x) * options.metersPerUnit / edgeLengthMeters;
  const directionZ = (edgeEnd.z - edgeStart.z) * options.metersPerUnit / edgeLengthMeters;
  const centerAlongMeters = offsetMeters + widthMeters / 2;
  const panel = stageBuildingMesh(MeshBuilder.CreateBox("buildingFacadePanel", {
    width: widthMeters / options.metersPerUnit,
    height: heightMeters / options.metersPerUnit,
    depth: thicknessMeters / options.metersPerUnit,
  }, scene));
  panel.position.set(
    edgeStart.x + directionX * centerAlongMeters / options.metersPerUnit +
      directionZ * outwardOffsetMeters / options.metersPerUnit,
    (bottomElevation + heightMeters / 2) / options.metersPerUnit,
    edgeStart.z + directionZ * centerAlongMeters / options.metersPerUnit -
      directionX * outwardOffsetMeters / options.metersPerUnit,
  );
  panel.rotation.y = -Math.atan2(directionZ, directionX);
  setSolidVertexColor(panel, color);
  parts.push(panel);
}

function prepareBuildingFootprint(
  footprint: BuildingPolygon,
  terrain: TerrainData,
  options: BuildingRenderOptions,
): PreparedBuildingFootprint | undefined {
  const clipBounds = {
    minX: -options.meshWidth / 2,
    maxX: options.meshWidth / 2,
    minZ: -options.meshDepth / 2,
    maxZ: options.meshDepth / 2,
  };
  const projectRing = (ring: LonLat[]): ScenePoint[] => {
    const points = ring.map(([lon, lat]) =>
      lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
    );
    if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
    return clipPolygon(points, clipBounds);
  };
  const outline = projectRing(footprint.outer);
  if (outline.length < 3) return undefined;
  if (signedArea(outline) < 0) outline.reverse();
  const holes = footprint.holes
    .map(projectRing)
    .filter((hole) => hole.length >= 3 && Math.abs(signedArea(hole)) > 1e-10)
    .filter((hole) => hole.some((point) => pointInPolygon(point, outline)) ||
      pointInPolygon(averagePoint(hole), outline));
  for (const hole of holes) {
    if (signedArea(hole) > 0) hole.reverse();
  }
  const center = averagePoint(outline);
  const elevations = [center, ...outline].map((point) =>
    sampleElevation(terrain, point.x, point.z, options.meshWidth, options.meshDepth)
  );
  if (elevations.some((elevation) => elevation <= SEA_LEVEL_METERS)) return undefined;
  return { outline, holes, baseElevation: Math.max(...elevations) };
}

function findSharedFacadeEdges(
  footprint: BuildingPlan["footprint"],
  outline: readonly ScenePoint[],
  terrain: TerrainData,
  options: BuildingRenderOptions,
): ReadonlySet<number> {
  const neighbors = options.neighboringBuildingFootprints ?? [];
  const ownPoints = footprint.outer;
  const sameFootprint = (other: BuildingPlan["footprint"]): boolean => {
    if (other.outer.length !== ownPoints.length) return false;
    return other.outer.every(([lon, lat]) => ownPoints.some((point) =>
      Math.abs(lon - point[0]) < 1e-9 && Math.abs(lat - point[1]) < 1e-9));
  };
  const projected = (ring: readonly (readonly [number, number])[]): ScenePoint[] =>
    ring.map(([lon, lat]) => lonLatToScene(
      lon, lat, terrain.bounds, options.meshWidth, options.meshDepth));
  const tolerance = 0.25 / options.metersPerUnit;
  const minimumOverlap = 0.5 / options.metersPerUnit;
  const blocked = new Set<number>();
  for (const neighbor of neighbors) {
    if (sameFootprint(neighbor)) continue;
    const ring = projected(neighbor.outer);
    for (let edgeIndex = 0; edgeIndex < outline.length; edgeIndex++) {
      const start = outline[edgeIndex];
      const end = outline[(edgeIndex + 1) % outline.length];
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const length = Math.hypot(dx, dz);
      if (length < minimumOverlap) continue;
      for (let index = 0; index < ring.length; index++) {
        const otherStart = ring[index];
        const otherEnd = ring[(index + 1) % ring.length];
        const cross = (point: ScenePoint) =>
          Math.abs(dx * (point.z - start.z) - dz * (point.x - start.x)) / length;
        if (cross(otherStart) > tolerance || cross(otherEnd) > tolerance) continue;
        const along = (point: ScenePoint) =>
          ((point.x - start.x) * dx + (point.z - start.z) * dz) / length;
        const overlap = Math.min(length, Math.max(along(otherStart), along(otherEnd))) -
          Math.max(0, Math.min(along(otherStart), along(otherEnd)));
        if (overlap >= minimumOverlap) {
          blocked.add(edgeIndex);
          break;
        }
      }
    }
  }
  return blocked;
}

function createBuildingPrism(
  scene: Scene,
  outline: ScenePoint[],
  topElevation: number,
  bottomElevation: number,
  options: BuildingRenderOptions,
  holes?: readonly ScenePoint[][],
): Mesh {
  const shape = outline.map(({ x, z }) => new Vector2(x, z));
  const depth = Math.max(0.01, (topElevation - bottomElevation) / options.metersPerUnit);
  if (!holes || holes.length === 0) {
    const mesh = stageBuildingMesh(
      new PolygonMeshBuilder("building", shape, scene, earcut).build(false, depth),
    );
    mesh.position.y = topElevation / options.metersPerUnit;
    return mesh;
  }
  const builder = new PolygonMeshBuilder("building", shape, scene, earcut);
  for (const hole of holes) {
    builder.addHole(hole.map(({ x, z }) => new Vector2(x, z)));
  }
  const mesh = stageBuildingMesh(
    builder.build(false, depth),
  );
  mesh.position.y = topElevation / options.metersPerUnit;
  return mesh;
}

function findStairLayouts(
  outline: ScenePoint[],
  options: BuildingRenderOptions,
  entrance: EntranceClearance,
  flightCount: number,
  detailSeed: number,
): StairLayout[] {
  const edges = outline.map((_, index) => index).sort((a, b) =>
    Number(a === entrance.edgeIndex) - Number(b === entrance.edgeIndex) ||
    pointDistance(outline[b], outline[(b + 1) % outline.length]) -
    pointDistance(outline[a], outline[(a + 1) % outline.length])
  );
  const candidates: StairLayout[] = [];
  for (const edgeIndex of edges) {
    const edgeStart = outline[edgeIndex];
    const edgeEnd = outline[(edgeIndex + 1) % outline.length];
    const edgeLengthMeters = pointDistance(edgeStart, edgeEnd) * options.metersPerUnit;
    const runMeters = Math.min(BUILDING_STAIR_MAX_RUN_METERS, edgeLengthMeters - 1.2);
    if (runMeters < BUILDING_STAIR_MIN_RUN_METERS) continue;
    const direction = {
      x: (edgeEnd.x - edgeStart.x) * options.metersPerUnit / edgeLengthMeters,
      z: (edgeEnd.z - edgeStart.z) * options.metersPerUnit / edgeLengthMeters,
    };
    const inward = { x: -direction.z, z: direction.x };
    const acrossCenter = BUILDING_STAIR_WALL_CLEARANCE_METERS +
      BUILDING_STAIR_WIDTH_METERS / 2;
    const centeredStart = (edgeLengthMeters - runMeters) / 2;
    const alongStarts = [
      centeredStart,
      0.6,
      edgeLengthMeters - runMeters - 0.6,
    ].filter((value, index, values) =>
      values.findIndex((candidate) => Math.abs(candidate - value) < 0.1) === index
    );
    for (const alongStart of alongStarts) {
      if (alongStart < 0.35 || alongStart + runMeters > edgeLengthMeters - 0.35) continue;
      if (edgeIndex === entrance.edgeIndex) {
        const doorwayMinimum = entrance.centerMeters - entrance.widthMeters / 2 - 0.65;
        const doorwayMaximum = entrance.centerMeters + entrance.widthMeters / 2 + 0.65;
        if (alongStart < doorwayMaximum && alongStart + runMeters > doorwayMinimum) continue;
      }
      const start = {
        x: edgeStart.x + (direction.x * alongStart + inward.x * acrossCenter) /
          options.metersPerUnit,
        z: edgeStart.z + (direction.z * alongStart + inward.z * acrossCenter) /
          options.metersPerUnit,
      };
      const layout = {
        edgeIndex,
        start,
        direction,
        inward,
        runMeters,
        widthMeters: BUILDING_STAIR_WIDTH_METERS,
      };
      if (stairOpening(layout, options).every((point) => pointInPolygon(point, outline))) {
        candidates.push(layout);
      }
    }
  }
  if (candidates.length === 0) return [];

  const layouts: StairLayout[] = [];
  for (let flight = 0; flight < flightCount; flight++) {
    const previous = layouts[flight - 1];
    const separated = previous
      ? candidates.filter((candidate) => !stairLayoutsOverlap(candidate, previous, options))
      : candidates;
    if (separated.length === 0) break;
    const choices = separated;
    const choiceIndex = Math.floor(
      seededUnit(detailSeed ^ (flight * 0x1b873593) ^ 0x6d2b79f5) * choices.length,
    );
    layouts.push(choices[Math.min(choiceIndex, choices.length - 1)]);
  }
  return layouts;
}

function stairCenter(stair: StairLayout): ScenePoint {
  return {
    x: stair.start.x + stair.direction.x * stair.runMeters / 2,
    z: stair.start.z + stair.direction.z * stair.runMeters / 2,
  };
}

function stairLayoutsOverlap(
  first: StairLayout,
  second: StairLayout,
  options: BuildingRenderOptions,
): boolean {
  const corners = (stair: StairLayout): ScenePoint[] => {
    const halfWidth = stair.widthMeters / 2;
    return [
      [0, -halfWidth],
      [stair.runMeters, -halfWidth],
      [stair.runMeters, halfWidth],
      [0, halfWidth],
    ].map(([along, across]) => ({
      x: stair.start.x + (stair.direction.x * along + stair.inward.x * across) /
        options.metersPerUnit,
      z: stair.start.z + (stair.direction.z * along + stair.inward.z * across) /
        options.metersPerUnit,
    }));
  };
  const firstCorners = corners(first);
  const secondCorners = corners(second);
  const axes = [
    first.direction, first.inward,
    second.direction, second.inward,
  ];
  return axes.every((axis) => {
    const project = (point: ScenePoint): number => point.x * axis.x + point.z * axis.z;
    const firstProjection = firstCorners.map(project);
    const secondProjection = secondCorners.map(project);
    const firstMin = Math.min(...firstProjection);
    const firstMax = Math.max(...firstProjection);
    const secondMin = Math.min(...secondProjection);
    const secondMax = Math.max(...secondProjection);
    return Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin) > 0.1 / options.metersPerUnit;
  });
}

function stairOpening(stair: StairLayout, options: BuildingRenderOptions): ScenePoint[] {
  const halfWidth = (stair.widthMeters + 0.2) / 2;
  const runStart = -0.1;
  const runEnd = stair.runMeters + 0.1;
  const point = (along: number, across: number): ScenePoint => ({
    x: stair.start.x +
      (stair.direction.x * along + stair.inward.x * across) / options.metersPerUnit,
    z: stair.start.z +
      (stair.direction.z * along + stair.inward.z * across) / options.metersPerUnit,
  });
  return [
    point(runStart, -halfWidth),
    point(runEnd, -halfWidth),
    point(runEnd, halfWidth),
    point(runStart, halfWidth),
  ].reverse();
}

function createStairFlight(
  parts: Mesh[],
  scene: Scene,
  stair: StairLayout,
  floorElevation: number,
  storyHeight: number,
  reverse: boolean,
  options: BuildingRenderOptions,
  color: Color3,
): void {
  const stepCount = Math.max(8, Math.ceil(storyHeight / 0.19));
  const treadMeters = stair.runMeters / stepCount;
  const riseMeters = storyHeight / stepCount;
  for (let step = 0; step < stepCount; step++) {
    const along = (step + 0.5) * treadMeters;
    const heightMeters = (step + 1) * riseMeters;
    const signedAlong = reverse ? stair.runMeters - along : along;
    const direction = reverse
      ? { x: -stair.direction.x, z: -stair.direction.z }
      : stair.direction;
    const center = {
      x: stair.start.x + stair.direction.x * signedAlong / options.metersPerUnit,
      z: stair.start.z + stair.direction.z * signedAlong / options.metersPerUnit,
    };
    const mesh = stageBuildingMesh(MeshBuilder.CreateBox("buildingStair", {
      width: stair.widthMeters / options.metersPerUnit,
      height: heightMeters / options.metersPerUnit,
      depth: treadMeters / options.metersPerUnit,
    }, scene));
    mesh.position.set(
      center.x,
      (floorElevation + BUILDING_FLOOR_THICKNESS_METERS + heightMeters / 2) /
        options.metersPerUnit,
      center.z,
    );
    mesh.rotation.y = Math.atan2(direction.x, direction.z);
    setSolidVertexColor(mesh, color);
    parts.push(mesh);
  }
}

function pointInPolygon(point: ScenePoint, polygon: readonly ScenePoint[]): boolean {
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

function configureBuildingSurfaceMaterials(
  mesh: Mesh,
  metersPerUnit: number,
  solidMaterial: StandardMaterial,
  skyReflection: BaseTexture | null | undefined,
): BuildingShadowRange[] {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
  const indices = mesh.getIndices();
  if (!positions || !colors || !indices) return [];
  const windowVertices: number[] = [];
  const reflectiveVertices = new Set<number>();
  for (let vertex = 0; vertex < colors.length / 4; vertex++) {
    const marker = colors[vertex * 4 + 3];
    if (marker < 0.5) windowVertices.push(vertex);
    else if (marker < 0.99) {
      reflectiveVertices.add(vertex);
      colors[vertex * 4 + 3] = 1;
    }
  }
  if (windowVertices.length === 0 && reflectiveVertices.size === 0) {
    return [{ indexStart: 0, indexCount: indices.length }];
  }

  const solidIndices: number[] = [];
  const windowIndices: number[] = [];
  const reflectiveIndices: number[] = [];
  for (let index = 0; index < indices.length; index += 3) {
    const target = reflectiveVertices.has(indices[index]) &&
        reflectiveVertices.has(indices[index + 1]) &&
        reflectiveVertices.has(indices[index + 2])
      ? reflectiveIndices
      : colors[indices[index] * 4 + 3] < 0.5 &&
          colors[indices[index + 1] * 4 + 3] < 0.5 &&
          colors[indices[index + 2] * 4 + 3] < 0.5
        ? windowIndices
        : solidIndices;
    target.push(indices[index], indices[index + 1], indices[index + 2]);
  }
  mesh.setIndices([...solidIndices, ...windowIndices, ...reflectiveIndices], undefined, true);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
  mesh.releaseSubMeshes();

  const glassMaterial = new StandardMaterial(`${mesh.name}WindowMaterial`, mesh.getScene());
  glassMaterial.diffuseColor = Color3.White();
  glassMaterial.specularColor = new Color3(0.3, 0.34, 0.36);
  glassMaterial.specularPower = 48;
  glassMaterial.backFaceCulling = false;
  glassMaterial.transparencyMode = Material.MATERIAL_ALPHABLEND;
  const reflectiveMaterial = new PBRMaterial(`${mesh.name}HighRiseMaterial`, mesh.getScene());
  reflectiveMaterial.metallic = 0.18;
  reflectiveMaterial.roughness = 0.16;
  reflectiveMaterial.environmentIntensity = 0.85;
  reflectiveMaterial.reflectionTexture = skyReflection ?? null;
  reflectiveMaterial.backFaceCulling = false;
  reflectiveMaterial.alpha = 1;
  reflectiveMaterial.transparencyMode = Material.MATERIAL_OPAQUE;
  reflectiveMaterial.useAlphaFromAlbedoTexture = false;
  const materials = new MultiMaterial(`${mesh.name}Materials`, mesh.getScene());
  materials.subMaterials = [];
  let indexOffset = 0;
  const addSurface = (surfaceIndices: number[], material: StandardMaterial | PBRMaterial): void => {
    if (surfaceIndices.length === 0) return;
    const materialIndex = materials.subMaterials.length;
    materials.subMaterials.push(material);
    SubMesh.CreateFromIndices(materialIndex, indexOffset, surfaceIndices.length, mesh);
    indexOffset += surfaceIndices.length;
  };
  addSurface(solidIndices, solidMaterial);
  addSurface(windowIndices, glassMaterial);
  addSurface(reflectiveIndices, reflectiveMaterial);
  mesh.material = materials;

  // Include window triangles in the depth pass. The dedicated caster uses an
  // opaque material, so the whole building always casts a solid silhouette.
  const shadowRanges: BuildingShadowRange[] = indices.length > 0
    ? [{ indexStart: 0, indexCount: indices.length }]
    : [];

  if (windowVertices.length === 0) return shadowRanges;
  mesh.markVerticesDataAsUpdatable(VertexBuffer.ColorKind, true);
  if (mesh.metadata?.interiorsLoaded !== true) {
    // Apply the residency rule before the first render as well as during the
    // distance update below. This avoids one frame of see-through geometry.
    for (const vertex of windowVertices) colors[vertex * 4 + 3] = 1;
    mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
  }
  let lastUpdateMilliseconds = -Infinity;
  mesh.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    if (now - lastUpdateMilliseconds < 100) return;
    lastUpdateMilliseconds = now;
    const camera = mesh.getScene().activeCamera;
    if (!camera) return;
    // Use the building center for the transition. Per-window distances let
    // the near facade of a large building remain transparent long after the
    // building itself has become a distant object.
    const bounds = mesh.getBoundingInfo().boundingSphere;
    const center = bounds.centerWorld;
    const distanceMeters = Vector3.Distance(center, camera.globalPosition) * metersPerUnit;
    // Keep the shell opaque until its interior is resident. A transparent
    // window with no loaded interior exposes the terrain behind the house.
    const fade = mesh.metadata?.interiorsLoaded === true
      ? clamp01(
        (distanceMeters - BUILDING_WINDOW_CLEAR_DISTANCE_METERS) /
        (BUILDING_WINDOW_OPAQUE_DISTANCE_METERS - BUILDING_WINDOW_CLEAR_DISTANCE_METERS),
      )
      : 1;
    for (const vertex of windowVertices) {
      const offset = vertex * 3;
      colors[vertex * 4 + 3] = BUILDING_WINDOW_CLOSE_ALPHA +
        (1 - BUILDING_WINDOW_CLOSE_ALPHA) * fade;
    }
    mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
  });
  return shadowRanges;
}

function createBuildingShadowCaster(
  source: Mesh,
  parent: TransformNode,
  ranges: readonly BuildingShadowRange[],
): Mesh | undefined {
  if (!source.geometry || ranges.length === 0) return undefined;
  const caster = new Mesh("buildingShadows", source.getScene());
  source.geometry.applyToMesh(caster);
  caster.releaseSubMeshes();
  for (const range of ranges) {
    SubMesh.CreateFromIndices(0, range.indexStart, range.indexCount, caster);
  }
  const shadowMaterial = new StandardMaterial(`${source.name}ShadowMaterial`, source.getScene());
  shadowMaterial.diffuseColor = Color3.White();
  shadowMaterial.specularColor = Color3.Black();
  shadowMaterial.backFaceCulling = false;
  shadowMaterial.transparencyMode = Material.MATERIAL_OPAQUE;
  shadowMaterial.alpha = 1;
  caster.material = shadowMaterial;
  caster.parent = parent;
  caster.isPickable = false;
  caster.receiveShadows = false;
  caster.isVisible = false;
  caster.metadata = { buildingShadowCaster: true, shadowOnly: true };
  caster.onDisposeObservable.addOnce(() => shadowMaterial.dispose());
  return caster;
}

function configureLazyInteriors(
  exterior: Mesh,
  parent: TransformNode,
  pendingInteriors: PendingBuildingInterior[],
  metersPerUnit: number,
): void {
  if (pendingInteriors.length === 0) return;
  exterior.metadata ??= {};
  delete exterior.metadata.pendingInterior;
  exterior.metadata.pendingInteriorCount = pendingInteriors.length;
  exterior.metadata.loadedInteriorCount = 0;
  const loadedInteriors: LoadedBuildingInterior[] = [];
  let lastCheckMilliseconds = -Infinity;
  const scene = exterior.getScene();
  // Creating and merging an interior mutates the scene graph. Doing that from
  // onBeforeRender lets the main pass, SSR, and transparent windows observe
  // different scene contents in one frame, which produces visible flashes.
  // Queue the residency work after the frame so the next frame sees a stable
  // set of meshes across every render pass.
  const afterRenderObserver = scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (now - lastCheckMilliseconds < BUILDING_INTERIOR_CHECK_INTERVAL_MS) return;
    lastCheckMilliseconds = now;
    const camera = scene.activeCamera;
    if (!camera) return;
    const parentWorld = parent.computeWorldMatrix(true);
    const localCamera = Vector3.TransformCoordinates(
      camera.globalPosition,
      parentWorld.clone().invert(),
    );

    // Release interiors that are no longer near enough to be seen. Their
    // pending descriptors are retained so returning to the building can load
    // them again without rebuilding the detailed exterior.
    for (let index = loadedInteriors.length - 1; index >= 0; index--) {
      const loadedInterior = loadedInteriors[index];
      if (interiorDistanceMeters(loadedInterior.center, loadedInterior.pending.radiusMeters,
          localCamera, metersPerUnit) <= BUILDING_INTERIOR_UNLOAD_DISTANCE_METERS) continue;
      loadedInterior.mesh.dispose(false, true);
      pendingInteriors.push(loadedInterior.pending);
      loadedInteriors.splice(index, 1);
      exterior.metadata.loadedInteriorCount--;
    }
    for (const loadedInterior of loadedInteriors) {
      // Keep the render cutoff explicit on the interior mesh itself. This is
      // intentionally separate from residency so a stale/culled exterior
      // callback can never make an interior visible at distance.
      loadedInterior.mesh.isVisible = true;
    }

    let loaded = 0;
    while (loaded < BUILDING_INTERIORS_PER_CHECK && pendingInteriors.length > 0) {
      let nearestIndex = 0;
      let nearestDistanceMeters = Number.POSITIVE_INFINITY;
      for (let index = 0; index < pendingInteriors.length; index++) {
        const pending = pendingInteriors[index];
        const distanceMeters = interiorDistanceMeters(
          pending.center,
          pending.radiusMeters,
          localCamera,
          metersPerUnit,
        );
        if (distanceMeters < nearestDistanceMeters) {
          nearestDistanceMeters = distanceMeters;
          nearestIndex = index;
        }
      }
      const candidate = pendingInteriors[nearestIndex];
      if (nearestDistanceMeters > BUILDING_INTERIOR_LOAD_DISTANCE_METERS) break;
      pendingInteriors.splice(nearestIndex, 1);
      const interiorSource = candidate.load();
      if (!interiorSource) continue;
      const interior = ProceduralBuildingRenderer.merge(
        [interiorSource],
        "buildingInteriors",
        parent,
      );
      if (!interior) continue;
      interior.onBeforeRenderObservable.add(() => {
        const activeCamera = interior.getScene().activeCamera;
        if (!activeCamera) return;
        const currentParentWorld = parent.computeWorldMatrix(true);
        const currentLocalCamera = Vector3.TransformCoordinates(
          activeCamera.globalPosition,
          currentParentWorld.clone().invert(),
        );
        interior.isVisible = interiorDistanceMeters(
          candidate.center,
          candidate.radiusMeters,
          currentLocalCamera,
          metersPerUnit,
        ) <=
          BUILDING_INTERIOR_UNLOAD_DISTANCE_METERS;
      });
      interior.checkCollisions = true;
      interior.setEnabled(true);
      loadedInteriors.push({ center: candidate.center, pending: candidate, mesh: interior });
      exterior.metadata.loadedInteriorCount++;
      loaded++;
    }
    exterior.metadata.pendingInteriorCount = pendingInteriors.length;
    exterior.metadata.interiorsLoaded = pendingInteriors.length === 0;
  });
  exterior.onDisposeObservable.add(() => {
    scene.onAfterRenderObservable.remove(afterRenderObserver);
  });
}

function interiorDistanceMeters(
  center: Vector3,
  radiusMeters: number,
  camera: Vector3,
  metersPerUnit: number,
): number {
  const centerDistanceMeters = Math.hypot(
    center.x - camera.x,
    center.z - camera.z,
  ) * metersPerUnit;
  return Math.max(0, centerDistanceMeters - radiusMeters);
}

function createRoofTrim(
  scene: Scene,
  outline: ScenePoint[],
  elevation: number,
  options: BuildingRenderOptions,
  color: Color3,
  detailSeed: number,
): Mesh | undefined {
  if (outline.length > 12) return undefined;
  const trimHeight = BUILDING_ROOF_TRIM_METERS +
    (seededUnit(detailSeed ^ 0x683a9f) - 0.5) * 0.16;
  const trim = createBuildingPrism(
    scene,
    outline,
    elevation + trimHeight / 2,
    elevation - trimHeight / 2,
    options,
  );
  const center = averagePoint(outline);
  const trimScale = 1.006 + seededUnit(detailSeed ^ 0x915cb4) * 0.016;
  const positions = trim.getVerticesData(VertexBuffer.PositionKind);
  if (positions) {
    for (let index = 0; index < positions.length; index += 3) {
      positions[index] = center.x + (positions[index] - center.x) * trimScale;
      positions[index + 2] = center.z + (positions[index + 2] - center.z) * trimScale;
    }
    trim.updateVerticesData(VertexBuffer.PositionKind, positions);
  }
  setSolidVertexColor(trim, color);
  return trim;
}

function createPitchedRoof(
  scene: Scene,
  outline: ScenePoint[],
  eaveElevation: number,
  peakElevation: number,
  roofShape: BuildingPlan["roofShape"],
  options: BuildingRenderOptions,
  color: Color3,
  detailSeed: number,
): Mesh | undefined {
  if (!isConvex(outline) || outline.length > 12) return undefined;
  const eaveY = eaveElevation / options.metersPerUnit;
  const peakY = peakElevation / options.metersPerUnit;
  const eaves = offsetConvexPolygon(
    outline,
    roofOverhangMeters(detailSeed) / options.metersPerUnit,
  );
  const vertices: Array<{ x: number; y: number; z: number }> = eaves.map((point) => ({
    x: point.x,
    y: eaveY,
    z: point.z,
  }));
  const indices: number[] = [];

  if (roofShape === "skillion" && eaves.length === 4) {
    const longestEdge = longestPolygonEdge(eaves);
    const order = [0, 1, 2, 3].map((offset) => (longestEdge + offset) % 4);
    const highStart = vertices.length;
    vertices.push(
      { x: eaves[order[0]].x, y: peakY, z: eaves[order[0]].z },
      { x: eaves[order[1]].x, y: peakY, z: eaves[order[1]].z },
    );
    addRoofFace(indices, [highStart, highStart + 1, order[2], order[3]]);
    addRoofFace(indices, [order[0], order[1], highStart + 1, highStart]);
  } else if ((roofShape === "gabled" || roofShape === "hipped") && eaves.length === 4) {
    const longestEdge = longestPolygonEdge(eaves);
    const order = [0, 1, 2, 3].map((offset) => (longestEdge + offset) % 4);
    const corners = order.map((index) => eaves[index]);
    const left = midpoint(corners[3], corners[0]);
    const right = midpoint(corners[1], corners[2]);
    const inset = roofShape === "hipped"
      ? Math.min(0.32, pointDistance(corners[0], corners[3]) / Math.max(0.01, pointDistance(left, right) * 2))
      : 0;
    const ridgeLeft = lerpPoint(left, right, inset);
    const ridgeRight = lerpPoint(left, right, 1 - inset);
    const ridgeStart = vertices.length;
    vertices.push(
      { x: ridgeLeft.x, y: peakY, z: ridgeLeft.z },
      { x: ridgeRight.x, y: peakY, z: ridgeRight.z },
    );
    addRoofFace(indices, [order[0], order[1], ridgeStart + 1, ridgeStart]);
    addRoofFace(indices, [order[2], order[3], ridgeStart, ridgeStart + 1]);
    if (roofShape === "hipped") {
      addRoofFace(indices, [order[1], order[2], ridgeStart + 1]);
      addRoofFace(indices, [order[3], order[0], ridgeStart]);
    }
  } else {
    const center = polygonCentroid(eaves);
    const peak = vertices.length;
    vertices.push({ x: center.x, y: peakY, z: center.z });
    for (let index = 0; index < eaves.length; index++) {
      addRoofFace(indices, [index, (index + 1) % eaves.length, peak]);
    }
  }

  const positions = vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]);
  const normals = new Array<number>(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = new Array<number>(vertices.length * 2).fill(0);
  const roof = stageBuildingMesh(new Mesh("buildingRoof", scene));
  data.applyToMesh(roof);
  roof.convertToFlatShadedMesh();
  colorRoofMesh(roof, color);
  return roof;
}

function createRoofGutters(
  scene: Scene,
  outline: ScenePoint[],
  eaveElevation: number,
  roofShape: BuildingPlan["roofShape"],
  options: BuildingRenderOptions,
  color: Color3,
  detailSeed: number,
): Mesh | undefined {
  if (!isConvex(outline) || outline.length > 12) return undefined;

  const eaves = offsetConvexPolygon(
    outline,
    roofOverhangMeters(detailSeed) / options.metersPerUnit,
  );
  const edgeIndices = roofShape === "gabled" && eaves.length === 4
    ? (() => {
      const longestEdge = longestPolygonEdge(eaves);
      return [longestEdge, (longestEdge + 2) % 4];
    })()
    : eaves.map((_, index) => index);
  const gutterY = (eaveElevation - BUILDING_GUTTER_DROP_METERS) / options.metersPerUnit;
  const radius = BUILDING_GUTTER_RADIUS_METERS / options.metersPerUnit;
  const gutterMeshes: Mesh[] = [];

  for (const edgeIndex of edgeIndices) {
    const start = eaves[edgeIndex];
    const end = eaves[(edgeIndex + 1) % eaves.length];
    const gutter = MeshBuilder.CreateTube("buildingGutter", {
      path: [
        new Vector3(start.x, gutterY, start.z),
        new Vector3(end.x, gutterY, end.z),
      ],
      radius,
      tessellation: 6,
      cap: Mesh.CAP_ALL,
    }, scene);
    setSolidVertexColor(gutter, color);
    gutterMeshes.push(gutter);
  }

  const merged = Mesh.MergeMeshes(gutterMeshes, true, true);
  return merged ? stageBuildingMesh(merged) : undefined;
}

function createResidentialDormers(
  scene: Scene,
  plan: BuildingPlan,
  outline: readonly ScenePoint[],
  eaveElevation: number,
  roofHeightMeters: number,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
): Mesh | undefined {
  if (outline.length !== 4 || !isConvex([...outline])) return undefined;

  const geographicCenter = averageLonLat(plan.footprint.outer);
  // Coordinates are in roughly 500 m regions. This is intentionally much
  // broader than a house, so a cluster of nearby villas tends to agree.
  const regionalValue = DORMER_REGION_NOISE.sample(
    geographicCenter.longitude * 220,
    geographicCenter.latitude * 220,
  );
  if (regionalValue < 0.04) return undefined;

  const longestEdge = longestPolygonEdge([...outline]);
  const oppositeEdge = (longestEdge + 2) % 4;
  const shortSpan = Math.min(
    pointDistance(outline[longestEdge], outline[(longestEdge + 3) % 4]),
    pointDistance(outline[(longestEdge + 1) % 4], outline[oppositeEdge]),
  ) * options.metersPerUnit;
  const edgeLength = pointDistance(
    outline[longestEdge], outline[(longestEdge + 1) % 4],
  ) * options.metersPerUnit;
  if (shortSpan < 4.5 || edgeLength < 6) return undefined;

  const count = regionalValue > 0.42 && seededUnit(plan.detailSeed ^ 0x27a1) > 0.35 ? 2 : 1;
  const parts: Mesh[] = [];
  for (let index = 0; index < count; index++) {
    const edgeIndex = index === 0 ? longestEdge : oppositeEdge;
    const start = outline[edgeIndex];
    const end = outline[(edgeIndex + 1) % 4];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    const direction = { x: dx / length, z: dz / length };
    // Counter-clockwise outlines have the building on the left side. The
    // dormer front faces outwards, toward the corresponding long facade.
    const inward = { x: -direction.z, z: direction.x };
    const edgeCenter = {
      x: start.x + dx * (index === 0 ? 0.5 : 0.5),
      z: start.z + dz * 0.5,
    };
    const distanceToRidgeMeters = shortSpan * 0.38;
    const roofY = eaveElevation + roofHeightMeters * (1 - distanceToRidgeMeters / (shortSpan / 2));
    const center = {
      x: edgeCenter.x + inward.x * distanceToRidgeMeters / options.metersPerUnit,
      z: edgeCenter.z + inward.z * distanceToRidgeMeters / options.metersPerUnit,
    };
    const width = Math.min(2.1, edgeLength * 0.34) / options.metersPerUnit;
    const depth = 0.82 / options.metersPerUnit;
    const height = 0.95 / options.metersPerUnit;
    const rotation = -Math.atan2(direction.z, direction.x);
    const wall = MeshBuilder.CreateBox("buildingDormer", {
      width, height, depth,
    }, scene);
    wall.position.set(center.x, (roofY + height * 0.45) / options.metersPerUnit, center.z);
    wall.rotation.y = rotation;
    setSolidVertexColor(wall, appearance.wall);
    parts.push(stageBuildingMesh(wall));

    const window = MeshBuilder.CreateBox("buildingDormerWindow", {
      width: width * 0.62, height: height * 0.52, depth: 0.035 / options.metersPerUnit,
    }, scene);
    window.position.set(
      center.x + direction.z * 0.012,
      (roofY + height * 0.48) / options.metersPerUnit,
      center.z - direction.x * 0.012,
    );
    window.rotation.y = rotation;
    setSolidVertexColor(window, new Color3(0.12, 0.22, 0.28));
    parts.push(stageBuildingMesh(window));

    const cap = MeshBuilder.CreateBox("buildingDormerRoof", {
      width: width * 1.16, height: 0.14 / options.metersPerUnit, depth: depth * 1.18,
    }, scene);
    cap.position.set(center.x, (roofY + height + 0.07 / options.metersPerUnit) / options.metersPerUnit, center.z);
    cap.rotation.y = rotation;
    setSolidVertexColor(cap, appearance.roof);
    parts.push(stageBuildingMesh(cap));
  }
  const merged = Mesh.MergeMeshes(parts, true, true);
  return merged ? stageBuildingMesh(merged) : undefined;
}

function averageLonLat(points: readonly LonLat[]): { longitude: number; latitude: number } {
  const total = points.reduce((sum, [longitude, latitude]) => ({
    longitude: sum.longitude + longitude,
    latitude: sum.latitude + latitude,
  }), { longitude: 0, latitude: 0 });
  return {
    longitude: total.longitude / points.length,
    latitude: total.latitude / points.length,
  };
}

function createResidentialChimney(
  scene: Scene,
  outline: readonly ScenePoint[],
  ridgeElevation: number,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
  detailSeed: number,
): Mesh | undefined {
  if (outline.length < 4 || !isConvex([...outline])) return undefined;

  const center = polygonCentroid([...outline]);
  const metersPerUnit = options.metersPerUnit;
  const shaftWidth = (0.42 + seededUnit(detailSeed ^ 0x2ac491) * 0.12) / metersPerUnit;
  const shaftHeight = (1.15 + seededUnit(detailSeed ^ 0x7d31a2) * 0.35) / metersPerUnit;
  const capHeight = 0.12 / metersPerUnit;
  const capOverhang = 0.08 / metersPerUnit;
  const shaftBottom = ridgeElevation / metersPerUnit - 0.08 / metersPerUnit;
  const shaft = MeshBuilder.CreateBox("buildingChimney", {
    width: shaftWidth,
    height: shaftHeight,
    depth: shaftWidth,
  }, scene);
  shaft.position.set(center.x, shaftBottom + shaftHeight / 2, center.z);

  const cap = MeshBuilder.CreateBox("buildingChimneyCap", {
    width: shaftWidth + capOverhang,
    height: capHeight,
    depth: shaftWidth + capOverhang,
  }, scene);
  cap.position.set(
    center.x,
    shaftBottom + shaftHeight + capHeight / 2,
    center.z,
  );

  setSolidVertexColor(shaft, mixColor(appearance.wall, new Color3(0.33, 0.31, 0.28), 0.58));
  setSolidVertexColor(cap, mixColor(appearance.roof, new Color3(0.2, 0.19, 0.17), 0.35));
  const chimney = Mesh.MergeMeshes([shaft, cap], true, true);
  return chimney ? stageBuildingMesh(chimney) : undefined;
}

function createRooftopVolume(
  scene: Scene,
  plan: BuildingPlan,
  outline: ScenePoint[],
  roofElevation: number,
  areaSquareMeters: number,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
): Mesh | undefined {
  // Complex footprints cannot use the pitched triangulation. Always provide
  // a footprint-matching cap so a building never renders open to the sky.
  const thicknessMeters = Math.max(0.18, Math.min(0.32, areaSquareMeters > 260 ? 0.28 : 0.2));
  const rooftop = createBuildingPrism(
    scene,
    outline,
    roofElevation + thicknessMeters / 2,
    roofElevation - thicknessMeters / 2,
    options,
  );
  setSolidVertexColor(rooftop, appearance.roof);
  return rooftop;
}

function inferredRoofHeight(
  outline: ScenePoint[],
  areaSquareMeters: number,
  options: BuildingRenderOptions,
  detailSeed: number,
): number {
  const spanMeters = outline.length === 4
    ? Math.min(
      (pointDistance(outline[0], outline[1]) + pointDistance(outline[2], outline[3])) / 2,
      (pointDistance(outline[1], outline[2]) + pointDistance(outline[3], outline[0])) / 2,
    ) * options.metersPerUnit
    : Math.sqrt(areaSquareMeters);
  const pitchDegrees = 32 + seededUnit(detailSeed ^ 0x46a31d) * 16;
  const rise = spanMeters / 2 * Math.tan(pitchDegrees * Math.PI / 180);
  return Math.max(1.8, Math.min(6, rise));
}

function roofOverhangMeters(detailSeed: number): number {
  return BUILDING_ROOF_OVERHANG_METERS +
    (seededUnit(detailSeed ^ 0x31bd72) - 0.5) * 0.3;
}

function resolvedRoofShape(
  plan: BuildingPlan,
  outline: ScenePoint[],
  areaSquareMeters: number,
  options: BuildingRenderOptions,
): BuildingPlan["roofShape"] {
  if (plan.roofShape !== "unknown") {
    if (plan.roofShape === "flat") return "flat";
    // Keep residential roofs to the two-side gabled profile: four-sided
    // hipped/pyramidal roofs look too stylized at this scale.
    if (
      plan.roofShape === "skillion" ||
      plan.roofShape === "hipped" ||
      plan.roofShape === "pyramidal"
    ) return "gabled";
    return isConvex(outline) && outline.length <= 12 ? plan.roofShape : "flat";
  }
  if (outline.length !== 4 || !isConvex(outline) || areaSquareMeters > 650 || plan.heightMeters > 16) {
    return "flat";
  }
  const sharedShape = options.residentialRoofShapes?.get(plan.id);
  if (plan.buildingClass === "residential" && sharedShape && sharedShape !== "unknown") {
    return sharedShape;
  }
  const variation = plan.buildingClass === "residential"
    ? residentialRoofVariation(outline, options)
    : seededUnit(plan.detailSeed ^ 0x7a4d2b);
  if (variation < RESIDENTIAL_PITCHED_ROOF_SHARE) return "gabled";
  return "flat";
}

function residentialRoofVariation(
  outline: readonly ScenePoint[],
  _options: BuildingRenderOptions,
): number {
  const center = polygonCentroid([...outline]);
  // Villa districts usually repeat one simple roof language across many
  // adjacent plots. Keep the cells broad enough to cover a small residential
  // area, and bias the default toward pitched roofs. Explicit OSM roof tags
  // are still handled by resolvedRoofShape before this fallback is reached.
  const neighborhoodCell = RESIDENTIAL_ROOF_NEIGHBORHOOD_METERS /
    Math.max(0.01, _options.metersPerUnit);
  const key = `${Math.floor(center.x / neighborhoodCell)},${Math.floor(center.z / neighborhoodCell)}`;
  return seededUnit(hashString(key) ^ 0x7a4d2b);
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return hash | 0;
}

function createGableEndWalls(
  scene: Scene,
  outline: readonly ScenePoint[],
  eaveElevation: number,
  peakElevation: number,
  options: BuildingRenderOptions,
  color: Color3,
): Mesh | undefined {
  if (outline.length !== 4 || !isConvex([...outline])) return undefined;
  const longestEdge = longestPolygonEdge([...outline]);
  const order = [0, 1, 2, 3].map((offset) => (longestEdge + offset) % 4);
  const corners = order.map((index) => outline[index]);
  const left = midpoint(corners[3], corners[0]);
  const right = midpoint(corners[1], corners[2]);
  const vertices = [
    corners[1], corners[2], right,
    corners[3], corners[0], left,
  ].map((point, index) => ({
    x: point.x,
    y: (index === 2 || index === 5 ? peakElevation : eaveElevation) / options.metersPerUnit,
    z: point.z,
  }));
  const positions = vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]);
  const indices = [0, 1, 2, 3, 4, 5];
  const normals = new Array<number>(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = new Array<number>(vertices.length * 2).fill(0);
  const mesh = stageBuildingMesh(new Mesh("buildingGableWalls", scene));
  data.applyToMesh(mesh);
  setSolidVertexColor(mesh, color);
  return mesh;
}

function buildingAppearance(plan: BuildingPlan): BuildingAppearance {
  const profile = buildingProfile(plan.buildingClass);
  const palettes: Array<{ wall: string; roof: string }> = [
    { wall: "#d7d0c1", roof: "#655b52" },
    { wall: "#c89677", roof: "#74483a" },
    { wall: "#bdc3b5", roof: "#59645d" },
    { wall: "#d9c590", roof: "#6f5742" },
    { wall: "#bbc6cc", roof: "#4f5d64" },
    { wall: "#d3b6a7", roof: "#76524a" },
    { wall: "#e0ded5", roof: "#667079" },
    { wall: "#b8aa93", roof: "#5f5144" },
  ];
  const materialColors: Record<string, string> = {
    brick: "#a66f59",
    concrete: "#b9b7b1",
    cement_block: "#aaa9a3",
    glass: "#8299a3",
    metal: "#9da6a8",
    plaster: "#d8d2c5",
    stone: "#aaa08e",
    wood: "#a98263",
  };
  const palette = plan.buildingClass === "generic"
    ? palettes[Math.abs(plan.detailSeed) % palettes.length]
    : { wall: profile.wall, roof: profile.roof };
  const baseWall = parseBuildingColor(plan.wallColor) ??
    parseBuildingColor(plan.wallMaterial ? materialColors[plan.wallMaterial] : undefined) ??
    parseBuildingColor(palette.wall)!;
  const baseRoof = parseBuildingColor(plan.roofColor) ??
    parseBuildingColor(plan.roofMaterial ? materialColors[plan.roofMaterial] : undefined) ??
    parseBuildingColor(palette.roof)!;
  const wall = varyColor(
    baseWall,
    seededUnit(plan.detailSeed ^ 0x128fa3) - 0.5,
    seededUnit(plan.detailSeed ^ 0x74c921) - 0.5,
  );
  const roof = varyColor(
    baseRoof,
    seededUnit(plan.detailSeed ^ 0x5e219b) - 0.5,
    seededUnit(plan.detailSeed ^ 0x2794df) - 0.5,
  );
  return { wall, roof, trim: mixColor(wall, roof, 0.72) };
}

function parseBuildingColor(value: string | undefined): Color3 | undefined {
  if (!value) return undefined;
  const named: Record<string, string> = {
    beige: "#d8cfb5",
    black: "#242526",
    blue: "#6e8799",
    brown: "#806553",
    gray: "#a6a6a2",
    grey: "#a6a6a2",
    green: "#78907b",
    red: "#aa6256",
    silver: "#b8bcbb",
    white: "#e6e4dc",
    yellow: "#d8c77e",
  };
  let hexadecimal = named[value] ?? value;
  if (/^#[0-9a-f]{3}$/i.test(hexadecimal)) {
    hexadecimal = `#${hexadecimal[1]}${hexadecimal[1]}${hexadecimal[2]}${hexadecimal[2]}${hexadecimal[3]}${hexadecimal[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/i.test(hexadecimal)) return undefined;
  return new Color3(
    Number.parseInt(hexadecimal.slice(1, 3), 16) / 255,
    Number.parseInt(hexadecimal.slice(3, 5), 16) / 255,
    Number.parseInt(hexadecimal.slice(5, 7), 16) / 255,
  );
}

function colorBuildingMass(mesh: Mesh, appearance: BuildingAppearance): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions) return;
  const colors: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const normalX = normals?.[vertex * 3] ?? 0;
    const normalY = normals?.[vertex * 3 + 1] ?? 0;
    const normalZ = normals?.[vertex * 3 + 2] ?? 0;
    const base = normalY > 0.55 ? appearance.roof : appearance.wall;
    const light = normalY > 0.55
      ? 1
      : Math.max(0.7, Math.min(1.03, 0.84 + normalX * 0.11 - normalZ * 0.07));
    colors.push(
      clamp01(base.r * light),
      clamp01(base.g * light),
      clamp01(base.b * light),
      1,
    );
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.useVertexColors = true;
}

function colorReflectiveBuildingMass(mesh: Mesh, wall: Color3, roof: Color3): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions) return;
  const colors: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const normalX = normals?.[vertex * 3] ?? 0;
    const normalY = normals?.[vertex * 3 + 1] ?? 0;
    const normalZ = normals?.[vertex * 3 + 2] ?? 0;
    const base = normalY > 0.55 ? roof : wall;
    const light = normalY > 0.55
      ? 0.9
      : Math.max(0.72, Math.min(1.06, 0.9 + normalX * 0.1 - normalZ * 0.06));
    colors.push(
      clamp01(base.r * light),
      clamp01(base.g * light),
      clamp01(base.b * light),
      BUILDING_REFLECTIVE_MARKER_ALPHA,
    );
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.useVertexColors = true;
}

function colorRoofMesh(mesh: Mesh, color: Color3): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions) return;
  const colors: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const normalX = Math.abs(normals?.[vertex * 3] ?? 0);
    const normalZ = Math.abs(normals?.[vertex * 3 + 2] ?? 0);
    const light = 0.86 + normalX * 0.08 + normalZ * 0.04;
    colors.push(color.r * light, color.g * light, color.b * light, 1);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.useVertexColors = true;
}

function setSolidVertexColor(mesh: Mesh, color: Color3): void {
  const count = mesh.getTotalVertices();
  const colors = new Array<number>(count * 4);
  for (let vertex = 0; vertex < count; vertex++) {
    colors[vertex * 4] = color.r;
    colors[vertex * 4 + 1] = color.g;
    colors[vertex * 4 + 2] = color.b;
    colors[vertex * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.useVertexColors = true;
}

/** Babylon requires every source mesh in a merge to expose the same buffers. */
function normalizeBuildingMergeAttributes(meshes: readonly Mesh[]): void {
  for (const mesh of meshes) {
    const vertexCount = mesh.getTotalVertices();
    if (!mesh.getVerticesData(VertexBuffer.NormalKind)) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      const indices = mesh.getIndices();
      if (positions && indices) {
        const normals = new Array<number>(positions.length).fill(0);
        VertexData.ComputeNormals(positions, indices, normals);
        mesh.setVerticesData(VertexBuffer.NormalKind, normals);
      }
    }
    if (!mesh.getVerticesData(VertexBuffer.UVKind)) {
      mesh.setVerticesData(VertexBuffer.UVKind, new Array<number>(vertexCount * 2).fill(0));
    }
    if (!mesh.getVerticesData(VertexBuffer.ColorKind)) {
      const colors = new Array<number>(vertexCount * 4).fill(1);
      mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    }
  }
}

function seededUnit(seed: number): number {
  let value = seed | 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function pointDistance(a: ScenePoint, b: ScenePoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function longestPolygonEdge(points: ScenePoint[], excluded: ReadonlySet<number> = new Set()): number {
  let longest = -1;
  for (let index = 0; index < points.length; index++) {
    if (excluded.has(index)) continue;
    if (
      longest < 0 || pointDistance(points[index], points[(index + 1) % points.length]) >
      pointDistance(points[longest], points[(longest + 1) % points.length])
    ) {
      longest = index;
    }
  }
  return longest >= 0 ? longest : 0;
}

/** Expands a counter-clockwise convex ring to create a physical roof eave. */
function offsetConvexPolygon(points: ScenePoint[], distance: number): ScenePoint[] {
  return points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const incomingLength = pointDistance(previous, point) || 1;
    const outgoingLength = pointDistance(point, next) || 1;
    const incomingNormal = {
      x: (point.z - previous.z) / incomingLength,
      z: -(point.x - previous.x) / incomingLength,
    };
    const outgoingNormal = {
      x: (next.z - point.z) / outgoingLength,
      z: -(next.x - point.x) / outgoingLength,
    };
    // Intersect the two translated wall lines. This keeps every roof edge a
    // true parallel offset of its corresponding wall, including skewed and
    // acute footprints. A capped miter moves the corner off both lines and
    // leaves visible sections of the house outside the roof.
    const incomingStart = {
      x: previous.x + incomingNormal.x * distance,
      z: previous.z + incomingNormal.z * distance,
    };
    const incomingEnd = {
      x: point.x + incomingNormal.x * distance,
      z: point.z + incomingNormal.z * distance,
    };
    const outgoingStart = {
      x: point.x + outgoingNormal.x * distance,
      z: point.z + outgoingNormal.z * distance,
    };
    const outgoingEnd = {
      x: next.x + outgoingNormal.x * distance,
      z: next.z + outgoingNormal.z * distance,
    };
    const intersection = lineIntersection(
      incomingStart,
      incomingEnd,
      outgoingStart,
      outgoingEnd,
    );
    return intersection ?? outgoingStart;
  });
}

function lineIntersection(
  a: ScenePoint,
  b: ScenePoint,
  c: ScenePoint,
  d: ScenePoint,
): ScenePoint | undefined {
  const abX = b.x - a.x;
  const abZ = b.z - a.z;
  const cdX = d.x - c.x;
  const cdZ = d.z - c.z;
  const denominator = abX * cdZ - abZ * cdX;
  if (Math.abs(denominator) < 1e-8) return undefined;
  const amount = ((c.x - a.x) * cdZ - (c.z - a.z) * cdX) / denominator;
  return { x: a.x + abX * amount, z: a.z + abZ * amount };
}

function midpoint(a: ScenePoint, b: ScenePoint): ScenePoint {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

function lerpPoint(a: ScenePoint, b: ScenePoint, amount: number): ScenePoint {
  return { x: a.x + (b.x - a.x) * amount, z: a.z + (b.z - a.z) * amount };
}

function addRoofFace(indices: number[], face: number[]): void {
  for (let index = 1; index < face.length - 1; index++) {
    indices.push(face[0], face[index + 1], face[index]);
  }
}

function isConvex(points: ScenePoint[]): boolean {
  if (points.length < 3) return false;
  let direction = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const c = points[(index + 2) % points.length];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) < 1e-8) continue;
    const sign = Math.sign(cross);
    if (direction !== 0 && sign !== direction) return false;
    direction = sign;
  }
  return direction !== 0;
}

function polygonCentroid(points: ScenePoint[]): ScenePoint {
  let area = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    const cross = points[index].x * next.z - next.x * points[index].z;
    area += cross;
    x += (points[index].x + next.x) * cross;
    z += (points[index].z + next.z) * cross;
  }
  return Math.abs(area) < 1e-8
    ? averagePoint(points)
    : { x: x / (3 * area), z: z / (3 * area) };
}

function polygonBounds(points: ScenePoint[]): Bounds {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minZ: Math.min(bounds.minZ, point.z),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function clipPolygon(points: ScenePoint[], bounds: Bounds): ScenePoint[] {
  const edges: Array<{
    inside: (point: ScenePoint) => boolean;
    intersect: (start: ScenePoint, end: ScenePoint) => ScenePoint;
  }> = [
    { inside: (point) => point.x >= bounds.minX, intersect: (a, b) => atX(a, b, bounds.minX) },
    { inside: (point) => point.x <= bounds.maxX, intersect: (a, b) => atX(a, b, bounds.maxX) },
    { inside: (point) => point.z >= bounds.minZ, intersect: (a, b) => atZ(a, b, bounds.minZ) },
    { inside: (point) => point.z <= bounds.maxZ, intersect: (a, b) => atZ(a, b, bounds.maxZ) },
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

function atX(start: ScenePoint, end: ScenePoint, x: number): ScenePoint {
  const amount = (x - start.x) / (end.x - start.x);
  return { x, z: start.z + amount * (end.z - start.z) };
}

function atZ(start: ScenePoint, end: ScenePoint, z: number): ScenePoint {
  const amount = (z - start.z) / (end.z - start.z);
  return { x: start.x + amount * (end.x - start.x), z };
}

function signedArea(points: ScenePoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.z - next.x * points[index].z;
  }
  return area / 2;
}

function averagePoint(points: ScenePoint[]): ScenePoint {
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
    { x: 0, z: 0 },
  );
  return { x: total.x / points.length, z: total.z / points.length };
}

function samePoint(a: ScenePoint, b: ScenePoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

function mixColor(a: Color3, b: Color3, amount: number): Color3 {
  return new Color3(
    a.r + (b.r - a.r) * amount,
    a.g + (b.g - a.g) * amount,
    a.b + (b.b - a.b) * amount,
  );
}

function varyColor(color: Color3, tone: number, warmth: number): Color3 {
  const light = 1 + tone * 0.16;
  return new Color3(
    clamp01(color.r * light + warmth * 0.035),
    clamp01(color.g * light + warmth * 0.008),
    clamp01(color.b * light - warmth * 0.025),
  );
}

function stageBuildingMesh<T extends Mesh>(mesh: T): T {
  mesh.setEnabled(false);
  return mesh;
}
