import {
  Engine,
  Scene,
  ArcRotateCamera,
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
} from '@babylonjs/core';

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

    // Create camera
    const camera = new ArcRotateCamera(
      'camera',
      Math.PI / 2,
      Math.PI / 2.5,
      10,
      Vector3.Zero(),
      this.scene
    );
    camera.attachControl(this.canvas, true);
    camera.lowerRadiusLimit = 3;
    camera.upperRadiusLimit = 20;
    camera.wheelPrecision = 50;
    camera.panningSensibility = 0;

    // Create lights
    const hemisphericLight = new HemisphericLight(
      'hemisphericLight',
      new Vector3(1, 1, 0),
      this.scene
    );
    hemisphericLight.intensity = 0.3;
    hemisphericLight.groundColor = new Color3(0.1, 0.1, 0.2);

    const earth = await this.createHeightmapMesh('terrain', 'assets/heightmaps/Oslo%20height.png', {
      width: 20,
      height: 20,
      subdivisions: 150,
      minHeight: 0,
      maxHeight: 3,
    });
    // Create Earth material
    const earthMaterial = new StandardMaterial('earthMaterial', this.scene);
    earthMaterial.diffuseColor = new Color3(0.2, 0.8, 0.5);
    earthMaterial.specularColor = new Color3(0.3, 0.3, 0.5);
    earthMaterial.specularPower = 32;
    earthMaterial.emissiveColor = new Color3(0.05, 0.1, 0.2);
    earth.material = earthMaterial;
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
      groundMaterial.diffuseColor = new Color3(0.4, 0.6, 0.3);
      groundMaterial.specularColor = new Color3(0.1, 0.1, 0.1);
      ground.material = groundMaterial;
    });
  }
}
