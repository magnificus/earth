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
} from '@babylonjs/core';
import { TerrainTiles } from './TerrainTiles';
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
    //casa =  59.904706664625266, 10.61104958556299;
    const heightmap = await TerrainTiles.fetchTileAtLocation(storyodden.lat, storyodden.lon, 15);
    
    // Download the heightmap to disk
    //TerrainTiles.downloadHeightmap(heightmap, 'oslo_heightmap.png');
    
    // Derive meters-per-unit from the real ground extent so
    // horizontal and vertical scales match 1:1 (absolute height).
    const meshWidth = 100;   // scene units for the ground plane
    const groundWidth = heightmap.groundWidthMeters ?? 1000;
    const groundHeight = heightmap.groundHeightMeters ?? 1000;
    const metersPerUnit = groundWidth / meshWidth;
    const meshDepth = groundHeight / metersPerUnit; // may differ slightly from meshWidth due to latitude

    // Absolute elevation mapped to the same scale
    const minHeight = heightmap.minElevation / metersPerUnit;
    const maxHeight = heightmap.maxElevation / metersPerUnit;

    console.log(`Ground extent: ${groundWidth.toFixed(0)}m × ${groundHeight.toFixed(0)}m → ${meshWidth} × ${meshDepth.toFixed(2)} units (1 unit = ${metersPerUnit.toFixed(1)}m)`);
    console.log(`Elevation: ${heightmap.minElevation.toFixed(0)}m – ${heightmap.maxElevation.toFixed(0)}m → ${minHeight.toFixed(2)} – ${maxHeight.toFixed(2)} units`);

    // Multiplier for mesh subdivisions relative to source image pixels.
    // 1 = one vertex per pixel, 0.5 = half resolution, 2 = double, etc.
    const subdivisionMultiplier = 1;
    const subdivisions = Math.max(1, Math.round(heightmap.width * subdivisionMultiplier));

    console.log(`Heightmap: ${heightmap.width}×${heightmap.height}px → ${subdivisions} subdivisions (×${subdivisionMultiplier})`);

    const terrain = await this.createHeightmapMesh('terrain', heightmap.dataUrl, {
      width: meshWidth,
      height: meshDepth,
      subdivisions,
      minHeight,
      maxHeight,
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
   * Creates a mesh plane from a heightmap image.
   * @param name - The name of the mesh
   * @param heightmapUrl - URL or path to the heightmap image
   * @param options - Configuration options for the terrain
   * @returns Promise that resolves to the created ground mesh
   */
  createHeightmapMesh(
    name: string,
    heightmapUrl: string,
    options: {
      width?: number;
      height?: number;
      subdivisions?: number;
      minHeight?: number;
      maxHeight?: number;
    } = {}
  ): Promise<Mesh> {
    const {
      width = 10,
      height = 10,
      subdivisions = 100,
      minHeight = 0,
      maxHeight = 2,
    } = options;

    return new Promise((resolve) => {
      const ground = MeshBuilder.CreateGroundFromHeightMap(
        name,
        heightmapUrl,
        {
          width,
          height,
          subdivisions,
          minHeight,
          maxHeight,
          onReady: (mesh) => {
            resolve(mesh);
          },
        },
        this.scene
      );

      // Apply a default material
      const groundMaterial = new StandardMaterial(`${name}Material`, this.scene);
      groundMaterial.diffuseColor = new Color3(0.4, 0.9, 0.6);
      groundMaterial.specularColor = new Color3(0.1, 0.1, 0.1);
      ground.material = groundMaterial;
    });
  }
}
