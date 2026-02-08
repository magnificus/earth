import {
  Scene,
  Vector2,
  MeshBuilder,
  Color3,
  Mesh,
  Texture,
} from '@babylonjs/core';
import { WaterMaterial } from '@babylonjs/materials';

/**
 * Creates a water plane with realistic reflections and waves.
 * @param scene - The Babylon.js scene
 * @param renderListMeshes - Meshes to include in reflection/refraction render list
 * @param options - Configuration options for the water plane
 * @returns The water ground mesh
 */
export function createWaterPlane(
  scene: Scene,
  renderListMeshes: Mesh[],
  options: {
    width?: number;
    height?: number;
    subdivisions?: number;
    elevation?: number;
  } = {}
): Mesh {
  const {
    width = 100,
    height = 100,
    subdivisions = 64,
    elevation = 0.7,
  } = options;

  // Extend slightly beyond the terrain to avoid edge clipping artifacts
  const waterMesh = MeshBuilder.CreateGround(
    'waterMesh',
    { width: width * 1.2, height: height * 1.2, subdivisions },
    scene
  );
  waterMesh.position.y = elevation;

  const water = new WaterMaterial('waterMaterial', scene, new Vector2(512, 512));
  water.bumpTexture = new Texture(
    'https://assets.babylonjs.com/textures/waterbump.png',
    scene
  );

  // Wave properties
  water.windForce = -5;
  water.waveHeight = 0.03;
  water.bumpHeight = 0.07;
  water.waveLength = 0.1;
  water.windDirection = new Vector2(1, 1);

  // Color & blending — higher blend factors mask the black refraction edge at the shoreline
  water.waterColor = new Color3(0.05, 0.2, 0.4);
  water.waterColor2 = new Color3(0.0, 0.1, 0.25);
  water.colorBlendFactor = 0.8;
  water.colorBlendFactor2 = 0.8;

  // Add meshes to the water's render list for reflections/refractions
  for (const mesh of renderListMeshes) {
    water.addToRenderList(mesh);
  }

  waterMesh.material = water;
  return waterMesh;
}
