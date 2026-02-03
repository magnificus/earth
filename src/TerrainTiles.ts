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
   * Fetches a Terrarium elevation tile from AWS and converts it to a grayscale heightmap.
   * Terrarium format encodes elevation as: height = (R × 256 + G + B/256) - 32768
   * @param z - Zoom level (0-15)
   * @param x - Tile X coordinate
   * @param y - Tile Y coordinate
   * @returns Promise that resolves to heightmap result with data URL and elevation info
   */
  static async fetchTile(z: number, x: number, y: number): Promise<HeightmapResult> {
    const url = `${this.BASE_URL}/${z}/${x}/${y}.png`;
    
    // Load image
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load terrain tile: ${url}`));
      img.src = url;
    });

    // Create canvas to read pixel data
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    // Decode Terrarium RGB to elevation and track min/max
    const elevations: number[] = [];
    let minElevation = Infinity;
    let maxElevation = -Infinity;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      
      // Terrarium formula: height = (R × 256 + G + B/256) - 32768
      const elevation = (r * 256 + g + b / 256) - 32768;
      elevations.push(elevation);
      
      if (elevation < minElevation) minElevation = elevation;
      if (elevation > maxElevation) maxElevation = elevation;
    }

    // Normalize elevations to 0-255 grayscale
    const range = maxElevation - minElevation || 1;
    const outputData = ctx.createImageData(canvas.width, canvas.height);
    
    for (let i = 0; i < elevations.length; i++) {
      const normalized = Math.floor(((elevations[i] - minElevation) / range) * 255);
      const pixelIndex = i * 4;
      outputData.data[pixelIndex] = normalized;     // R
      outputData.data[pixelIndex + 1] = normalized; // G
      outputData.data[pixelIndex + 2] = normalized; // B
      outputData.data[pixelIndex + 3] = 255;        // A
    }

    ctx.putImageData(outputData, 0, 0);
    
    const dataUrl = canvas.toDataURL('image/png');
    
    console.log(`Terrain tile ${z}/${x}/${y}: elevation range ${minElevation.toFixed(1)}m to ${maxElevation.toFixed(1)}m`);
    
    return {
      dataUrl,
      minElevation,
      maxElevation,
      width: canvas.width,
      height: canvas.height,
      tile: { z, x, y },
    };
  }

  /**
   * Fetches a terrain tile for a given latitude/longitude.
   * @param lat - Latitude in degrees
   * @param lon - Longitude in degrees
   * @param zoom - Zoom level (0-15, higher = more detail, smaller area)
   * @returns Promise that resolves to heightmap result
   */
  static async fetchTileAtLocation(lat: number, lon: number, zoom: number): Promise<HeightmapResult> {
    const tile = this.latLonToTile(lat, lon, zoom);
    return this.fetchTile(zoom, tile.x, tile.y);
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
