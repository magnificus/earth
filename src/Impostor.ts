import {
  Color4,
  Constants,
  FreeCamera,
  Mesh,
  RawTexture,
  RenderTargetTexture,
  Scene,
  Texture,
  Vector3,
  Viewport,
} from "@babylonjs/core";
import { documentIsBackgrounded, waitForNextFrame as nextFrame } from "./FrameBudget";
import { waitForVertexColorTextures } from "./procedural/ProceduralCaptureMaterial";

export interface ImpostorAssets {
  /** Raw RGBA atlases preserve hidden edge colors used by bilinear filtering. */
  textures: Texture[];
  /** Source canvases retained for the capture preview and validation tools. */
  atlasCanvases: HTMLCanvasElement[];
  /** Per-frame downsampled atlases used once an impostor is small on screen. */
  lowResolutionTextures: Texture[];
  rotationallySymmetric: boolean;
  rotationalSymmetryOrder: number;
  /** Side-face rows start at a level view instead of including views from below. */
  upperHemisphereOnly: boolean;
  gridWidth: number;
  gridHeight: number;
  /** Kept for the square-grid validation tools. */
  gridSize: number;
  resolution: number;
  resolutionWidth: number;
  resolutionHeight: number;
  lowResolutionWidth: number;
  lowResolutionHeight: number;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth: number;
  captureHeight: number;
}

/** Runtime capture work per frame; editor/demo captures retain their faster path. */
const RUNTIME_CAPTURE_FRAME_BUDGET_MS = 2;
const OFFLINE_CAPTURE_FRAME_BUDGET_MS = 12;
const BACKGROUND_CAPTURE_VIEWS_PER_SLICE = 16;

/** Target height of each frame in the distant impostor atlas. */
const LOW_RESOLUTION_FRAME_SIZE = 20;
/** Any meaningful source coverage becomes a solid distant texel. */
const LOW_RESOLUTION_ALPHA_THRESHOLD = 8;

export interface CubeFace {
  normal: Vector3;
  right: Vector3;
  up: Vector3;
}

export const IMPOSTOR_CUBE_FACES: readonly CubeFace[] = [
  { normal: new Vector3(1, 0, 0), right: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(-1, 0, 0), right: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, -1) },
  { normal: new Vector3(0, 0, 1), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 0, -1), right: new Vector3(-1, 0, 0), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, -1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, 1) },
];

/** One side and the top are sufficient for sources symmetric around the Y axis. */
export const AXISYMMETRIC_IMPOSTOR_FACES: readonly CubeFace[] = [
  IMPOSTOR_CUBE_FACES[0],
  IMPOSTOR_CUBE_FACES[2],
];

export interface ImpostorCaptureOptions {
  name: string;
  meshes: Mesh[];
  gridWidth: number;
  gridHeight: number;
  resolution: number;
  resolutionWidth?: number;
  resolutionHeight?: number;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth?: number;
  captureHeight?: number;
  faces?: readonly CubeFace[];
  rotationallySymmetric?: boolean;
  rotationalSymmetryOrder?: number;
  /** Captures side faces from level through overhead; top faces retain their full range. */
  upperHemisphereOnly?: boolean;
  /** Prioritizes stable gameplay frames over total capture duration. */
  cooperative?: boolean;
  onProgress?: (
    completed: number,
    total: number,
    faceIndex: number,
    x: number,
    y: number,
  ) => void;
}

export interface ImpostorSampling {
  horizontalSamples: number;
  verticalSamples: number;
  resolution: number;
}

export interface ImpostorVariant {
  /** Stable spatial identity included in the per-scene atlas cache key. */
  key: string;
  /** Seed supplied to the procedural source. Omitted by legacy static captures. */
  seed?: number;
}

export interface ImpostorAssetRequestOptions {
  /** Overrides whether a newly required atlas is spread across gameplay frames. */
  cooperative?: boolean;
}

export interface ImpostorAssetLease {
  assets: ImpostorAssets;
  release(): void;
}

export interface ImpostorParameter {
  default: number;
  minimum: number;
  maximum: number;
}

export interface ImpostorDefinition {
  /** Stable identifier used for Babylon resources and logs. */
  name: string;
  /** Defaults to `name`; useful when resource names and public parameters differ. */
  queryPrefix?: string;
  createSource(scene: Scene, variant: ImpostorVariant): Mesh | Mesh[] | Promise<Mesh | Mesh[]>;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth?: number;
  captureHeight?: number;
  /** Fits width and height to the generated mesh bounds with this multiplier. */
  boundsPadding?: number;
  preserveCaptureAspectRatio?: boolean;
  minimumResolutionWidth?: number;
  faces?: readonly CubeFace[];
  rotationallySymmetric?: boolean;
  rotationalSymmetryOrder?: number;
  /** Omits below-object angles from side-face atlas rows. Defaults to false. */
  upperHemisphereOnly?: boolean;
  sampling: {
    horizontalSamples: ImpostorParameter;
    verticalSamples: ImpostorParameter;
    resolution: ImpostorParameter;
  };
}

export interface ImpostorAssetProvider {
  getAssets(
    scene: Scene,
    sampling?: Partial<ImpostorSampling>,
    variant?: ImpostorVariant,
    requestOptions?: ImpostorAssetRequestOptions,
  ): Promise<ImpostorAssets>;
  acquireAssets(
    scene: Scene,
    sampling?: Partial<ImpostorSampling>,
    variant?: ImpostorVariant,
    requestOptions?: ImpostorAssetRequestOptions,
  ): Promise<ImpostorAssetLease>;
  getDefaultSampling(): ImpostorSampling;
}

interface ImpostorCacheEntry {
  promise: Promise<ImpostorAssets>;
  references: number;
  pinned: boolean;
  lastUsed: number;
}

const DEFAULT_IMPOSTOR_VARIANT: ImpostorVariant = { key: "default" };
/** Four corner variants, the legacy default, and one recently used neighbor. */
const MAX_CACHED_IMPOSTOR_VARIANTS = 6;
const sceneCaptureTails = new WeakMap<Scene, Promise<void>>();

/**
 * Turns a procedural source descriptor into a lazy, per-scene atlas provider.
 * Adding a new model only requires a descriptor and its geometry factory.
 */
export function createImpostorAssetProvider(
  definition: ImpostorDefinition,
): ImpostorAssetProvider {
  const sceneAssets = new WeakMap<Scene, Map<string, ImpostorCacheEntry>>();
  const queryPrefix = definition.queryPrefix ?? definition.name;
  let accessCounter = 0;

  const getDefaultSampling = (): ImpostorSampling => ({
    horizontalSamples: queryParameter(
      `${queryPrefix}-x-samples`,
      definition.sampling.horizontalSamples,
    ),
    verticalSamples: queryParameter(
      `${queryPrefix}-y-samples`,
      definition.sampling.verticalSamples,
    ),
    resolution: queryParameter(
      `${queryPrefix}-resolution`,
      definition.sampling.resolution,
    ),
  });

  const getEntry = (
    scene: Scene,
    overrides: Partial<ImpostorSampling>,
    variant: ImpostorVariant,
    requestOptions: ImpostorAssetRequestOptions,
  ): { cache: Map<string, ImpostorCacheEntry>; entry: ImpostorCacheEntry } => {
    const requestedSampling = { ...getDefaultSampling(), ...overrides };
    const regionalVariant = variant.key !== DEFAULT_IMPOSTOR_VARIANT.key;
    const cooperative = requestOptions.cooperative ?? regionalVariant;
    // Regional variants differ only in their source identity. Capture quality
    // is shared with startup captures; cooperative mode only spreads the work
    // across frames while streaming.
    const sampling = requestedSampling;
    validateSampling(definition, sampling);
    let cache = sceneAssets.get(scene);
    if (!cache) {
      cache = new Map();
      sceneAssets.set(scene, cache);
    }

    const key = [
      variant.key,
      variant.seed ?? "static",
      sampling.horizontalSamples,
      sampling.verticalSamples,
      sampling.resolution,
    ].join(":");
    const existing = cache.get(key);
    if (existing) {
      existing.lastUsed = ++accessCounter;
      return { cache, entry: existing };
    }

    const capture = enqueueImpostorCapture(
      scene,
      () => captureDefinition(
        scene,
        definition,
        sampling,
        variant,
        cooperative,
      ),
    );
    const entry: ImpostorCacheEntry = {
      promise: capture,
      references: 0,
      pinned: false,
      lastUsed: ++accessCounter,
    };
    cache.set(key, entry);
    capture.catch(() => {
      if (cache?.get(key) === entry) cache.delete(key);
    });
    return { cache, entry };
  };

  return {
    getDefaultSampling,
    getAssets(scene, overrides = {}, variant = DEFAULT_IMPOSTOR_VARIANT, requestOptions = {}) {
      const { cache, entry } = getEntry(scene, overrides, variant, requestOptions);
      // Legacy callers do not expose a lifetime, so their capture must remain valid.
      entry.pinned = true;
      pruneCache(cache);
      return entry.promise;
    },
    async acquireAssets(
      scene,
      overrides = {},
      variant = DEFAULT_IMPOSTOR_VARIANT,
      requestOptions = {},
    ) {
      const { cache, entry } = getEntry(scene, overrides, variant, requestOptions);
      entry.references++;
      pruneCache(cache);
      let assets: ImpostorAssets;
      try {
        assets = await entry.promise;
      } catch (error) {
        entry.references--;
        throw error;
      }
      let released = false;
      return {
        assets,
        release() {
          if (released) return;
          released = true;
          entry.references = Math.max(0, entry.references - 1);
          entry.lastUsed = ++accessCounter;
          pruneCache(cache);
        },
      };
    },
  };

  function pruneCache(cache: Map<string, ImpostorCacheEntry>): void {
    if (cache.size <= MAX_CACHED_IMPOSTOR_VARIANTS) return;
    const evictable = [...cache.entries()]
      .filter(([, entry]) => entry.references === 0 && !entry.pinned)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    while (cache.size > MAX_CACHED_IMPOSTOR_VARIANTS && evictable.length > 0) {
      const [key, entry] = evictable.shift()!;
      if (cache.get(key) !== entry) continue;
      cache.delete(key);
      void entry.promise.then(disposeImpostorAssets, () => undefined);
    }
  }
}

function enqueueImpostorCapture<T>(scene: Scene, capture: () => Promise<T>): Promise<T> {
  const previous = sceneCaptureTails.get(scene) ?? Promise.resolve();
  const next = previous.then(capture, capture);
  sceneCaptureTails.set(scene, next.then(() => undefined, () => undefined));
  return next;
}

async function captureDefinition(
  scene: Scene,
  definition: ImpostorDefinition,
  sampling: ImpostorSampling,
  variant: ImpostorVariant,
  cooperativeOverride?: boolean,
): Promise<ImpostorAssets> {
  const cooperative = cooperativeOverride ?? variant.key !== DEFAULT_IMPOSTOR_VARIANT.key;
  if (cooperative) await nextFrame();
  const created = await definition.createSource(scene, variant);
  const meshes = Array.isArray(created) ? created : [created];
  if (meshes.length === 0) throw new Error(`${definition.name} created no source meshes.`);

  // A lazily discovered source belongs only to its render target. Keep it out
  // of gameplay frames while textures become ready and between capture views.
  meshes.forEach((mesh) => { mesh.isVisible = false; });

  try {
    // Invisible capture sources are not a reliable part of Babylon's scene
    // readiness checks. Explicitly wait for their optional foliage cutouts so
    // every atlas direction is captured with the same material state.
    await waitForVertexColorTextures(meshes);
    await scene.whenReadyAsync();
    let captureWidth = definition.captureWidth ?? definition.captureDiameter;
    let captureHeight = definition.captureHeight ?? definition.captureDiameter;
    if (definition.boundsPadding !== undefined) {
      const bounds = sourceDimensions(meshes);
      captureWidth = Math.max(bounds.x, bounds.z) * definition.boundsPadding;
      captureHeight = bounds.y * definition.boundsPadding;
    }
    const resolutionWidth = definition.preserveCaptureAspectRatio
      ? Math.max(
        definition.minimumResolutionWidth ?? 1,
        Math.round(sampling.resolution * captureWidth / captureHeight),
      )
      : sampling.resolution;

    const assets = await captureImpostorAtlases(scene, {
      name: variant.key === DEFAULT_IMPOSTOR_VARIANT.key
        ? definition.name
        : `${definition.name}-${resourceKey(variant.key)}`,
      meshes,
      gridWidth: sampling.horizontalSamples,
      gridHeight: sampling.verticalSamples,
      resolution: sampling.resolution,
      resolutionWidth,
      resolutionHeight: sampling.resolution,
      sourceHeight: definition.sourceHeight,
      captureDiameter: definition.captureDiameter,
      captureWidth,
      captureHeight,
      faces: definition.faces,
      rotationallySymmetric: definition.rotationallySymmetric,
      rotationalSymmetryOrder: definition.rotationalSymmetryOrder,
      upperHemisphereOnly: definition.upperHemisphereOnly,
      cooperative,
    });
    console.log(`${definition.name}: capture complete; procedural source disposed`);
    return assets;
  } finally {
    const materials = new Set(meshes.map((mesh) => mesh.material).filter((material) => material !== null));
    meshes.forEach((mesh) => mesh.dispose(false, false));
    // Capture sources may use scene-cached procedural textures that remain
    // useful to live models after the temporary source material is gone.
    materials.forEach((material) => material.dispose(true, false));
  }
}

function disposeImpostorAssets(assets: ImpostorAssets): void {
  const textures = new Set([...assets.textures, ...assets.lowResolutionTextures]);
  textures.forEach((texture) => texture.dispose());
  for (const canvas of assets.atlasCanvases) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function resourceKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function sourceDimensions(meshes: readonly Mesh[]): Vector3 {
  let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    mesh.refreshBoundingInfo();
    const bounds = mesh.getBoundingInfo().boundingBox;
    minimum = Vector3.Minimize(minimum, bounds.minimumWorld);
    maximum = Vector3.Maximize(maximum, bounds.maximumWorld);
  }
  return maximum.subtract(minimum);
}

function validateSampling(definition: ImpostorDefinition, sampling: ImpostorSampling): void {
  for (const [name, value, limits] of [
    ["horizontalSamples", sampling.horizontalSamples, definition.sampling.horizontalSamples],
    ["verticalSamples", sampling.verticalSamples, definition.sampling.verticalSamples],
    ["resolution", sampling.resolution, definition.sampling.resolution],
  ] as const) {
    if (!Number.isInteger(value) || value < limits.minimum || value > limits.maximum) {
      throw new Error(
        `${definition.name} ${name} must be an integer from ${limits.minimum} to ${limits.maximum}.`,
      );
    }
  }
}

function queryParameter(name: string, parameter: ImpostorParameter): number {
  if (typeof window === "undefined") return parameter.default;
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value >= parameter.minimum && value <= parameter.maximum
    ? Math.round(value)
    : parameter.default;
}

/** Captures an origin-centered source into the requested directional atlases. */
export async function captureImpostorAtlases(
  scene: Scene,
  options: ImpostorCaptureOptions,
): Promise<ImpostorAssets> {
  const {
    name,
    meshes,
    gridWidth,
    gridHeight,
    resolution,
    resolutionWidth = resolution,
    resolutionHeight = resolution,
    sourceHeight,
    captureDiameter,
    captureWidth = captureDiameter,
    captureHeight = captureDiameter,
    faces = IMPOSTOR_CUBE_FACES,
    rotationallySymmetric = false,
    rotationalSymmetryOrder = 0,
    upperHemisphereOnly = false,
    cooperative = false,
    onProgress,
  } = options;
  const captureFaces = upperHemisphereOnly
    ? faces.filter((face) => face.normal.y >= -0.5)
    : faces;
  const atlasWidth = gridWidth * resolutionWidth;
  const atlasHeight = gridHeight * resolutionHeight;
  const maxTextureSize = scene.getEngine().getCaps().maxTextureSize;
  if (atlasWidth > maxTextureSize || atlasHeight > maxTextureSize) {
    throw new Error(
      `${name} atlas ${atlasWidth}x${atlasHeight}px exceeds the GPU limit of ${maxTextureSize}px.`,
    );
  }
  console.log(
    `${name}: capturing ${captureFaces.length * gridWidth * gridHeight} views ` +
    `(${gridWidth}x${gridHeight} directions per face) ` +
    `at ${resolutionWidth}x${resolutionHeight}`,
  );

  const canvases = captureFaces.map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = atlasWidth;
    canvas.height = atlasHeight;
    return canvas;
  });
  const camera = new FreeCamera(`${name}CaptureCamera`, Vector3.Zero(), scene);
  camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.01;
  camera.maxZ = captureDiameter * 4;
  camera.orthoLeft = -captureWidth / 2;
  camera.orthoRight = captureWidth / 2;
  // All of a face's views render into one atlas-sized target through per-tile
  // camera viewports, so the whole face needs a single GPU readback instead of
  // one synchronous pipeline stall per view.
  const target = new RenderTargetTexture(
    `${name}CaptureTarget`,
    { width: atlasWidth, height: atlasHeight },
    scene,
    false,
    false,
  );
  target.clearColor = new Color4(0, 0, 0, 0);
  target.renderList = meshes;
  target.activeCamera = camera;
  target.samples = 1;
  // The default clear wipes the full target on every tile render, erasing the
  // tiles already captured. Tiles occupy disjoint viewport regions, so color
  // and depth only need clearing once per face.
  let clearPending = true;
  target.onClearObservable.add(() => {
    if (!clearPending) return;
    scene.getEngine().clear(target.clearColor, true, true, true);
    clearPending = false;
  });
  const sourceVisibility = meshes.map((mesh) => mesh.isVisible);
  const total = captureFaces.length * gridWidth * gridHeight;
  let completed = 0;
  let sliceStart = performance.now();
  let viewsThisFrame = 0;
  const frameBudget = cooperative
    ? RUNTIME_CAPTURE_FRAME_BUDGET_MS
    : OFFLINE_CAPTURE_FRAME_BUDGET_MS;

  try {
    if (cooperative) {
      await nextFrame();
      sliceStart = performance.now();
    }
    for (let faceIndex = 0; faceIndex < captureFaces.length; faceIndex++) {
      const face = captureFaces[faceIndex];
      const context = canvases[faceIndex].getContext("2d", { alpha: true })!;
      const verticalSpan = Math.abs(face.normal.y) > 0.5 ? captureWidth : captureHeight;
      camera.orthoTop = verticalSpan / 2;
      camera.orthoBottom = -verticalSpan / 2;
      clearPending = true;
      for (let y = 0; y < gridHeight; y++) {
        for (let x = 0; x < gridWidth; x++) {
          // A background page paints nothing, so capture views no longer have
          // to leave room for a gameplay frame between them.
          const viewsPerSlice = documentIsBackgrounded() ? BACKGROUND_CAPTURE_VIEWS_PER_SLICE : 1;
          if (cooperative && viewsThisFrame >= viewsPerSlice) {
            await nextFrame();
            sliceStart = performance.now();
            viewsThisFrame = 0;
          }
          const u = gridWidth === 1 ? 0 : (x / (gridWidth - 1)) * 2 - 1;
          const fullRangeV = gridHeight === 1 ? 0 : (y / (gridHeight - 1)) * 2 - 1;
          const isSideFace = Math.abs(face.normal.y) <= 0.5;
          const v = upperHemisphereOnly && isSideFace
            ? (fullRangeV + 1) * 0.5
            : fullRangeV;
          const direction = face.normal.add(face.right.scale(u)).add(face.up.scale(v)).normalize();
          camera.position.copyFrom(direction.scale(captureDiameter));
          camera.upVector.copyFrom(face.up);
          camera.setTarget(Vector3.Zero());
          // The readback conversion flips the atlas vertically, so grid row 0
          // renders at the top of the bottom-up GL target to end up on top.
          camera.viewport = new Viewport(
            x / gridWidth,
            (gridHeight - 1 - y) / gridHeight,
            1 / gridWidth,
            1 / gridHeight,
          );
          meshes.forEach((mesh) => { mesh.isVisible = true; });
          try {
            target.render(true);
          } finally {
            meshes.forEach((mesh) => { mesh.isVisible = false; });
          }
          completed++;
          viewsThisFrame++;
          onProgress?.(completed, total, faceIndex, x, y);
          if (!cooperative && performance.now() - sliceStart > frameBudget) {
            await nextFrame();
            sliceStart = performance.now();
            viewsThisFrame = 0;
          }
        }
      }
      if (cooperative) await nextFrame();
      const pixels = await target.readPixels();
      if (!pixels) throw new Error(`${name} GPU readback failed.`);
      if (cooperative) await nextFrame();
      context.putImageData(
        await binaryImage(pixels, atlasWidth, atlasHeight, context, cooperative),
        0,
        0,
      );
      await nextFrame();
      sliceStart = performance.now();
      viewsThisFrame = 0;
    }
  } finally {
    meshes.forEach((mesh, index) => { mesh.isVisible = sourceVisibility[index]; });
    target.dispose();
    camera.dispose();
  }

  return createImpostorTextures(scene, name, canvases, {
    rotationallySymmetric,
    rotationalSymmetryOrder,
    upperHemisphereOnly,
    gridWidth,
    gridHeight,
    resolution: resolutionHeight,
    resolutionWidth,
    resolutionHeight,
    lowResolutionWidth: Math.max(
      1,
      Math.round(LOW_RESOLUTION_FRAME_SIZE * resolutionWidth / resolutionHeight),
    ),
    lowResolutionHeight: LOW_RESOLUTION_FRAME_SIZE,
    sourceHeight,
    captureDiameter,
    captureWidth,
    captureHeight,
  }, cooperative);
}

async function createImpostorTextures(
  scene: Scene,
  name: string,
  canvases: HTMLCanvasElement[],
  metadata: Omit<
    ImpostorAssets,
    "textures" | "atlasCanvases" | "lowResolutionTextures" | "gridSize"
  >,
  cooperative: boolean,
): Promise<ImpostorAssets> {
  const atlasWidth = metadata.gridWidth * metadata.resolutionWidth;
  const atlasHeight = metadata.gridHeight * metadata.resolutionHeight;
  const textures: Texture[] = [];
  for (let index = 0; index < canvases.length; index++) {
    if (cooperative) await nextFrame();
    const canvas = canvases[index];
    const image = canvas.getContext("2d", { alpha: true })!.getImageData(
      0,
      0,
      atlasWidth,
      atlasHeight,
    );
    // A canvas texture is uploaded through a premultiplied backing store, which
    // commonly turns RGB under zero alpha black. Thin grass silhouettes then
    // acquire a dark line when bilinear filtering reaches across their edge.
    // RawTexture keeps this two-pixel, per-frame color gutter intact.
    await dilateTransparentTileEdgeColors(
      image,
      metadata.gridWidth,
      metadata.gridHeight,
      metadata.resolutionWidth,
      metadata.resolutionHeight,
      2,
      cooperative,
    );
    if (cooperative) await nextFrame();
    const texture = new RawTexture(
      image.data,
      atlasWidth,
      atlasHeight,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    texture.name = `${name}Atlas${index}`;
    texture.gammaSpace = false;
    texture.hasAlpha = true;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    textures.push(texture);
  }
  const lowResolutionTextures: Texture[] = [];
  for (let index = 0; index < canvases.length; index++) {
    if (cooperative) await nextFrame();
    const lowImage = await downsampleAtlasTiles(
      canvases[index],
      metadata.gridWidth,
      metadata.gridHeight,
      metadata.resolutionWidth,
      metadata.resolutionHeight,
      metadata.lowResolutionWidth,
      metadata.lowResolutionHeight,
      cooperative,
    );
    if (cooperative) await nextFrame();
    const texture = new RawTexture(
      lowImage.data,
      lowImage.width,
      lowImage.height,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    texture.name = `${name}LowResolutionAtlas${index}`;
    texture.gammaSpace = false;
    texture.hasAlpha = true;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    lowResolutionTextures.push(texture);
  }
  return {
    textures,
    atlasCanvases: canvases,
    lowResolutionTextures,
    ...metadata,
    gridSize: metadata.gridWidth,
  };
}

/** Extends opaque RGB just far enough to cover the bilinear footprint. */
async function dilateTransparentTileEdgeColors(
  image: ImageData,
  gridWidth: number,
  gridHeight: number,
  tileWidth: number,
  tileHeight: number,
  radius: number,
  cooperative: boolean,
): Promise<void> {
  const source = new Uint8ClampedArray(image.data);
  const slice = captureWorkSlice();
  for (let tileY = 0; tileY < gridHeight; tileY++) {
    for (let tileX = 0; tileX < gridWidth; tileX++) {
      const startX = tileX * tileWidth;
      const startY = tileY * tileHeight;
      for (let localY = 0; localY < tileHeight; localY++) {
        for (let localX = 0; localX < tileWidth; localX++) {
          const x = startX + localX;
          const y = startY + localY;
          const destination = (y * image.width + x) * 4;
          if (source[destination + 3] !== 0) continue;

          let nearest = -1;
          let nearestDistanceSquared = Number.POSITIVE_INFINITY;
          for (let offsetY = -radius; offsetY <= radius; offsetY++) {
            const sampleY = localY + offsetY;
            if (sampleY < 0 || sampleY >= tileHeight) continue;
            for (let offsetX = -radius; offsetX <= radius; offsetX++) {
              const sampleX = localX + offsetX;
              if (sampleX < 0 || sampleX >= tileWidth) continue;
              const distanceSquared = offsetX * offsetX + offsetY * offsetY;
              if (distanceSquared > radius * radius || distanceSquared >= nearestDistanceSquared) {
                continue;
              }
              const sample = (
                (startY + sampleY) * image.width + startX + sampleX
              ) * 4;
              if (source[sample + 3] === 0) continue;
              nearest = sample;
              nearestDistanceSquared = distanceSquared;
            }
          }
          if (nearest >= 0) {
            image.data[destination] = source[nearest];
            image.data[destination + 1] = source[nearest + 1];
            image.data[destination + 2] = source[nearest + 2];
          }
        }
        await yieldCaptureWorkIfNeeded(cooperative, slice);
      }
    }
  }
}

/** Downsamples frames independently so neighboring atlas tiles cannot bleed together. */
async function downsampleAtlasTiles(
  source: HTMLCanvasElement,
  gridWidth: number,
  gridHeight: number,
  sourceTileWidth: number,
  sourceTileHeight: number,
  targetTileWidth: number,
  targetTileHeight: number,
  cooperative: boolean,
): Promise<ImageData> {
  const target = document.createElement("canvas");
  target.width = gridWidth * targetTileWidth;
  target.height = gridHeight * targetTileHeight;
  const context = target.getContext("2d", { alpha: true })!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      context.drawImage(
        source,
        x * sourceTileWidth,
        y * sourceTileHeight,
        sourceTileWidth,
        sourceTileHeight,
        x * targetTileWidth,
        y * targetTileHeight,
        targetTileWidth,
        targetTileHeight,
      );
    }
  }
  const pixels = context.getImageData(0, 0, target.width, target.height);
  // The regular impostor shader uses alpha testing, not alpha blending. At
  // At low resolution, retaining averaged fractional coverage produces a conspicuous Bayer
  // pattern of holes. Preserve the filtered color but make meaningful distant
  // coverage solid so sub-pixel leaves merge into a stable canopy.
  const slice = captureWorkSlice();
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const alpha = (y * pixels.width + x) * 4 + 3;
      pixels.data[alpha] = pixels.data[alpha] >= LOW_RESOLUTION_ALPHA_THRESHOLD ? 255 : 0;
    }
    await yieldCaptureWorkIfNeeded(cooperative, slice);
  }
  await dilateTransparentTileColors(
    pixels,
    gridWidth,
    gridHeight,
    targetTileWidth,
    targetTileHeight,
    cooperative,
  );
  await fillDistantSilhouetteRows(
    pixels,
    gridWidth,
    gridHeight,
    targetTileWidth,
    targetTileHeight,
    cooperative,
  );
  return pixels;
}

/** Removes distracting foliage holes while retaining each row's outer silhouette. */
async function fillDistantSilhouetteRows(
  image: ImageData,
  gridWidth: number,
  gridHeight: number,
  tileWidth: number,
  tileHeight: number,
  cooperative: boolean,
): Promise<void> {
  const slice = captureWorkSlice();
  for (let tileY = 0; tileY < gridHeight; tileY++) {
    for (let tileX = 0; tileX < gridWidth; tileX++) {
      const startX = tileX * tileWidth;
      const startY = tileY * tileHeight;
      for (let localY = 0; localY < tileHeight; localY++) {
        const y = startY + localY;
        let firstCovered = tileWidth;
        let lastCovered = -1;
        for (let localX = 0; localX < tileWidth; localX++) {
          const alpha = image.data[(y * image.width + startX + localX) * 4 + 3];
          if (alpha === 0) continue;
          firstCovered = Math.min(firstCovered, localX);
          lastCovered = localX;
        }
        for (let localX = firstCovered; localX <= lastCovered; localX++) {
          image.data[(y * image.width + startX + localX) * 4 + 3] = 255;
        }
        await yieldCaptureWorkIfNeeded(cooperative, slice);
      }
    }
  }
}

/**
 * Supplies hidden edge colors for straight-alpha bilinear sampling. RawTexture
 * preserves RGB under zero alpha; Canvas textures do not, which causes either
 * bright fringes or dark quantization spots at this very small resolution.
 */
async function dilateTransparentTileColors(
  image: ImageData,
  gridWidth: number,
  gridHeight: number,
  tileWidth: number,
  tileHeight: number,
  cooperative: boolean,
): Promise<void> {
  const source = new Uint8ClampedArray(image.data);
  const slice = captureWorkSlice();
  for (let tileY = 0; tileY < gridHeight; tileY++) {
    for (let tileX = 0; tileX < gridWidth; tileX++) {
      const startX = tileX * tileWidth;
      const startY = tileY * tileHeight;
      for (let localY = 0; localY < tileHeight; localY++) {
        for (let localX = 0; localX < tileWidth; localX++) {
          const x = startX + localX;
          const y = startY + localY;
          const destination = (y * image.width + x) * 4;
          if (source[destination + 3] !== 0) continue;

          let nearest = -1;
          let nearestDistanceSquared = Number.POSITIVE_INFINITY;
          for (let sampleY = 0; sampleY < tileHeight; sampleY++) {
            for (let sampleX = 0; sampleX < tileWidth; sampleX++) {
              const sample = ((startY + sampleY) * image.width + startX + sampleX) * 4;
              if (source[sample + 3] === 0) continue;
              const dx = sampleX - localX;
              const dy = sampleY - localY;
              const distanceSquared = dx * dx + dy * dy;
              if (distanceSquared < nearestDistanceSquared) {
                nearest = sample;
                nearestDistanceSquared = distanceSquared;
              }
            }
          }
          if (nearest >= 0) {
            image.data[destination] = source[nearest];
            image.data[destination + 1] = source[nearest + 1];
            image.data[destination + 2] = source[nearest + 2];
          }
        }
        await yieldCaptureWorkIfNeeded(cooperative, slice);
      }
    }
  }
}

async function binaryImage(
  pixels: ArrayBufferView,
  width: number,
  height: number,
  context: CanvasRenderingContext2D,
  cooperative: boolean,
): Promise<ImageData> {
  const input = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const output = context.createImageData(width, height);
  const slice = captureWorkSlice();
  for (let y = 0; y < height; y++) {
    const sourceY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const source = (sourceY * width + x) * 4;
      const destination = (y * width + x) * 4;
      const alpha = input[source + 3] >= 128 ? 255 : 0;
      output.data[destination] = alpha ? input[source] : 0;
      output.data[destination + 1] = alpha ? input[source + 1] : 0;
      output.data[destination + 2] = alpha ? input[source + 2] : 0;
      output.data[destination + 3] = alpha;
    }
    await yieldCaptureWorkIfNeeded(cooperative, slice);
  }
  return output;
}

interface CaptureWorkSlice {
  startedAt: number;
}

function captureWorkSlice(): CaptureWorkSlice {
  return { startedAt: performance.now() };
}

async function yieldCaptureWorkIfNeeded(
  cooperative: boolean,
  slice: CaptureWorkSlice,
): Promise<void> {
  if (!cooperative || performance.now() - slice.startedAt < RUNTIME_CAPTURE_FRAME_BUDGET_MS) return;
  await nextFrame();
  slice.startedAt = performance.now();
}
