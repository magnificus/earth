/**
 * Utility class for fetching and processing AWS Terrain Tiles.
 * https://registry.opendata.aws/terrain-tiles/
 */
export class TerrainTiles {
  private static readonly BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

  /**
   * Converts latitude/longitude to tile coordinates at a given zoom level.
   * @param lat - Latitude in degrees
   * @param lon - Longitude in degrees
   * @param zoom - Zoom level
   * @returns Object with x and y tile coordinates
   */
  static latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
    return { x, y };
  }

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
    const url = `${this.BASE_URL}/${z}/${x}/${y}.png`;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load terrain tile: ${url}`));
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

  /**
   * Converts raw elevation data into a normalized grayscale heightmap.
   * @param elevations - Raw elevation values
   * @param width - Image width in pixels
   * @param height - Image height in pixels
   * @param tile - Tile coordinates for metadata
   * @returns HeightmapResult with data URL and elevation info
   */
  private static elevationsToHeightmap(
    elevations: Float32Array,
    width: number,
    height: number,
    tile: { z: number; x: number; y: number }
  ): HeightmapResult {
    // Push sea-level (0m) elevations down to create a visible coastline drop
    for (let i = 0; i < elevations.length; i++) {
      if (elevations[i] <= 0.5) {
        elevations[i] = -100;
      }
    }

    let minElevation = Infinity;
    let maxElevation = -Infinity;
    for (let i = 0; i < elevations.length; i++) {
      if (elevations[i] < minElevation) minElevation = elevations[i];
      if (elevations[i] > maxElevation) maxElevation = elevations[i];
    }

    const range = maxElevation - minElevation || 1;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const outputData = ctx.createImageData(width, height);

    for (let i = 0; i < elevations.length; i++) {
      const normalized = Math.floor(((elevations[i] - minElevation) / range) * 255);
      const pi = i * 4;
      outputData.data[pi] = normalized;       // R
      outputData.data[pi + 1] = normalized;   // G
      outputData.data[pi + 2] = normalized;   // B
      outputData.data[pi + 3] = 255;          // A
    }

    ctx.putImageData(outputData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');

    console.log(`Terrain tile ${tile.z}/${tile.x}/${tile.y}: elevation range ${minElevation.toFixed(1)}m to ${maxElevation.toFixed(1)}m`);

    return { dataUrl, minElevation, maxElevation, width, height, tile };
  }

  /**
   * Fetches a Terrarium elevation tile from AWS and converts it to a grayscale heightmap.
   * Terrarium format encodes elevation as: height = (R × 256 + G + B/256) - 32768
   * @param z - Zoom level (0-15)
   * @param x - Tile X coordinate
   * @param y - Tile Y coordinate
   * @returns Promise that resolves to heightmap result with data URL and elevation info
   */
  static async fetchTile(z: number, x: number, y: number): Promise<HeightmapResult> {
    const raw = await this.loadTileElevations(z, x, y);
    return this.elevationsToHeightmap(raw.elevations, raw.width, raw.height, { z, x, y });
  }

  /**
   * Returns the lon/lat bounding box of a tile.
   * @param x - Tile X coordinate
   * @param y - Tile Y coordinate
   * @param zoom - Zoom level
   * @returns Bounding box with west/east longitude and north/south latitude
   */
  static tileBounds(x: number, y: number, zoom: number): TileBounds {
    const n = Math.pow(2, zoom);
    const lonWest = (x / n) * 360 - 180;
    const lonEast = ((x + 1) / n) * 360 - 180;
    const latNorth = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
    const latSouth = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
    return { lonWest, lonEast, latNorth, latSouth };
  }

  /**
   * Returns the approximate ground size of a tile in meters.
   * @param bounds - The tile bounding box from tileBounds()
   * @returns Width and height in meters
   */
  static tileSizeMeters(bounds: TileBounds): { widthMeters: number; heightMeters: number } {
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

  /**
   * Fetches terrain centered on a given latitude/longitude.
   * Loads a 2x2 grid of tiles so the given coordinate ends up
   * near the center of the stitched output (512×512).
   * @param lat - Latitude in degrees
   * @param lon - Longitude in degrees
   * @param zoom - Zoom level (0-15, higher = more detail, smaller area)
   * @returns Promise that resolves to heightmap result centered on the coordinate
   */
  static async fetchTileAtLocation(lat: number, lon: number, zoom: number): Promise<HeightmapResult> {
    const n = Math.pow(2, zoom);

    // Compute fractional tile coordinates
    const fracX = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const fracY = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n;

    const tileX = Math.floor(fracX);
    const tileY = Math.floor(fracY);
    const fx = fracX - tileX; // position within tile [0, 1)
    const fy = fracY - tileY;

    // Pick which 2x2 grid of tiles to fetch so the coordinate
    // falls near the center of the stitched area
    const startX = fx >= 0.5 ? tileX : tileX - 1;
    const startY = fy >= 0.5 ? tileY : tileY - 1;

    // Fetch 4 tiles in parallel
    const [tl, tr, bl, br] = await Promise.all([
      this.loadTileElevations(zoom, startX, startY),
      this.loadTileElevations(zoom, startX + 1, startY),
      this.loadTileElevations(zoom, startX, startY + 1),
      this.loadTileElevations(zoom, startX + 1, startY + 1),
    ]);

    const tileSize = tl.width; // typically 256
    const stitchedSize = tileSize * 2;

    // Stitch the 4 tiles into a single elevation grid
    const stitched = new Float32Array(stitchedSize * stitchedSize);
    const rawTiles = [tl, tr, bl, br];
    for (let i = 0; i < 4; i++) {
      const ox = (i % 2) * tileSize;
      const oy = Math.floor(i / 2) * tileSize;
      for (let row = 0; row < tileSize; row++) {
        for (let col = 0; col < tileSize; col++) {
          stitched[(oy + row) * stitchedSize + (ox + col)] =
            rawTiles[i].elevations[row * tileSize + col];
        }
      }
    }

    return this.elevationsToHeightmap(stitched, stitchedSize, stitchedSize, { z: zoom, x: tileX, y: tileY });
  }

  /**
   * Downloads the heightmap as a PNG file.
   * @param result - The heightmap result from fetchTile
   * @param filename - Optional filename (defaults to tile coordinates)
   */
  static downloadHeightmap(result: HeightmapResult, filename?: string): void {
    const name = filename || `heightmap_${result.tile.z}_${result.tile.x}_${result.tile.y}.png`;
    
    const link = document.createElement('a');
    link.download = name;
    link.href = result.dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log(`Downloaded heightmap: ${name}`);
  }

  /**
   * Fetches a tile and automatically saves it to disk.
   * @param lat - Latitude in degrees
   * @param lon - Longitude in degrees
   * @param zoom - Zoom level
   * @param filename - Optional filename
   * @returns Promise that resolves to heightmap result
   */
  static async fetchAndDownload(
    lat: number,
    lon: number,
    zoom: number,
    filename?: string
  ): Promise<HeightmapResult> {
    const result = await this.fetchTileAtLocation(lat, lon, zoom);
    this.downloadHeightmap(result, filename);
    return result;
  }
}

/**
 * Bounding box of a tile in longitude/latitude.
 */
export interface TileBounds {
  /** Western edge longitude in degrees */
  lonWest: number;
  /** Eastern edge longitude in degrees */
  lonEast: number;
  /** Northern edge latitude in degrees */
  latNorth: number;
  /** Southern edge latitude in degrees */
  latSouth: number;
}

/**
 * Result from fetching and processing a terrain tile.
 */
export interface HeightmapResult {
  /** Base64 data URL of the grayscale heightmap PNG */
  dataUrl: string;
  /** Minimum elevation in meters */
  minElevation: number;
  /** Maximum elevation in meters */
  maxElevation: number;
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** Tile coordinates */
  tile: { z: number; x: number; y: number };
}
