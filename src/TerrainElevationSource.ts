import type { TerrainData } from "./TerrainData";
import type { TileBounds, WorldTileArea } from "./WorldGrid";

const TERRAIN_TILE_LOAD_TIMEOUT_MS = 15_000;

/**
 * Utility class for fetching and processing AWS Terrain Tiles.
 * https://registry.opendata.aws/terrain-tiles/
 */
export class TerrainElevationSource {
  private static readonly BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
  private static readonly elevationCache = new Map<string, Promise<{
    elevations: Float32Array;
    width: number;
    height: number;
  }>>();

  /**
   * Loads a single Terrarium tile and decodes RGB to raw elevation values.
   * @param z - Zoom level
   * @param x - Tile X coordinate
   * @param y - Tile Y coordinate
   * @returns Raw elevation data and image dimensions
   */
  private static async loadTileElevations(z: number, x: number, y: number): Promise<{
    elevations: Float32Array;
    width: number;
    height: number;
  }> {
    const key = `${z}/${x}/${y}`;
    const cached = this.elevationCache.get(key);
    if (cached) return cached;

    const request = this.fetchTileElevations(z, x, y).catch((error: unknown) => {
      this.elevationCache.delete(key);
      throw error;
    });
    this.elevationCache.set(key, request);
    return request;
  }

  private static async fetchTileElevations(z: number, x: number, y: number): Promise<{
    elevations: Float32Array;
    width: number;
    height: number;
  }> {
    const url = `${this.BASE_URL}/${z}/${x}/${y}.png`;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        img.onload = null;
        img.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        finish(new Error(`Terrain tile request timed out: ${url}`));
        img.src = "";
      }, TERRAIN_TILE_LOAD_TIMEOUT_MS);
      img.onload = () => finish();
      img.onerror = () => finish(new Error(`Failed to load terrain tile: ${url}`));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    const elevations = new Float32Array(canvas.width * canvas.height);
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // Terrarium formula: height = (R × 256 + G + B/256) - 32768
      elevations[i / 4] = (r * 256 + g + b / 256) - 32768;
    }

    return { elevations, width: canvas.width, height: canvas.height };
  }

  /** Samples one raw provider elevation without building an application tile. */
  static async fetchElevationAtLocation(
    latitude: number,
    longitude: number,
    level = 10,
  ): Promise<number> {
    const sourceLevel = Math.max(0, Math.min(15, Math.round(level)));
    const scale = 2 ** sourceLevel;
    const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const latitudeRadians = clampedLatitude * Math.PI / 180;
    const projectedX = (longitude + 180) / 360 * scale;
    const projectedY = (
      1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI
    ) / 2 * scale;
    const tileX = Math.max(0, Math.min(scale - 1, Math.floor(projectedX)));
    const tileY = Math.max(0, Math.min(scale - 1, Math.floor(projectedY)));
    const tile = await this.loadTileElevations(sourceLevel, tileX, tileY);
    const pixelX = Math.max(0, Math.min(
      tile.width - 1,
      Math.floor((projectedX - tileX) * tile.width),
    ));
    const pixelY = Math.max(0, Math.min(
      tile.height - 1,
      Math.floor((projectedY - tileY) * tile.height),
    ));
    return tile.elevations[pixelY * tile.width + pixelX];
  }

  /**
   * Computes the raw elevation range and retains full precision for direct vertex use.
   */
  private static async processElevations(
    elevations: Float32Array,
    width: number,
    height: number,
    description: string,
    yieldControl?: () => Promise<void>,
  ): Promise<Pick<TerrainData, "elevations" | "minElevation" | "maxElevation" | "width" | "height">> {
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    for (let i = 0; i < elevations.length; i++) {
      if (elevations[i] < minElevation) minElevation = elevations[i];
      if (elevations[i] > maxElevation) maxElevation = elevations[i];
      if ((i & 4095) === 4095) await yieldControl?.();
    }

    console.log(`${description}: elevation range ${minElevation.toFixed(1)}m to ${maxElevation.toFixed(1)}m`);

    return { elevations, minElevation, maxElevation, width, height };
  }

  /**
   * Returns the approximate ground size of a tile in meters.
   * @param bounds - Geographic bounds to measure
   * @returns Width and height in meters
   */
  private static tileSizeMeters(bounds: TileBounds): { widthMeters: number; heightMeters: number } {
    const lonSpanDeg = bounds.lonEast - bounds.lonWest;
    const latSpanDeg = bounds.latNorth - bounds.latSouth;
    const midLat = (bounds.latNorth + bounds.latSouth) / 2;
    const metersPerDegLat = 111_320;
    const metersPerDegLon = 111_320 * Math.cos(midLat * Math.PI / 180);
    return {
      widthMeters: lonSpanDeg * metersPerDegLon,
      heightMeters: latSpanDeg * metersPerDegLat,
    };
  }

  /** Populates an application-owned tile area from the elevation provider. */
  static async fetchWorldArea(
    area: WorldTileArea,
    yieldControl?: () => Promise<void>,
  ): Promise<TerrainData> {
    // The source adapter chooses its own level and determines which provider
    // tiles overlap our requested bounds. The equality with our current grid
    // level is a quality setting, not an identity relationship.
    const sourceLevel = Math.min(15, area.center.level);
    const { northWest: sourceNorthWest, southEast: sourceSouthEast } =
      providerElevationTileRange(area.bounds, sourceLevel);
    const sourceColumns = sourceSouthEast.x - sourceNorthWest.x + 1;
    const sourceRows = sourceSouthEast.y - sourceNorthWest.y + 1;
    const startX = sourceNorthWest.x;
    const startY = sourceNorthWest.y;
    const requests = [] as Array<Promise<{ elevations: Float32Array; width: number; height: number }>>;
    for (let row = 0; row < sourceRows; row++) {
      for (let column = 0; column < sourceColumns; column++) {
        requests.push(this.loadTileElevations(sourceLevel, startX + column, startY + row));
      }
    }
    const rawTiles = await Promise.all(requests);
    const tileSize = rawTiles[0].width; // typically 256
    const stitchedWidth = tileSize * sourceColumns;
    const stitchedHeight = tileSize * sourceRows;

    // Stitch the tile grid into a single elevation grid.
    const stitched = new Float32Array(stitchedWidth * stitchedHeight);
    for (let i = 0; i < rawTiles.length; i++) {
      const ox = (i % sourceColumns) * tileSize;
      const oy = Math.floor(i / sourceColumns) * tileSize;
      for (let row = 0; row < tileSize; row++) {
        for (let col = 0; col < tileSize; col++) {
          stitched[(oy + row) * stitchedWidth + (ox + col)] =
            rawTiles[i].elevations[row * tileSize + col];
        }
        await yieldControl?.();
      }
    }

    // Provider tiles rarely align with our grid when its level is finer than
    // the source level, so cut the stitched grid down to the requested bounds.
    // The crop includes both boundary samples. Adjacent application tiles
    // therefore share one complete row or column instead of terminating on
    // opposite sides of a provider pixel interval.
    const crop = providerPixelCrop(
      area.bounds,
      sourceLevel,
      sourceNorthWest,
      tileSize,
      stitchedWidth,
      stitchedHeight,
    );
    const cropped = new Float32Array(crop.width * crop.height);
    for (let row = 0; row < crop.height; row++) {
      cropped.set(
        stitched.subarray(
          (crop.top + row) * stitchedWidth + crop.left,
          (crop.top + row) * stitchedWidth + crop.left + crop.width,
        ),
        row * crop.width,
      );
      await yieldControl?.();
    }

    // Compute the real-world ground extent of the requested area.
    const stitchedBounds = area.bounds;
    const { widthMeters, heightMeters } = this.tileSizeMeters(stitchedBounds);

    const result = await this.processElevations(
      cropped,
      crop.width,
      crop.height,
      `World tile ${area.center.level}/${area.center.x}/${area.center.y}`,
      yieldControl,
    );
    return {
      ...result,
      groundWidthMeters: widthMeters,
      groundHeightMeters: heightMeters,
      worldTile: area.center,
      generationSeed: area.seed,
      bounds: stitchedBounds,
    };
  }

}

/**
 * Provider tiles needed for a boundary-inclusive elevation crop.
 * Unlike image crops, terrain needs the tile containing the south/east
 * endpoint so neighboring meshes can reuse the exact same height samples.
 */
export function providerElevationTileRange(
  bounds: TileBounds,
  level: number,
): { northWest: { x: number; y: number }; southEast: { x: number; y: number } } {
  return {
    northWest: providerTileForSample(bounds.latNorth, bounds.lonWest, level),
    southEast: providerTileForSample(bounds.latSouth, bounds.lonEast, level),
  };
}

function providerTileForSample(
  latitude: number,
  longitude: number,
  level: number,
): { x: number; y: number } {
  const scale = 2 ** level;
  const latitudeRadians = latitude * Math.PI / 180;
  const projectedX = snapProjectedBoundary((longitude + 180) / 360 * scale);
  const projectedY = snapProjectedBoundary(
    (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale,
  );
  return {
    x: Math.max(0, Math.min(scale - 1, Math.floor(projectedX))),
    y: Math.max(0, Math.min(scale - 1, Math.floor(projectedY))),
  };
}

function snapProjectedBoundary(value: number): number {
  const integer = Math.round(value);
  return Math.abs(value - integer) < 1e-9 ? integer : value;
}

/**
 * Pixel window of a geographic bounds inside a stitched provider-tile grid.
 * Width and height are vertex-sample counts, including both boundary samples.
 */
export function providerPixelCrop(
  bounds: TileBounds,
  level: number,
  northWestTile: { x: number; y: number },
  tileSize: number,
  stitchedWidth: number,
  stitchedHeight: number,
): { left: number; top: number; width: number; height: number } {
  const scale = 2 ** level;
  const column = (longitude: number): number => (longitude + 180) / 360 * scale;
  const row = (latitude: number): number => {
    const latitudeRadians = latitude * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale;
  };
  const left = Math.max(
    0,
    Math.round((column(bounds.lonWest) - northWestTile.x) * tileSize),
  );
  const top = Math.max(
    0,
    Math.round((row(bounds.latNorth) - northWestTile.y) * tileSize),
  );
  const right = Math.min(
    stitchedWidth - 1,
    Math.round((column(bounds.lonEast) - northWestTile.x) * tileSize),
  );
  const bottom = Math.min(
    stitchedHeight - 1,
    Math.round((row(bounds.latSouth) - northWestTile.y) * tileSize),
  );
  if (right - left < 1 || bottom - top < 1) {
    throw new Error("Requested area maps to an unusably small elevation window.");
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
