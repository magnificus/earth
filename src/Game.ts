import {
  AbstractEngine,
  BaseTexture,
  Constants,
  RenderTargetTexture,
  Ray,
  Scene,
  SSRRenderingPipeline,
  UniversalCamera,
  Vector3,
  Color4,
  Mesh,
  KeyboardEventTypes,
} from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import { TerrainElevationSource } from "./TerrainElevationSource";
import { stitchTerrainEdges } from "./TerrainStitching";
import { createWaterPlane, disposeWaterPlane } from "./Water";
import {
  createTerrainLakeLayer,
  disposeTerrainLakeLayer,
} from "./TerrainLakeSurface";
import {
  conformTerrainToLakePolygons,
  LAKE_TERRAIN_CONTEXT_METERS,
} from "./TerrainLakePolygons";
import type { TerrainLakePolygon } from "./TerrainLakePolygons";
import { createTreeField } from "./TreeField";
import { createGrassField, setGrassFieldDetailDistance } from "./GrassField";
import { createBushField } from "./BushField";
import { createSaplingField } from "./SaplingField";
import { createFernField } from "./FernField";
import { createTallPlantField } from "./TallPlantField";
import { createWheatField } from "./WheatField";
import { createRockyBeachField } from "./RockyBeachField";
import { createRockField } from "./RockField";
import { proceduralActorMixAtTile } from "./procedural/ProceduralActorMix";
import {
  createBrowserWorldLocationStore,
  EXAMPLE_LOCATIONS,
  randomLandWorldLocation,
} from "./Locations";
import type { WorldLocation, WorldLocationStore } from "./Locations";
import {
  combineHorizontalExclusionMasks,
  geographicFrameOffset,
  lonLatToScene,
  sampleElevation,
  sceneToLonLat,
  sinkSubmergedTerrain,
} from "./Geo";
import type { SceneGeographicFrame } from "./Geo";
import { OpenStreetMap } from "./OpenStreetMap";
import type { MapTile } from "./OpenStreetMap";
import { OpenStreetMapBarriers } from "./OpenStreetMapBarriers";
import { StreetLamps } from "./StreetLamps";
import { LandCoverClass, WorldCover } from "./WorldCover";
import type { LandCoverSampler } from "./WorldCover";
import { disposeTerrainMesh } from "./TerrainMaterial";
import { createTerrainMesh as buildTerrainMesh } from "./TerrainMesh";
import { TerrainSurface } from "./TerrainSurface";
import { configureWindSceneScale, setManualWindSpeed } from "./Wind";
import { SolarLighting } from "./SolarLighting";
import { hasWinterGroundCover } from "./TreeSeason";
import { createCloudLayer } from "./CloudImpostors";
import type { CloudLayer } from "./CloudImpostors";
import { FpsCounter } from "./FpsCounter";
import {
  createFrameBudgetYielder,
  FrameBudgetYielder,
  waitForNextFrame,
} from "./FrameBudget";
import {
  PLAYER_HEIGHT_METERS,
  PLAYER_RADIUS_METERS,
  PlayerControls,
  WALK_MAX_STEP_UP_METERS,
  WALK_SURFACE_PROBE_DEPTH_METERS,
} from "./PlayerControls";
import { LayerFades } from "./LayerFades";
import {
  disposeStreamedTile,
  setFrozenMeshOffset,
  setMapLayerFade,
  setTransformNodeOffset,
  VEGETATION_FIELD_KINDS,
} from "./StreamedTile";
import type { StreamedTile, VegetationFieldKind } from "./StreamedTile";
import {
  VegetationFieldResult,
  VegetationLodDebugStats,
  VegetationRenderMode,
} from "./VegetationField";
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
  worldTileKey,
  worldTileWindowOffsetsAtLocation,
} from "./WorldGrid";
import type { WorldTileWindowOffsets } from "./WorldGrid";
import type { WorldTileId } from "./WorldGrid";
import { PlayerPresence } from "./integration/PlayerPresence";
import type {
  GameIntegrationOptions,
  LocalPlayerTransform,
} from "./integration/PlayerPresence";
import type { PlayerPose } from "./integration/GameProtocol";

export type { GameIntegrationOptions } from "./integration/PlayerPresence";

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
/** Terrain resolution for tiles beyond the detail rings. */
const FAR_TILE_SUBDIVISIONS = 32;
/**
 * Distant tree layers use wider spacing with raised occupancy, matching the
 * detail rings' trees per square meter at a quarter of the instance count.
 */
const FAR_TREE_SPACING_METERS = 5;
const FAR_TREE_OCCUPANCY = 1;
const FAR_TREE_EDGE_OCCUPANCY = 0.24;
const TERRAIN_STREAMING_CHECK_INTERVAL_MS = 250;
export type InitializationProgress = (step: string, progress: number) => void;

export class Game {
  private canvas: HTMLCanvasElement;
  private engine: AbstractEngine;
  private scene: Scene;
  private water?: Mesh;
  private readonly tiles = new Map<string, StreamedTile>();
  private readonly activeTileBuilds = new Set<string>();
  private readonly terrainEdgeElevations = new Map<string, number>();
  private readonly lakeElevations = new Map<string, number>();
  private readonly buildingElevations = new Map<string, number>();
  private readonly layerFades: LayerFades;
  private streamingGeneration = 0;
  /** Streaming CPU work yields when it has consumed its frame slice. */
  private readonly streamingYielder = createFrameBudgetYielder();
  private cameraTileKey?: string;
  private readonly gridLevel = WORLD_GRID_LEVEL;
  private readonly worldSeed: number;
  private readonly renderScale: number;
  private readonly sceneSettings: SceneSettingsStore;
  private readonly clockSettings: ClockSettingsStore;
  private readonly worldLocation: WorldLocationStore;
  private lastTerrainStreamingCheckMilliseconds = 0;
  private solarLighting?: SolarLighting;
  private cloudLayer?: CloudLayer;
  private readonly cloudsEnabled: boolean;
  private readonly initialDate?: string;
  private readonly initialTimeOfDay?: number;
  /** Date captured once for vegetation generation; sky controls do not rebuild trees. */
  private vegetationDate?: Date;
  private readonly fpsCounter: FpsCounter;
  private readonly vegetationModes: VegetationModes;
  private sceneControls?: SceneControls;
  private readonly waterReflectionsEnabled: boolean;
  private screenSpaceReflections?: SSRRenderingPipeline;
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
    const forceReverseDepth = ["1", "on", "true", "force"].includes(
      query.get("reverse-depth")?.toLowerCase() ?? "",
    );
    // Babylon 7's WebGPU path is first exercised with conventional depth.
    // Reverse depth can be isolated explicitly once the base renderer is sound.
    this.engine.useReverseDepthBuffer = !this.engine.isWebGPU || forceReverseDepth;
    this.scene = new Scene(this.engine);
    this.layerFades = new LayerFades({
      refreshShadows: () => this.solarLighting?.refreshShadows(),
      // Refreshing the shadow framebuffer on every fade frame can overlap
      // streamed capture state on WebGL. The settled callback below is enough.
      refreshShadowsDuringFade: () => undefined,
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
      isScenePositionLoaded: (x, z) => this.isScenePositionReady(x, z),
      isMenuOpen: () => this.sceneControls?.isOpen ?? false,
      onPointerLockExit: () => {
        if (!this.sceneControls?.isOpen) this.sceneControls?.setMenuOpen(true);
      },
    });

    await reportInitializationProgress(onProgress, "Connecting to game server", 5);
    const presenceSession = await this.playerPresence.connect(this.worldLocation.value);
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

    // Give the core native terrain and visible stand-ins before dismissing the
    // loading screen. Full detail can then replace them without a blank world.
    await this.startWorld(location, onProgress);
    if (presenceSession.restoredPose) this.playerControls.applyRestoredPose(presenceSession.restoredPose);
    this.publishLocalPlayerPose(true);
    await reportInitializationProgress(onProgress, "Setting up controls", 98);
    this.sceneControls = new SceneControls({
      settings: this.sceneSettings.value,
      clockSettings: this.clockSettings.value,
      initialLocation: location,
      onSettingChange: (key, value) => this.changeSceneSetting(key, value),
      onRoofsVisibilityChange: (visible) => this.changeRoofsVisibility(visible),
      onClockModeChange: (mode) => this.changeClockMode(mode),
      onDateChange: (date) => {
        this.clockSettings.setManualDate(date);
        if (this.clockSettings.value.mode === "manual") this.solarLighting?.setDate(date);
      },
      onTimeOfDayChange: (hours) => {
        this.clockSettings.setManualTimeOfDay(hours);
        if (this.clockSettings.value.mode === "manual") this.solarLighting?.setTimeOfDay(hours);
      },
      onLocationChange: (target) => this.reloadAtLocation(target),
      onMenuOpenChange: (isOpen) => this.setMenuOpen(isOpen),
    });
    this.setupDebugControls();
    await reportInitializationProgress(onProgress, "Ready", 100);
  }

  /** Clears every streamed tile and starts a fresh world around a location. */
  private async startWorld(
    target: WorldLocation,
    onProgress?: InitializationProgress,
  ): Promise<void> {
    const generation = ++this.streamingGeneration;
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
    const detailWindow = worldTileWindowOffsetsAtLocation(
      target.lat,
      target.lon,
      this.sceneSettings.value.detailTilesAcross,
      centerTile.level,
    );
    const scale = 2 ** centerTile.level;
    const coreTiles: Array<{ id: WorldTileId; distanceSquared: number }> = [];
    for (let dy = detailWindow.minimumY; dy <= detailWindow.maximumY; dy++) {
      const y = centerTile.y + dy;
      if (y < 0 || y >= scale) continue;
      for (let dx = detailWindow.minimumX; dx <= detailWindow.maximumX; dx++) {
        coreTiles.push({
          id: {
            level: centerTile.level,
            x: ((centerTile.x + dx) % scale + scale) % scale,
            y,
          },
          distanceSquared: dx * dx + dy * dy,
        });
      }
    }
    coreTiles.sort((a, b) => a.distanceSquared - b.distanceSquared);

    // Supplying a progress callback selects fast impostor capture and keeps
    // each core tile inside this initial load, including coordinate changes
    // that do not have a page-level loading overlay.
    const coreTileCount = coreTiles.length;
    for (let index = 0; index < coreTileCount; index++) {
      const item = coreTiles[index];
      const tileProgress: InitializationProgress = (step, progress) => {
        onProgress?.(
          coreTileCount > 1 ? `Loading core tiles (${index + 1}/${coreTileCount}): ${step}` : step,
          10 + ((index + progress / 100) / coreTileCount) * 87,
        );
      };
      await this.streamTile(
        item.id,
        index === 0,
        generation,
        tileProgress,
        index === 0 ? () => this.placeCameraAtLocation(target) : undefined,
        true,
      );
      if (generation !== this.streamingGeneration) return;
    }
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
    standInsOnly = false,
  ): Promise<void> {
    const key = worldTileKey(id);
    if (this.activeTileBuilds.has(key)) return;
    this.activeTileBuilds.add(key);
    try {
      let record = this.tiles.get(key);
      if (!record || (wantDetail && !record.nativeTerrain)) {
        record = await this.buildTileTerrain(id, wantDetail, generation, onProgress);
      }
      if (!record) return;
      if (generation === this.streamingGeneration) onTerrainReady?.();
      if (standInsOnly) {
        if (!record.farTreeField) {
          await this.buildFarTrees(record, generation, onProgress ? "fast" : "cooperative");
        }
      } else if (wantDetail && !record.detailed) {
        try {
          await this.buildTileDetail(record, generation, onProgress);
        } catch (error: unknown) {
          // Detail is assembled in stages. Keep anything that did finish
          // visible when one optional feature compiler fails, instead of
          // leaving a successfully loaded destination as bare terrain.
          console.error(`Failed to build detail for tile ${key}.`, error);
          if (generation === this.streamingGeneration) {
            await this.activateTileVegetation(record, generation);
          }
        }
      } else if (!wantDetail) {
        // Runs for undetailed tiles, and for detailed tiles the scheduler
        // queued ahead of a demotion (the stand-ins commit hidden there).
        if (!record.farTreeField) await this.buildFarTrees(record, generation);
        if (!record.farBuildings) await this.buildFarBuildings(record, generation);
        if (!record.farRoads) await this.buildFarRoads(record, generation);
      }
    } finally {
      this.activeTileBuilds.delete(key);
    }
  }

  private async buildTileTerrain(
    id: WorldTileId,
    native: boolean,
    generation: number,
    onProgress?: InitializationProgress,
  ): Promise<StreamedTile | undefined> {
    const key = worldTileKey(id);
    const previous = this.tiles.get(key);
    const area = worldTileArea(id, this.worldSeed);
    const yieldControl = onProgress ? undefined : this.streamingYielder;
    const terrainData = await TerrainElevationSource.fetchWorldArea(area, yieldControl);
    if (generation !== this.streamingGeneration) return undefined;
    await reportInitializationProgress(onProgress, "Loading land cover", 24);
    const landCover = previous?.landCover ??
      await WorldCover.fetchForTerrain(terrainData).catch((error: unknown) => {
        console.warn("ESA WorldCover unavailable; land-cover layers were skipped.", error);
        return undefined;
      });
    if (generation !== this.streamingGeneration) return undefined;
    const preCarvingElevations = terrainData.elevations.slice();
    if (landCover) {
      await landCover.constrainElevations(
        terrainData,
        undefined,
        undefined,
        yieldControl,
      );
    } else {
      sinkSubmergedTerrain(terrainData);
    }
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
      console.log(
        `World frame anchored at tile ${key} (1 unit = ${metersPerUnit.toFixed(1)}m)`,
      );
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

    let mapTiles = previous?.mapTiles;
    mapTiles ??= this.requestMapTiles(terrainData.bounds);
    let lakeContextTiles = previous?.lakeContextTiles;
    lakeContextTiles ??= this.requestMapTiles(expandTerrainBounds(
      terrainData,
      LAKE_TERRAIN_CONTEXT_METERS,
    ));
    const [lakeTiles, contextTiles] = await Promise.all([mapTiles, lakeContextTiles]);
    if (generation !== this.streamingGeneration) return undefined;
    const surfaceLakeSources = OpenStreetMap.collectLakePolygons(
      lakeTiles,
      terrainData,
      { meshWidth, meshDepth },
    );
    const lakeSources = OpenStreetMap.collectLakePolygons(
      contextTiles,
      terrainData,
      {
        meshWidth,
        meshDepth,
        clipPadding: LAKE_TERRAIN_CONTEXT_METERS / metersPerUnit,
      },
    );
    const lakePolygons: TerrainLakePolygon[] = await conformTerrainToLakePolygons(
      terrainData,
      preCarvingElevations,
      lakeSources,
      {
        meshWidth,
        meshDepth,
        metersPerUnit,
        sharedLakeElevations: this.lakeElevations,
        surfaceSources: surfaceLakeSources,
      },
      yieldControl,
    );
    if (generation !== this.streamingGeneration) return undefined;
    if (native) {
      await reportInitializationProgress(onProgress, "Planning roads and building sites", 34);
    }
    const roadAndBuildingPlan = OpenStreetMap.planRoadsAndBuildings(
      lakeTiles,
      terrainData,
      { meshWidth, meshDepth, metersPerUnit },
    );
    if (native) {
      await OpenStreetMap.conformTerrainToPlan(
        roadAndBuildingPlan,
        terrainData,
        {
          meshWidth,
          meshDepth,
          metersPerUnit,
          sharedBuildingElevations: this.buildingElevations,
        },
        yieldControl,
      );
      if (generation !== this.streamingGeneration) return undefined;
    }

    // Cache only finalized terrain. Newly attached tiles now adopt lake,
    // building, and road deformation from an already-visible neighbor instead
    // of restoring the pre-lake WorldCover edge that caused tile chasms.
    stitchTerrainEdges(terrainData, this.terrainEdgeElevations);

    const subdivisions = Math.max(
      1,
      native
        ? terrainData.width - 1
        : Math.min(FAR_TILE_SUBDIVISIONS, terrainData.width - 1),
    );
    await reportInitializationProgress(onProgress, "Building terrain mesh", 40);
    const terrain = await this.createTerrainMesh(`terrain ${key}`, terrainData, {
      meshWidth,
      meshDepth,
      subdivisions,
      metersPerUnit,
      worldOffsetX: offset.x,
      worldOffsetZ: offset.z,
      landCover,
      yieldControl,
    });
    if (generation !== this.streamingGeneration) {
      disposeTerrainMesh(terrain);
      return undefined;
    }
    setFrozenMeshOffset(terrain, offset.x, offset.z);
    terrain.checkCollisions = true;
    terrain.setEnabled(true);

    let lakeSurfaces = previous?.lakeSurfaces;
    if (!lakeSurfaces) {
      lakeSurfaces = await createTerrainLakeLayer(
        this.scene,
        lakePolygons,
        {
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
    }
    setTransformNodeOffset(lakeSurfaces.root, offset.x, offset.z);
    for (const mesh of lakeSurfaces.meshes) mesh.freezeWorldMatrix();
    lakeSurfaces.root.setEnabled(true);

    // Upgrading a streamed tile from the coarse terrain tier to native detail
    // replaces its record. Keep the already-visible distant tree stand-in
    // alive across that replacement; buildTileDetail will cross-fade it only
    // after the matching detailed tree field has committed.
    const carriedFarTreeField = previous?.farTreeField;
    const carriedFarBuildings = previous?.farBuildings;
    const carriedFarRoads = previous?.farRoads;
    if (previous) {
      previous.farTreeField = undefined;
      previous.farBuildings = undefined;
      previous.farRoads = undefined;
      previous.lakeSurfaces = undefined;
    }
    const now = performance.now();
    const record: StreamedTile = {
      id: area.center,
      key,
      terrainData,
      landCover,
      preCarvingElevations,
      mapTiles,
      lakeContextTiles,
      roadAndBuildingPlan,
      terrain,
      meshWidth,
      meshDepth,
      offsetX: offset.x,
      offsetZ: offset.z,
      nativeTerrain: native,
      lakeSurfaces,
      farTreeField: carriedFarTreeField,
      farBuildings: carriedFarBuildings,
      farRoads: carriedFarRoads,
      detailed: false,
      lastNeededMilliseconds: now,
      detailLastNeededMilliseconds: now,
      lodResolved: false,
    };
    this.tiles.set(key, record);
    if (previous) disposeStreamedTile(previous);
    this.playerControls?.ensureAboveGround();
    return record;
  }

  private async buildTileDetail(
    record: StreamedTile,
    generation: number,
    onProgress?: InitializationProgress,
  ): Promise<void> {
    const { terrainData } = record;
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const yieldControl = onProgress ? undefined : this.streamingYielder;
    const startDisabled = !onProgress;
    await reportInitializationProgress(onProgress, "Loading map features", 50);
    const mapWays = await this.loadMapTiles(record);
    if (generation !== this.streamingGeneration) return;
    const placementLandCover = OpenStreetMap.createLandCoverSampler(
      mapWays,
      record.landCover,
    );

    const mapOptions = {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      preCarvingElevations: record.preCarvingElevations,
      skyReflection: this.solarLighting?.skyReflectionTexture,
      showRoofs: this.sceneSettings.value.showRoofs,
      startDisabled,
      planning: record.roadAndBuildingPlan,
      sharedBuildingElevations: this.buildingElevations,
      terrainSurface: TerrainSurface.fromGroundMesh(
        record.terrain,
        record.meshWidth,
        record.meshDepth,
      ),
    };
    let mappedExclusionMask;
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
      yieldControl,
      impostorCaptureMode: onProgress ? "fast" as const : "cooperative" as const,
      startDisabled,
    };
    const winterGroundCover = hasWinterGroundCover(
      this.vegetationDate,
      (terrainData.bounds.latNorth + terrainData.bounds.latSouth) / 2,
    );
    const actorMix = proceduralActorMixAtTile(record.id, this.worldSeed);

    await reportInitializationProgress(onProgress, "Planting trees", 58);
    const treeField = await createTreeField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "trees"),
      speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
      densityScale: () => actorMix.trees.densityScale,
      renderMode: this.vegetationModes.trees,
      includeFallenLogs: true,
    });
    await this.prepareTileFieldLod(
      record,
      treeField,
      this.vegetationLodDistanceMeters,
      yieldControl,
    );
    if (!this.stageTileField(record, "treeField", treeField, generation)) return;

    await reportInitializationProgress(onProgress, "Planting saplings", 63);
    const saplingField = await createSaplingField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "saplings"),
      speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
      densityScale: () => actorMix.trees.densityScale,
      renderMode: this.vegetationModes.trees,
    });
    await this.prepareTileFieldLod(
      record,
      saplingField,
      this.vegetationLodDistanceMeters,
      yieldControl,
    );
    if (!this.stageTileField(record, "saplingField", saplingField, generation)) return;

    await reportInitializationProgress(onProgress, "Growing grass", 68);
    const grassField = await createGrassField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "grass"),
      renderMode: this.vegetationModes.grass,
      densityScale: () => winterGroundCover ? 0 : actorMix.grass.densityScale,
    });
    await this.prepareTileFieldLod(
      record,
      grassField,
      this.fieldLodDistance("grassField"),
      yieldControl,
    );
    if (!this.stageTileField(record, "grassField", grassField, generation)) return;

    await reportInitializationProgress(onProgress, "Growing wildflowers", 74);
    const tallPlantField = await createTallPlantField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "tallPlants"),
      densityScale: () => winterGroundCover ? 0 : actorMix.tallPlants.densityScale,
      renderMode: this.vegetationModes.grass,
    });
    await this.prepareTileFieldLod(
      record,
      tallPlantField,
      this.vegetationLodDistanceMeters,
      yieldControl,
    );
    if (!this.stageTileField(record, "tallPlantField", tallPlantField, generation)) return;

    await reportInitializationProgress(onProgress, "Growing wheat", 76);
    const wheatField = await createWheatField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "wheat"),
      densityScale: () => actorMix.tallPlants.densityScale,
      renderMode: this.vegetationModes.grass,
    });
    await this.prepareTileFieldLod(
      record,
      wheatField,
      this.vegetationLodDistanceMeters,
      yieldControl,
    );
    if (!this.stageTileField(record, "wheatField", wheatField, generation)) return;

    await reportInitializationProgress(onProgress, "Adding bushes", 79);
    const bushField = await createBushField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "bushes"),
      densityScale: () => winterGroundCover ? 0 : actorMix.bushes.densityScale,
      renderMode: this.vegetationModes.bushes,
    });
    await this.prepareTileFieldLod(
      record,
      bushField,
      this.vegetationLodDistanceMeters,
      yieldControl,
    );
    if (!this.stageTileField(record, "bushField", bushField, generation)) return;

    await reportInitializationProgress(onProgress, "Growing undergrowth", 83);
    const fernField = await createFernField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "ferns"),
      densityScale: () => winterGroundCover ? 0 : actorMix.ferns.densityScale,
      renderMode: this.vegetationModes.grass,
    });
    await this.prepareTileFieldLod(
      record,
      fernField,
      this.vegetationLodDistanceMeters,
      yieldControl,
    );
    if (!this.stageTileField(record, "fernField", fernField, generation)) return;

    await reportInitializationProgress(onProgress, "Covering rocky beaches", 85);
    const rockyBeachField = await createRockyBeachField(this.scene, terrainData, {
      ...fieldOptions,
      seed: layerSeed(terrainData.generationSeed, "rockyBeaches"),
      densityScale: () => winterGroundCover ? 0 : actorMix.rocks.densityScale,
      renderMode: this.vegetationModes.grass,
    });
    await this.prepareTileFieldLod(
      record,
      rockyBeachField,
      this.vegetationLodDistanceMeters,
      yieldControl,
    );
    if (!this.stageTileField(
      record,
      "rockyBeachField",
      rockyBeachField,
      generation,
    )) return;

    await reportInitializationProgress(onProgress, "Scattering rocks", 86);
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

    await reportInitializationProgress(onProgress, "Creating map features", 88);
    const mapFeatures = await OpenStreetMap.createLayer(
      this.scene,
      mapWays,
      terrainData,
      mapOptions,
      yieldControl,
    );
    const plotBoundaryLayer = await OpenStreetMapBarriers.createPlannedLayer(
      this.scene,
      record.roadAndBuildingPlan.plotBoundaries,
      terrainData,
      mapOptions,
      yieldControl,
    );
    const streetLampLayer = StreetLamps.createLayer(
      this.scene,
      record.roadAndBuildingPlan.streetLamps,
      terrainData,
      mapOptions,
    );
    if (generation !== this.streamingGeneration) {
      OpenStreetMap.disposeLayer(mapFeatures.root);
      plotBoundaryLayer.root.dispose(false, true);
      streetLampLayer.root.dispose(false, true);
      return;
    }
    plotBoundaryLayer.root.parent = mapFeatures.root;
    streetLampLayer.root.parent = mapFeatures.root;
    await this.streamingYielder.nextFrame();
    setTransformNodeOffset(mapFeatures.root, record.offsetX, record.offsetZ);
    await this.streamingYielder.nextFrame();
    mapFeatures.root.setEnabled(true);
    const mapRoot = mapFeatures.root;
    this.layerFades.begin(0, 1, (fade) => setMapLayerFade(mapRoot, fade), undefined, true);
    record.mapFeatures = mapFeatures.root;
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
    this.refreshShadowCasters();
    console.log(
      `Tile ${record.key}: ${treeField.count} trees, ${saplingField.count} saplings, ` +
      `${grassField.count} grass, ${tallPlantField.count} wildflower patches, ` +
      `${wheatField.count} wheat, ` +
      `${bushField.count} bushes, ` +
      `${fernField.count} ferns, ${rockyBeachField.count} rocky beach patches, ` +
      `${rockField.count} rocks, ` +
      `${mapFeatures.counts.buildings} buildings, ` +
      `${mapFeatures.counts.roads} roads, ${plotBoundaryLayer.count} plot boundaries, ` +
      `${streetLampLayer.count} street lamps (${streetLampLayer.mappedCount} mapped)`,
    );
  }

  /**
   * Gives a tile outside the detail rings a cheap tree layer: lowest-LOD
   * impostors only, no models, no shadows, and no per-frame LOD work. Forests
   * then read all the way to the fog instead of ending at the detail ring.
   */
  private async buildFarTrees(
    record: StreamedTile,
    generation: number,
    impostorCaptureMode: "fast" | "cooperative" = "cooperative",
  ): Promise<void> {
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const mapWays = await this.loadMapTiles(record);
    if (generation !== this.streamingGeneration) return;
    const placementLandCover = OpenStreetMap.createLandCoverSampler(
      mapWays,
      record.landCover,
    );
    const exclusionMask = await OpenStreetMap.createVegetationExclusionMask(
      mapWays,
      record.terrainData,
      {
        meshWidth: record.meshWidth,
        meshDepth: record.meshDepth,
        metersPerUnit,
        planning: record.roadAndBuildingPlan,
      },
      this.streamingYielder,
    );
    if (generation !== this.streamingGeneration) return;
    const actorMix = proceduralActorMixAtTile(record.id, this.worldSeed);
    const treeField = await createTreeField(this.scene, record.terrainData, {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      seed: layerSeed(record.terrainData.generationSeed, "trees"),
      speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
      densityScale: () => actorMix.trees.densityScale,
      modelVariantSeed: layerSeed(this.worldSeed, "proceduralModels"),
      seasonalDate: this.vegetationDate,
      landCover: placementLandCover,
      exclusionMask,
      spacingMeters: FAR_TREE_SPACING_METERS,
      occupancy: FAR_TREE_OCCUPANCY,
      edgeOccupancy: FAR_TREE_EDGE_OCCUPANCY,
      includeModels: false,
      forceLowestImpostorLod: true,
      renderMode: "impostors",
      yieldControl: impostorCaptureMode === "cooperative" ? this.streamingYielder : undefined,
      impostorCaptureMode,
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
    record.farTreeField = treeField;
    if (record.detailed) {
      // Pre-built for an upcoming demotion: stays hidden until the tile's full
      // detail cross-fades out.
      treeField.root.setEnabled(false);
    } else {
      treeField.root.setEnabled(true);
      this.layerFades.fadeFieldIn(treeField);
    }
  }

  /** Builds one merged massing layer for buildings outside the detail rings. */
  private async buildFarBuildings(record: StreamedTile, generation: number): Promise<void> {
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const mapWays = await this.loadMapTiles(record);
    if (generation !== this.streamingGeneration) return;
    const layer = await OpenStreetMap.createBuildingLayer(
      this.scene,
      mapWays,
      record.terrainData,
      {
        meshWidth: record.meshWidth,
        meshDepth: record.meshDepth,
        metersPerUnit,
        showRoofs: this.sceneSettings.value.showRoofs,
        startDisabled: true,
        planning: record.roadAndBuildingPlan,
      },
      "far",
      this.streamingYielder,
    );
    if (generation !== this.streamingGeneration || record.farBuildings) {
      OpenStreetMap.disposeLayer(layer.root);
      return;
    }
    setTransformNodeOffset(layer.root, record.offsetX, record.offsetZ);
    record.farBuildings = layer.root;
    if (record.detailed) {
      layer.root.setEnabled(false);
    } else {
      layer.root.setEnabled(true);
      this.layerFades.begin(0, 1, (fade) => setMapLayerFade(layer.root, fade));
    }
  }

  /** Builds coarsely sampled road surfaces for tiles outside the detail rings. */
  private async buildFarRoads(record: StreamedTile, generation: number): Promise<void> {
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const mapWays = await this.loadMapTiles(record);
    if (generation !== this.streamingGeneration) return;
    const layer = await OpenStreetMap.createRoadLayer(
      this.scene,
      mapWays,
      record.terrainData,
      {
        meshWidth: record.meshWidth,
        meshDepth: record.meshDepth,
        metersPerUnit,
        preCarvingElevations: record.preCarvingElevations,
        startDisabled: true,
        planning: record.roadAndBuildingPlan,
        terrainSurface: TerrainSurface.fromGroundMesh(
          record.terrain,
          record.meshWidth,
          record.meshDepth,
        ),
      },
      this.streamingYielder,
    );
    if (generation !== this.streamingGeneration || record.farRoads) {
      OpenStreetMap.disposeLayer(layer.root);
      return;
    }
    setTransformNodeOffset(layer.root, record.offsetX, record.offsetZ);
    record.farRoads = layer.root;
    if (record.detailed) {
      layer.root.setEnabled(false);
    } else {
      layer.root.setEnabled(true);
      this.layerFades.begin(0, 1, (fade) => setMapLayerFade(layer.root, fade));
    }
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
    if (kind === "grassField") {
      setGrassFieldDetailDistance(
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

    // The cooperative preparation cached an earlier camera position while the
    // field was disabled. Repack and upload once after enabling so a late tile
    // cannot fade its stand-in before its real model slots are renderable.
    this.updateVegetationLod(record);

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
    reflections.samples = 4;
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
    center: WorldTileId,
    detailWindow: WorldTileWindowOffsets,
  ): void {
    const scale = 2 ** center.level;
    let detailChanged = false;
    for (const record of [...this.tiles.values()]) {
      if (this.activeTileBuilds.has(record.key)) continue;
      const rawDx = record.id.x - center.x;
      const dx = rawDx > scale / 2
        ? rawDx - scale
        : rawDx < -scale / 2 ? rawDx + scale : rawDx;
      const dy = Math.abs(record.id.y - center.y);
      const ring = Math.max(Math.abs(dx), dy);
      const wantDetail = dx >= detailWindow.minimumX && dx <= detailWindow.maximumX &&
        record.id.y - center.y >= detailWindow.minimumY &&
        record.id.y - center.y <= detailWindow.maximumY;
      if (ring > this.terrainTileRadius &&
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
      } else if (kbInfo.event.key === "f" || kbInfo.event.key === "F") {
        this.fpsCounter.toggleExpanded();
      } else if (kbInfo.event.key === "r" || kbInfo.event.key === "R") {
        this.fpsCounter.dumpRenderStats(this.engine, this.scene, this.getRenderStatsContext());
      } else if (kbInfo.event.key === "0") {
        void this.changeToRandomTerrainLocation();
      } else if (/^[1-9]$/.test(kbInfo.event.key)) {
        const locationIndex = Number(kbInfo.event.key) - 1;
        if (locationIndex < EXAMPLE_LOCATIONS.length) {
          void this.reloadAtLocation(EXAMPLE_LOCATIONS[locationIndex]);
        }
      }
    });
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
    if (detailSizeChanged) this.updateGrassDetailDistance();
    if (modelRangeChanged) this.updateVegetationLod();
    if (cloudDensityChanged) this.cloudLayer?.setDensity(next.cloudDensity);
  }

  private changeRoofsVisibility(visible: boolean): void {
    this.sceneSettings.setRoofsVisible(visible);
    this.streamingGeneration++;
    for (const record of this.tiles.values()) {
      if (record.mapFeatures) {
        const layer = record.mapFeatures;
        record.mapFeatures = undefined;
        OpenStreetMap.disposeLayer(layer);
      }
      if (record.farBuildings) {
        const layer = record.farBuildings;
        record.farBuildings = undefined;
        OpenStreetMap.disposeLayer(layer);
      }
      record.detailed = false;
    }
    this.requestStreamingUpdate();
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
  }

  private requestStreamingUpdate(): void {
    this.lastTerrainStreamingCheckMilliseconds = Number.NEGATIVE_INFINITY;
    this.updateTerrainStreaming();
  }

  private updateGrassDetailDistance(): void {
    const detailTilesAcross = this.sceneSettings.value.detailTilesAcross;
    for (const record of this.tiles.values()) {
      if (!record.grassField) continue;
      setGrassFieldDetailDistance(
        record.grassField,
        Math.min(record.meshWidth, record.meshDepth),
        detailTilesAcross,
      );
    }
  }

  private fieldLodDistance(kind: VegetationFieldKind): number {
    return kind === "grassField"
      ? Math.min(this.vegetationLodDistanceMeters, GRASS_MODEL_RANGE_CAP_METERS)
      : this.vegetationLodDistanceMeters;
  }

  private updateVegetationLod(forceRecord?: StreamedTile): void {
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
      forceFullUpdate = false,
    ): void => {
      localPosition.copyFrom(cameraPosition);
      localPosition.x -= originX;
      localPosition.z -= originZ;
      field.updateLod(localPosition, distanceMeters, forceFullUpdate);
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
      const forceFullUpdate = record === forceRecord;
      if (!forceFullUpdate && !withinReach && record.lodResolved) continue;
      record.lodResolved = !withinReach;
      for (const kind of VEGETATION_FIELD_KINDS) {
        const field = record[kind];
        if (field) updateField(
          field,
          this.fieldLodDistance(kind),
          field.root.position.x,
          field.root.position.z,
          forceFullUpdate,
        );
      }
      if (record.barrierField && record.mapFeatures) {
        updateField(
          record.barrierField,
          this.vegetationLodDistanceMeters,
          record.mapFeatures.position.x,
          record.mapFeatures.position.z,
          forceFullUpdate,
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
    console.log(
      `[Vegetation LOD / 2s] total=${stats.totalInstances.toLocaleString()} ` +
      `grid-now=${stats.currentGridCandidates.toLocaleString()} ` +
      `transition-now=${stats.currentTransitionInstances.toLocaleString()} ` +
      `processed-avg=${averageProcessed.toLocaleString()}/update ` +
      `processed-peak=${stats.peakProcessedInstances.toLocaleString()} ` +
      `slot-crossings=${stats.membershipChanges.toLocaleString()} ` +
      `full-rebuilds=${stats.fullRebuilds}`,
    );
  }

  /** Persists a keyboard-selected destination, then rebuilds all scene-owned state. */
  private async reloadAtLocation(target: WorldLocation): Promise<void> {
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
        activeBuilds: [...this.activeTileBuilds],
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
      const bounds = worldTileBounds(worldTileAtLocation(
        location.lat,
        location.lon,
        this.gridLevel,
      ));
      const [landCover, elevation] = await Promise.all([
        WorldCover.fetch(bounds),
        TerrainElevationSource.fetchElevationAtLocation(location.lat, location.lon),
      ]);
      return (
        landCover.sample(location.lon, location.lat) !== LandCoverClass.Water &&
        elevation > 0
      );
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

  private updateTerrainStreaming(): void {
    const now = performance.now();
    if (now - this.lastTerrainStreamingCheckMilliseconds < TERRAIN_STREAMING_CHECK_INTERVAL_MS) {
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
    const detailWindow = worldTileWindowOffsetsAtLocation(
      lat,
      lon,
      this.sceneSettings.value.detailTilesAcross,
      center.level,
    );
    const work: Array<{ id: WorldTileId; detail: boolean; distanceSquared: number }> = [];
    for (let dy = -this.terrainTileRadius; dy <= this.terrainTileRadius; dy++) {
      const y = center.y + dy;
      if (y < 0 || y >= scale) continue;
      for (let dx = -this.terrainTileRadius; dx <= this.terrainTileRadius; dx++) {
        const id: WorldTileId = {
          level: center.level,
          x: ((center.x + dx) % scale + scale) % scale,
          y,
        };
        const key = worldTileKey(id);
        const wantDetail = dx >= detailWindow.minimumX && dx <= detailWindow.maximumX &&
          dy >= detailWindow.minimumY && dy <= detailWindow.maximumY;
        const record = this.tiles.get(key);
        if (record) {
          record.lastNeededMilliseconds = now;
          if (wantDetail) record.detailLastNeededMilliseconds = now;
        }
        if (this.activeTileBuilds.has(key)) continue;
        const needsTerrain = !record ||
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
          work.push({ id, detail: wantDetail, distanceSquared: dx * dx + dy * dy });
        }
      }
    }
    work.sort((a, b) => a.distanceSquared - b.distanceSquared);
    for (const item of work) {
      // Keep the main-thread workload predictable: one tile builds at a time.
      if (this.activeTileBuilds.size > 0) break;
      void this.streamTile(item.id, item.detail, generation).catch((error: unknown) => {
        console.error(`Failed to stream tile ${worldTileKey(item.id)}.`, error);
      });
    }

    this.evictCooledTiles(now, center, detailWindow);
  }

  run(): void {
    this.engine.runRenderLoop(() => {
      const gameStart = performance.now();
      this.playerControls?.updateMovement();
      this.updateTerrainStreaming();
      this.layerFades.update();
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
      });
    });
  }

  resize(): void {
    this.engine.resize();
  }

  dispose(): void {
    window.removeEventListener("pagehide", this.handlePageHide);
    this.playerControls?.dispose();
    this.playerPresence.dispose();
    this.fpsCounter.dispose();
    this.sceneControls?.dispose();
    this.cloudLayer?.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  /** Hands the locally predicted camera transform to the presence subsystem. */
  private publishLocalPlayerPose(force = false): void {
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

  /** Finds the streamed tile whose footprint contains a scene position. */
  private tileAtScenePosition(x: number, z: number): StreamedTile | undefined {
    const frame = this.terrainCoordinateFrame;
    if (!frame) return undefined;
    const { lon, lat } = sceneToLonLat(x, z, frame.bounds, frame.meshWidth, frame.meshDepth);
    return this.tiles.get(worldTileKey(worldTileAtLocation(lat, lon, this.gridLevel)));
  }

  /** Bare terrain is not ready for entry until it has visible world content. */
  private isScenePositionReady(x: number, z: number): boolean {
    const record = this.tileAtScenePosition(x, z);
    return record !== undefined && (record.detailed || record.farTreeField !== undefined);
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
      worldOffsetX?: number;
      worldOffsetZ?: number;
      landCover?: LandCoverSampler;
      yieldControl?: FrameBudgetYielder;
    },
  ): Promise<Mesh> {
    return buildTerrainMesh(this.scene, name, terrain, {
      ...options,
      worldSeed: this.worldSeed,
      snowCovered: hasWinterGroundCover(
        this.vegetationDate,
        (terrain.bounds.latNorth + terrain.bounds.latSouth) / 2,
      ),
    });
  }

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
