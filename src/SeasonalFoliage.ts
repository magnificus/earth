import { Color3, Mesh, ShaderMaterial } from "@babylonjs/core";

/**
 * Live seasonal foliage colour.
 *
 * Nothing about the colour change is baked into a tree model or its impostor
 * atlas. Geometry carries a per-leaf turning phase (vertex colour alpha, also
 * captured into an atlas data band) that is spatially coherent across the
 * crown, and each material receives the season's target tint plus how far the
 * season has progressed. Every instance then derives its own timing from its
 * world position, so neighbouring trees turn at different moments and to
 * slightly different depths of colour while sharing one atlas.
 */

export const SEASONAL_FOLIAGE_UNIFORMS = ["seasonTint", "seasonProgress"] as const;

/** Half-width of a leaf region's transition; keeps region edges soft. */
const SEASON_EDGE = 0.14;
/** Tree-to-tree timing spread, as a fraction of the crown's phase range. */
const SEASON_SPREAD = 0.35;

export const seasonalFoliageVertexDeclaration = `
uniform float seasonProgress;
uniform vec3 seasonTint;
varying float vSeasonProgress;
varying vec3 vSeasonTint;
float seasonHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
// Maps the season's 0..1 progress onto the crown's phase range with enough
// slack that every tree is untouched at 0 and fully turned at 1, then shifts
// this tree earlier or later than its neighbours.
float seasonInstanceProgress(vec3 origin) {
  float offset = seasonHash(origin) * 2.0 - 1.0;
  return mix(
    -${SEASON_EDGE.toFixed(3)} - ${SEASON_SPREAD.toFixed(3)},
    1.0 + ${SEASON_EDGE.toFixed(3)} + ${SEASON_SPREAD.toFixed(3)},
    seasonProgress
  ) + offset * ${SEASON_SPREAD.toFixed(3)};
}
// Some trees colour more deeply than others. Raising the tint to a per-tree
// power varies its strength while leaving an untinted season untouched.
vec3 seasonInstanceTint(vec3 origin) {
  float depth = seasonHash(origin + vec3(17.0, 3.0, 29.0));
  return pow(max(seasonTint, vec3(0.0001)), vec3(mix(0.7, 1.3, depth)));
}
`;

export const seasonalFoliageFragmentDeclaration = `
varying float vSeasonProgress;
varying vec3 vSeasonTint;
// phase: this leaf region's turning order, 0 first and 1 last (1 also marks
// geometry that never turns). foliageMask: 1 on leaves, 0 on bark.
vec3 seasonFoliageColor(vec3 color, float phase, float foliageMask) {
  float turn = smoothstep(
    phase - ${SEASON_EDGE.toFixed(3)},
    phase + ${SEASON_EDGE.toFixed(3)},
    vSeasonProgress
  );
  return color * mix(vec3(1.0), vSeasonTint, turn * foliageMask);
}
`;

/** Neutral defaults: no tint and no progress leave every material unchanged. */
export function initializeSeasonalFoliage(material: ShaderMaterial): void {
  material.setColor3("seasonTint", Color3.White());
  material.setFloat("seasonProgress", 0);
}

export function setSeasonalFoliage(
  material: ShaderMaterial,
  tint: readonly [number, number, number],
  progress: number,
): void {
  material.setColor3("seasonTint", new Color3(tint[0], tint[1], tint[2]));
  material.setFloat("seasonProgress", clamp01(progress));
}

/** Updates the live season progress on every distinct material of the meshes. */
export function setSeasonalFoliageProgress(meshes: readonly Mesh[], progress: number): void {
  const materials = new Set<ShaderMaterial>();
  for (const mesh of meshes) {
    if (mesh.material instanceof ShaderMaterial) materials.add(mesh.material);
  }
  materials.forEach((material) => material.setFloat("seasonProgress", clamp01(progress)));
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
