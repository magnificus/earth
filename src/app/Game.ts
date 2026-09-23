import { monitorRenderHealth } from "../diagnostics/RenderHealth";
import { TileGeneration } from "../world/TileGeneration";
import { captureTileMeshes, installTileGenerationDebug } from "../diagnostics/TileGenerationCapture";
import { encounteredBuildingLayouts } from "../buildings/BuildingLayoutDebugCapture";
import type { BuildingPlan } from "../buildings/BuildingPlanner";
import {
  AbstractEngine,
  BaseTexture,
  Constants,
  RenderTargetTexture,
  Ray,
  Scene,
  SSRRenderingPipeline,
  TAARenderingPipeline,
  FxaaPostProcess,
  PostProcess,
  UniversalCamera,
  Vector3,
  Color4,
  Mesh,
  KeyboardEventTypes,
} from "@babylonjs/core";
import type { TerrainData } from "../terrain/TerrainData";
import { pointInRing } from "../core/PlanarGeometry";
import type { PlannedBuildingSite } from "../roads/RoadAndBuildingPlanner";
import { enableTerrainCollisions } from "../terrain/TerrainCollision";
import { prepareSceneForReveal } from "../rendering/SceneReadiness";
import { registerStaticMeshCandidates } from "../rendering/StaticMeshCandidates";
import { StaticMeshBatches } from "../rendering/StaticMeshBatches";
import { loadAntialiasing, saveAntialiasing } from "../rendering/Antialiasing";
import { createToneMappingPass } from "../rendering/ToneMapping";
import type { AntialiasingMode } from "../rendering/Antialiasing";
import { TerrainElevationSource } from "../terrain/TerrainElevationSource";
import { applyTerrainDetail, upsampleTerrain } from "../terrain/TerrainDetail";
import { stitchTerrainEdges } from "../terrain/TerrainStitching";
import { carveTerrainWaterways } from "../terrain/TerrainWaterways";
import { createWaterPlane, disposeWaterPlane } from "../water/Water";
import {
  createTerrainLakeLayer,
  LAKE_SURFACE_CLEARANCE_METERS,
  disposeTerrainLakeLayer,
} from "../terrain/TerrainLakeSurface";
import {
  conformTerrainToLakePolygons,
  LAKE_TERRAIN_CONTEXT_METERS,
  measureLakeSupport,
} from "../terrain/TerrainLakePolygons";
import type { TerrainLakePolygon, TerrainLakeSource } from "../terrain/TerrainLakePolygons";
import { createTreeField } from "../vegetation/TreeField";
import {
  resolveTreeTrunkCollisions,
  type TreeTrunk,
  type WalkerBody,
} from "../vegetation/TreeTrunkCollision";
import { createGrassField } from "../vegetation/GrassField";
import { setVegetationFieldDetailDistance } from "../vegetation/VegetationMaterial";
import { createBushField } from "../vegetation/BushField";
import { createSaplingField } from "../vegetation/SaplingField";
import { createFernField } from "../vegetation/FernField";
import { createTallPlantField } from "../vegetation/TallPlantField";
import { createWheatField } from "../vegetation/WheatField";
import { createRockyBeachField } from "../vegetation/RockyBeachField";
import { createRockField } from "../vegetation/RockField";
import { proceduralActorMixAtTile } from "../procedural/ProceduralActorMix";
import {
  createBrowserWorldLocationStore,
  EXAMPLE_LOCATIONS,
  randomLandWorldLocation,
} from "../world/Locations";
import type { WorldLocation, WorldLocationStore } from "../world/Locations";
import {
  combineHorizontalExclusionMasks,
  PolygonExclusionMask,
  SegmentExclusionMask,
  geographicFrameOffset,
  lonLatToScene,
  sampleElevation,
  sceneToLonLat,
  sinkSubmergedTerrain,
} from "../world/Geo";
import type { SceneGeographicFrame } from "../world/Geo";
import { OpenStreetMap } from "../world/OpenStreetMap";
import { RoadPlanningWorker } from "../roads/RoadPlanningWorker";
import { LakeCollectionWorker } from "../water/LakeCollectionWorker";
import { BuildingPlanningWorker } from "../buildings/BuildingPlanningWorker";
import { BuildingCompositionWorker } from "../buildings/BuildingCompositionWorker";
import type { RoadAndBuildingPlan } from "../roads/RoadAndBuildingPlanner";
import { OwnedValueCache } from "../core/OwnedValueCache";
import type { MapTile } from "../world/OpenStreetMap";
import { OpenStreetMapBarriers } from "../world/OpenStreetMapBarriers";
import { StreetLamps } from "../roads/StreetLamps";
import { LandCoverClass, WorldCover } from "../world/WorldCover";
import type { LandCoverSampler } from "../world/WorldCover";
import { disposeTerrainMesh } from "../terrain/TerrainMaterial";
import { createTerrainMesh as buildTerrainMesh, setTerrainSnowCover, terrainSnowCover } from "../terrain/TerrainMesh";
import { setHierarchySnowCover } from "../rendering/SnowCover";
import { TerrainSurface } from "../terrain/TerrainSurface";
import { configureWindSceneScale, setManualWindSpeed } from "../vegetation/Wind";
import { SolarLighting } from "../sky/SolarLighting";
import { groundCoverUnderSnow, snowCoverAt, snowCoverTier, treeSeasonAt } from "../vegetation/TreeSeason";
import { createCloudLayer } from "../sky/Clouds";
import type { CloudLayer } from "../sky/Clouds";
import { FpsCounter } from "../diagnostics/FpsCounter";
import {
  createFrameBudgetYielder,
  documentIsBackgrounded,
  FrameBudgetYielder,
  waitForNextFrame,
} from "../diagnostics/FrameBudget";
import {
  PLAYER_HEIGHT_METERS,
  PLAYER_RADIUS_METERS,
  PlayerControls,
  WALK_MAX_STEP_UP_METERS,
  WALK_SURFACE_PROBE_DEPTH_METERS,
} from "./PlayerControls";
import { LayerFades } from "../rendering/LayerFades";
import {
  disposeStreamedTile,
  disposeTileDetail,
  setFrozenMeshOffset,
  setMapLayerFade,
  setTransformNodeOffset,
  VEGETATION_FIELD_KINDS,
} from "../world/StreamedTile";
import type { StreamedTile, VegetationFieldKind } from "../world/StreamedTile";
import { StreamingTrace } from "../diagnostics/StreamingDiagnostics";
import { setCooperativeCaptureBudget } from "../rendering/Impostor";
import { creationStats } from "../diagnostics/CreationStats";
import {
  VegetationFieldResult,
  VegetationLodDebugStats,
  VegetationRenderMode,
} from "../vegetation/VegetationField";
import { SceneControls } from "./SceneControls";
import { createBrowserSceneSettingsStore } from "./SceneSettings";
import type {
  SceneSettingKey,
  SceneSettings,
  SceneSettingsStore,
} from "./SceneSettings";
import {
  ClockMode,
  ClockSettingsStore,
  createBrowserClockSettingsStore,
} from "./ClockSettings";
import {
  DEFAULT_WORLD_SEED,
  layerSeed,
  WORLD_GRID_LEVEL,
  worldTileArea,
  worldTileAtLocation,
  worldTileBounds,
  worldTileCoordinatesAtLocation,
  worldTileIntersectsCircle,
  worldTileKey,
} from "../world/WorldGrid";
import type { WorldTileId } from "../world/WorldGrid";
import { PlayerPresence } from "../integration/PlayerPresence";
import type {
  GameIntegrationOptions,
  LocalPlayerTransform,
} from "../integration/PlayerPresence";
import type { PlayerPose } from "../integration/GameProtocol";

export type { GameIntegrationOptions } from "../integration/PlayerPresence";

type VegetationCategory = "trees" | "grass" | "bushes";
type VegetationModes = Record<VegetationCategory, VegetationRenderMode>;
interface VegetationFieldConfig {
  category: VegetationCategory;
}
const VEGETATION_FIELD_CONFIG: Readonly<Record<VegetationFieldKind, VegetationFieldConfig>> = {
  treeField: { category: "trees" },
  saplingField: { category: "trees" },
  grassField: { category: "grass" },
  tallPlantField: { category: "grass" },
  wheatField: { category: "grass" },
  rockyBeachField: { category: "grass" },
  bushField: { category: "bushes" },
  fernField: { category: "grass" },
};
/** Dense mature grass is costly as geometry and only needs close-up detail. */
const GRASS_MODEL_RANGE_CAP_METERS = 8;
/** One world tile spans this many scene units in the stable frame. */
const TILE_MESH_WIDTH_UNITS = 25;
/** Share of that horizon the view stays clear before fog takes over. */
const FOG_START_FRACTION = 0.6;
/** Built tiles cool down for this long after leaving the radius before disposal. */
const TILE_COOLDOWN_MS = 30_000;
const DETAIL_COOLDOWN_MS = 10_000;
// Streamed main-thread work per frame: the default slice when frames are
// busy, up to a cap that still leaves room for input and compositing.
const STREAMING_BUDGET_MINIMUM_MS = 2;
const STREAMING_BUDGET_MAXIMUM_MS = 8;
const STREAMING_BUDGET_SPARE_SHARE = 0.5;
// Far tiles spend most of their build waiting on workers, network and frame
// slices, so a few may overlap. Main-thread slices stay bounded by the shared
// frame budget, and shared edge, lake and building elevations are claimed
// synchronously, so overlapping neighbours still agree. Detail builds carry
// far heavier main-thread work and build alone.
const MAX_CONCURRENT_FAR_TILE_BUILDS = 2;
/** One departing row/column may cool down; older off-window tiles are evicted. */
const RETAINED_TILE_EDGE_SLACK = 2;
/** Terrain resolution for tiles beyond the detail rings. */
const FAR_TILE_SUBDIVISIONS = 16;
/**
 * Native tiles double the provider raster so procedural relief has vertices to
 * live on: one vertex roughly every 1.2 to 2.4 m instead of 2.5 to 5 m.
 */
const NATIVE_TERRAIN_UPSAMPLE_FACTOR = 2;
const TERRAIN_STREAMING_CHECK_INTERVAL_MS = 250;
/** No stem is wider than this, so tiles farther away cannot touch the walker. */
const TREE_TRUNK_REACH_METERS = 2;
export type InitializationProgress = (step: string, progress: number) => void;

export class Game {
  private canvas: HTMLCanvasElement;
  private engine: AbstractEngine;
  private scene: Scene;
  private readonly staticBatches: StaticMeshBatches;
  private water?: Mesh;
  private readonly tiles = new Map<string, StreamedTile>();
  private readonly activeTileBuilds = new Map<string, number>();
  private readonly activeDetailBuilds = new Set<string>();
  private readonly terrainEdgeElevations = new OwnedValueCache<string, number>();
  private readonly lakeElevations = new OwnedValueCache<string, number>();
  /** `?lake-debug` logs where rendered ground fails to carry a mapped lake outline. */
  private readonly lakeDebug: boolean;
  private readonly captureTileGeneration: ReturnType<typeof installTileGenerationDebug>;
  private readonly buildingElevations = new OwnedValueCache<string, number>();
  private readonly layerFades: LayerFades;
  private streamingGeneration = 0;
  private readonly roadPlanningWorker = new RoadPlanningWorker();
  private readonly lakeCollectionWorker = new LakeCollectionWorker();
  private readonly buildingPlanningWorker = new BuildingPlanningWorker();
  private readonly buildingCompositionWorker = new BuildingCompositionWorker();
  /** Streaming CPU work yields when it has consumed its frame slice. */
  // Streaming slices grow while frames have spare time and shrink to the
  // default slice when the render callback itself fills the frame.
  private streamingBudgetMilliseconds = STREAMING_BUDGET_MINIMUM_MS;
  private frameIntervalEstimateMilliseconds = 1000 / 60;
  private frameCallbackEstimateMilliseconds = 0;
  private lastFrameStartMilliseconds?: number;
  private terrainStreamingTimer?: ReturnType<typeof setInterval>;
  private readonly streamingYielder = createFrameBudgetYielder(() => this.streamingBudgetMilliseconds);
  private cameraTileKey?: string;
  private readonly gridLevel = WORLD_GRID_LEVEL;
  private readonly worldSeed: number;
  private readonly renderScale: number;
  private readonly sceneSettings: SceneSettingsStore;
  private readonly clockSettings: ClockSettingsStore;
  private readonly worldLocation: WorldLocationStore;
  private reloadingLocation = false;
  private lastTerrainStreamingCheckMilliseconds = 0;
  private solarLighting?: SolarLighting;
  private cloudLayer?: CloudLayer;
  private readonly cloudsEnabled: boolean;
  private readonly initialDate?: string;
  private readonly initialTimeOfDay?: number;
  /** Date used by the current generation of seasonal scenery. */
  private vegetationDate?: Date;
  private sceneryRevision = 0;
  private readonly fpsCounter: FpsCounter;
  private readonly vegetationModes: VegetationModes;
  private sceneControls?: SceneControls;
  private readonly waterReflectionsEnabled: boolean;
  private screenSpaceReflections?: SSRRenderingPipeline;
  private antialiasingMode: AntialiasingMode;
  private temporalAA?: TAARenderingPipeline;
  private antialiasingPass?: FxaaPostProcess;
  private toneMappingPass?: PostProcess;
  private flyCamera?: UniversalCamera;
  private playerControls?: PlayerControls;
  private terrainCoordinateFrame?: SceneGeographicFrame;
  private terrainMetersPerUnit?: number;
  private lastVegetationLodDebugLogMilliseconds = 0;
  private readonly playerPresence: PlayerPresence;

  private readonly handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) this.playerPresence.dispose();
  };

  constructor(
    canvas: HTMLCanvasElement,
    engine: AbstractEngine,
    integration?: GameIntegrationOptions,
  ) {
    this.canvas = canvas;
    this.engine = engine;
    const query = new URLSearchParams(window.location.search);
    this.lakeDebug = query.has("lake-debug");
    this.captureTileGeneration = installTileGenerationDebug(query);
    const forceReverseDepth = ["1", "on", "true", "force"].includes(
      query.get("reverse-depth")?.toLowerCase() ?? "",
    );
    // Babylon 7's WebGPU path is first exercised with conventional depth.
    // Reverse depth can be isolated explicitly once the base renderer is sound.
    this.engine.useReverseDepthBuffer = !this.engine.isWebGPU || forceReverseDepth;
    this.scene = new Scene(this.engine);
    this.staticBatches = new StaticMeshBatches(this.scene);
    monitorRenderHealth(this.scene);
    this.antialiasingMode = loadAntialiasing(query);
    if (this.antialiasingMode === "taa" && !this.engine.getCaps().texelFetch) {
      this.antialiasingMode = "msaa";
    }
    this.layerFades = new LayerFades({
      refreshShadows: () => this.solarLighting?.refreshShadows(),
      refreshShadowsDuringFade: () => {
        if (!this.engine.isWebGPU) this.solarLighting?.refreshShadows();
      },
    });
    this.playerPresence = new PlayerPresence(this.scene, integration);
    window.addEventListener("pagehide", this.handlePageHide);
    // The app does not use hover picking. Skipping the implicit ray cast keeps
    // pointer movement from competing with rendering on slower CPUs.
    this.scene.skipPointerMovePicking = true;
    this.scene.collisionsEnabled = true;
    this.worldSeed = queryInteger(
      query,
      "seed",
      DEFAULT_WORLD_SEED,
      -2_147_483_648,
      2_147_483_647,
    );
    this.renderScale = queryNumber(query, "render-scale", 1, 0.25, 1);
    this.sceneSettings = createBrowserSceneSettingsStore(query);
    setManualWindSpeed(this.sceneSettings.value.windSpeedMetersPerSecond);
    this.clockSettings = createBrowserClockSettingsStore(query);
    this.worldLocation = createBrowserWorldLocationStore(EXAMPLE_LOCATIONS[0]);
    this.engine.setHardwareScalingLevel(1 / this.renderScale);
    this.fpsCounter = new FpsCounter(
      this.scene,
      query.has("performance-debug") || query.has("perf"),
      { renderScale: this.renderScale },
    );
    const requestedMode = query.get("vegetation");
    const initialMode: VegetationRenderMode = requestedMode === "models" || requestedMode === "impostors"
      ? requestedMode
      : "auto";
    this.vegetationModes = {
      trees: initialMode,
      grass: initialMode === "impostors" ? "impostors" : "auto",
      bushes: initialMode === "impostors" ? "impostors" : "auto",
    };
    const reflectionSetting = query.get("reflections")?.toLowerCase() ?? "";
    const reflectionsRequested = !["0", "off", "false"].includes(reflectionSetting);
    const forceWebGPUReflections = ["1", "on", "true", "force"].includes(
      reflectionSetting,
    );
    // SSR owns the final full-screen pass, so keep it out of the initial
    // WebGPU compatibility baseline instead of letting a failed pass hide an
    // otherwise valid scene. `reflections=force` isolates it when needed.
    this.waterReflectionsEnabled = reflectionsRequested &&
      (!this.engine.isWebGPU || forceWebGPUReflections);
    this.cloudsEnabled = !["0", "off", "false"].includes(
      query.get("clouds")?.toLowerCase() ?? "",
    );
    const clock = this.clockSettings.value;
    this.initialDate = clock.mode === "manual" ? clock.manualDate : undefined;
    this.initialTimeOfDay = clock.mode === "manual" ? clock.manualTimeOfDay : undefined;
  }

  private get terrainTileRadius(): number {
    return (this.sceneSettings.value.terrainTilesAcross - 1) / 2;
  }

  private get vegetationLodDistanceMeters(): number {
    return this.sceneSettings.value.modelRangeMeters;
  }

  private get cloudDensity(): number {
    return this.sceneSettings.value.cloudDensity;
  }

  private get movementMode(): PlayerPose["movementMode"] {
    return this.playerControls?.movementMode ?? "fly";
  }

  async initialize(onProgress?: InitializationProgress): Promise<void> {
    await reportInitializationProgress(onProgress, "Preparing the scene", 3);
    // Set scene background
    this.scene.clearColor = new Color4(0.02, 0.02, 0.05, 1);

    // Create fly camera with WASD controls. The spawn stays well inside the
    // loaded window's central tile so startup does not immediately trigger a
    // terrain streaming pass.
    const camera = new UniversalCamera(
      "camera",
      new Vector3(0, 5, -6),
      this.scene,
    );
    camera.setTarget(Vector3.Zero());
    camera.attachControl(this.canvas, true);

    camera.speed = 0.5;
    camera.angularSensibility = 1000;
    this.flyCamera = camera;
    this.playerControls = new PlayerControls({
      canvas: this.canvas,
      engine: this.engine,
      scene: this.scene,
      camera,
      getMetersPerUnit: () => this.terrainMetersPerUnit,
      getGroundEyeHeight: (x, z, referenceEyeHeight) => (
        this.getGroundEyeHeight(x, z, referenceEyeHeight)
      ),
      isScenePositionLoaded: (x, z) => this.tileAtScenePosition(x, z) !== undefined,
      resolveTreeTrunkCollisions: (body) => this.resolveTreeTrunkCollisions(body),
      isMenuOpen: () => this.sceneControls?.isOpen ?? false,
      onPointerLockExit: () => {
        if (!this.sceneControls?.isOpen) this.sceneControls?.setMenuOpen(true);
      },
    });

    const presenceSession = await this.playerPresence.connect(
      this.worldLocation.value,
      this.worldLocation.pendingDestination,
    );
    const location = presenceSession.location;
    this.solarLighting = new SolarLighting(
      this.scene,
      location.lat,
      location.lon,
    );
    this.solarLighting.setDate(this.initialDate);
    this.solarLighting.setTimeOfDay(this.initialTimeOfDay);
    this.vegetationDate = this.solarLighting.currentDate;
    if (this.waterReflectionsEnabled) this.enableWaterReflections(camera);
    this.applyAntialiasing(camera);

    // Wait for the full-detail inner window; far terrain streams after spawn.
    await this.startWorld(location, onProgress);
    if (presenceSession.restoredPose) this.playerControls.applyRestoredPose(presenceSession.restoredPose);
    this.publishLocalPlayerPose(true);
    this.worldLocation.completeDestination();
    await reportInitializationProgress(onProgress, "Setting up controls", 98);
    this.sceneControls = new SceneControls({
      antialiasing: this.antialiasingMode,
      temporalAASupported: this.engine.getCaps().texelFetch,
      onAntialiasingChange: (mode) => {
        this.antialiasingMode = mode;
        this.applyAntialiasing(camera);
        saveAntialiasing(mode);
      },
      settings: this.sceneSettings.value,
      clockSettings: this.clockSettings.value,
      initialLocation: location,
      onSettingChange: (key, value) => this.changeSceneSetting(key, value),
      onRoofsVisibilityChange: (visible) => this.changeRoofsVisibility(visible),
      onClockModeChange: (mode) => this.changeClockMode(mode),
      onDateChange: (date) => {
        this.clockSettings.setManualDate(date);
        if (this.clockSettings.value.mode === "manual") {
          this.solarLighting?.setDate(date);
          this.refreshSeasonalScenery();
        }
      },
      onTimeOfDayChange: (hours) => {
        this.clockSettings.setManualTimeOfDay(hours);
        if (this.clockSettings.value.mode === "manual") this.solarLighting?.setTimeOfDay(hours);
      },
      onLocationChange: (target) => this.changeToCoordinates(target),
      onRandomLocation: () => this.changeToRandomTerrainLocation(),
      onMenuOpenChange: (isOpen) => this.setMenuOpen(isOpen),
    });
    this.setupDebugControls();
    await reportInitializationProgress(onProgress, "Preparing the first frame", 99);
    await prepareSceneForReveal(this.scene);
    await reportInitializationProgress(onProgress, "Ready", 100);
  }

  /** Clears every streamed tile and starts a fresh world around a location. */
  private async startWorld(
    target: WorldLocation,
    onProgress?: InitializationProgress,
  ): Promise<void> {
    const generation = ++this.streamingGeneration;
    this.roadPlanningWorker.reset();
    this.lakeCollectionWorker.reset();
    this.buildingPlanningWorker.reset();
    this.buildingCompositionWorker.reset();
    this.resetCameraForWorldChange();
    this.cloudLayer?.dispose();
    this.cloudLayer = undefined;
    this.disposeAllTiles();
    this.terrainEdgeElevations.clear();
    this.lakeElevations.clear();
    this.buildingElevations.clear();
    this.terrainCoordinateFrame = undefined;
    this.terrainMetersPerUnit = undefined;
    this.solarLighting?.setLocation(target.lat, target.lon);
    await reportInitializationProgress(onProgress, "Loading terrain elevation", 10);
    const centerTile = worldTileAtLocation(target.lat, target.lon, this.gridLevel);
    // Establish the geographic frame and camera before preparing nearby LODs.
    await this.streamTile(
      centerTile,
      true,
      generation,
      (step, progress) => onProgress?.(step, 10 + progress * 0.25),
      () => this.placeCameraAtLocation(target),
    );
    // Only the centre tile gates the spawn. The surrounding detail window
    // streams in behind the player once the render loop runs, ordered by
    // distance, instead of holding the loading screen for every tile.
    await reportInitializationProgress(onProgress, "Spawn tile ready", 96);
    this.layerFades.finish();
    this.worldLocation.update(target);
    this.sceneControls?.setLocation(target);
    if (this.terrainCoordinateFrame && this.terrainMetersPerUnit) {
      this.playerPresence.setWorldFrame(this.terrainCoordinateFrame, this.terrainMetersPerUnit);
    }
  }

  /** Drops movement carried over from the outgoing world's local frame. */
  private resetCameraForWorldChange(): void {
    this.playerPresence.clearWorldFrame();
    this.playerControls?.resetForWorldChange();
  }

  /** Brings one tile to the requested state (terrain, then optional detail). */
  private async streamTile(
    id: WorldTileId,
    wantDetail: boolean,
    generation: number,
    onProgress?: InitializationProgress,
    onTerrainReady?: () => void,
    terrainOnly = false,
  ): Promise<void> {
    const key = worldTileKey(id);
    if (this.activeTileBuilds.has(key)) return;
    this.activeTileBuilds.set(key, generation);
    if (wantDetail) this.activeDetailBuilds.add(key);
    const trace = new StreamingTrace(`tile=${key} detail=${wantDetail}`);
    let record = this.tiles.get(key);
    try {
      if (!record || (wantDetail && !record.nativeTerrain) ||
          (!wantDetail && record.nativeTerrain && !record.detailed)) {
        trace.stage("terrain");
        record = await this.buildTileTerrain(id, wantDetail, generation, onProgress, trace);
      }
      if (!record) return;
      if (generation !== this.streamingGeneration) return;
      if (record.sceneryRevision !== this.sceneryRevision) {
        // Date/roof edits only affect appearance and generated objects. Keep
        // the elevation, collision surface, map data, water and road plan.
        disposeTileDetail(record);
        record.farTreeField?.root.dispose(false, false);
        record.farTreeField = undefined;
        if (record.farBuildings) OpenStreetMap.disposeLayer(record.farBuildings);
        record.farBuildings = undefined;
        record.sceneryRevision = this.sceneryRevision;
      }
      if (generation === this.streamingGeneration) onTerrainReady?.();
      if (wantDetail && !record.detailed) {
        try {
          trace.stage("detail (vegetation, LOD preparation, map features)");
          await this.buildTileDetail(record, generation, onProgress, trace);
        } catch (error: unknown) {
          record.generationStages.abort(error);
          // Detail is assembled in stages. Keep anything that did finish
          // visible when one optional feature compiler fails, instead of
          // leaving a successfully loaded destination as bare terrain.
          console.error(`Failed to build detail for tile ${key}.`, error);
          if (generation === this.streamingGeneration) {
            await this.activateTileVegetation(record, generation);
          }
        }
      } else if (!wantDetail && !terrainOnly) {
        // Runs for undetailed tiles, and for detailed tiles the scheduler
        // queued ahead of a demotion (the stand-ins commit hidden there).
        trace.stage("far trees (including exclusion mask)");
        if (!record.farTreeField) await this.buildFarTrees(record, generation);
        else {
          const field = record.farTreeField;
          record.generationStages.begin("vegetation");
          record.generationStages.finish("vegetation", () => ({ terrain: record!.terrainData,
            frame: { meshWidth: record!.meshWidth, meshDepth: record!.meshDepth, metersPerUnit: this.terrainMetersPerUnit! },
            placements: [{ kind: "farTrees", count: field.count, matrices: field.instanceMatrices }],
          }), "Retained far trees from an earlier tile revision");
        }
        trace.stage("far buildings");
        if (!record.farBuildings) await this.buildFarBuildings(record, generation);
        else this.captureRetainedFarLayer(record, "farBuildings");
        trace.stage("far roads");
        if (!record.farRoads) await this.buildFarRoads(record, generation);
        else this.captureRetainedFarLayer(record, "farRoads");
        if (generation !== this.streamingGeneration) return;
        if (!record.nativeTerrain) {
          record.generationStages.begin("props");
          record.generationStages.finish("props", () => ({
            terrain: record!.terrainData,
            frame: { meshWidth: record!.meshWidth, meshDepth: record!.meshDepth, metersPerUnit: this.terrainMetersPerUnit! },
            plan: record!.roadAndBuildingPlan,
          }), "Far tiles defer lamps and plot boundaries");
        }
      }
    } catch (error) {
      record?.generationStages.abort(error);
      throw error;
    } finally {
      record?.generationStages.abort("Tile build ended before this stage completed", generation !== this.streamingGeneration);
      trace.finish();
      if (this.activeTileBuilds.get(key) === generation) {
        this.activeTileBuilds.delete(key);
        this.activeDetailBuilds.delete(key);
      }
    }
  }

  private async buildTileTerrain(
    id: WorldTileId,
    native: boolean,
    generation: number,
    onProgress?: InitializationProgress,
    trace?: StreamingTrace,
  ): Promise<StreamedTile | undefined> {
    const key = worldTileKey(id);
    const sharedElevationOwner = {};
    let retainSharedElevations = false;
    const capture = this.captureTileGeneration(key, native, this.worldSeed);
    const stages = new TileGeneration(capture?.record);
    stages.begin("sources");
    try {
    const previous = this.tiles.get(key);
    const area = worldTileArea(id, this.worldSeed);
    const yieldControl = onProgress ? undefined : this.streamingYielder;
    // Map data does not depend on elevation; overlap its download with the DEM.
    const mapTiles = previous?.mapTiles ?? this.requestMapTiles(area.bounds);
    trace?.stage("elevation fetch/resample");
    const sourceTerrain = await TerrainElevationSource.fetchWorldArea(area, yieldControl);
    if (generation !== this.streamingGeneration) return undefined;
    // Native tiles carry relief finer than the provider raster, so they need
    // the vertices to hold it. Far tiles only ever render a coarse subset.
    const terrainData = native
      ? upsampleTerrain(sourceTerrain, NATIVE_TERRAIN_UPSAMPLE_FACTOR)
      : sourceTerrain;
    const subdivisions = Math.max(
      1,
      native
        ? terrainData.width - 1
        : Math.min(FAR_TILE_SUBDIVISIONS, terrainData.width - 1),
    );
    const lakeContextTiles = previous?.lakeContextTiles ?? this.requestMapTiles(expandTerrainBounds(
      terrainData,
      LAKE_TERRAIN_CONTEXT_METERS,
    ));
    const landCoverRequest = previous?.landCover
      ? Promise.resolve(previous.landCover)
      : WorldCover.fetchForTerrain(terrainData).catch((error: unknown) => {
        console.warn("LCM-10 unavailable; land-cover layers were skipped.", error);
        return undefined;
      });
    await reportInitializationProgress(onProgress, "Loading land cover", 24);
    trace?.stage("land cover fetch");
    const landCover = await landCoverRequest;
    if (generation !== this.streamingGeneration) return undefined;
    trace?.stage("map and lake context fetch");
    const [lakeTiles, contextTiles] = await Promise.all([mapTiles, lakeContextTiles]);
    if (generation !== this.streamingGeneration) return undefined;
    const surfaceLandCover = OpenStreetMap.createLandCoverSampler(contextTiles, landCover);
    // The first tile of a world anchors the stable coordinate frame; every
    // later tile is projected into it so offsets stay exact while streaming.
    if (!this.terrainCoordinateFrame || !this.terrainMetersPerUnit) {
      const metersPerUnit = terrainData.groundWidthMeters / TILE_MESH_WIDTH_UNITS;
      this.terrainMetersPerUnit = metersPerUnit;
      this.terrainCoordinateFrame = {
        bounds: terrainData.bounds,
        meshWidth: TILE_MESH_WIDTH_UNITS,
        meshDepth: terrainData.groundHeightMeters / metersPerUnit,
      };
      // Gust wavelength is expressed in meters and must follow the stable
      // world frame's scale for every subsequently streamed tile.
      configureWindSceneScale(metersPerUnit);
      this.playerControls?.refreshTerrainScale();
      this.configureLoadHorizon();
      if (this.cloudsEnabled && this.solarLighting) {
        this.cloudLayer = createCloudLayer(this.scene, this.solarLighting, {
          metersPerUnit,
          weatherSeed: layerSeed(area.seed, "cloudWeather"),
          density: this.cloudDensity,
        });
      }
      creationStats.record("worldFrame.metersPerUnit", metersPerUnit);
    }
    const frame = this.terrainCoordinateFrame;
    const metersPerUnit = this.terrainMetersPerUnit;
    const northWest = lonLatToScene(
      terrainData.bounds.lonWest,
      terrainData.bounds.latNorth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    const southEast = lonLatToScene(
      terrainData.bounds.lonEast,
      terrainData.bounds.latSouth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    const meshWidth = southEast.x - northWest.x;
    const meshDepth = northWest.z - southEast.z;
    const offset = geographicFrameOffset(frame, {
      bounds: terrainData.bounds,
      meshWidth,
      meshDepth,
    });

    trace?.stage("lake surface source preparation", "synchronous");
    // The overlap verdict is decided once per water polygon from the wider
    // context input below; the surface input only supplies tile-clipped rings.
    const surfaceLakeInput = OpenStreetMap.prepareLakeCollection(
      contextTiles,
      terrainData,
      { meshWidth, meshDepth, withoutObstacles: true },
    );
    trace?.stage("lake context source preparation", "synchronous");
    const contextLakeInput = OpenStreetMap.prepareLakeCollection(
      contextTiles,
      terrainData,
      {
        meshWidth,
        meshDepth,
        clipPadding: LAKE_TERRAIN_CONTEXT_METERS / metersPerUnit,
      },
    );
    const waterwaySegments = OpenStreetMap.collectWaterwaySegments(contextTiles, terrainData, {
      meshWidth, meshDepth, metersPerUnit,
    });
    const stageFrame = { meshWidth, meshDepth, metersPerUnit };
    const waterSources = surfaceLakeInput.candidates.map(candidate => candidate.clipped);
    stages.finish("sources", () => ({ terrain: terrainData, frame: stageFrame,
      lakes: waterSources, rivers: waterwaySegments, sourceTerrain,
      providerTiles: OpenStreetMap.captureTileSources(contextTiles),
      lakeInput: contextLakeInput, surfaceLakeInput,
      landCover: landCover ?? null, subdivisions,
    }));
    stages.begin("relief");
    trace?.stage("procedural relief");
    await applyTerrainDetail(terrainData, {
      meshVertexSpacingMeters: Math.max(terrainData.groundWidthMeters, terrainData.groundHeightMeters) / subdivisions,
      landCover: surfaceLandCover, worldSeed: this.worldSeed,
    }, yieldControl);
    if (generation !== this.streamingGeneration) return undefined;
    stages.finish("relief", () => ({ terrain: terrainData, frame: stageFrame, lakes: waterSources, rivers: waterwaySegments }));
    stages.begin("coastline");
    trace?.stage("land cover terrain shaping");
    const preCarvingElevations = terrainData.elevations.slice();
    if (landCover) await landCover.constrainElevations(terrainData, undefined, undefined, yieldControl);
    else sinkSubmergedTerrain(terrainData);
    if (generation !== this.streamingGeneration) return undefined;
    stages.finish("coastline", () => ({ terrain: terrainData, frame: stageFrame, lakes: waterSources,
      rivers: waterwaySegments, preCarvingElevations, landCoverAvailable: !!landCover }));
    stages.begin("water-selection");
    trace?.stage("lake collection worker wait");
    let surfaceLakeSources: TerrainLakeSource[];
    let lakeSources: TerrainLakeSource[];
    try {
      // Context tiles and clip bounds cover every surface candidate, and the
      // overlap fraction describes the whole provider polygon, so one worker
      // pass decides both lists.
      lakeSources = await this.lakeCollectionWorker.collect(contextLakeInput, `tile=${key} lake context`);
      const accepted = new Set(lakeSources.map((lake) => lake.sourceId));
      surfaceLakeSources = surfaceLakeInput.candidates
        .filter((candidate) => accepted.has(candidate.water.sourceId))
        .map((candidate) => candidate.clipped);
    } catch (error) {
      if (generation !== this.streamingGeneration) return undefined;
      throw error;
    }
    if (generation !== this.streamingGeneration) return undefined;
    stages.finish("water-selection", () => ({ terrain: terrainData, frame: stageFrame,
      lakes: surfaceLakeSources, rivers: waterwaySegments, contextLakes: lakeSources,
      decisions: surfaceLakeInput.candidates.map(({ water }) => ({ sourceId: water.sourceId,
        accepted: surfaceLakeSources.some(lake => lake.sourceId === water.sourceId),
        policy: "Reject >=15% building or >=10% surface-road overlap; cached by source ID" })),
    }));
    stages.begin("lake-terrain");
    trace?.stage("lake terrain shaping");
    const lakePolygons: TerrainLakePolygon[] = await conformTerrainToLakePolygons(
      terrainData,
      preCarvingElevations,
      lakeSources,
      {
        meshWidth,
        meshDepth,
        metersPerUnit,
        sharedLakeElevations: this.lakeElevations.forOwner(sharedElevationOwner),
        smallWaterSurfaceClearanceMeters: LAKE_SURFACE_CLEARANCE_METERS,
        surfaceSources: surfaceLakeSources,
        // Far tiles render this terrain with a coarser vertex grid; native
        // tile edges are linearized to that same grid when stitching meshes.
        renderedVertexSpacing: Math.max(meshWidth, meshDepth) /
          Math.max(1, Math.min(FAR_TILE_SUBDIVISIONS, terrainData.width - 1)),
      },
      yieldControl,
      trace,
    );
    stages.finish("lake-terrain", () => ({ terrain: terrainData, frame: stageFrame,
      lakes: lakePolygons, rivers: waterwaySegments, contextLakes: lakeSources,
      support: measureLakeSupport(terrainData, lakePolygons, stageFrame) }));
    stages.begin("river-terrain");
    trace?.stage("river terrain shaping");
    await carveTerrainWaterways(terrainData, waterwaySegments,
      { meshWidth, meshDepth, metersPerUnit }, yieldControl);
    trace?.stage("lake support diagnostics", "synchronous");
    if (generation !== this.streamingGeneration) return undefined;
    stages.finish("river-terrain", () => ({ terrain: terrainData, frame: stageFrame,
      lakes: lakePolygons, rivers: waterwaySegments }));
    const lakeSupportOptions = { meshWidth, meshDepth, metersPerUnit };
    this.reportLakeSupport("lakes", key, native, terrainData, lakePolygons, lakeSupportOptions);
    if (native) {
      trace?.stage("planning progress wait");
      await reportInitializationProgress(onProgress, "Planning roads and building sites", 34);
    }
    if (generation !== this.streamingGeneration) return undefined;
    trace?.stage("road/building planning and terrain shaping");
    stages.begin("site-plan");
    trace?.stage("building composition worker wait");
    try {
      await OpenStreetMap.prepareBuildingComposition(lakeTiles,
        sources => this.buildingCompositionWorker.compose(sources, `tile=${key}`));
    } catch (error) {
      if (generation !== this.streamingGeneration) return undefined;
      throw error;
    }
    if (generation !== this.streamingGeneration) return undefined;
    const planningInput = OpenStreetMap.prepareRoadAndBuildingInputs(
      lakeTiles,
      terrainData,
      // Far tiles only render carriageways and building stand-ins; promotion
      // to native terrain plans again with shoulders.
      { meshWidth, meshDepth, metersPerUnit, includeShoulders: native },
      trace,
    );
    trace?.stage("road and building worker wait");
    let roadAndBuildingPlan: RoadAndBuildingPlan;
    try {
      roadAndBuildingPlan = await this.roadPlanningWorker.plan(planningInput, `tile=${key}`);
    } catch (error) {
      if (generation !== this.streamingGeneration) return undefined;
      throw error;
    }
    if (generation !== this.streamingGeneration) return undefined;
    trace?.stage("planned terrain shaping");
    stages.finish("site-plan", () => ({ terrain: terrainData, frame: stageFrame,
      lakes: lakePolygons, rivers: waterwaySegments, plan: roadAndBuildingPlan, input: planningInput }));
    const captureEarthworks = () => ({ terrain: terrainData, frame: stageFrame,
      lakes: lakePolygons, rivers: waterwaySegments, plan: roadAndBuildingPlan,
      support: measureLakeSupport(terrainData, lakePolygons, stageFrame) });
    stages.begin("building-pads");
    if (native) {
      await OpenStreetMap.conformTerrainToPlan(
        roadAndBuildingPlan,
        terrainData,
        {
          meshWidth,
          meshDepth,
          metersPerUnit,
          sharedBuildingElevations: this.buildingElevations.forOwner(sharedElevationOwner),
          onBuildingPadsComplete: () => {
            stages.finish("building-pads", captureEarthworks);
            stages.begin("road-grades");
          },
        },
        yieldControl,
        trace,
      );
      trace?.stage("planned terrain lake support diagnostics", "synchronous");
      if (generation !== this.streamingGeneration) return undefined;
      this.reportLakeSupport("plan", key, native, terrainData, lakePolygons, lakeSupportOptions);
    }
    if (!native) {
      stages.finish("building-pads", captureEarthworks, "Far terrain omits building pads");
      stages.begin("road-grades");
    }
    stages.finish("road-grades", captureEarthworks, native ? undefined : "Far terrain omits road earthworks");

    // Cache only finalized terrain. Newly attached tiles now adopt lake,
    // building, and road deformation from an already-visible neighbor instead
    // of restoring the pre-lake WorldCover edge that caused tile chasms.
    trace?.stage("terrain edge stitching", "synchronous");
    stages.begin("stitching");
    stitchTerrainEdges(
      terrainData,
      this.terrainEdgeElevations.forOwner(sharedElevationOwner),
    );
    trace?.stage("stitched terrain lake support diagnostics", "synchronous");
    this.reportLakeSupport("stitch", key, native, terrainData, lakePolygons, lakeSupportOptions);
    stages.finish("stitching", () => ({ terrain: terrainData, frame: stageFrame,
      lakes: lakePolygons, rivers: waterwaySegments, plan: roadAndBuildingPlan,
      support: measureLakeSupport(terrainData, lakePolygons, stageFrame) }));

    stages.begin("terrain-mesh");
    trace?.stage("terrain mesh progress wait");
    await reportInitializationProgress(onProgress, "Building terrain mesh", 40);
    trace?.stage("terrain mesh and textures");
    const terrain = await this.createTerrainMesh(`terrain ${key}`, terrainData, {
      trace,
      meshWidth,
      meshDepth,
      subdivisions,
      metersPerUnit,
      landCover: surfaceLandCover,
      yieldControl,
      snowExclusion: buildingSnowExclusion(roadAndBuildingPlan.buildingSites),
    });
    if (generation !== this.streamingGeneration) {
      disposeTerrainMesh(terrain);
      return undefined;
    }
    setFrozenMeshOffset(terrain, offset.x, offset.z);
    enableTerrainCollisions(terrain);
    terrain.setEnabled(false);
    stages.finish("terrain-mesh", () => ({ terrain: terrainData, frame: stageFrame,
      meshes: captureTileMeshes([terrain]), offset, subdivisions }));

    stages.begin("water-mesh");
    trace?.stage("lake surfaces and terrain commit");
    // Shorelines are sampled from this mesh's triangles. Rebuild them on
    // promotion so they follow native terrain instead of the old coarse bed.
    // Keep the previous terrain and lake layer visible until both are ready.
    const lakeSurfaces = await createTerrainLakeLayer(
      this.scene,
      lakePolygons,
      {
        terrain,
        meshWidth,
        meshDepth,
        metersPerUnit,
        worldOffsetX: offset.x,
        worldOffsetZ: offset.z,
        skyReflection: this.solarLighting?.skyReflectionTexture,
      },
      yieldControl,
    );
    if (generation !== this.streamingGeneration) {
      disposeTerrainMesh(terrain);
      disposeTerrainLakeLayer(lakeSurfaces);
      return undefined;
    }
    setTransformNodeOffset(lakeSurfaces.root, offset.x, offset.z);
    for (const mesh of lakeSurfaces.meshes) mesh.freezeWorldMatrix();
    terrain.setEnabled(true);
    lakeSurfaces.root.setEnabled(true);
    stages.finish("water-mesh", () => ({ terrain: terrainData, frame: stageFrame,
      lakes: lakePolygons, rivers: waterwaySegments, meshes: captureTileMeshes(lakeSurfaces.meshes),
      offset,
      ocean: { elevationMeters: 0, ownership: "Shared camera-centered plane, not tile-owned" } }));

    // Upgrading a streamed tile from the coarse terrain tier to native detail
    // replaces its record. Keep the already-visible distant tree stand-in
    // alive across that replacement; buildTileDetail will cross-fade it only
    // after the matching detailed tree field has committed.
    const retainScenery = previous?.sceneryRevision === this.sceneryRevision;
    const carriedFarTreeField = retainScenery ? previous?.farTreeField : undefined;
    const carriedFarBuildings = retainScenery ? previous?.farBuildings : undefined;
    const carriedFarRoads = previous?.farRoads;
    if (previous) {
      if (retainScenery) {
        previous.farTreeField = undefined;
        previous.farBuildings = undefined;
      }
      previous.farRoads = undefined;
    }
    const now = performance.now();
    const record: StreamedTile = {
      id: area.center,
      key,
      sceneryRevision: this.sceneryRevision,
      terrainData,
      landCover,
      preCarvingElevations,
      mapTiles,
      lakeContextTiles,
      roadAndBuildingPlan,
      generationStages: stages,
      captureGeneration: !!capture,
      terrain,
      meshWidth,
      meshDepth,
      offsetX: offset.x,
      offsetZ: offset.z,
      nativeTerrain: native,
      lakeSurfaces,
      lakeExclusionMask: new PolygonExclusionMask(
        lakePolygons.map(polygon => ({ outer: polygon.outline, holes: polygon.holes })),
        Math.max(0.25, 20 / metersPerUnit),
      ),
      riverExclusionMask: new SegmentExclusionMask(waterwaySegments, Math.max(0.25, 20 / metersPerUnit)),
      farTreeField: carriedFarTreeField,
      farBuildings: carriedFarBuildings,
      farRoads: carriedFarRoads,
      detailed: false,
      lastNeededMilliseconds: now,
      detailLastNeededMilliseconds: now,
      lodResolved: false,
      sharedElevationOwner,
      releaseSharedElevations: () => {
        this.terrainEdgeElevations.release(sharedElevationOwner);
        this.lakeElevations.release(sharedElevationOwner);
        this.buildingElevations.release(sharedElevationOwner);
      },
    };
    retainSharedElevations = true;
    this.tiles.set(key, record);
    if (!native) registerStaticMeshCandidates(this.scene, [terrain, ...terrain.getChildMeshes(), ...lakeSurfaces.meshes]);
    if (!native) {
      const region = `${Math.floor(id.x / 4)}/${Math.floor(id.y / 4)}`;
      this.staticBatches.add(terrain, region, metersPerUnit);
      const skirt = terrain.metadata?.skirt;
      if (skirt instanceof Mesh) this.staticBatches.add(skirt, region, metersPerUnit);
    }
    if (previous) disposeStreamedTile(previous);
    this.playerControls?.ensureAboveGround();
    return record;
    } catch (error) {
      stages.abort(error);
      throw error;
    } finally {
      if (!retainSharedElevations) stages.abort("Tile generation superseded", true);
      if (!retainSharedElevations) {
        this.terrainEdgeElevations.release(sharedElevationOwner);
        this.lakeElevations.release(sharedElevationOwner);
        this.buildingElevations.release(sharedElevationOwner);
      }
    }
  }

  /** Logs lake outlines the rendered ground (native grid and far mesh) fails to carry. */
  private reportLakeSupport(
    stage: string,
    key: string,
    native: boolean,
    terrainData: TerrainData,
    polygons: readonly TerrainLakePolygon[],
    options: { meshWidth: number; meshDepth: number; metersPerUnit: number },
  ): void {
    if (!this.lakeDebug || polygons.length === 0) return;
    const fine = measureLakeSupport(terrainData, polygons, options);
    const far = measureLakeSupport(terrainData, polygons, {
      ...options,
      meshSubdivisions: Math.min(FAR_TILE_SUBDIVISIONS, terrainData.width - 1),
    });
    const worst = (reports: typeof fine) => Math.max(0, ...reports.map((r) => r.maxGapMeters));
    console.info(
      `[lake-debug] tile=${key} native=${native} stage=${stage} lakes=${polygons.length} ` +
      `shore=${fine.reduce((sum, r) => sum + r.perimeterMeters, 0).toFixed(0)}m ` +
      `worst grid gap=${worst(fine).toFixed(2)}m far gap=${worst(far).toFixed(2)}m`,
    );
    for (let index = 0; index < polygons.length; index++) {
      const grid = fine[index];
      const coarse = far[index];
      if (grid.maxGapMeters < 0.1 && coarse.maxGapMeters < 0.1) continue;
      console.warn(
        `[lake-debug] tile=${key} native=${native} stage=${stage} ${grid.sourceId} ` +
        `level=${grid.elevationMeters.toFixed(2)} perimeter=${grid.perimeterMeters.toFixed(0)}m ` +
        `grid: gap=${grid.maxGapMeters.toFixed(2)}m frac=${grid.unsupportedFraction.toFixed(3)} ` +
        `far: gap=${coarse.maxGapMeters.toFixed(2)}m frac=${coarse.unsupportedFraction.toFixed(3)}`,
      );
    }
  }

  private async buildTileDetail(
    record: StreamedTile,
    generation: number,
    onProgress?: InitializationProgress,
    trace?: StreamingTrace,
  ): Promise<void> {
    const { terrainData } = record;
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const yieldControl = onProgress ? undefined : this.streamingYielder;
    const startDisabled = !onProgress;
    const stages = record.generationStages;
    const buildingPlans: BuildingPlan[] = [];
    const stageFrame = { meshWidth: record.meshWidth, meshDepth: record.meshDepth, metersPerUnit };
    await reportInitializationProgress(onProgress, "Loading map features", 50);
    trace?.stage("detail map data and exclusion masks");
    const mapWays = await this.loadMapTiles(record);
    if (generation !== this.streamingGeneration) return;
    const placementLandCover = OpenStreetMap.createLandCoverSampler(
      mapWays,
      record.landCover,
    );

    const mapOptions = {
      buildingPlanningWorker: this.buildingPlanningWorker,
      isCancelled: () => generation !== this.streamingGeneration,
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      preCarvingElevations: record.preCarvingElevations,
      skyReflection: this.solarLighting?.skyReflectionTexture,
      showRoofs: this.sceneSettings.value.showRoofs,
      snowCover: this.tileSnowCover(terrainData),
      startDisabled,
      planning: record.roadAndBuildingPlan,
      onBuildingPlan: record.captureGeneration ? (plan: BuildingPlan) => buildingPlans.push(plan) : undefined,
      onBuildingsCreated: (meshes: Mesh[]) => stages.finish("buildings", () => ({
        terrain: terrainData, frame: stageFrame, plans: buildingPlans,
        layouts: encounteredBuildingLayouts(buildingPlans.map(plan => plan.id)),
        plan: record.roadAndBuildingPlan, meshes: captureTileMeshes(meshes),
        interiors: "Layouts captured; interior geometry and furniture stream on demand",
      })),
      sharedBuildingElevations: this.buildingElevations.forOwner(
        record.sharedElevationOwner,
      ),
      terrainSurface: TerrainSurface.fromGroundMesh(
        record.terrain,
        record.meshWidth,
        record.meshDepth,
      ),
    };
    let mappedExclusionMask;
    let exclusionMaskFallback = false;
    try {
      mappedExclusionMask = await OpenStreetMap.createVegetationExclusionMask(
        mapWays,
        terrainData,
        mapOptions,
        yieldControl,
      );
    } catch (error: unknown) {
      // The exclusion mask is only a placement aid. Keep the natural layers
      // renderable when an individual provider feature is malformed.
      console.warn("Could not build the map exclusion mask; continuing without it.", error);
      exclusionMaskFallback = true;
      mappedExclusionMask = { intersects: () => false };
    }
    if (generation !== this.streamingGeneration) return;
    const exclusionMask = combineHorizontalExclusionMasks([
      mappedExclusionMask,
      OpenStreetMapBarriers.createPlannedExclusionMask(
        record.roadAndBuildingPlan.plotBoundaries,
        mapOptions,
      ),
    ]);
    const fieldOptions = {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      landCover: placementLandCover,
      exclusionMask,
      modelVariantSeed: layerSeed(this.worldSeed, "proceduralModels"),
      seasonalDate: this.vegetationDate,
      snowCover: this.tileSnowCover(terrainData),
      yieldControl,
      impostorCaptureMode: onProgress ? "fast" as const : "cooperative" as const,
      startDisabled,
    };
    // Low ground cover disappears under the raised deep snow of midwinter.
    const snowFreeGroundCover = groundCoverUnderSnow(fieldOptions.snowCover);
    const actorMix = proceduralActorMixAtTile(record.id, this.worldSeed);

    const fields: { kind: VegetationFieldKind; label: string; progress: number;
      create: () => Promise<VegetationFieldResult> }[] = [
      { kind: "treeField", label: "Planting trees", progress: 58,
        create: () => createTreeField(this.scene, terrainData, {
          ...fieldOptions,
          seed: layerSeed(terrainData.generationSeed, "trees"),
          speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
          densityScale: () => actorMix.trees.densityScale,
          renderMode: this.vegetationModes.trees,
          includeFallenLogs: true,
        }) },
      { kind: "saplingField", label: "Planting saplings", progress: 63,
        create: () => createSaplingField(this.scene, terrainData, {
          ...fieldOptions,
          seed: layerSeed(terrainData.generationSeed, "saplings"),
          speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
          densityScale: () => actorMix.trees.densityScale,
          renderMode: this.vegetationModes.trees,
        }) },
      { kind: "grassField", label: "Growing grass", progress: 68,
        create: () => createGrassField(this.scene, terrainData, {
          ...fieldOptions,
          buildingExclusionMask: new PolygonExclusionMask(
            record.roadAndBuildingPlan.buildingSites.map((site) => ({
              outer: site.outline,
              holes: site.holes,
            })),
            Math.max(0.25, 20 / metersPerUnit),
          ),
          lakeExclusionMask: record.lakeExclusionMask,
          riverExclusionMask: record.riverExclusionMask,
          seed: layerSeed(terrainData.generationSeed, "grass"),
          renderMode: this.vegetationModes.grass,
          densityScale: () => actorMix.grass.densityScale * snowFreeGroundCover,
        }) },
      { kind: "tallPlantField", label: "Growing wildflowers", progress: 74,
        create: () => createTallPlantField(this.scene, terrainData, {
          ...fieldOptions,
          seed: layerSeed(terrainData.generationSeed, "tallPlants"),
          densityScale: () => actorMix.tallPlants.densityScale * snowFreeGroundCover,
          renderMode: this.vegetationModes.grass,
        }) },
      { kind: "wheatField", label: "Growing wheat", progress: 76,
        create: () => createWheatField(this.scene, terrainData, {
          ...fieldOptions,
          seed: layerSeed(terrainData.generationSeed, "wheat"),
          densityScale: () => actorMix.tallPlants.densityScale * snowFreeGroundCover,
          renderMode: this.vegetationModes.grass,
        }) },
      { kind: "bushField", label: "Adding bushes", progress: 79,
        create: () => createBushField(this.scene, terrainData, {
          ...fieldOptions,
          seed: layerSeed(terrainData.generationSeed, "bushes"),
          densityScale: () => actorMix.bushes.densityScale,
          renderMode: this.vegetationModes.bushes,
        }) },
      { kind: "fernField", label: "Growing undergrowth", progress: 83,
        create: () => createFernField(this.scene, terrainData, {
          ...fieldOptions,
          seed: layerSeed(terrainData.generationSeed, "ferns"),
          densityScale: () => actorMix.ferns.densityScale * snowFreeGroundCover,
          renderMode: this.vegetationModes.grass,
        }) },
      { kind: "rockyBeachField", label: "Covering rocky beaches", progress: 85,
        create: () => createRockyBeachField(this.scene, terrainData, {
          ...fieldOptions,
          seed: layerSeed(terrainData.generationSeed, "rockyBeaches"),
          densityScale: () => actorMix.rocks.densityScale,
          renderMode: this.vegetationModes.grass,
        }) },
    ];
    const buildVegetation = async () => {
      stages.begin("vegetation");
      for (const { kind, label, progress, create } of fields) {
        await reportInitializationProgress(onProgress, label, progress);
        trace?.stage(kind + " and initial LOD");
        const field = await create();
        await this.prepareTileFieldLod(record, field, this.fieldLodDistance(kind), yieldControl);
        if (!this.stageTileField(record, kind, field, generation)) return;
      }

      await reportInitializationProgress(onProgress, "Scattering rocks", 86);
      trace?.stage("rocks and vegetation activation");
      const rockField = await createRockField(this.scene, terrainData, {
        ...fieldOptions,
        seed: layerSeed(terrainData.generationSeed, "rocks"),
        densityScale: () => actorMix.rocks.densityScale,
      });
      if (generation !== this.streamingGeneration) {
        rockField.root.dispose(false, true);
        return;
      }
      setTransformNodeOffset(rockField.root, record.offsetX, record.offsetZ);
      record.rockField = rockField;
      await this.activateTileVegetation(record, generation);
      stages.finish("vegetation", () => ({ terrain: terrainData, frame: stageFrame,
        plan: record.roadAndBuildingPlan,
        placements: VEGETATION_FIELD_KINDS.flatMap(kind => {
          const field = record[kind];
          return field ? [{ kind, count: field.count, matrices: field.instanceMatrices }] : [];
        }),
        meshes: captureTileMeshes(rockField.meshes),
        offset: { x: record.offsetX, z: record.offsetZ },
        actorMix, snowCover: fieldOptions.snowCover, seasonalDate: this.vegetationDate,
        exclusionMaskFallback,
      }));
      return rockField;
    };

    // Both phases stage disabled resources and use the same cooperative budget.
    // Settle both before cleanup so a failed phase cannot leak a later result.
    stages.begin("buildings");
    stages.begin("roads-rivers");
    const [vegetationResult, mapResult] = await Promise.allSettled([
      buildVegetation(),
      OpenStreetMap.createLayer(this.scene, mapWays, terrainData, mapOptions, yieldControl).then(layer => {
        stages.finish("roads-rivers", () => ({ terrain: terrainData, frame: stageFrame,
          plan: record.roadAndBuildingPlan,
          meshes: captureTileMeshes(layer.meshes.filter(mesh => mesh.name !== "buildings")),
          counts: layer.counts,
        }));
        return layer;
      }),
    ]);
    if (mapResult.status === "rejected") throw mapResult.reason;
    const mapFeatures = mapResult.value;
    if (vegetationResult.status === "rejected" || !vegetationResult.value || generation !== this.streamingGeneration) {
      OpenStreetMap.disposeLayer(mapFeatures.root);
      if (vegetationResult.status === "rejected") throw vegetationResult.reason;
      return;
    }
    const rockField = vegetationResult.value;
    stages.begin("props");
    await reportInitializationProgress(onProgress, "Creating map features", 88);
    trace?.stage("map features, boundaries, lamps and commit");
    trace?.stage("plot boundaries");
    const plotBoundaryLayer = await OpenStreetMapBarriers.createPlannedLayer(
      this.scene,
      record.roadAndBuildingPlan.plotBoundaries,
      terrainData,
      mapOptions,
      yieldControl,
    );
    trace?.stage("street lamp geometry");
    const streetLampLayer = StreetLamps.createLayer(
      this.scene,
      record.roadAndBuildingPlan.streetLamps,
      terrainData,
      mapOptions,
    );
    if (generation !== this.streamingGeneration) {
      OpenStreetMap.disposeLayer(mapFeatures.root);
      OpenStreetMap.disposeLayer(plotBoundaryLayer.root);
      streetLampLayer.root.dispose(false, true);
      return;
    }
    plotBoundaryLayer.root.parent = mapFeatures.root;
    streetLampLayer.root.parent = mapFeatures.root;
    // Both layers honour startDisabled on their own root, so parenting alone
    // leaves them hidden once the map root is enabled. Visibility is gated by
    // the map root from here on.
    plotBoundaryLayer.root.setEnabled(true);
    streetLampLayer.root.setEnabled(true);
    stages.finish("props", () => ({ terrain: terrainData, frame: stageFrame,
      plan: record.roadAndBuildingPlan,
      meshes: captureTileMeshes([...plotBoundaryLayer.root.getChildMeshes(), ...streetLampLayer.root.getChildMeshes()]
        .filter((mesh): mesh is Mesh => mesh instanceof Mesh)),
      boundaries: record.roadAndBuildingPlan.plotBoundaries, lamps: record.roadAndBuildingPlan.streetLamps,
    }));
    trace?.stage("map commit frame wait");
    await this.streamingYielder.nextFrame();
    trace?.stage("map world matrices/offset");
    setTransformNodeOffset(mapFeatures.root, record.offsetX, record.offsetZ);
    // Only the static layer meshes, not their animated doors or lazy interiors.
    registerStaticMeshCandidates(this.scene, mapFeatures.meshes);
    trace?.stage("map activation frame wait");
    await this.streamingYielder.nextFrame();
    if (generation !== this.streamingGeneration) {
      OpenStreetMap.disposeLayer(mapFeatures.root);
      return;
    }
    trace?.stage("map activation/fades");
    mapFeatures.root.setEnabled(true);
    const mapRoot = mapFeatures.root;
    this.layerFades.begin(0, 1, (fade) => setMapLayerFade(mapRoot, fade), undefined, true);
    record.mapFeatures = mapFeatures.root;
    setHierarchySnowCover(mapFeatures.root, this.tileSnowCover(record.terrainData), this.terrainMetersPerUnit ?? 1);
    record.barrierField = plotBoundaryLayer.hedgeField;
    if (record.farBuildings) {
      const farBuildings = record.farBuildings;
      record.farBuildings = undefined;
      this.layerFades.begin(1, 0, (fade) => setMapLayerFade(farBuildings, fade),
        () => OpenStreetMap.disposeLayer(farBuildings));
    }
    if (record.farRoads) {
      const farRoads = record.farRoads;
      record.farRoads = undefined;
      this.layerFades.begin(1, 0, (fade) => setMapLayerFade(farRoads, fade),
        () => OpenStreetMap.disposeLayer(farRoads));
    }
    record.detailed = true;
    trace?.stage("refresh shadow casters");
    this.refreshShadowCasters();
    trace?.stage("detail complete");
    creationStats.record("tiles.detailed");
    for (const kind of VEGETATION_FIELD_KINDS) {
      creationStats.record(`created.${kind}`, record[kind]?.count ?? 0);
    }
    creationStats.record("created.rocks", rockField.count);
    creationStats.record("created.buildings", mapFeatures.counts.buildings);
    creationStats.record("created.roads", mapFeatures.counts.roads);
    creationStats.record("created.plotBoundaries", plotBoundaryLayer.count);
    creationStats.record("created.streetLamps", streetLampLayer.count);
  }

  /**
   * Gives a tile outside the detail rings a cheap tree layer: lowest-LOD
   * impostors only, no models, no shadows, and no per-frame LOD work. Forests
   * then read all the way to the fog instead of ending at the detail ring.
   */
  private async buildFarTrees(record: StreamedTile, generation: number): Promise<void> {
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const mapWays = await this.loadMapTiles(record);
    if (generation !== this.streamingGeneration) return;
    const placementLandCover = OpenStreetMap.createLandCoverSampler(
      mapWays,
      record.landCover,
    );
    const placementOptions = {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      planning: record.roadAndBuildingPlan,
      terrainSurface: TerrainSurface.fromGroundMesh(
        record.terrain, record.meshWidth, record.meshDepth,
      ),
    };
    const mappedExclusionMask = await OpenStreetMap.createVegetationExclusionMask(
      mapWays,
      record.terrainData,
      placementOptions,
      this.streamingYielder,
    );
    const exclusionMask = combineHorizontalExclusionMasks([
      mappedExclusionMask,
      OpenStreetMapBarriers.createPlannedExclusionMask(
        record.roadAndBuildingPlan.plotBoundaries,
        placementOptions,
      ),
    ]);
    if (generation !== this.streamingGeneration) return;
    const actorMix = proceduralActorMixAtTile(record.id, this.worldSeed);
    record.generationStages.begin("vegetation");
    const treeField = await createTreeField(this.scene, record.terrainData, {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      seed: layerSeed(record.terrainData.generationSeed, "trees"),
      speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
      densityScale: () => actorMix.trees.densityScale,
      modelVariantSeed: layerSeed(this.worldSeed, "proceduralModels"),
      seasonalDate: this.vegetationDate,
      snowCover: this.tileSnowCover(record.terrainData),
      landCover: placementLandCover,
      exclusionMask,
      // Match detailed-tree placement; only the representation changes with range.
      includeModels: false,
      forceLowestImpostorLod: true,
      renderMode: "impostors",
      yieldControl: this.streamingYielder,
      startDisabled: true,
    });
    if (generation !== this.streamingGeneration || record.farTreeField) {
      treeField.root.dispose(false, false);
      return;
    }
    // Far fields never swap LOD slots, so frustum culling is safe and drops
    // the tiles behind the camera from the draw list.
    for (const mesh of treeField.meshes) mesh.alwaysSelectAsActiveMesh = false;
    setTransformNodeOffset(treeField.root, record.offsetX, record.offsetZ);
    registerStaticMeshCandidates(this.scene, treeField.meshes);
    record.farTreeField = treeField;
    record.generationStages.finish("vegetation", () => ({ terrain: record.terrainData,
      frame: { meshWidth: record.meshWidth, meshDepth: record.meshDepth, metersPerUnit },
      placements: [{ kind: "farTrees", matrices: treeField.instanceMatrices, count: treeField.count }],
      detail: "Far trees only", actorMix }));
    if (record.detailed) {
      // Pre-built for an upcoming demotion: stays hidden until the tile's full
      // detail cross-fades out.
      treeField.root.setEnabled(false);
    } else {
      treeField.root.setEnabled(true);
      this.layerFades.fadeFieldIn(treeField);
    }
  }

  private buildFarBuildings(record: StreamedTile, generation: number): Promise<void> {
    return this.buildFarMapLayer(record, generation, "farBuildings");
  }

  private buildFarRoads(record: StreamedTile, generation: number): Promise<void> {
    return this.buildFarMapLayer(record, generation, "farRoads");
  }

  private captureRetainedFarLayer(record: StreamedTile, kind: "farBuildings" | "farRoads"): void {
    const stage = kind === "farBuildings" ? "buildings" : "roads-rivers";
    record.generationStages.begin(stage);
    record.generationStages.finish(stage, () => ({ terrain: record.terrainData,
      frame: { meshWidth: record.meshWidth, meshDepth: record.meshDepth, metersPerUnit: this.terrainMetersPerUnit! },
      plan: record.roadAndBuildingPlan, offset: { x: record.offsetX, z: record.offsetZ },
      meshes: captureTileMeshes(record[kind]!.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh)),
    }), "Retained far geometry from an earlier tile revision");
  }

  /** Builds, publishes, and fades one map layer outside the detail rings. */
  private async buildFarMapLayer(
    record: StreamedTile, generation: number, kind: "farBuildings" | "farRoads",
  ): Promise<void> {
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const mapWays = await this.loadMapTiles(record);
    if (generation !== this.streamingGeneration) return;
    const options = {
      meshWidth: record.meshWidth, meshDepth: record.meshDepth, metersPerUnit,
      startDisabled: true, planning: record.roadAndBuildingPlan,
    };
    const stage = kind === "farBuildings" ? "buildings" : "roads-rivers";
    record.generationStages.begin(stage);
    const layer = kind === "farBuildings"
      ? await OpenStreetMap.createBuildingLayer(this.scene, mapWays, record.terrainData, {
        ...options, showRoofs: this.sceneSettings.value.showRoofs,
        snowCover: this.tileSnowCover(record.terrainData),
      }, "far", this.streamingYielder)
      : await OpenStreetMap.createRoadLayer(this.scene, mapWays, record.terrainData, {
        ...options, preCarvingElevations: record.preCarvingElevations,
        terrainSurface: TerrainSurface.fromGroundMesh(record.terrain, record.meshWidth, record.meshDepth),
      }, this.streamingYielder);
    if (generation !== this.streamingGeneration || record[kind]) {
      OpenStreetMap.disposeLayer(layer.root);
      record.generationStages.abort("Far layer superseded", true);
      return;
    }
    record.generationStages.finish(stage, () => ({ terrain: record.terrainData, frame: options,
      plan: record.roadAndBuildingPlan, meshes: captureTileMeshes(layer.meshes),
      detail: kind === "farBuildings" ? "Far building massing" : "Far carriageways and bridges; river ribbons deferred",
    }));
    setTransformNodeOffset(layer.root, record.offsetX, record.offsetZ);
    record[kind] = layer.root;
    registerStaticMeshCandidates(this.scene, layer.root.getChildMeshes());
    setHierarchySnowCover(layer.root, this.tileSnowCover(record.terrainData),
      kind === "farBuildings" ? metersPerUnit : this.terrainMetersPerUnit ?? 1);
    if (kind === "farRoads") {
      for (const mesh of layer.root.getChildMeshes()) {
        if (mesh instanceof Mesh) this.staticBatches.add(mesh,
          Math.floor(record.id.x / 4) + "/" + Math.floor(record.id.y / 4), metersPerUnit);
      }
    }
    layer.root.setEnabled(!record.detailed);
    if (!record.detailed) this.layerFades.begin(0, 1, (fade) => setMapLayerFade(layer.root, fade));
  }

  private loadMapTiles(record: StreamedTile): Promise<MapTile[]> {
    record.mapTiles ??= this.requestMapTiles(record.terrainData.bounds);
    return record.mapTiles;
  }

  private requestMapTiles(bounds: TerrainData["bounds"]): Promise<MapTile[]> {
    return OpenStreetMap.fetch(bounds).catch((error: unknown) => {
      console.warn("OpenStreetMap unavailable; map-backed layers were skipped.", error);
      return [];
    });
  }

  /** Resolves the first full LOD layout while the field is still staged. */
  private async prepareTileFieldLod(
    record: StreamedTile,
    field: VegetationFieldResult,
    distanceMeters: number,
    yieldControl?: () => Promise<void>,
  ): Promise<void> {
    const camera = this.scene.activeCamera;
    if (!camera || !yieldControl) return;
    const localCameraPosition = camera.globalPosition.clone();
    localCameraPosition.x -= record.offsetX;
    localCameraPosition.z -= record.offsetZ;
    await field.prepareLod(localCameraPosition, distanceMeters, yieldControl);
  }

  /** Stages one finished detail field, or disposes it when the world moved on. */
  private stageTileField(
    record: StreamedTile,
    kind: VegetationFieldKind,
    field: VegetationFieldResult,
    generation: number,
  ): boolean {
    if (generation !== this.streamingGeneration) {
      field.root.dispose(false, false);
      return false;
    }
    setTransformNodeOffset(field.root, record.offsetX, record.offsetZ);
    if (kind === "grassField" || kind === "bushField" || kind === "tallPlantField") {
      setVegetationFieldDetailDistance(
        field,
        Math.min(record.meshWidth, record.meshDepth),
        this.sceneSettings.value.detailTilesAcross,
      );
    }
    record[kind] = field;
    record.lodResolved = false;
    return true;
  }

  /** Cross-fades the complete vegetation layer against its distant stand-in. */
  private async activateTileVegetation(record: StreamedTile, generation: number): Promise<void> {
    const fields = VEGETATION_FIELD_KINDS
      .map((kind) => record[kind])
      .filter((field): field is VegetationFieldResult => field !== undefined);
    for (const field of fields) {
      if (generation !== this.streamingGeneration || record.terrain.isDisposed()) return;
      field.setFade(0);
      field.root.setEnabled(true);
      // Enabling a new field can compile shaders and upload instance buffers.
      // Give Babylon a complete render opportunity between those commits.
      await this.streamingYielder.nextFrame();
    }
    const rockField = record.rockField;
    if (rockField) {
      if (generation !== this.streamingGeneration || record.terrain.isDisposed()) return;
      rockField.setFade(0);
      rockField.root.setEnabled(true);
      await this.streamingYielder.nextFrame();
    }

    if (generation !== this.streamingGeneration || record.terrain.isDisposed()) return;

    const farTrees = record.farTreeField;
    this.layerFades.begin(0, 1, (fade) => {
      for (const field of fields) {
        if (!field.root.isDisposed()) field.setFade(fade);
      }
      if (rockField && !rockField.root.isDisposed()) rockField.setFade(fade);
      if (farTrees && !farTrees.root.isDisposed()) farTrees.setFade(1 - fade);
    }, () => {
      farTrees?.root.dispose(false, false);
      if (record.farTreeField === farTrees) record.farTreeField = undefined;
      // Leave one settled static frame after the temporary fade refreshes.
      this.solarLighting?.refreshShadows();
    }, true);

    this.refreshShadowCasters();
    this.updateVegetationLod();
  }

  /** Rebuilds the shadow render list from every live detail layer. */
  private refreshShadowCasters(): void {
    const casters: Mesh[] = [];
    for (const record of this.tiles.values()) {
      const fields = VEGETATION_FIELD_KINDS
        // Trees and saplings cast vegetation shadows. Low vegetation stays lit
        // as receivers without adding noisy small geometry to the map.
        .filter((kind) => kind === "treeField" || kind === "saplingField")
        .map((kind) => record[kind])
        .filter((field): field is VegetationFieldResult => field !== undefined);
      if (fields.length === 0 && !record.rockField && !record.mapFeatures) continue;
      record.terrain.receiveShadows = true;
      // Packed WebGPU depth makes a height field compare almost equal to its
      // own shadow depth, producing repeating terrain-acne stripes. Preserve
      // terrain as a receiver while leaving self-shadowing to WebGL.
      if (!this.engine.isWebGPU) casters.push(record.terrain);
      for (const field of fields) {
        // Dedicated casters retain every tree in the detail ring even when
        // its visible mesh has switched to a medium-range impostor.
        casters.push(...(
          field.shadowCasterMeshes.length > 0 ? field.shadowCasterMeshes : field.meshes
        ));
      }
      if (record.rockField) casters.push(...record.rockField.meshes);
      if (record.mapFeatures) {
        const mapMeshes = record.mapFeatures.getChildMeshes(false).filter(
          (mesh): mesh is Mesh => mesh instanceof Mesh,
        );
        // Roads and waterways sit only centimetres above the terrain.
        // Casting them creates long, thin shadow streaks, but they should
        // still receive shadows from real elevated geometry.
        for (const mesh of mapMeshes) mesh.receiveShadows = true;
        casters.push(...mapMeshes.filter(
          (mesh) => mesh.metadata?.buildingShadowCaster === true,
        ));
      }
    }
    // An empty list must clear casters retained from a previous streamed tile.
    this.solarLighting?.setShadowCasters(casters);
  }

  /** Replace AA passes live, releasing temporal history and projection jitter. */
  private applyAntialiasing(camera: UniversalCamera): void {
    this.temporalAA?.dispose();
    if (this.temporalAA) this.scene.postProcessRenderPipelineManager.removePipeline("temporalAA");
    this.temporalAA = undefined;
    this.antialiasingPass?.dispose(camera);
    this.antialiasingPass = undefined;
    this.toneMappingPass?.dispose(camera);
    this.toneMappingPass = createToneMappingPass(camera);
    camera.getProjectionMatrix(true);

    const samples = this.antialiasingMode === "msaa" ? 4 : 1;
    if (this.screenSpaceReflections) this.screenSpaceReflections.samples = samples;
    else this.toneMappingPass.samples = samples;
    if (this.antialiasingMode === "taa") {
      const taa = new TAARenderingPipeline("temporalAA", this.scene, [camera]);
      taa.samples = 8;
      taa.msaaSamples = 1;
      taa.disableOnCameraMove = true;
      taa.factor = 0.2;
      this.temporalAA = taa;
    } else if (this.antialiasingMode === "fxaa") {
      this.antialiasingPass = new FxaaPostProcess("FXAA", 1, camera);
    }
  }

  /**
   * Screen-space reflections, aimed at the ocean.
   *
   * The pass runs over the whole frame but only touches pixels whose material
   * reported a reflectivity above the threshold. Terrain specular sits an
   * order of magnitude below it once the prepass linearises it, and the map
   * features are matte, so the water is the only surface that traces rays.
   *
   * Vegetation draws with custom shaders that write no prepass geometry. That
   * costs nothing here beyond trees reflecting as if they were painted on the
   * ground behind them, and it keeps the streamed instance fields out of an
   * extra geometry pass.
   */
  private enableWaterReflections(camera: UniversalCamera): void {
    const reflections = new SSRRenderingPipeline(
      "waterReflections",
      this.scene,
      [camera],
      false,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    if (!reflections.isSupported) {
      console.warn("Screen-space reflections are unsupported here; water stays flat.");
      reflections.dispose();
      return;
    }
    // Above the terrain's specular colour, below the water's reflectivity.
    reflections.reflectivityThreshold = 0.045;
    // Water is a weak reflector head-on and a mirror at grazing angles, which
    // is the whole reason the surface stops reading as a flat blue sheet.
    reflections.useFresnel = true;
    // A long stride with hit refinement covers the distance to the shoreline
    // for a fraction of the samples a per-pixel march would need.
    reflections.step = 12;
    reflections.maxSteps = 96;
    reflections.enableSmoothReflections = true;
    // Rays stop at the distance fog starts washing the scene out, which is as
    // far as a reflection can still be told apart from the haze.
    reflections.maxDistance = this.loadHorizonUnits * FOG_START_FRACTION;
    reflections.thickness = 0.4;
    // Waves tip some rays back down into the surface they just left; skipping
    // the first steps keeps those from returning the water's own colour.
    reflections.selfCollisionNumSkip = 3;
    // Blurring the reflection would mean gathering it in a separate
    // half-resolution texture, which smears the water's reflection across the
    // silhouettes in front of it and, because the vertical blur covers an even
    // number of rows, drops a black row off the top and bottom of an
    // odd-height frame. Scattering the rays themselves gives a rippled
    // surface's broken reflection with no neighbouring pixels involved, and
    // saves three full-screen passes.
    reflections.blurDispersionStrength = 0;
    reflections.roughnessFactor = 0.35;
    reflections.attenuateScreenBorders = true;
    reflections.attenuateFacingCamera = true;
    reflections.attenuateBackfaceReflection = true;
    // The prepass takes rendering off the back buffer, so the engine's own
    // anti-aliasing no longer applies to the scene.
    reflections.samples = this.antialiasingMode === "msaa" ? 4 : 1;
    this.screenSpaceReflections = reflections;
    this.keepRenderTargetsOutOfPrePass();
  }

  /**
   * Babylon re-runs the prepass' "is anything still asking for this?" check at
   * the start of every render target draw, and answers it from the scene's
   * active camera. Inside a shadow map, a reflection probe or an impostor
   * capture that camera is not the one carrying the SSR post-processes, so the
   * check concludes nothing needs the prepass and switches it off until the
   * next time a material dirties it — which, with tiles streaming in and out,
   * leaves the reflections flickering on and off at random.
   *
   * None of those targets want prepass output anyway, and opting them out also
   * spares each one the multi-target attachments it was allocating.
   */
  private keepRenderTargetsOutOfPrePass(): void {
    const prePass = this.scene.prePassRenderer;
    if (!prePass) return;
    const exclude = (texture: BaseTexture): void => {
      if (!(texture instanceof RenderTargetTexture)) return;
      if (prePass.renderTargets.some((target) => target === texture)) return;
      texture.noPrePassRenderer = true;
    };
    for (const texture of this.scene.textures) exclude(texture);
    this.scene.onNewTextureAddedObservable.add(exclude);
  }

  /** Fog hides tiles popping in at the edge of the streamed radius. */
  private configureLoadHorizon(): void {
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = this.loadHorizonUnits * FOG_START_FRACTION;
    this.scene.fogEnd = this.loadHorizonUnits * 0.95;
    if (this.screenSpaceReflections) {
      this.screenSpaceReflections.maxDistance = this.loadHorizonUnits * FOG_START_FRACTION;
    }
  }

  private get loadHorizonUnits(): number {
    return (this.terrainTileRadius + 0.5) * TILE_MESH_WIDTH_UNITS;
  }

  /** Keeps one large ocean plane centered on the camera's tile. */
  private recenterWater(center: WorldTileId): void {
    const frame = this.terrainCoordinateFrame;
    if (!frame) return;
    if (!this.water) {
      const sizeUnits = (2 * (this.terrainTileRadius + 1) + 1) * TILE_MESH_WIDTH_UNITS;
      this.water = createWaterPlane(this.scene, {
        width: sizeUnits,
        height: sizeUnits,
        metersPerUnit: this.terrainMetersPerUnit,
        skyReflection: this.solarLighting?.skyReflectionTexture,
      });
    }
    const bounds = worldTileBounds(center);
    const northWest = lonLatToScene(
      bounds.lonWest,
      bounds.latNorth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    const southEast = lonLatToScene(
      bounds.lonEast,
      bounds.latSouth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    setFrozenMeshOffset(
      this.water,
      (northWest.x + southEast.x) / 2,
      (northWest.z + southEast.z) / 2,
    );
  }

  private disposeAllTiles(): void {
    this.layerFades.clear();
    for (const record of this.tiles.values()) disposeStreamedTile(record);
    this.tiles.clear();
    this.activeTileBuilds.clear();
    if (this.water) disposeWaterPlane(this.water);
    this.water = undefined;
    this.cameraTileKey = undefined;
  }

  /**
   * Cross-fades a tile leaving the detail rings back to its distant stand-ins.
   */
  private demoteTileDetail(record: StreamedTile): void {
    const farTrees = record.farTreeField;
    if (farTrees && !farTrees.root.isDisposed()) {
      farTrees.setFade(0);
      farTrees.root.setEnabled(true);
      this.layerFades.fadeFieldIn(farTrees);
    }
    const farBuildings = record.farBuildings;
    if (farBuildings && !farBuildings.isDisposed()) {
      setMapLayerFade(farBuildings, 0);
      farBuildings.setEnabled(true);
      this.layerFades.begin(0, 1, (fade) => setMapLayerFade(farBuildings, fade));
    }
    const farRoads = record.farRoads;
    if (farRoads && !farRoads.isDisposed()) {
      setMapLayerFade(farRoads, 0);
      farRoads.setEnabled(true);
      this.layerFades.begin(0, 1, (fade) => setMapLayerFade(farRoads, fade));
    }
    for (const kind of VEGETATION_FIELD_KINDS) {
      const field = record[kind];
      if (!field) continue;
      record[kind] = undefined;
      this.layerFades.fadeFieldOutAndDispose(field, kind === "treeField");
    }
    const rockField = record.rockField;
    if (rockField) {
      record.rockField = undefined;
      this.layerFades.begin(1, 0, (fade) => {
        if (!rockField.root.isDisposed()) rockField.setFade(fade);
      }, () => rockField.root.dispose(false, true), true);
    }
    const mapFeatures = record.mapFeatures;
    if (mapFeatures) {
      record.mapFeatures = undefined;
      this.layerFades.begin(1, 0, (fade) => setMapLayerFade(mapFeatures, fade),
        () => OpenStreetMap.disposeLayer(mapFeatures), true);
    }
    record.detailed = false;
  }

  /** Disposes tiles that stayed outside the streamed radius past their cooldown. */
  private evictCooledTiles(
    now: number,
    detailTiles: ReadonlySet<string>,
    neededTiles: ReadonlySet<string>,
  ): void {
    let detailChanged = false;
    for (const record of [...this.tiles.values()]) {
      if (this.activeTileBuilds.has(record.key)) continue;
      const wantDetail = detailTiles.has(record.key);
      if (!neededTiles.has(record.key) &&
          now - record.lastNeededMilliseconds > TILE_COOLDOWN_MS) {
        this.tiles.delete(record.key);
        detailChanged = detailChanged || record.detailed;
        disposeStreamedTile(record);
      } else if (record.detailed && !wantDetail &&
          now - record.detailLastNeededMilliseconds > DETAIL_COOLDOWN_MS &&
          record.farTreeField && record.farBuildings && record.farRoads) {
        // The streaming pass pre-builds every stand-in; demotion waits for
        // them so the cross-fade never leaves the tile bare.
        this.demoteTileDetail(record);
        detailChanged = true;
      }
    }
    const tilesAcross = this.terrainTileRadius * 2 + 1;
    const maximumRetainedTiles = neededTiles.size +
      RETAINED_TILE_EDGE_SLACK * tilesAcross;
    if (this.tiles.size > maximumRetainedTiles) {
      const stale = [...this.tiles.values()]
        .filter((record) => !this.activeTileBuilds.has(record.key))
        .filter((record) => !neededTiles.has(record.key))
        .sort((left, right) => left.lastNeededMilliseconds - right.lastNeededMilliseconds);
      while (this.tiles.size > maximumRetainedTiles && stale.length > 0) {
        const record = stale.shift()!;
        this.tiles.delete(record.key);
        detailChanged = detailChanged || record.detailed;
        disposeStreamedTile(record);
      }
    }
    if (detailChanged) this.refreshShadowCasters();
  }

  /** Debug-only keyboard actions are isolated from camera input. */
  private setupDebugControls(): void {
    this.scene.onKeyboardObservable.add((kbInfo) => {
      if (kbInfo.type !== KeyboardEventTypes.KEYDOWN || (kbInfo.event as KeyboardEvent).repeat) return;
      if (this.sceneControls?.isOpen) return;

      if (kbInfo.event.key === "v" || kbInfo.event.key === "V") {
        const nextMode: VegetationRenderMode = this.vegetationModes.trees === "auto"
          ? "models"
          : this.vegetationModes.trees === "models"
            ? "impostors"
            : "auto";
        this.setAllVegetationModes(nextMode);
      } else if (kbInfo.event.shiftKey && (kbInfo.event.key === "f" || kbInfo.event.key === "F")) {
        this.fpsCounter.toggleExpanded();
      } else if (kbInfo.event.key === "r" || kbInfo.event.key === "R") {
        this.fpsCounter.dumpRenderStats(this.engine, this.scene, this.getRenderStatsContext());
      }
    });
  }

  /** Streamed work may use about half of the frame time the callback leaves unused. */
  private updateStreamingBudget(callbackMilliseconds: number): void {
    this.frameCallbackEstimateMilliseconds +=
      (callbackMilliseconds - this.frameCallbackEstimateMilliseconds) * 0.1;
    const spare = this.frameIntervalEstimateMilliseconds - callbackMilliseconds;
    this.streamingBudgetMilliseconds = Math.min(STREAMING_BUDGET_MAXIMUM_MS,
      Math.max(STREAMING_BUDGET_MINIMUM_MS, spare * STREAMING_BUDGET_SPARE_SHARE));
    setCooperativeCaptureBudget(this.streamingBudgetMilliseconds);
  }

  private setVegetationMode(category: VegetationCategory, mode: VegetationRenderMode): void {
    // Rendering every procedural clump as geometry is prohibitively costly;
    // Auto still provides real models in the immediate foreground.
    if ((category === "grass" || category === "bushes") && mode === "models") mode = "auto";
    this.vegetationModes[category] = mode;
    for (const record of this.tiles.values()) {
      for (const kind of VEGETATION_FIELD_KINDS) {
        if (VEGETATION_FIELD_CONFIG[kind].category === category) {
          record[kind]?.setRenderMode(mode);
        }
      }
    }
    this.solarLighting?.refreshShadows();
  }

  private setAllVegetationModes(mode: VegetationRenderMode): void {
    this.setVegetationMode("trees", mode);
    this.setVegetationMode("grass", mode);
    this.setVegetationMode("bushes", mode);
  }

  private changeSceneSetting(key: SceneSettingKey, value: number): void {
    const previous = this.sceneSettings.value;
    const next = this.sceneSettings.update(key, value);
    this.sceneControls?.setSettings(next);

    const modelRangeChanged = changed(previous, next, "modelRangeMeters");
    const detailSizeChanged = changed(previous, next, "detailTilesAcross");
    const terrainSizeChanged = changed(previous, next, "terrainTilesAcross");
    const cloudDensityChanged = changed(previous, next, "cloudDensity");
    const windChanged = changed(previous, next, "windSpeedMetersPerSecond");

    if (windChanged) setManualWindSpeed(next.windSpeedMetersPerSecond);

    if (detailSizeChanged && next.detailTilesAcross < previous.detailTilesAcross) {
      const expired = performance.now() - DETAIL_COOLDOWN_MS - 1;
      for (const record of this.tiles.values()) record.detailLastNeededMilliseconds = expired;
    }
    if (terrainSizeChanged) {
      if (next.terrainTilesAcross < previous.terrainTilesAcross) {
        const expired = performance.now() - TILE_COOLDOWN_MS - 1;
        for (const record of this.tiles.values()) record.lastNeededMilliseconds = expired;
      }
      this.configureLoadHorizon();
      if (this.water) {
        disposeWaterPlane(this.water);
        this.water = undefined;
      }
    }
    if (detailSizeChanged || terrainSizeChanged) this.requestStreamingUpdate();
    if (detailSizeChanged) this.updateVegetationDetailDistance();
    if (modelRangeChanged) {
      for (const record of this.tiles.values()) record.lodResolved = false;
      this.updateVegetationLod();
    }
    if (cloudDensityChanged) this.cloudLayer?.setDensity(next.cloudDensity);
  }

  private changeRoofsVisibility(visible: boolean): void {
    if (this.sceneSettings.value.showRoofs === visible) return;
    this.sceneSettings.setRoofsVisible(visible);
    this.invalidateScenery();
  }

  /** Rebuild in place, retaining visible tiles until their replacements are ready. */
  private invalidateScenery(): void {
    this.sceneryRevision++;
    this.streamingGeneration++;
    this.roadPlanningWorker.reset();
    this.lakeCollectionWorker.reset();
    this.buildingPlanningWorker.reset();
    this.buildingCompositionWorker.reset();
    this.requestStreamingUpdate();
  }

  private refreshSeasonalScenery(): void {
    const date = this.solarLighting?.currentDate;
    if (!date) return;
    // Season and snow depth depend on the calendar day, not the frame or time
    // of day. Newly streamed layers receive the current snow depth at creation.
    const previousDate = this.vegetationDate;
    if (previousDate && previousDate.getFullYear() === date.getFullYear() &&
        previousDate.getMonth() === date.getMonth() && previousDate.getDate() === date.getDate()) return;
    // Atlases use snow tiers, but low vegetation density follows the exact
    // depth. Both must be checked before keeping the generated fields.
    // Every deciduous cohort has its own onset, including southern autumn.
    const appearanceKey = (day: Date | undefined) => [45, -45].flatMap((latitude) =>
      (["birch", "maple", "beech", "oak"] as const).flatMap((species) =>
        [0, 1, 2].map((variant) => treeSeasonAt(day, latitude, species, variant).key),
      ),
    ).join("/");
    const previousSeason = appearanceKey(this.vegetationDate);
    const nextSeason = appearanceKey(date);
    this.vegetationDate = date;
    let rebuildScenery = previousSeason !== nextSeason;
    const metersPerUnit = this.terrainMetersPerUnit ?? 1;
    for (const record of this.tiles.values()) {
      const snowCover = this.tileSnowCover(record.terrainData);
      const previousSnowCover = terrainSnowCover(record.terrain);
      if (snowCoverTier(previousSnowCover) !== snowCoverTier(snowCover) ||
          groundCoverUnderSnow(previousSnowCover) !== groundCoverUnderSnow(snowCover)) {
        rebuildScenery = true;
      }
      setTerrainSnowCover(record.terrain, snowCover);
      record.rockField?.setSnowCover(snowCover);
      for (const layer of [record.mapFeatures, record.farBuildings, record.farRoads]) {
        if (layer) setHierarchySnowCover(layer, snowCover, metersPerUnit);
      }
    }
    this.staticBatches?.update();
    if (rebuildScenery) this.invalidateScenery();
  }

  /** Snow depth on a tile from the scenery date, location and mean elevation. */
  private tileSnowCover(terrain: TerrainData): number {
    return snowCoverAt(
      this.vegetationDate,
      (terrain.bounds.latNorth + terrain.bounds.latSouth) / 2,
      meanElevation(terrain),
      (terrain.bounds.lonWest + terrain.bounds.lonEast) / 2,
    );
  }

  private changeClockMode(mode: ClockMode): void {
    const clock = this.clockSettings.setMode(mode);
    if (mode === "manual") {
      this.solarLighting?.setDate(clock.manualDate);
      this.solarLighting?.setTimeOfDay(clock.manualTimeOfDay);
    } else {
      this.solarLighting?.setDate(undefined);
      this.solarLighting?.setTimeOfDay(undefined);
    }
    this.refreshSeasonalScenery();
  }

  private requestStreamingUpdate(): void {
    this.lastTerrainStreamingCheckMilliseconds = Number.NEGATIVE_INFINITY;
    this.updateTerrainStreaming();
  }

  private updateVegetationDetailDistance(): void {
    const detailTilesAcross = this.sceneSettings.value.detailTilesAcross;
    for (const record of this.tiles.values()) {
      for (const field of [record.grassField, record.bushField, record.tallPlantField]) {
        if (!field) continue;
        setVegetationFieldDetailDistance(
          field,
          Math.min(record.meshWidth, record.meshDepth),
          detailTilesAcross,
        );
      }
    }
  }

  private fieldLodDistance(kind: VegetationFieldKind): number {
    return kind === "grassField"
      ? Math.min(this.vegetationLodDistanceMeters, GRASS_MODEL_RANGE_CAP_METERS)
      : this.vegetationLodDistanceMeters;
  }

  private updateVegetationLod(): void {
    const camera = this.scene.activeCamera;
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!camera || !metersPerUnit) return;

    const cameraPosition = camera.globalPosition;
    // Fields sit at per-tile offsets in the stable frame; LOD runs in each
    // field's local space. Reuse one vector because updateLod stores a clone.
    const localPosition = new Vector3();
    const updateField = (
      field: VegetationFieldResult,
      distanceMeters: number,
      originX = field.root.position.x,
      originZ = field.root.position.z,
    ): void => {
      localPosition.copyFrom(cameraPosition);
      localPosition.x -= originX;
      localPosition.z -= originZ;
      field.updateLod(localPosition, distanceMeters);
    };
    for (const record of this.tiles.values()) {
      if (!VEGETATION_FIELD_KINDS.some((kind) => record[kind]) && !record.barrierField) continue;
      // A freshly built field already renders as pure impostors, and instances
      // beyond the model range stay impostors. Only tiles the model range can
      // actually reach need per-frame LOD work; one final update settles a
      // tile when the camera leaves its reach.
      const reachUnits = (this.vegetationLodDistanceMeters + 40) / metersPerUnit +
        Math.hypot(record.meshWidth, record.meshDepth) / 2;
      const dx = cameraPosition.x - record.offsetX;
      const dz = cameraPosition.z - record.offsetZ;
      const withinReach = dx * dx + dz * dz <= reachUnits * reachUnits;
      if (!withinReach && record.lodResolved) continue;
      record.lodResolved = !withinReach;
      for (const kind of VEGETATION_FIELD_KINDS) {
        const field = record[kind];
        if (field) updateField(field, this.fieldLodDistance(kind));
      }
      if (record.barrierField && record.mapFeatures) {
        updateField(
          record.barrierField,
          this.vegetationLodDistanceMeters,
          record.mapFeatures.position.x,
          record.mapFeatures.position.z,
        );
      }
    }
    // Camera-relative LOD changes buffer contents but do not change the world
    // caster set, so the cached static shadow map remains valid.
    this.logVegetationLodStats();
  }

  private logVegetationLodStats(): void {
    const now = performance.now();
    if (now - this.lastVegetationLodDebugLogMilliseconds < 2_000) return;
    this.lastVegetationLodDebugLogMilliseconds = now;
    const fields: VegetationFieldResult[] = [];
    for (const record of this.tiles.values()) {
      for (const kind of VEGETATION_FIELD_KINDS) {
        const field = record[kind];
        if (field) fields.push(field);
      }
    }
    const stats = fields.reduce<VegetationLodDebugStats>(
      (total, field) => addVegetationLodStats(total, field.consumeLodDebugStats()),
      emptyVegetationLodStats(),
    );
    if (stats.updates === 0) return;
    const averageProcessed = Math.round(stats.processedInstances / stats.updates);
    creationStats.record("vegetation.totalInstances", stats.totalInstances);
    creationStats.record("vegetation.gridCandidates", stats.currentGridCandidates);
    creationStats.record("vegetation.transitions", stats.currentTransitionInstances);
    creationStats.record("vegetation.processedPerUpdate", averageProcessed);
    creationStats.record("vegetation.processedPeak", stats.peakProcessedInstances);
    creationStats.record("vegetation.slotCrossings", stats.membershipChanges);
    creationStats.record("vegetation.fullRebuilds", stats.fullRebuilds);
  }

  /** Persists a destination, then rebuilds all scene-owned state. */
  private async reloadAtLocation(target: WorldLocation): Promise<void> {
    if (this.reloadingLocation) return;
    this.reloadingLocation = true;
    this.worldLocation.requestDestination(target);
    this.worldLocation.update(target);
    const camera = this.flyCamera;
    if (camera) {
      try {
        await this.playerPresence.publishDestination(target, {
          yaw: camera.rotation.y,
          pitch: camera.rotation.x,
          movementMode: this.movementMode,
        });
      } catch (error) {
        console.warn("Could not persist the destination before reloading.", error);
      }
    }
    window.location.reload();
  }

  private async changeToCoordinates(target: WorldLocation): Promise<void> {
    console.log(`Loading coordinates: lon ${target.lon.toFixed(6)}, lat ${target.lat.toFixed(6)}`);
    await this.reloadAtLocation(target);
  }

  private setMenuOpen(isOpen: boolean): void {
    this.playerControls?.setMenuOpen(isOpen);
  }

  private getRenderStatsContext(): Record<string, unknown> {
    const camera = this.flyCamera;
    const frame = this.terrainCoordinateFrame;
    const geographicPosition = camera && frame
      ? sceneToLonLat(
        camera.position.x,
        camera.position.z,
        frame.bounds,
        frame.meshWidth,
        frame.meshDepth,
      )
      : undefined;
    return {
      worldSeed: this.worldSeed,
      renderScale: this.renderScale,
      movementMode: this.movementMode,
      vegetationModes: { ...this.vegetationModes },
      vegetationLodDistanceMeters: this.vegetationLodDistanceMeters,
      cloudDensity: this.cloudDensity,
      waterReflectionsEnabled: this.waterReflectionsEnabled,
      geographicPosition,
      streaming: {
        gridLevel: this.gridLevel,
        detailTilesAcross: this.sceneSettings.value.detailTilesAcross,
        terrainTilesAcross: this.terrainTileRadius * 2 + 1,
        cameraTileKey: this.cameraTileKey,
        terrainTiles: this.tiles.size,
        detailTiles: [...this.tiles.values()].filter((tile) => tile.detailed).length,
        nativeTerrainTiles: [...this.tiles.values()].filter((tile) => tile.nativeTerrain).length,
        activeBuilds: [...this.activeTileBuilds.keys()],
        activeLayerFades: this.layerFades.size,
        tiles: [...this.tiles.values()].map((tile) => ({
          key: tile.key,
          detailed: tile.detailed,
          nativeTerrain: tile.nativeTerrain,
          layers: {
            trees: Boolean(tile.treeField),
            grass: Boolean(tile.grassField),
            tallPlants: Boolean(tile.tallPlantField),
            bushes: Boolean(tile.bushField),
            mapFeatures: Boolean(tile.mapFeatures),
            farBuildings: Boolean(tile.farBuildings),
            farRoads: Boolean(tile.farRoads),
            farTrees: Boolean(tile.farTreeField),
          },
        })),
      },
    };
  }

  private async changeToRandomTerrainLocation(): Promise<void> {
    const target = await randomLandWorldLocation(async (location) => {
      const elevation = await TerrainElevationSource.fetchElevationAtLocation(location.lat, location.lon);
      if (!(elevation > 0)) return false;
      const bounds = worldTileBounds(worldTileAtLocation(
        location.lat,
        location.lon,
        this.gridLevel,
      ));
      const landCover = await WorldCover.fetch(bounds);
      const classification = landCover.sampleKnown(location.lon, location.lat);
      return classification !== undefined && classification !== LandCoverClass.Water;
    });
    console.log(`Random location: lon ${target.lon.toFixed(6)}, lat ${target.lat.toFixed(6)}`);
    await this.reloadAtLocation(target);
  }

  /** Places the player's eye exactly one standing height over loaded terrain. */
  private placeCameraAtLocation(target: WorldLocation): void {
    if (!this.flyCamera || !this.terrainCoordinateFrame) return;
    const position = lonLatToScene(
      target.lon,
      target.lat,
      this.terrainCoordinateFrame.bounds,
      this.terrainCoordinateFrame.meshWidth,
      this.terrainCoordinateFrame.meshDepth,
    );
    this.flyCamera.position.x = position.x;
    this.flyCamera.position.z = position.z;
    const groundEyeHeight = this.getGroundEyeHeight(position.x, position.z);
    if (groundEyeHeight !== undefined) this.flyCamera.position.y = groundEyeHeight;
    this.playerControls?.resetVerticalMotion();
  }

  private updateTerrainStreaming(force = false): void {
    if (this.reloadingLocation) return;
    const now = performance.now();
    if (!force && now - this.lastTerrainStreamingCheckMilliseconds < TERRAIN_STREAMING_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastTerrainStreamingCheckMilliseconds = now;

    const frame = this.terrainCoordinateFrame;
    const camera = this.flyCamera;
    if (!frame || !camera) return;
    const { lon, lat } = sceneToLonLat(
      camera.position.x,
      camera.position.z,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    this.worldLocation.update({ lat, lon });
    const center = worldTileAtLocation(lat, lon, this.gridLevel);
    const centerKey = worldTileKey(center);
    if (centerKey !== this.cameraTileKey || !this.water) {
      this.cameraTileKey = centerKey;
      this.solarLighting?.setLocation(lat, lon);
      this.recenterWater(center);
    }

    const scale = 2 ** center.level;
    const generation = this.streamingGeneration;
    const coordinates = worldTileCoordinatesAtLocation(lat, lon, center.level);
    const fractionX = coordinates.x - center.x;
    const fractionY = coordinates.y - center.y;
    const neededTiles = new Set<string>();
    const radius = this.terrainTileRadius + 0.5;
    const extent = Math.ceil(radius);
    const detailRadius = this.sceneSettings.value.detailTilesAcross / 2;
    const detailTiles = new Set<string>();
    const work: Array<{
      id: WorldTileId;
      detail: boolean;
      demotion: boolean;
      terrainOnly: boolean;
      distanceSquared: number;
    }> = [];
    for (let dy = -extent; dy <= extent; dy++) {
      const y = center.y + dy;
      if (y < 0 || y >= scale) continue;
      for (let dx = -extent; dx <= extent; dx++) {
        const wantDetail = worldTileIntersectsCircle(dx, dy, fractionX, fractionY, detailRadius);
        if (!wantDetail && !worldTileIntersectsCircle(dx, dy, fractionX, fractionY, radius)) continue;
        const id: WorldTileId = {
          level: center.level,
          x: ((center.x + dx) % scale + scale) % scale,
          y,
        };
        const key = worldTileKey(id);
        neededTiles.add(key);
        if (wantDetail) detailTiles.add(key);
        const record = this.tiles.get(key);
        if (record) {
          record.lastNeededMilliseconds = now;
          if (wantDetail) record.detailLastNeededMilliseconds = now;
        }
        if (this.activeTileBuilds.has(key)) continue;
        const needsTerrain = !record || record.sceneryRevision !== this.sceneryRevision ||
          (wantDetail && !record.nativeTerrain) ||
          (!wantDetail && record.nativeTerrain && !record.detailed);
        const needsDetail = wantDetail && !(record?.detailed ?? false);
        // A detailed tile past its detail cooldown gets its far stand-in
        // pre-built (hidden) so the demotion can cross-fade seamlessly.
        const wantsDemotion = record !== undefined && record.detailed && !wantDetail &&
          now - record.detailLastNeededMilliseconds > DETAIL_COOLDOWN_MS;
        const needsFarLayers = !wantDetail && record !== undefined &&
          (!record.farTreeField || !record.farBuildings || !record.farRoads) &&
          (!record.detailed || wantsDemotion);
        if (needsTerrain || needsDetail || needsFarLayers) {
          work.push({ id, detail: wantDetail, demotion: wantsDemotion,
            terrainOnly: !wantDetail && needsTerrain && !wantsDemotion,
            distanceSquared: dx * dx + dy * dy });
        }
      }
    }
    // Release expired detail before allocating another tile's full models.
    // Distance-only ordering starves demotions while the camera keeps moving.
    work.sort((a, b) => Number(b.demotion) - Number(a.demotion) ||
      Number(b.detail) - Number(a.detail) ||
      Number(b.terrainOnly) - Number(a.terrainOnly) ||
      a.distanceSquared - b.distanceSquared);
    for (const item of work) {
      // Detail builds run alone; far builds overlap up to a small limit.
      if (this.activeDetailBuilds.size > 0) break;
      if (item.detail ? this.activeTileBuilds.size > 0
        : this.activeTileBuilds.size >= MAX_CONCURRENT_FAR_TILE_BUILDS) break;
      // Release the build slot once ground and water are visible. Far scenery
      // gets a separate turn after the missing terrain has filled the horizon.
      void this.streamTile(item.id, item.detail, generation, undefined, undefined, item.terrainOnly).then(() => {
        this.continueTerrainStreaming(generation);
      }).catch((error: unknown) => {
        console.error(`Failed to stream tile ${worldTileKey(item.id)}.`, error);
      });
    }

    this.evictCooledTiles(now, detailTiles, neededTiles);
  }

  private continueTerrainStreaming(generation: number): void {
    if (generation !== this.streamingGeneration || this.terrainStreamingTimer === undefined) return;
    if (!documentIsBackgrounded() && this.lastFrameStartMilliseconds !== undefined &&
        performance.now() - this.lastFrameStartMilliseconds < TERRAIN_STREAMING_CHECK_INTERVAL_MS) {
      // Refill on the next render tick instead of leaving a completed slot
      // idle until the periodic camera-window check. Never recurse into builds.
      this.lastTerrainStreamingCheckMilliseconds = Number.NEGATIVE_INFINITY;
      return;
    }
    // Hidden-tab timers may fire only once a minute. A completed build releases
    // capacity immediately, so drain the queue from that event instead.
    this.updateTerrainStreaming(true);
    this.layerFades.update();
    this.staticBatches?.update();
  }

  run(): void {
    // Rendering can stop in an occluded window. Keep filling the current tile
    // window and settling its transitions even when no render callback arrives.
    if (this.terrainStreamingTimer === undefined) {
      this.terrainStreamingTimer = setInterval(() => {
        if (this.lastFrameStartMilliseconds !== undefined &&
            performance.now() - this.lastFrameStartMilliseconds < TERRAIN_STREAMING_CHECK_INTERVAL_MS) return;
        this.updateTerrainStreaming();
        this.layerFades.update();
        this.staticBatches?.update();
      }, TERRAIN_STREAMING_CHECK_INTERVAL_MS);
    }
    this.engine.runRenderLoop(() => {
      const gameStart = performance.now();
      if (this.lastFrameStartMilliseconds !== undefined) {
        const interval = Math.min(gameStart - this.lastFrameStartMilliseconds, 1000 / 30);
        this.frameIntervalEstimateMilliseconds += (interval - this.frameIntervalEstimateMilliseconds) * 0.1;
      }
      this.lastFrameStartMilliseconds = gameStart;
      this.playerControls?.updateMovement();
      this.refreshSeasonalScenery();
      this.updateTerrainStreaming();
      const fading = this.layerFades.size > 0;
      this.layerFades.update();
      this.staticBatches.update(fading);
      if (this.flyCamera) {
        this.cloudLayer?.update(this.flyCamera.globalPosition);
      }
      const vegetationStart = performance.now();
      this.updateVegetationLod();
      const vegetationEnd = performance.now();
      this.playerControls?.updateDepthPrecision();
      const renderStart = performance.now();
      this.scene.render();
      // Camera keyboard input is applied by Babylon during scene rendering.
      // Apply the same loaded-tile constraint afterward so fly mode cannot
      // carry the player through a tile that was not ready at the boundary.
      this.playerControls?.constrainToLoadedTile();
      this.publishLocalPlayerPose();
      const renderEnd = performance.now();
      this.updateStreamingBudget(renderEnd - gameStart);
      let detailTiles = 0;
      for (const tile of this.tiles.values()) {
        if (tile.detailed) detailTiles++;
      }
      this.fpsCounter.update(this.engine, this.scene, {
        gameMilliseconds: renderStart - gameStart,
        vegetationMilliseconds: vegetationEnd - vegetationStart,
        renderMilliseconds: renderEnd - renderStart,
        activeTileBuilds: this.activeTileBuilds.size,
        terrainTiles: this.tiles.size,
        detailTiles,
        activeLayerFades: this.layerFades.size,
      });
    });
  }

  resize(): void {
    this.engine.resize();
  }

  dispose(): void {
    if (this.terrainStreamingTimer !== undefined) {
      clearInterval(this.terrainStreamingTimer);
      this.terrainStreamingTimer = undefined;
    }
    this.streamingGeneration++;
    this.roadPlanningWorker.dispose();
    this.lakeCollectionWorker.dispose();
    this.buildingPlanningWorker.dispose();
    this.buildingCompositionWorker.dispose();
    window.removeEventListener("pagehide", this.handlePageHide);
    this.playerControls?.dispose();
    this.playerPresence.dispose();
    this.staticBatches?.dispose();
    this.fpsCounter.dispose();
    this.sceneControls?.dispose();
    this.cloudLayer?.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  /** Hands the locally predicted camera transform to the presence subsystem. */
  private publishLocalPlayerPose(force = false): void {
    if (this.reloadingLocation) return;
    const camera = this.flyCamera;
    if (!camera) return;
    const transform: LocalPlayerTransform = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      yaw: camera.rotation.y,
      pitch: camera.rotation.x,
      movementMode: this.movementMode,
    };
    this.playerPresence.publishLocalTransform(transform, force);
  }

  /**
   * Gathers the tree stems within reach of a walker's footprint from every
   * tile it touches and pushes the body out of them. Detail tiles collide
   * with their full tree and sapling layers; tiles still showing their distant
   * stand-in collide with those trees instead, since that is what is visible.
   */
  private resolveTreeTrunkCollisions(body: WalkerBody): { x: number; z: number } | undefined {
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return undefined;
    const reach = body.radius + TREE_TRUNK_REACH_METERS / metersPerUnit;
    const corners: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [-reach, -reach],
      [reach, -reach],
      [-reach, reach],
      [reach, reach],
    ];
    const visited = new Set<StreamedTile>();
    const trunks: TreeTrunk[] = [];
    for (const [offsetX, offsetZ] of corners) {
      const record = this.tileAtScenePosition(body.x + offsetX, body.z + offsetZ);
      if (!record || visited.has(record)) continue;
      visited.add(record);
      const fields = record.treeField?.root.isEnabled()
        ? [record.treeField, record.saplingField]
        : [record.farTreeField];
      for (const field of fields) {
        const index = field?.trunks;
        if (!index) continue;
        const localX = body.x - record.offsetX;
        const localZ = body.z - record.offsetZ;
        for (const trunk of index.nearby(localX, localZ, body.radius)) {
          trunks.push({
            ...trunk,
            x: trunk.x + record.offsetX,
            z: trunk.z + record.offsetZ,
          });
        }
      }
    }
    if (trunks.length === 0) return undefined;
    const resolved = resolveTreeTrunkCollisions(body, trunks);
    return resolved.blocked ? resolved : undefined;
  }

  /** Finds the streamed tile whose footprint contains a scene position. */
  private tileAtScenePosition(x: number, z: number): StreamedTile | undefined {
    const frame = this.terrainCoordinateFrame;
    if (!frame) return undefined;
    const { lon, lat } = sceneToLonLat(x, z, frame.bounds, frame.meshWidth, frame.meshDepth);
    return this.tiles.get(worldTileKey(worldTileAtLocation(lat, lon, this.gridLevel)));
  }

  private getGroundEyeHeight(
    x: number,
    z: number,
    referenceEyeHeight = this.flyCamera?.position.y,
  ): number | undefined {
    const record = this.tileAtScenePosition(x, z);
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!record || !metersPerUnit) return undefined;
    const localX = x - record.offsetX;
    const localZ = z - record.offsetZ;

    // Use the highest point under the player's footprint so the 1.8 m body
    // cannot intersect a steep triangle beside its center point.
    const radius = PLAYER_RADIUS_METERS / metersPerUnit;
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [-radius, -radius],
      [radius, -radius],
      [-radius, radius],
      [radius, radius],
    ];
    let elevationMeters = -Infinity;
    for (const [offsetX, offsetZ] of offsets) {
      elevationMeters = Math.max(
        elevationMeters,
        sampleElevation(
          record.terrainData,
          localX + offsetX,
          localZ + offsetZ,
          record.meshWidth,
          record.meshDepth,
        ),
      );
    }
    const terrainEyeHeight = (elevationMeters + PLAYER_HEIGHT_METERS) / metersPerUnit;
    if (referenceEyeHeight === undefined) return terrainEyeHeight;

    // Probe only slightly above the player's feet. This finds stair treads and
    // interior slabs without selecting a roof or ceiling above the walker.
    const probeStartY = referenceEyeHeight - PLAYER_HEIGHT_METERS / metersPerUnit +
      WALK_MAX_STEP_UP_METERS / metersPerUnit;
    const hit = this.scene.pickWithRay(
      new Ray(
        new Vector3(x, probeStartY, z),
        Vector3.Down(),
        WALK_SURFACE_PROBE_DEPTH_METERS / metersPerUnit,
      ),
      (mesh) => mesh.checkCollisions && mesh.isEnabled(),
      false,
    );
    const structureEyeHeight = hit?.pickedPoint
      ? hit.pickedPoint.y + PLAYER_HEIGHT_METERS / metersPerUnit
      : -Infinity;
    return Math.max(terrainEyeHeight, structureEyeHeight);
  }

  /**
   * Creates a terrain mesh by setting vertex heights directly from
   * full-precision Float32 elevation data (no lossy image round-trip).
   * @param name - The name of the mesh
   * @param terrain - Processed terrain result with raw elevation data
   * @param options - Mesh dimensions and scale
   * @returns The created ground mesh
   */
  async createTerrainMesh(
    name: string,
    terrain: TerrainData,
    options: {
      meshWidth: number;
      meshDepth: number;
      subdivisions: number;
      metersPerUnit: number;
      landCover?: LandCoverSampler;
      yieldControl?: FrameBudgetYielder;
      trace?: StreamingTrace;
      snowExclusion?: (x: number, z: number) => boolean;
    },
  ): Promise<Mesh> {
    return buildTerrainMesh(this.scene, name, terrain, {
      ...options,
      worldSeed: this.worldSeed,
      snowCover: this.tileSnowCover(terrain),
    });
  }

}

/** Ground under a planned building keeps no snow; the raised layer would show through its floors. */
function buildingSnowExclusion(
  sites: readonly PlannedBuildingSite[],
): ((x: number, z: number) => boolean) | undefined {
  if (sites.length === 0) return undefined;
  return (x, z) => sites.some((site) => (
    pointInRing({ x, z }, site.outline) && !site.holes.some((hole) => pointInRing({ x, z }, hole))
  ));
}

/** Mean elevation of a tile's raster, sampled coarsely; it only nudges snow depth. */
function meanElevation(terrain: TerrainData): number {
  const { elevations } = terrain;
  if (elevations.length === 0) return 0;
  const step = Math.max(1, Math.floor(elevations.length / 4096));
  let sum = 0;
  let count = 0;
  for (let index = 0; index < elevations.length; index += step) {
    const elevation = elevations[index];
    if (!Number.isFinite(elevation)) continue;
    sum += elevation;
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

function queryNumber(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(query.get(name));
  return query.has(name) && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function emptyVegetationLodStats(): VegetationLodDebugStats {
  return {
    totalInstances: 0,
    updates: 0,
    processedInstances: 0,
    peakProcessedInstances: 0,
    currentGridCandidates: 0,
    currentTransitionInstances: 0,
    membershipChanges: 0,
    fullRebuilds: 0,
  };
}

function addVegetationLodStats(
  total: VegetationLodDebugStats,
  stats: VegetationLodDebugStats,
): VegetationLodDebugStats {
  total.totalInstances += stats.totalInstances;
  total.updates += stats.updates;
  total.processedInstances += stats.processedInstances;
  total.peakProcessedInstances += stats.peakProcessedInstances;
  total.currentGridCandidates += stats.currentGridCandidates;
  total.currentTransitionInstances += stats.currentTransitionInstances;
  total.membershipChanges += stats.membershipChanges;
  total.fullRebuilds += stats.fullRebuilds;
  return total;
}

function queryInteger(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.round(queryNumber(query, name, fallback, minimum, maximum));
}

function changed(
  previous: Readonly<SceneSettings>,
  next: Readonly<SceneSettings>,
  key: SceneSettingKey,
): boolean {
  return previous[key] !== next[key];
}

/** Expands a terrain footprint in its Mercator-aligned local frame. */
function expandTerrainBounds(
  terrain: TerrainData,
  paddingMeters: number,
): TerrainData["bounds"] {
  const northWest = sceneToLonLat(
    -terrain.groundWidthMeters / 2 - paddingMeters,
    terrain.groundHeightMeters / 2 + paddingMeters,
    terrain.bounds,
    terrain.groundWidthMeters,
    terrain.groundHeightMeters,
  );
  const southEast = sceneToLonLat(
    terrain.groundWidthMeters / 2 + paddingMeters,
    -terrain.groundHeightMeters / 2 - paddingMeters,
    terrain.bounds,
    terrain.groundWidthMeters,
    terrain.groundHeightMeters,
  );
  return {
    lonWest: Math.max(-180, northWest.lon),
    lonEast: Math.min(180, southEast.lon),
    latNorth: Math.min(85.05112878, northWest.lat),
    latSouth: Math.max(-85.05112878, southEast.lat),
  };
}

async function reportInitializationProgress(
  onProgress: InitializationProgress | undefined,
  step: string,
  progress: number,
): Promise<void> {
  if (!onProgress) return;
  onProgress(step, progress);
  await waitForNextFrame();
}
