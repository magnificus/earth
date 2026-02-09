import {
  Engine,
  Scene,
  UniversalCamera,
  Vector3,
  HemisphericLight,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  Mesh,
  KeyboardEventTypes,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import { TerrainTiles, TerrainResult } from './TerrainTiles';
import { createWaterPlane } from './Water';

export class Game {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true,
    });
    this.scene = new Scene(this.engine);
  }

  async initialize(): Promise<void> {
    // Set scene background
    this.scene.clearColor = new Color4(0.02, 0.02, 0.05, 1);

    // Create fly camera with WASD controls
    const camera = new UniversalCamera(
      'camera',
      new Vector3(0, 5, -15),
      this.scene
    );
    camera.setTarget(Vector3.Zero());
    camera.attachControl(this.canvas, true);

    // WASD keys for movement (W=87, A=65, S=83, D=68)
    camera.keysUp = [87];    // W
    camera.keysDown = [83];  // S
    camera.keysLeft = [65];  // A
    camera.keysRight = [68]; // D

    // Movement speed
    camera.speed = 0.5;
    camera.angularSensibility = 1000;

    // Add Q/E for vertical movement
    const verticalSpeed = 0.2;
    this.scene.onKeyboardObservable.add((kbInfo) => {
      if (kbInfo.type === KeyboardEventTypes.KEYDOWN) {
        if (kbInfo.event.key === 'q' || kbInfo.event.key === 'Q') {
          camera.position.y -= verticalSpeed;
        }
        if (kbInfo.event.key === 'e' || kbInfo.event.key === 'E') {
          camera.position.y += verticalSpeed;
        }
      }
    });

    // Create lights
    const hemisphericLight = new HemisphericLight(
      'hemisphericLight',
      new Vector3(1, 1, 0),
      this.scene
    );
    hemisphericLight.intensity = 1.0;
    hemisphericLight.groundColor = new Color3(0.1, 0.1, 0.2);

    // Oslo coordinates: 59.91°N, 10.75°E
    const storyodden = { lat: 59.8888085995981, lon: 10.593090176648504 };
    const casa = { lat: 59.904706664625266, lon: 10.61104958556299 };
    const terrainData = await TerrainTiles.fetchTileAtLocation(storyodden.lat, storyodden.lon, 15);
    
    // Download the heightmap to disk
    //TerrainTiles.downloadHeightmap(terrainData, 'oslo_heightmap.png');
    
    // Derive meters-per-unit from the real ground extent so
    // horizontal and vertical scales match 1:1 (absolute height).
    const meshWidth = 100;   // scene units for the ground plane
    const groundWidth = terrainData.groundWidthMeters ?? 1000;
    const groundHeight = terrainData.groundHeightMeters ?? 1000;
    const metersPerUnit = groundWidth / meshWidth;
    const meshDepth = groundHeight / metersPerUnit; // may differ slightly from meshWidth due to latitude

    console.log(`Ground extent: ${groundWidth.toFixed(0)}m × ${groundHeight.toFixed(0)}m → ${meshWidth} × ${meshDepth.toFixed(2)} units (1 unit = ${metersPerUnit.toFixed(1)}m)`);
    console.log(`Elevation: ${terrainData.minElevation.toFixed(0)}m – ${terrainData.maxElevation.toFixed(0)}m`);

    // Multiplier for mesh subdivisions relative to source image pixels.
    // 1 = one vertex per pixel, 0.5 = half resolution, 2 = double, etc.
    const subdivisionMultiplier = 1;
    const subdivisions = Math.max(1, Math.round(terrainData.width * subdivisionMultiplier));

    console.log(`Terrain: ${terrainData.width}×${terrainData.height}px → ${subdivisions} subdivisions (×${subdivisionMultiplier})`);

    const terrain = this.createTerrainMesh('terrain', terrainData, {
      meshWidth,
      meshDepth,
      subdivisions,
      metersPerUnit,
    });

    // Create water plane at 0 meters elevation
    createWaterPlane(this.scene, [terrain]);
  }

  run(): void {
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });
  }

  resize(): void {
    this.engine.resize();
  }

  dispose(): void {
    this.scene.dispose();
    this.engine.dispose();
  }

  /**
   * Creates a terrain mesh by setting vertex heights directly from
   * full-precision Float32 elevation data (no lossy image round-trip).
   * @param name - The name of the mesh
   * @param terrain - Processed terrain result with raw elevation data
   * @param options - Mesh dimensions and scale
   * @returns The created ground mesh
   */
  createTerrainMesh(
    name: string,
    terrain: TerrainResult,
    options: {
      meshWidth: number;
      meshDepth: number;
      subdivisions: number;
      metersPerUnit: number;
    }
  ): Mesh {
    const { meshWidth, meshDepth, subdivisions, metersPerUnit } = options;

    const ground = MeshBuilder.CreateGround(
      name,
      { width: meshWidth, height: meshDepth, subdivisions, updatable: true },
      this.scene
    );

    const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
    const indices = ground.getIndices()!;
    const { elevations, width: elevW, height: elevH } = terrain;
    const vPerRow = subdivisions + 1;

    for (let row = 0; row < vPerRow; row++) {
      for (let col = 0; col < vPerRow; col++) {
        // Map vertex grid position to elevation data coordinates
        const u = col / subdivisions;
        const v = row / subdivisions;
        const px = u * (elevW - 1);
        const py = v * (elevH - 1);

        // Bilinear interpolation
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, elevW - 1);
        const y1 = Math.min(y0 + 1, elevH - 1);
        const fx = px - x0;
        const fy = py - y0;

        const e00 = elevations[y0 * elevW + x0];
        const e10 = elevations[y0 * elevW + x1];
        const e01 = elevations[y1 * elevW + x0];
        const e11 = elevations[y1 * elevW + x1];

        const elevation =
          e00 * (1 - fx) * (1 - fy) +
          e10 * fx * (1 - fy) +
          e01 * (1 - fx) * fy +
          e11 * fx * fy;

        const vertexIndex = row * vPerRow + col;
        positions[vertexIndex * 3 + 1] = elevation / metersPerUnit;
      }
    }

    // Recompute normals for correct lighting after modifying heights
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    ground.updateVerticesData(VertexBuffer.PositionKind, positions);
    ground.updateVerticesData(VertexBuffer.NormalKind, normals);

    // Apply a default material
    const groundMaterial = new StandardMaterial(`${name}Material`, this.scene);
    groundMaterial.diffuseColor = new Color3(0.4, 0.9, 0.6);
    groundMaterial.specularColor = new Color3(0.1, 0.1, 0.1);
    ground.material = groundMaterial;

    return ground;
  }
}
