import {
  Engine,
  Scene,
  UniversalCamera,
  Vector3,
  HemisphericLight,
  PointLight,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  Animation,
  PolygonMeshBuilder,
  Mesh,
  Texture,
  KeyboardEventTypes,
} from '@babylonjs/core';
import { TerrainTiles } from './TerrainTiles';

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
    hemisphericLight.intensity = 0.3;
    hemisphericLight.groundColor = new Color3(0.1, 0.1, 0.2);

    // Oslo coordinates: 59.91°N, 10.75°E
    // Zoom 10 covers roughly 40km x 40km area
    const heightmap = await TerrainTiles.fetchTileAtLocation(60, 10.738, 10);
    
    // Download the heightmap to disk
    TerrainTiles.downloadHeightmap(heightmap, 'oslo_heightmap.png');
    
    // Scale real-world elevation to scene units
    // e.g., 1 scene unit = 100 meters
    const metersPerUnit = 100;
    const elevationRange = heightmap.maxElevation - heightmap.minElevation;
    const maxHeight = elevationRange / metersPerUnit;
    
    console.log(`Elevation: ${heightmap.minElevation.toFixed(0)}m - ${heightmap.maxElevation.toFixed(0)}m (range: ${elevationRange.toFixed(0)}m, scaled: ${maxHeight.toFixed(2)} units)`);
    
    const terrain = await this.createHeightmapMesh('terrain', heightmap.dataUrl, {
      width: 100,
      height: 100,
      subdivisions: 500,
      minHeight: 0,
      maxHeight,
    });
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
