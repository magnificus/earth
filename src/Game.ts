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
  GlowLayer,
  Animation,
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
      new Vector3(0, 1, 0),
      this.scene
    );
    hemisphericLight.intensity = 0.3;
    hemisphericLight.groundColor = new Color3(0.1, 0.1, 0.2);

    const pointLight = new PointLight(
      'pointLight',
      new Vector3(5, 5, 5),
      this.scene
    );
    pointLight.intensity = 1.2;
    pointLight.diffuse = new Color3(1, 0.95, 0.9);

    // Add glow effect
    const glowLayer = new GlowLayer('glow', this.scene);
    glowLayer.intensity = 0.5;

    // Create the Earth sphere
    const earth = MeshBuilder.CreateSphere(
      'earth',
      { diameter: 4, segments: 64 },
      this.scene
    );

    // Create Earth material
    const earthMaterial = new StandardMaterial('earthMaterial', this.scene);
    earthMaterial.diffuseColor = new Color3(0.2, 0.4, 0.8);
    earthMaterial.specularColor = new Color3(0.3, 0.3, 0.5);
    earthMaterial.specularPower = 32;
    earthMaterial.emissiveColor = new Color3(0.05, 0.1, 0.2);
    earth.material = earthMaterial;

    // Add rotation animation to Earth
    const rotationAnimation = new Animation(
      'earthRotation',
      'rotation.y',
      30,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );

    const rotationKeys = [
      { frame: 0, value: 0 },
      { frame: 1000, value: Math.PI * 2 },
    ];
    rotationAnimation.setKeys(rotationKeys);
    earth.animations.push(rotationAnimation);
    this.scene.beginAnimation(earth, 0, 1000, true);

    // Create atmosphere effect
    const atmosphere = MeshBuilder.CreateSphere(
      'atmosphere',
      { diameter: 4.2, segments: 64 },
      this.scene
    );

    const atmosphereMaterial = new StandardMaterial('atmosphereMaterial', this.scene);
    atmosphereMaterial.diffuseColor = new Color3(0.4, 0.6, 1);
    atmosphereMaterial.alpha = 0.15;
    atmosphereMaterial.backFaceCulling = false;
    atmosphereMaterial.emissiveColor = new Color3(0.2, 0.4, 0.8);
    atmosphere.material = atmosphereMaterial;

    // Create moon
    const moon = MeshBuilder.CreateSphere(
      'moon',
      { diameter: 0.8, segments: 32 },
      this.scene
    );
    moon.position = new Vector3(6, 1, 0);

    const moonMaterial = new StandardMaterial('moonMaterial', this.scene);
    moonMaterial.diffuseColor = new Color3(0.7, 0.7, 0.7);
    moonMaterial.specularColor = new Color3(0.2, 0.2, 0.2);
    moon.material = moonMaterial;

    // Moon orbit animation
    const moonOrbitAnimation = new Animation(
      'moonOrbit',
      'position',
      30,
      Animation.ANIMATIONTYPE_VECTOR3,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );

    const orbitRadius = 6;
    const moonOrbitKeys = [];
    for (let i = 0; i <= 360; i += 10) {
      const angle = (i * Math.PI) / 180;
      moonOrbitKeys.push({
        frame: i * 3,
        value: new Vector3(
          Math.cos(angle) * orbitRadius,
          Math.sin(angle * 0.5) * 0.5,
          Math.sin(angle) * orbitRadius
        ),
      });
    }
    moonOrbitAnimation.setKeys(moonOrbitKeys);
    moon.animations.push(moonOrbitAnimation);
    this.scene.beginAnimation(moon, 0, 1080, true);

    // Create starfield
    this.createStarfield();

    // Camera auto-rotation
    this.scene.registerBeforeRender(() => {
      camera.alpha += 0.001;
    });
  }

  private createStarfield(): void {
    const starCount = 2000;
    const positions: number[] = [];
    const colors: number[] = [];

    for (let i = 0; i < starCount; i++) {
      // Random spherical distribution
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 50 + Math.random() * 50;

      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);

      positions.push(x, y, z);

      // Random star colors (white to blue-ish)
      const brightness = 0.5 + Math.random() * 0.5;
      const blueShift = Math.random() * 0.3;
      colors.push(
        brightness - blueShift * 0.5,
        brightness - blueShift * 0.3,
        brightness,
        1
      );
    }

    const stars = MeshBuilder.CreateLineSystem(
      'stars',
      {
        lines: positions
          .reduce((acc: Vector3[][], _, i) => {
            if (i % 3 === 0) {
              const point = new Vector3(
                positions[i],
                positions[i + 1],
                positions[i + 2]
              );
              acc.push([point, point.add(new Vector3(0.01, 0.01, 0.01))]);
            }
            return acc;
          }, []),
      },
      this.scene
    );

    const starMaterial = new StandardMaterial('starMaterial', this.scene);
    starMaterial.emissiveColor = new Color3(1, 1, 1);
    starMaterial.disableLighting = true;
    stars.material = starMaterial;
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
}
