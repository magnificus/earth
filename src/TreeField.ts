import {
  Camera,
  Color3,
  DirectionalLight,
  HemisphericLight,
  Matrix,
  Mesh,
  Scene,
  ShadowDepthWrapper,
  ShaderMaterial,
  TransformNode,
  Vector2,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import {
  groundMetersAt,
  isTerrainFootprintAbove,
  sceneToLonLat,
  sampleElevation,
} from "./Geo";
import type { TerrainData } from "./TerrainData";
import {
  acquireTreeImpostorAssets,
  createTreeLogModel,
  createTreeModels,
  getTreeImpostorAssets,
  TREE_IMPOSTOR_FACES,
  TreeImpostorVariant,
} from "./TreeImpostor";
import { ImpostorAssets } from "./Impostor";
import {
  combineVegetationFieldResults,
  createVegetationFieldResult,
  VegetationFieldResult,
} from "./VegetationField";
import { LandCoverClass } from "./WorldCover";
import { createSeededRandom } from "./Random";
import {
  TREE_LOW_LIGHT_BRIGHTNESS,
  TREE_SPECIES,
  TREE_SPECIES_LIST,
  TreeSpecies,
} from "./procedural/ProceduralTree";
import { SimplexNoise2D } from "./SimplexNoise";
import {
  sampleWorldTreeSpecies,
  treeDistributionAt,
  TreeDistribution,
} from "./TreeDistribution";
import {
  createPlacementGrid,
  packInstanceMatrices,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import {
  bindCloudShadowReceiver,
  cloudShadowFragmentDeclaration,
  cloudShadowVertexDeclaration,
  CLOUD_SHADOW_UNIFORMS,
} from "./CloudShadows";
import {
  bindVegetationShadowReceiver,
  vegetationShadowFragmentDeclaration,
  vegetationShadowVertexDeclaration,
} from "./VegetationShadowReceiver";
import {
  bindWindPhase,
  setWindShear,
  windShearFraction,
  windPhaseVertexDeclaration,
  windShearVertexDeclaration,
  WIND_PHASE_UNIFORMS,
  WIND_SHEAR_UNIFORMS,
} from "./Wind";
import { setVegetationWindShear } from "./procedural/ProceduralCaptureMaterial";
import {
  proceduralLocalVariantAtLocation,
  proceduralVariantAtLocation,
} from "./procedural/ProceduralRegions";
import { DEFAULT_WORLD_SEED, layerSeed } from "./WorldGrid";
import { treeSeasonAt } from "./TreeSeason";

export type TreeFieldResult = VegetationFieldResult;
export const DEFAULT_TREE_SPACING_METERS = 3.5;
const TREE_SPECIES_CLUSTER_SIZE_METERS = 42;
/** Avoid baking a full atlas for a barely represented transition tail. */
const MIN_TREE_VARIANT_SHARE = 0.08;
/** A local forest reads more coherently and needs fewer atlases with a focused palette. */
const MAX_TREE_SPECIES_PER_VARIANT = 3;
/** A small reusable silhouette palette stops adjacent terrain tiles cloning one tree. */
const TREE_SISTER_MODELS = 4;
/** Sparse enough to read as deadfall rather than a second tree layer. */
const FALLEN_LOG_CHANCE = 0.015;
/** Fallen wood is reserved for the established interior of dense forest cover. */
const FALLEN_LOG_MINIMUM_INTERIOR_DEPTH = 0.7;
const TREE_SPECIES_SCALE: Readonly<Record<TreeSpecies, number>> = {
  acacia: 0.92,
  beech: 1.02,
  birch: 1,
  eucalyptus: 1.14,
  fir: 0.93,
  mangrove: 0.88,
  maple: 1.02,
  oak: 1.08,
  palm: 1.12,
  pine: 1.16,
  spruce: 0.86,
};

export interface ImpostorPrototype {
  root: TransformNode;
  mesh: Mesh;
  assets: ImpostorAssets;
  captureSize: number;
  captureWidth: number;
  captureHeight: number;
}

interface TreeFieldOptions extends VegetationPlacementOptions {
  occupancy?: number;
  edgeOccupancy?: number;
  fullDensityDepthMeters?: number;
  includeModels?: boolean;
  includeFallenLogs?: boolean;
  forceLowestImpostorLod?: boolean;
  positionOffset?: Vector3;
  elevationSampler?: (x: number, z: number) => number;
  /** Rendered height before per-instance scale variation. */
  renderHeightMeters?: number;
  /** Names the owning field and its per-species prototype children. */
  rootName?: string;
  prototypeNamePrefix?: string;
  /**
   * Seed for the species-grove noise. Pass a world-level seed (not a per-tile
   * one) so groves continue seamlessly across streamed tile boundaries.
   */
  speciesSeed?: number;
}

interface TreeVariantBucket {
  species: TreeSpecies;
  variant: TreeImpostorVariant;
  matrices: Matrix[];
  fallenLogMatrices: Matrix[];
}

export const impostorVertexShader = `
precision highp float;
attribute vec3 position;
#ifdef THIN_INSTANCES
attribute vec3 vegetationColor;
attribute float instanceLodBlend;
#endif
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float captureCenterY;
uniform float impostorDepthPull;
uniform vec3 sunDirection;
${vegetationShadowVertexDeclaration}
${cloudShadowVertexDeclaration}
${windPhaseVertexDeclaration}
${windShearVertexDeclaration}
#include<instancesDeclaration>
varying vec3 vLocalPosition;
varying vec3 vViewDirection;
varying vec3 vLocalSunDirection;
varying vec3 vLocalWorldUp;
varying vec3 vInstanceColor;
varying float vInstanceLodBlend;
varying vec3 vWindShear;
varying vec3 vCenterWorld;

void main(void) {
  #include<instancesVertex>
  vec3 instanceOrigin = finalWorld[3].xyz;
  vec4 worldPosition = finalWorld * vec4(position, 1.0);
  vCloudShadowWorldXZ = instanceOrigin.xz;
  vec4 shadowWorldPosition = mix(
    worldPosition,
    finalWorld * vec4(0.0, 0.0, 0.0, 1.0),
    vegetationShadowAtInstanceRoot
  );
  vVegetationShadowPosition = vegetationShadowMatrix * shadowWorldPosition;
  vec3 center = (finalWorld * vec4(0.0, captureCenterY, 0.0, 1.0)).xyz;
  vec3 axisX = normalize(finalWorld[0].xyz);
  vec3 axisY = normalize(finalWorld[1].xyz);
  vec3 axisZ = normalize(finalWorld[2].xyz);
  // Local-space lean per unit of height. The fragment stage applies it to the
  // point it samples, so a source leans with no extra atlas frames at all.
  vWindShear = windShearGradient(
    windLocalDirection(axisX, axisZ),
    windBend(instanceOrigin)
  );
  vec3 worldViewDirection = cameraPosition - center;

  vCenterWorld = center;
  vLocalPosition = position - vec3(0.0, captureCenterY, 0.0);
  vViewDirection = vec3(
    dot(worldViewDirection, axisX),
    dot(worldViewDirection, axisY),
    dot(worldViewDirection, axisZ)
  );
  vLocalSunDirection = normalize(vec3(
    dot(sunDirection, axisX),
    dot(sunDirection, axisY),
    dot(sunDirection, axisZ)
  ));
  vLocalWorldUp = normalize(vec3(axisX.y, axisY.y, axisZ.y));
  #ifdef THIN_INSTANCES
  vInstanceColor = vegetationColor;
  vInstanceLodBlend = instanceLodBlend;
  #else
  vInstanceColor = vec3(1.0);
  vInstanceLodBlend = 0.0;
  #endif
  vec4 clipPosition = viewProjection * worldPosition;
  // Low ground cover is a wide, flat disc, so its near edge stands well in
  // front of the center. Depth from the center plane then lets the terrain
  // under that edge win the depth test and bury the clump to half its height.
  // Pulling the depth plane out to the near edge costs coverage of real
  // geometry within one clump radius, which is imperceptible on a source this
  // short; tall sources leave the pull at zero and keep the center plane.
  float viewDistance = length(worldViewDirection);
  vec3 depthCenter = center + worldViewDirection *
    (min(impostorDepthPull, viewDistance * 0.5) / max(viewDistance, 0.0001));
  vec4 centerClipPosition = viewProjection * vec4(depthCenter, 1.0);
  // The box is only conservative raster coverage for the camera-facing image.
  // Using its nearest wall as depth makes the impostor incorrectly cover real
  // geometry between that wall and the captured object's center. Flatten the
  // proxy onto the center plane while retaining its screen-space coverage.
  clipPosition.z = (centerClipPosition.z / centerClipPosition.w) * clipPosition.w;
  gl_Position = clipPosition;
}`;

export const impostorFragmentShader = `
#extension GL_EXT_frag_depth : enable
precision highp float;
varying vec3 vLocalPosition;
varying vec3 vViewDirection;
varying vec3 vLocalSunDirection;
varying vec3 vLocalWorldUp;
varying vec3 vInstanceColor;
varying float vInstanceLodBlend;
varying vec3 vWindShear;
varying vec3 vCenterWorld;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform sampler2D atlas0;
uniform sampler2D atlas1;
uniform sampler2D atlas2;
uniform sampler2D atlas3;
uniform sampler2D atlas4;
uniform sampler2D atlas5;
uniform sampler2D lowAtlas0;
uniform sampler2D lowAtlas1;
uniform sampler2D lowAtlas2;
uniform sampler2D lowAtlas3;
uniform sampler2D lowAtlas4;
uniform sampler2D lowAtlas5;
uniform float rotationallySymmetric;
uniform float rotationalSymmetryOrder;
uniform float upperHemisphereOnly;
uniform float lowerHemisphereFace;
uniform vec2 gridDimensions;
uniform vec2 atlasTileCounts;
uniform vec2 tileInset;
uniform vec2 lowTileInset;
uniform vec2 captureDimensions;
uniform float impostorLodNear;
uniform float impostorLodFar;
uniform float forceLowestLod;
uniform float cameraOrthographic;
uniform float captureCenterY;
uniform vec3 sunColor;
uniform vec3 skyColor;
uniform vec3 groundColor;
uniform float lowLightAlbedoScale;
uniform float instanceColorCoverage;
uniform float fieldFade;
uniform float distanceFadeNear;
uniform float distanceFadeFar;
uniform float groundColorBlend;
uniform float distanceGroundBlend;
uniform vec3 distanceGroundColor;
uniform float impostorAmbientUpward;
uniform float impostorColorContrast;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
${vegetationShadowFragmentDeclaration}
${cloudShadowFragmentDeclaration}

vec4 atlasSample(float face, vec2 uv) {
  if (face < 0.5) return texture2D(atlas0, uv);
  if (face < 1.5) return texture2D(atlas1, uv);
  if (face < 2.5) return texture2D(atlas2, uv);
  if (face < 3.5) return texture2D(atlas3, uv);
  if (face < 4.5) return texture2D(atlas4, uv);
  return texture2D(atlas5, uv);
}

vec4 lowAtlasSample(float face, vec2 uv) {
  if (face < 0.5) return texture2D(lowAtlas0, uv);
  if (face < 1.5) return texture2D(lowAtlas1, uv);
  if (face < 2.5) return texture2D(lowAtlas2, uv);
  if (face < 3.5) return texture2D(lowAtlas3, uv);
  if (face < 4.5) return texture2D(lowAtlas4, uv);
  return texture2D(lowAtlas5, uv);
}

vec4 frame(float face, vec2 tile, vec2 imageUV, float lodBlend) {
  vec2 localUV = mix(tileInset, vec2(1.0) - tileInset, imageUV);
  vec2 atlasUV = (tile + localUV) / atlasTileCounts;
  if (lodBlend <= 0.0) return atlasSample(face, atlasUV);

  vec2 lowLocalUV = mix(lowTileInset, vec2(1.0) - lowTileInset, imageUV);
  vec4 lowColor = lowAtlasSample(face, (tile + lowLocalUV) / atlasTileCounts);
  // The low atlas is color-only. Its coarse coverage is unsuitable for a
  // stable foliage silhouette, so the original atlas remains the alpha mask.
  lowColor.a = step(0.5, lowColor.a);

  vec4 highColor = atlasSample(face, atlasUV);
  // Never cross-fade color against transparent black. When only one atlas
  // covers this fragment, extend that atlas's color through the other side of
  // the transition and blend only once both samples contain real color.
  float highPresent = step(1.0 / 255.0, highColor.a);
  float lowPresent = step(1.0 / 255.0, lowColor.a);
  vec3 highStraight = mix(lowColor.rgb, highColor.rgb, highPresent);
  vec3 lowStraight = mix(highStraight, lowColor.rgb, lowPresent);
  // Preserve the detailed atlas's coverage through and beyond the color LOD.
  // This avoids both low-resolution holes and an opaque coarse silhouette.
  float alpha = highColor.a;
  vec3 straightColor = mix(highStraight, lowStraight, lodBlend);
  return vec4(straightColor, alpha);
}

float bayer4(vec2 pixel) {
  vec2 p = mod(floor(pixel), 4.0);
  vec2 low = mod(p, 2.0);
  vec2 high = floor(p * 0.5);
  float lowValue = 2.0 * low.x + low.y * (3.0 - 4.0 * low.x);
  float highValue = 2.0 * high.x + high.y * (3.0 - 4.0 * high.x);
  return (4.0 * lowValue + highValue) / 16.0;
}

// The longer distance dissolve needs more coverage steps than the compact
// masks used by LOD swaps. Expanding the same ordered pattern to 8 by 8 keeps
// it stable in screen space while making individual steps and repeats much
// less apparent.
float bayer8(vec2 pixel) {
  vec2 p = mod(floor(pixel), 8.0);
  vec2 low = mod(p, 2.0);
  vec2 middle = mod(floor(p * 0.5), 2.0);
  vec2 high = floor(p * 0.25);
  float lowValue = 2.0 * low.x + low.y * (3.0 - 4.0 * low.x);
  float middleValue = 2.0 * middle.x + middle.y * (3.0 - 4.0 * middle.x);
  float highValue = 2.0 * high.x + high.y * (3.0 - 4.0 * high.x);
  return (16.0 * lowValue + 4.0 * middleValue + highValue) / 64.0;
}

void main(void) {
  // Complement the model shader's screen-door mask so the two LODs blend
  // without the depth-sorting problems of translucent vegetation.
  if (vInstanceLodBlend > bayer4(gl_FragCoord.xy + vec2(2.0, 1.0))) discard;
  // Whole-field dither lets streamed tiles fade their vegetation in and out
  // without the depth-sorting problems of true transparency.
  if (fieldFade < 0.999 && bayer4(gl_FragCoord.xy + vec2(1.0, 3.0)) >= fieldFade) discard;
  // Low ground cover dissolves before its streamed detail ring ends. Dithered
  // coverage stays depth-safe while avoiding a visible wall of transparency.
  float distanceFade = 1.0 - smoothstep(
    distanceFadeNear,
    distanceFadeFar,
    length(vViewDirection)
  );
  if (distanceFade < 0.999 &&
      bayer8(gl_FragCoord.xy + vec2(3.0, 2.0)) >= distanceFade) discard;
  // Select the captured silhouette from the light during shadow rendering.
  #if SM_DIRECTIONINLIGHTDATA == 1
  vec3 direction = normalize(vLocalSunDirection);
  #else
  vec3 direction = normalize(vViewDirection);
  #endif
  vec3 absoluteDirection = abs(direction);
  vec3 captureDirection = direction;
  vec3 faceNormal;
  float face;
  float topFacing = 0.0;
  vec3 faceRight;
  vec3 faceUp;
  vec3 billboardFaceUp;
  float sectorRotation = 0.0;

  if (rotationallySymmetric > 0.5) {
    float horizontal = length(direction.xz);
    if (rotationalSymmetryOrder > 1.5 && horizontal > 0.0001) {
      float sectorAngle = 6.28318530718 / rotationalSymmetryOrder;
      float azimuth = atan(direction.z, direction.x);
      float foldedAzimuth = mod(azimuth + sectorAngle * 0.5, sectorAngle) - sectorAngle * 0.5;
      sectorRotation = azimuth - foldedAzimuth;
      captureDirection = normalize(vec3(
        cos(foldedAzimuth) * horizontal,
        direction.y,
        sin(foldedAzimuth) * horizontal
      ));
    } else {
      captureDirection = normalize(vec3(horizontal, direction.y, 0.0));
    }

    if (direction.y >= abs(captureDirection.x) && direction.y >= abs(captureDirection.z)) {
      face = 1.0; faceNormal = vec3(0.0, 1.0, 0.0); faceRight = vec3(1.0, 0.0, 0.0); faceUp = vec3(0.0, 0.0, -1.0);
      topFacing = 1.0;
      if (rotationalSymmetryOrder <= 1.5) {
        captureDirection = normalize(vec3(0.0, direction.y, -horizontal));
      }
    } else {
      face = 0.0; faceNormal = vec3(1.0, 0.0, 0.0); faceRight = vec3(0.0, 0.0, -1.0); faceUp = vec3(0.0, 1.0, 0.0);
    }
  } else if (direction.y >= 0.0 && absoluteDirection.y >= absoluteDirection.x && absoluteDirection.y >= absoluteDirection.z) {
    face = 2.0; faceNormal = vec3(0.0, 1.0, 0.0); faceRight = vec3(1.0, 0.0, 0.0); faceUp = vec3(0.0, 0.0, -1.0);
    topFacing = 1.0;
  } else if (lowerHemisphereFace > 0.5 && direction.y < 0.0 && absoluteDirection.y >= absoluteDirection.x && absoluteDirection.y >= absoluteDirection.z) {
    face = 5.0; faceNormal = vec3(0.0, -1.0, 0.0); faceRight = vec3(1.0, 0.0, 0.0); faceUp = vec3(0.0, 0.0, 1.0);
    topFacing = 1.0;
  } else if (absoluteDirection.x >= absoluteDirection.z) {
    if (direction.x >= 0.0) {
      face = 0.0; faceNormal = vec3(1.0, 0.0, 0.0); faceRight = vec3(0.0, 0.0, -1.0); faceUp = vec3(0.0, 1.0, 0.0);
    } else {
      face = 1.0; faceNormal = vec3(-1.0, 0.0, 0.0); faceRight = vec3(0.0, 0.0, 1.0); faceUp = vec3(0.0, 1.0, 0.0);
    }
  } else {
    if (direction.z >= 0.0) {
      face = 3.0; faceNormal = vec3(0.0, 0.0, 1.0); faceRight = vec3(1.0, 0.0, 0.0); faceUp = vec3(0.0, 1.0, 0.0);
    } else {
      face = 4.0; faceNormal = vec3(0.0, 0.0, -1.0); faceRight = vec3(-1.0, 0.0, 0.0); faceUp = vec3(0.0, 1.0, 0.0);
    }
  }

  billboardFaceUp = faceUp;
  if (topFacing > 0.5 && rotationalSymmetryOrder > 1.5) {
    billboardFaceUp = vec3(sin(sectorRotation), 0.0, -cos(sectorRotation));
  }

  float denominator = max(0.0001, dot(captureDirection, faceNormal));
  vec2 projected = vec2(dot(captureDirection, faceRight), dot(captureDirection, faceUp)) / denominator;
  vec2 normalizedSamplePosition = (projected + 1.0) * 0.5;
  if (upperHemisphereOnly > 0.5 && topFacing < 0.5) {
    normalizedSamplePosition.y = projected.y;
  }
  vec2 samplePosition = clamp(normalizedSamplePosition, 0.0, 1.0) * (gridDimensions - 1.0);
  vec3 projectedPosition = vLocalPosition;
  #if SM_DIRECTIONINLIGHTDATA != 1
  if (cameraOrthographic < 0.5) {
    vec3 cameraOffset = vViewDirection;
    vec3 ray = vLocalPosition - cameraOffset;
    float rayDenominator = dot(ray, direction);
    if (abs(rayDenominator) < 0.0001) discard;
    float distanceAlongRay = -dot(cameraOffset, direction) / rayDenominator;
    projectedPosition = cameraOffset + ray * distanceAlongRay;
  }
  #endif

  // Lean the captured image by sampling it against the lean. Displacing the
  // point after it has been projected is what anchors the warp to the subject
  // rather than to the proxy box: side-on, image height is capture height, so
  // the frame shears progressively; from overhead the projection plane is level
  // and the whole frame shifts by the lean at mid-height, which is the closest a
  // flat lookup gets to a silhouette smeared through every height. Any component
  // along the view direction falls out of the billboard dots below on its own.
  // This needs slack around the subject inside its frame, which the square
  // captures of low vegetation have and a tightly fitted one would not.
  projectedPosition -= vWindShear * (projectedPosition.y + captureCenterY);
  vec3 billboardRight = normalize(cross(direction, billboardFaceUp));
  vec3 billboardUp = normalize(cross(billboardRight, direction));
  float verticalDimension = mix(captureDimensions.y, captureDimensions.x, topFacing);
  vec2 imageUV = vec2(0.5) + vec2(
    dot(projectedPosition, billboardRight) / captureDimensions.x,
    -dot(projectedPosition, billboardUp) / verticalDimension
  );
  if (any(lessThan(imageUV, vec2(0.0))) || any(greaterThan(imageUV, vec2(1.0)))) discard;

  vec2 low = floor(samplePosition);
  vec2 high = min(low + 1.0, gridDimensions - 1.0);
  vec2 blend = fract(samplePosition);
  vec4 weights = vec4(
    (1.0 - blend.x) * (1.0 - blend.y),
    blend.x * (1.0 - blend.y),
    (1.0 - blend.x) * blend.y,
    blend.x * blend.y
  );
  float choice = bayer4(gl_FragCoord.xy);
  // Distance drives the atlas blend directly in the material, so one impostor
  // instance covers every detail tier. No per-instance blend attribute and no
  // CPU transition ring are needed to reach the reduced source.
  float distanceRatio = length(vViewDirection) / max(captureDimensions.y, 0.0001);
  // Far-tile fields still use the low atlas for color, but retain the detailed
  // atlas's fractional alpha so their silhouettes receive the same ordered
  // coverage dither as ordinary distant impostors.
  float lodBlend = max(
    forceLowestLod,
    smoothstep(impostorLodNear, impostorLodFar, distanceRatio)
  );
  vec2 selectedTile;
  if (choice < weights.x) {
    selectedTile = low;
  } else if (choice < weights.x + weights.y) {
    selectedTile = vec2(high.x, low.y);
  } else if (choice < weights.x + weights.y + weights.z) {
    selectedTile = vec2(low.x, high.y);
  } else {
    selectedTile = high;
  }
  vec4 color = frame(face, selectedTile, imageUV, lodBlend);

  #if SM_DIRECTIONINLIGHTDATA == 1
  // A captured canopy otherwise writes one dense, hard-edged slab into the
  // shadow map. Filter only its depth-pass coverage over roughly one source
  // texel, then leave a little open foliage for the filtered shadow receiver
  // to turn into a restrained penumbra. Visible impostors are unaffected.
  vec2 shadowTexel = tileInset * 2.5;
  float softShadowAlpha = color.a * 0.5;
  softShadowAlpha += frame(
    face, selectedTile, clamp(imageUV + vec2(shadowTexel.x, 0.0), 0.0, 1.0), lodBlend
  ).a * 0.125;
  softShadowAlpha += frame(
    face, selectedTile, clamp(imageUV - vec2(shadowTexel.x, 0.0), 0.0, 1.0), lodBlend
  ).a * 0.125;
  softShadowAlpha += frame(
    face, selectedTile, clamp(imageUV + vec2(0.0, shadowTexel.y), 0.0, 1.0), lodBlend
  ).a * 0.125;
  softShadowAlpha += frame(
    face, selectedTile, clamp(imageUV - vec2(0.0, shadowTexel.y), 0.0, 1.0), lodBlend
  ).a * 0.125;
  color.a = clamp(softShadowAlpha * 0.9 - 0.02, 0.0, 1.0);
  float alphaChoice = bayer8(gl_FragCoord.xy + vec2(1.0, 2.0));
  #else
  float alphaChoice = bayer4(gl_FragCoord.xy + vec2(1.0, 2.0));
  #endif
  if (color.a <= alphaChoice) discard;

#ifdef IMPOSTOR_DEPTH_PROXY
  // The shadow generator always defines SM_DIRECTIONINLIGHTDATA, so its absence
  // is the camera pass. Only there does viewProjection hold the camera's
  // matrix; writing this depth into a shadow map would corrupt it.
  #ifndef SM_DIRECTIONINLIGHTDATA
  // One flattened plane gives every fragment the depth of the capture center,
  // so a tall source can neither ground its trunk nor interleave its canopy
  // with the terrain or with a neighbor. A tree fills its capture volume like
  // an ellipsoid, so intersecting each view ray with the inscribed ellipsoid
  // recovers a per-fragment depth: pinched to the axis at the base, bulging
  // toward the camera across the canopy.
  vec3 proxyRadii = 0.5 * vec3(captureDimensions.x, captureDimensions.y, captureDimensions.x);
  vec3 towardFragment = vLocalPosition - vViewDirection;
  // An orthographic view has no per-fragment ray to intersect, and the capture
  // and validation cameras are the only ones that use it.
  if (cameraOrthographic < 0.5 && length(towardFragment) > 0.0001) {
    vec3 rayStep = normalize(towardFragment);
    vec3 scaledOrigin = vViewDirection / proxyRadii;
    vec3 scaledStep = rayStep / proxyRadii;
    float a = dot(scaledStep, scaledStep);
    float b = 2.0 * dot(scaledOrigin, scaledStep);
    float c = dot(scaledOrigin, scaledOrigin) - 1.0;
    float discriminant = b * b - 4.0 * a * c;
    // Rays past the silhouette take their closest approach to the center,
    // which is where the near hit converges as the ellipsoid turns away. Depth
    // stays continuous over the edge of the proxy rather than snapping back to
    // the plane, which would leave a seam around every canopy.
    float hitDistance = discriminant > 0.0
      ? (-b - sqrt(discriminant)) / (2.0 * a)
      : -b / (2.0 * a);
    // Only movement along the view axis changes depth, and the axis through
    // the center is the one the flattened plane already agrees with.
    float depthOffset = dot(vViewDirection + rayStep * hitDistance, direction);
    vec3 towardCamera = cameraPosition - vCenterWorld;
    vec3 depthPoint = vCenterWorld +
      towardCamera * (depthOffset / max(length(towardCamera), 0.0001));
    vec4 depthClip = viewProjection * vec4(depthPoint, 1.0);
    // Behind the eye there is no meaningful depth to write, so those fragments
    // keep the flattened plane the rasterizer already interpolated.
    gl_FragDepthEXT = depthClip.w > 0.0
      ? 0.5 + 0.5 * depthClip.z / depthClip.w
      : gl_FragCoord.z;
  } else {
    gl_FragDepthEXT = gl_FragCoord.z;
  }
  #endif
#endif

  vec3 straightColor = color.rgb;
  float sceneBrightness = max(
    max(skyColor.r, max(skyColor.g, skyColor.b)),
    max(sunColor.r, max(sunColor.g, sunColor.b))
  );
  float lowLightBlend = 1.0 - smoothstep(0.22, 0.58, sceneBrightness);
  straightColor *= mix(1.0, lowLightAlbedoScale, lowLightBlend);
  float petalMask = smoothstep(0.68, 0.86, min(straightColor.r, min(straightColor.g, straightColor.b)));
  float instanceColorMask = max(petalMask, instanceColorCoverage);
  straightColor = mix(straightColor, straightColor * vInstanceColor, instanceColorMask);
  // The remaining sparse blades converge on the same locally-derived palette
  // as the terrain, making the final coverage loss read as ground texture.
  straightColor = mix(
    straightColor,
    distanceGroundColor * vInstanceColor,
    mix(groundColorBlend, distanceGroundBlend, 1.0 - distanceFade)
  );
  straightColor = clamp(
    (straightColor - vec3(0.42)) * impostorColorContrast + vec3(0.42),
    vec3(0.0),
    vec3(1.25)
  );

  // The atlas contains the whole canopy rather than one physical surface.
  // Deriving a normal from the camera-facing billboard makes the same foliage
  // change brightness when the camera orbits it. Light the canopy from its
  // stable world-up axis instead, matching the orientation-independent leaf
  // lighting used by the close model.
  // Grass uses the same ground/sky ambient balance as its live model. Trees
  // retain the sky-lit canopy default through impostorAmbientUpward = 1.
  vec3 ambientColor = mix(groundColor, skyColor, impostorAmbientUpward);
  float direct = max(
    0.0,
    (dot(vLocalWorldUp, vLocalSunDirection) + 0.42) / 1.42
  );
  float shadowVisibility = vegetationShadowVisibility();
  vec3 lighting = clamp(
    ambientColor + sunColor * (0.16 + direct * 0.62) * shadowVisibility,
    vec3(0.0),
    vec3(1.25)
  );

  // Open sky lights the crown more strongly than the lower foliage.
  float height01 = clamp((vLocalPosition.y / captureCenterY + 1.0) * 0.5, 0.0, 1.0);
  float crownLight = mix(0.62, 1.10, smoothstep(0.08, 0.92, height01));
  // Preserve enough ambient response for foliage to remain readable after sunset.
  lighting = clamp(lighting * crownLight, vec3(0.18), vec3(1.25));
  lighting *= vegetationCloudShadowVisibility();
  float fog = smoothstep(fogStart, fogEnd, length(vViewDirection));
  gl_FragColor = vec4(mix(straightColor * lighting, fogColor, fog), 1.0);
}`;

/** Creates fixed cube impostors within ESA WorldCover tree-cover cells. */
export async function createTreeField(
  scene: Scene,
  terrain: TerrainData,
  options: TreeFieldOptions,
): Promise<TreeFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x4f534c4f,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    seasonalDate,
    spacingMeters = DEFAULT_TREE_SPACING_METERS,
    occupancy = 0.52,
    edgeOccupancy = 0.12,
    fullDensityDepthMeters = 45,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    renderMode = "impostors",
    includeModels = true,
    includeFallenLogs = false,
    forceLowestImpostorLod = false,
    positionOffset = Vector3.Zero(),
    elevationSampler,
    densityScale,
    yieldControl,
    impostorCaptureMode = "cooperative",
    startDisabled = false,
    speciesSeed = seed,
    renderHeightMeters = 11,
    rootName = "treeField",
    prototypeNamePrefix = rootName,
  } = options;
  const treeHeight = renderHeightMeters / metersPerUnit;
  const root = new TransformNode(rootName, scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const speciesNoise = new SimplexNoise2D(speciesSeed ^ 0x54524545);
  const speciesDetailNoise = new SimplexNoise2D(speciesSeed ^ 0x434c5553);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const maximumHalfWidth = Math.max(...TREE_SPECIES_LIST.map((species) => {
    const definition = TREE_SPECIES[species];
    return definition.captureDiameter * treeHeight / definition.sourceHeight;
  })) * 0.55;
  const matrices: Matrix[] = [];
  let variantBuckets = new Map<string, TreeVariantBucket>();

  if (landCover) {
    const forestMask = new Uint8Array(rows * columns);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.5) * cellWidth;
        const z = meshDepth / 2 - (row + 0.5) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const cover = landCover.sample(lon, lat);
        if (cover === LandCoverClass.TreeCover || cover === LandCoverClass.Mangrove) {
          forestMask[row * columns + column] = 1;
        }
      }
      await yieldControl?.();
    }

    const edgeDistances = distanceInsideMask(
      forestMask,
      columns,
      rows,
      cellWidth * metersPerUnit,
      cellDepth * metersPerUnit,
    );

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        if (!forestMask[index]) continue;

        const x = -meshWidth / 2 + (column + 0.2 + random() * 0.6) * cellWidth;
        const z = meshDepth / 2 - (row + 0.2 + random() * 0.6) * cellDepth;
        const elevation = elevationSampler
          ? elevationSampler(x, z)
          : sampleElevation(terrain, x, z, meshWidth, meshDepth);
        if (exclusionMask?.intersects(x, z, maximumHalfWidth)) continue;
        if (!isTerrainFootprintAbove(
          terrain,
          x,
          z,
          maximumHalfWidth,
          maximumHalfWidth,
          meshWidth,
          meshDepth,
          waterLineMeters,
        )) continue;

        const depth = Math.min(1, edgeDistances[index] / fullDensityDepthMeters);
        const interiorWeight = depth * depth * (3 - 2 * depth);
        const worldX = x + positionOffset.x;
        const worldZ = z + positionOffset.z;
        const localOccupancy = Math.min(
          1,
          (edgeOccupancy + (occupancy - edgeOccupancy) * interiorWeight) *
            Math.max(0, densityScale?.(worldX, worldZ) ?? 1),
        );
        if (random() > localOccupancy) continue;

        const location = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const treeDistribution = treeDistributionAt(location.lon, location.lat);
        // Geographic meters anchor the grove noise to the world rather than
        // to this tile's local frame, keeping groves seamless across tiles.
        const ground = groundMetersAt(location.lon, location.lat);
        const species = sampleTreeSpecies(
          speciesNoise,
          speciesDetailNoise,
          ground.x,
          ground.y,
          treeDistribution,
          random(),
        );
        if (!species) continue;
        const speciesScale = TREE_SPECIES_SCALE[species];
        const heightScale = (0.75 + random() * 0.5) * speciesScale;
        const widthScale = (0.75 + random() * 0.35) * speciesScale;
        const yaw = (random() - 0.5) * Math.PI * 2;
        const pitch = (random() - 0.5) * 0.08;
        const roll = (random() - 0.5) * 0.08;
        const matrix = Matrix.Compose(
          new Vector3(widthScale, heightScale, widthScale),
          new Vector3(pitch, yaw, roll).toQuaternion(),
          new Vector3(
            worldX,
            elevation / metersPerUnit + positionOffset.y,
            worldZ,
          ),
        );
        matrices.push(matrix);
        const region = proceduralVariantAtLocation(
          "trees",
          location.lon,
          location.lat,
          modelVariantSeed,
        );
        // Trees are the skyline, so repetition is much more obvious here than
        // in low vegetation. Pick one of a small reusable model palette per
        // broad locality. Adjacent streamed tiles then reuse the same atlas
        // instead of extending the capture queue as the terrain ring fills.
        const localVariant = proceduralLocalVariantAtLocation(
          "trees",
          location.lon,
          location.lat,
          modelVariantSeed,
          TREE_SISTER_MODELS,
        );
        const season = treeSeasonAt(seasonalDate, location.lat, species);
        const variant: TreeImpostorVariant = {
          ...region,
          key: `${region.key}/local/${localVariant}/season/${season.key}`,
          seed: layerSeed(layerSeed(region.seed, `sister-${localVariant}`), species),
          season,
        };
        const bucketKey = `${species}:${variant.key}`;
        let bucket = variantBuckets.get(bucketKey);
        if (!bucket) {
          bucket = { species, variant, matrices: [], fallenLogMatrices: [] };
          variantBuckets.set(bucketKey, bucket);
        }
        bucket.matrices.push(matrix);
        if (includeFallenLogs && depth >= FALLEN_LOG_MINIMUM_INTERIOR_DEPTH &&
            random() < FALLEN_LOG_CHANCE) {
          const logYaw = random() * Math.PI * 2;
          const offsetDistance = (0.7 + random() * 0.9) / metersPerUnit;
          const logX = x + Math.cos(logYaw + Math.PI / 2) * offsetDistance;
          const logZ = z + Math.sin(logYaw + Math.PI / 2) * offsetDistance;
          const logElevation = elevationSampler
            ? elevationSampler(logX, logZ)
            : sampleElevation(terrain, logX, logZ, meshWidth, meshDepth);
          const lengthScale = (0.48 + random() * 0.3) * speciesScale;
          const thicknessScale = (0.82 + random() * 0.3) * speciesScale;
          bucket.fallenLogMatrices.push(Matrix.Compose(
            new Vector3(thicknessScale, lengthScale, thicknessScale),
            new Vector3(0, logYaw, Math.PI / 2 + (random() - 0.5) * 0.08).toQuaternion(),
            new Vector3(
              logX + positionOffset.x,
              (logElevation + 0.14) / metersPerUnit + positionOffset.y,
              logZ + positionOffset.z,
            ),
          ));
        }
      }
      await yieldControl?.();
    }
  }

  variantBuckets = consolidateTreeVariantBuckets(variantBuckets);

  // Only species that placement actually encountered in this lon/lat tile get
  // model geometry and an impostor capture. This avoids global up-front atlases.
  const resources: Array<{
    bucket: TreeVariantBucket;
    prototype: ImpostorPrototype;
    modelMeshes: Mesh[];
    fallenLogModel?: Mesh;
  }> = [];
  // Impostor capture temporarily installs an orthographic scene camera. Capture
  // species one at a time so each pass restores the real gameplay camera.
  for (const bucket of variantBuckets.values()) {
    const { species, variant } = bucket;
    const suffix = `${species}-${variant.key.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
    const prototype = await createTreeImpostorPrototype(
      scene,
      treeHeight,
      `${prototypeNamePrefix}-${suffix}`,
      species,
      variant,
      impostorCaptureMode === "cooperative",
    );
    prototype.root.parent = root;
    if (prototype.mesh.material instanceof ShaderMaterial) {
      prototype.mesh.material.setFloat("forceLowestLod", forceLowestImpostorLod ? 1 : 0);
    }
    const modelMeshes = includeModels
      ? await createTreeModels(scene, treeHeight, species, variant.seed, variant.season)
      : [];
    // Trees move with the same wind field as their impostors, but at a much
    // smaller amplitude so the canopy breathes without making trunks wobble.
    setVegetationWindShear(modelMeshes, windShearFraction("tree"));
    modelMeshes.forEach((mesh) => { mesh.parent = prototype.root; });
    const fallenLogModel = bucket.fallenLogMatrices.length > 0
      ? await createTreeLogModel(scene, treeHeight, species, variant.seed, variant.season)
      : undefined;
    if (fallenLogModel) fallenLogModel.parent = prototype.root;
    const modelMaterials = new Set(
      [...modelMeshes, ...(fallenLogModel ? [fallenLogModel] : [])]
        .map((mesh) => mesh.material).filter((material) => material !== null),
    );
    prototype.root.onDisposeObservable.add(() => {
      modelMaterials.forEach((material) => material.dispose(true, false));
    });
    resources.push({ bucket, prototype, modelMeshes, fallenLogModel });
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  const fields: VegetationFieldResult[] = [];
  for (const { bucket, prototype, modelMeshes, fallenLogModel } of resources) {
    const ownMatrices = await packInstanceMatrices(bucket.matrices, yieldControl);
    const field = await createVegetationFieldResult(
      prototype.root,
      [prototype.mesh],
      modelMeshes,
      ownMatrices,
      metersPerUnit,
      renderMode,
      undefined,
      yieldControl,
    );
    field.shadowCasterMeshes.push(...createTreeShadowCasters(
      scene,
      prototype.root,
      prototype.mesh,
      ownMatrices,
      bucket.species,
    ));
    fields.push(field);
    if (fallenLogModel) {
      const logMatrices = await packInstanceMatrices(bucket.fallenLogMatrices, yieldControl);
      const logField = await createVegetationFieldResult(
        prototype.root,
        [],
        [fallenLogModel],
        logMatrices,
        metersPerUnit,
        "auto",
        undefined,
        yieldControl,
      );
      // Deadfall has no impostor side. It follows the normal detail distance
      // but remains independent of the standing trees' selected render mode.
      logField.count = 0;
      logField.setRenderMode = () => undefined;
      fields.push(logField);
    }
    await yieldControl?.();
  }
  return combineVegetationFieldResults(root, fields, matrixData);
}

/**
 * Prevents tiny blend tails and low-probability biome species from each
 * allocating a complete atlas. Matrices are retained and folded into the
 * dominant compatible bucket, so consolidation never removes vegetation.
 */
function consolidateTreeVariantBuckets(
  buckets: ReadonlyMap<string, TreeVariantBucket>,
): Map<string, TreeVariantBucket> {
  if (buckets.size <= 1) return new Map(buckets);

  const variants = new Map<string, { variant: TreeImpostorVariant; count: number }>();
  let total = 0;
  for (const bucket of buckets.values()) {
    total += bucket.matrices.length;
    const existing = variants.get(bucket.variant.key);
    if (existing) existing.count += bucket.matrices.length;
    else variants.set(bucket.variant.key, {
      variant: bucket.variant,
      count: bucket.matrices.length,
    });
  }
  const dominantVariant = [...variants.values()].reduce((left, right) => (
    right.count > left.count ? right : left
  ));
  const retainedVariants = new Set(
    [...variants.entries()]
      .filter(([, value]) => value.count / total >= MIN_TREE_VARIANT_SHARE)
      .map(([key]) => key),
  );
  retainedVariants.add(dominantVariant.variant.key);

  const remapped = new Map<string, TreeVariantBucket>();
  for (const bucket of buckets.values()) {
    const variant = retainedVariants.has(bucket.variant.key)
      ? bucket.variant
      : dominantVariant.variant;
    const key = `${bucket.species}:${variant.key}`;
    const target = remapped.get(key);
    if (target) {
      target.matrices.push(...bucket.matrices);
      target.fallenLogMatrices.push(...bucket.fallenLogMatrices);
    } else {
      remapped.set(key, {
        species: bucket.species,
        variant,
        matrices: [...bucket.matrices],
        fallenLogMatrices: [...bucket.fallenLogMatrices],
      });
    }
  }

  const byVariant = new Map<string, TreeVariantBucket[]>();
  for (const bucket of remapped.values()) {
    const group = byVariant.get(bucket.variant.key);
    if (group) group.push(bucket);
    else byVariant.set(bucket.variant.key, [bucket]);
  }
  const consolidated = new Map<string, TreeVariantBucket>();
  for (const group of byVariant.values()) {
    group.sort((left, right) => right.matrices.length - left.matrices.length);
    const retained = group.slice(0, MAX_TREE_SPECIES_PER_VARIANT);
    for (let index = MAX_TREE_SPECIES_PER_VARIANT; index < group.length; index++) {
      retained[0].matrices.push(...group[index].matrices);
      retained[0].fallenLogMatrices.push(...group[index].fallenLogMatrices);
    }
    for (const bucket of retained) {
      consolidated.set(`${bucket.species}:${bucket.variant.key}`, bucket);
    }
  }
  return consolidated;
}

/**
 * Reuses the inexpensive impostor geometry for stable tree shadow depth passes.
 * The impostor material's shadow wrapper selects the sun-facing atlas view and
 * preserves its alpha silhouette. An independent all-tree instance buffer keeps
 * shadows across the detail ring without submitting full procedural tree models.
 */
function createTreeShadowCasters(
  scene: Scene,
  root: TransformNode,
  source: Mesh,
  matrices: Float32Array,
  species: TreeSpecies,
): Mesh[] {
  if (source.getTotalVertices() === 0 || matrices.length === 0) return [];

  // Extracting gives the caster independent geometry and instance bindings;
  // sharing a geometry would let its fixed buffers overwrite visible LOD data.
  const caster = new Mesh(`treeShadow-${species}`, scene);
  VertexData.ExtractFromMesh(source, true, true).applyToMesh(caster, true);
  caster.parent = root;
  caster.position.copyFrom(source.position);
  caster.rotation.copyFrom(source.rotation);
  caster.rotationQuaternion = source.rotationQuaternion?.clone() ?? null;
  caster.scaling.copyFrom(source.scaling);
  caster.material = source.material;
  caster.isPickable = false;
  caster.receiveShadows = false;
  caster.metadata = { ...(caster.metadata ?? {}), shadowOnly: true };
  caster.isVisible = false;
  caster.thinInstanceSetBuffer("matrix", matrices, 16, true);
  caster.thinInstanceSetBuffer(
    "vegetationColor",
    new Float32Array((matrices.length / 16) * 3).fill(1),
    3,
    true,
  );
  // Zero selects the impostor side of the complementary LOD depth mask.
  caster.thinInstanceSetBuffer(
    "instanceLodBlend",
    new Float32Array(matrices.length / 16),
    1,
    true,
  );
  caster.thinInstanceCount = matrices.length / 16;
  caster.thinInstanceRefreshBoundingInfo(true);
  root.onDisposeObservable.addOnce(() => {
    if (!caster.isDisposed()) caster.dispose(false, false);
  });
  return [caster];
}

/** Builds the same fixed cube and material used by every forest instance. */
export async function createTreeImpostorPrototype(
  scene: Scene,
  treeHeight: number,
  rootName = "treeImpostorPrototype",
  species: TreeSpecies = "birch",
  variant?: TreeImpostorVariant,
  cooperativeCapture = true,
): Promise<ImpostorPrototype> {
  const root = new TransformNode(rootName, scene);
  let lease: Awaited<ReturnType<typeof acquireTreeImpostorAssets>> | undefined;
  try {
    lease = variant
      ? await acquireTreeImpostorAssets(scene, species, variant, cooperativeCapture)
      : undefined;
    const assets = lease?.assets ?? await getTreeImpostorAssets(
      scene,
      undefined,
      undefined,
      undefined,
      species,
    );
    const prototype = createImpostorPrototypeFromAssets(
      scene,
      assets,
      treeHeight,
      root,
      rootName,
      { depthProxy: true },
    );
    if (prototype.mesh.material instanceof ShaderMaterial) {
      prototype.mesh.material.setFloat(
        "lowLightAlbedoScale",
        TREE_LOW_LIGHT_BRIGHTNESS[species],
      );
    }
    if (lease) root.onDisposeObservable.addOnce(() => lease?.release());
    return prototype;
  } catch (error) {
    lease?.release();
    root.dispose(false, false);
    throw error;
  }
}

/** Uses broad simplex regions with a finer octave to form soft-edged species groves. */
function sampleTreeSpecies(
  regionalNoise: SimplexNoise2D,
  detailNoise: SimplexNoise2D,
  xMeters: number,
  zMeters: number,
  distribution: TreeDistribution,
  randomValue: number,
): TreeSpecies | undefined {
  const regional = regionalNoise.sample(
    xMeters / TREE_SPECIES_CLUSTER_SIZE_METERS,
    zMeters / TREE_SPECIES_CLUSTER_SIZE_METERS,
  );
  const detail = detailNoise.sample(
    xMeters / (TREE_SPECIES_CLUSTER_SIZE_METERS * 0.38),
    zMeters / (TREE_SPECIES_CLUSTER_SIZE_METERS * 0.38),
  );
  const speciesValue = regional * 0.82 + detail * 0.18;
  // Adding a spatially smooth offset modulo one preserves the requested
  // distribution statistically while encouraging neighboring trees to agree.
  const clusteredRandom = (randomValue + speciesValue * 0.22 + 1) % 1;
  const worldSpecies = sampleWorldTreeSpecies(distribution, clusteredRandom);
  return worldSpecies
    ? distribution.trees.find((tree) => tree.species === worldSpecies)?.proceduralArchetype
    : undefined;
}

/**
 * Resolves a captured source's depth per fragment against an ellipsoid fitted
 * to its capture volume instead of one plane through its center. Worth its
 * dependent texture-free but early-depth-defeating cost on sources tall enough
 * for the flattened plane to read as a card; low ground cover uses the cheaper
 * `impostorDepthPull` instead.
 */
export interface ImpostorDepthOptions {
  depthProxy?: boolean;
}

/** Creates the render mesh and shader material for any captured source. */
export function createImpostorPrototypeFromAssets(
  scene: Scene,
  assets: ImpostorAssets,
  renderHeight: number,
  root: TransformNode,
  name: string,
  depth: ImpostorDepthOptions = {},
): ImpostorPrototype {
  const scale = renderHeight / assets.sourceHeight;
  const captureWidth = assets.captureWidth * scale;
  const captureHeight = assets.captureHeight * scale;
  const captureSize = Math.max(captureWidth, captureHeight);
  const mesh = createImpostorBox(scene, captureWidth, captureHeight, renderHeight / 2, name);
  mesh.parent = root;
  mesh.isPickable = false;

  const material = createImpostorMaterial(
    scene,
    assets,
    renderHeight,
    captureWidth,
    captureHeight,
    `${name}Material`,
    depth,
  );
  root.onDisposeObservable.add(() => material.dispose(false, false));
  mesh.material = material;
  return { root, mesh, assets, captureSize, captureWidth, captureHeight };
}

export function createImpostorMaterial(
  scene: Scene,
  assets: ImpostorAssets,
  renderHeight: number,
  captureWidth: number,
  captureHeight: number,
  name: string,
  depth: ImpostorDepthOptions = {},
): ShaderMaterial {
  const material = new ShaderMaterial(
    name,
    scene,
    { vertexSource: impostorVertexShader, fragmentSource: impostorFragmentShader },
    {
      attributes: ["position", "vegetationColor", "instanceLodBlend"],
      uniforms: ["world", "viewProjection", "cameraPosition", "captureCenterY", "impostorDepthPull", "captureDimensions", "gridDimensions", "atlasTileCounts", "tileInset", "lowTileInset", "impostorLodNear", "impostorLodFar", "forceLowestLod", "cameraOrthographic", "rotationallySymmetric", "rotationalSymmetryOrder", "upperHemisphereOnly", "lowerHemisphereFace", "sunDirection", "sunColor", "skyColor", "groundColor", "lowLightAlbedoScale", "instanceColorCoverage", "fieldFade", "distanceFadeNear", "distanceFadeFar", "groundColorBlend", "distanceGroundBlend", "distanceGroundColor", "impostorAmbientUpward", "impostorColorContrast", "fogColor", "fogStart", "fogEnd", "vegetationShadowMatrix", "vegetationShadowAtInstanceRoot", "vegetationShadowTexelSize", "vegetationShadowDepthValues", "vegetationShadowEnabled", "vegetationShadowReverseDepth", "vegetationShadowDarkness", "vegetationShadowFloatTexture", ...CLOUD_SHADOW_UNIFORMS, ...WIND_PHASE_UNIFORMS, ...WIND_SHEAR_UNIFORMS],
      samplers: ["atlas0", "atlas1", "atlas2", "atlas3", "atlas4", "atlas5", "lowAtlas0", "lowAtlas1", "lowAtlas2", "lowAtlas3", "lowAtlas4", "lowAtlas5", "vegetationShadowSampler", "cloudShadowAtlas"],
      // Writing depth costs the early depth test, so the dense low vegetation
      // that never needed it compiles without the proxy at all.
      defines: depth.depthProxy ? ["#define IMPOSTOR_DEPTH_PROXY"] : [],
      needAlphaBlending: false,
    },
  );
  material.backFaceCulling = true;
  // Preserve atlas alpha and the complementary model/impostor LOD mask in the
  // depth pass, avoiding a solid box shadow around each proxy.
  const shadowDepthWrapper = new ShadowDepthWrapper(material, scene, {
    remappedVariables: ["worldPos", "worldPosition"],
  });
  material.shadowDepthWrapper = shadowDepthWrapper;
  material.onDisposeObservable.addOnce(() => shadowDepthWrapper.dispose());
  bindVegetationShadowReceiver(material, scene);
  bindCloudShadowReceiver(material, scene);
  material.setFloat("captureCenterY", renderHeight / 2);
  material.setFloat("impostorDepthPull", 0);
  material.setVector2("captureDimensions", new Vector2(captureWidth, captureHeight));
  material.setVector2("gridDimensions", new Vector2(assets.gridWidth, assets.gridHeight));
  material.setVector2("atlasTileCounts", new Vector2(assets.gridWidth, assets.gridHeight));
  material.setVector2("tileInset", new Vector2(
    0.5 / assets.resolutionWidth,
    0.5 / assets.resolutionHeight,
  ));
  material.setVector2("lowTileInset", new Vector2(
    0.5 / assets.lowResolutionWidth,
    0.5 / assets.lowResolutionHeight,
  ));
  // Distances are multiples of the impostor's capture height, so the same
  // range holds for any scene scale. Begin the distant tier close enough to
  // cover most of the local forest.
  material.setFloat("impostorLodNear", 10);
  material.setFloat("impostorLodFar", 25);
  material.setFloat("forceLowestLod", 0);
  material.setFloat("cameraOrthographic", 0);
  material.setFloat("rotationallySymmetric", assets.rotationallySymmetric ? 1 : 0);
  material.setFloat("rotationalSymmetryOrder", assets.rotationalSymmetryOrder);
  material.setFloat("upperHemisphereOnly", assets.upperHemisphereOnly ? 1 : 0);
  material.setFloat("lowerHemisphereFace", assets.textures.length > 5 ? 1 : 0);
  material.setFloat("lowLightAlbedoScale", 1);
  material.setFloat("instanceColorCoverage", 0);
    setWindShear(material, windShearFraction("tree"));
  material.setFloat("fieldFade", 1);
  material.setFloat("distanceFadeNear", 1e6);
  material.setFloat("distanceFadeFar", 1e6 + 1);
  material.setFloat("groundColorBlend", 0);
  material.setFloat("distanceGroundBlend", 0);
  material.setColor3("distanceGroundColor", Color3.White());
  material.setFloat("impostorAmbientUpward", 1);
  material.setFloat("impostorColorContrast", 1);
  for (let index = 0; index < 6; index++) {
    material.setTexture(`atlas${index}`, assets.textures[Math.min(index, assets.textures.length - 1)]);
    material.setTexture(
      `lowAtlas${index}`,
      assets.lowResolutionTextures[Math.min(index, assets.lowResolutionTextures.length - 1)],
    );
  }
  const fallbackSky = new Color3(0.38, 0.42, 0.48);
  const fallbackGround = new Color3(0.08, 0.09, 0.07);
  material.onBindObservable.add(() => {
    bindWindPhase(material);
    material.setFloat(
      "cameraOrthographic",
      scene.activeCamera?.mode === Camera.ORTHOGRAPHIC_CAMERA ? 1 : 0,
    );
    const sun = scene.lights.find((light): light is DirectionalLight => (
      light instanceof DirectionalLight && light.name === "sunLight"
    ));
    const ambient = scene.lights.find((light): light is HemisphericLight => (
      light instanceof HemisphericLight && light.name === "skyAmbientLight"
    ));
    material.setVector3(
      "sunDirection",
      sun?.isEnabled() ? sun.direction.scale(-1).normalize() : Vector3.Up(),
    );
    material.setColor3(
      "sunColor",
      sun?.isEnabled() ? sun.diffuse.scale(sun.intensity) : Color3.Black(),
    );
    material.setColor3(
      "skyColor",
      ambient ? ambient.diffuse.scale(ambient.intensity) : fallbackSky,
    );
    material.setColor3(
      "groundColor",
      ambient ? ambient.groundColor.scale(ambient.intensity) : fallbackGround,
    );
    const fogEnabled = scene.fogMode === Scene.FOGMODE_LINEAR;
    material.setColor3("fogColor", scene.fogColor);
    material.setFloat("fogStart", fogEnabled ? scene.fogStart : 1e19);
    material.setFloat("fogEnd", fogEnabled ? scene.fogEnd : 2e19);
  });
  return material;
}

function createImpostorBox(
  scene: Scene,
  width: number,
  height: number,
  centerY: number,
  name = "treeImpostors",
): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  TREE_IMPOSTOR_FACES.forEach((face, faceIndex) => {
    const normalExtent = Math.abs(face.normal.y) > 0.5 ? halfHeight : halfWidth;
    const rightExtent = halfWidth;
    const upExtent = Math.abs(face.up.y) > 0.5 ? halfHeight : halfWidth;
    const faceCenter = face.normal.scale(normalExtent).add(new Vector3(0, centerY, 0));
    const corners = [
      faceCenter.subtract(face.right.scale(rightExtent)).subtract(face.up.scale(upExtent)),
      faceCenter.add(face.right.scale(rightExtent)).subtract(face.up.scale(upExtent)),
      faceCenter.add(face.right.scale(rightExtent)).add(face.up.scale(upExtent)),
      faceCenter.subtract(face.right.scale(rightExtent)).add(face.up.scale(upExtent)),
    ];
    for (const corner of corners) {
      positions.push(corner.x, corner.y, corner.z);
      normals.push(face.normal.x, face.normal.y, face.normal.z);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    const vertex = faceIndex * 4;
    indices.push(vertex, vertex + 2, vertex + 1, vertex, vertex + 3, vertex + 2);
  });

  const tree = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  data.applyToMesh(tree);
  return tree;
}

function distanceInsideMask(
  mask: Uint8Array,
  width: number,
  height: number,
  horizontalStep: number,
  verticalStep: number,
): Float32Array {
  const distance = new Float32Array(mask.length);
  const diagonalStep = Math.hypot(horizontalStep, verticalStep);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      // A tile boundary is not a forest boundary, so edge cells remain open.
      distance[index] = mask[index] ? Infinity : 0;
    }
  }

  distancePass(distance, width, height, horizontalStep, verticalStep, diagonalStep, false);
  distancePass(distance, width, height, horizontalStep, verticalStep, diagonalStep, true);
  return distance;
}

function distancePass(
  distance: Float32Array,
  width: number,
  height: number,
  horizontalStep: number,
  verticalStep: number,
  diagonalStep: number,
  reverse: boolean,
): void {
  for (let row = 0; row < height; row++) {
    const y = reverse ? height - 1 - row : row;
    for (let column = 0; column < width; column++) {
      const x = reverse ? width - 1 - column : column;
      const index = y * width + x;
      const horizontal = x + (reverse ? 1 : -1);
      const vertical = y + (reverse ? 1 : -1);

      if (horizontal >= 0 && horizontal < width) {
        distance[index] = Math.min(distance[index], distance[y * width + horizontal] + horizontalStep);
      }
      if (vertical >= 0 && vertical < height) {
        distance[index] = Math.min(distance[index], distance[vertical * width + x] + verticalStep);
        if (horizontal >= 0 && horizontal < width) {
          distance[index] = Math.min(distance[index], distance[vertical * width + horizontal] + diagonalStep);
        }
        const otherHorizontal = x + (reverse ? -1 : 1);
        if (otherHorizontal >= 0 && otherHorizontal < width) {
          distance[index] = Math.min(
            distance[index],
            distance[vertical * width + otherHorizontal] + diagonalStep,
          );
        }
      }
    }
  }
}
