import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isFloatShadowTexture,
  unpackVegetationShadowDepth,
  VEGETATION_SHADOW_RECEIVER_BIAS,
  vegetationShadowVisibilityFromSamples,
} from "../src/VegetationShadowReceiver.ts";

const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const layerFades = readFileSync(new URL("../src/LayerFades.ts", import.meta.url), "utf8");
const impostors = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
const models = readFileSync(
  new URL("../src/procedural/ProceduralCaptureMaterial.ts", import.meta.url),
  "utf8",
);
const receivers = readFileSync(
  new URL("../src/VegetationShadowReceiver.ts", import.meta.url),
  "utf8",
);
const cloudReceivers = readFileSync(
  new URL("../src/CloudShadows.ts", import.meta.url),
  "utf8",
);
const solarLighting = readFileSync(
  new URL("../src/SolarLighting.ts", import.meta.url),
  "utf8",
);
const grass = readFileSync(new URL("../src/GrassField.ts", import.meta.url), "utf8");

test("keeps low vegetation out of the tree and sapling shadow-caster list", () => {
  assert.match(
    game,
    /filter\(\(kind\) => kind === "treeField" \|\| kind === "saplingField"\)/,
  );
  assert.match(game, /field\.shadowCasterMeshes : field\.meshes/);
  assert.match(game, /setShadowCasters\(casters\)/);
});

test("roads and waterways receive shadows without casting ground streaks", () => {
  assert.match(game, /for \(const mesh of mapMeshes\) mesh\.receiveShadows = true/);
  assert.match(game, /mesh\.metadata\?\.buildingShadowCaster === true/);
});

test("buildings cast stable opaque geometry without proximity-fading windows", () => {
  const buildings = readFileSync(
    new URL("../src/procedural/BuildingRendererCompiler.ts", import.meta.url),
    "utf8",
  );
  assert.match(buildings, /function createBuildingShadowCaster\(/);
  assert.match(buildings, /const shadowRanges: BuildingShadowRange\[\] = indices\.length > 0/);
  assert.match(buildings, /indexCount: indices\.length/);
  assert.match(buildings, /transparencyMode = Material\.MATERIAL_OPAQUE/);
  assert.match(buildings, /buildingShadowCaster: true, shadowOnly: true/);
});

test("WebGPU terrain receives building shadows without self-shadow acne", () => {
  assert.match(game, /record\.terrain\.receiveShadows = true/);
  assert.match(game, /if \(!this\.engine\.isWebGPU\) casters\.push\(record\.terrain\)/);
  assert.match(game, /this\.solarLighting\?\.setShadowCasters\(casters\)/);
  assert.doesNotMatch(game, /if \(casters\.length > 0\) this\.solarLighting/);
});

test("trees cast through dedicated impostor shadow geometry at every renderer", () => {
  assert.match(impostors, /function createTreeShadowCasters/);
  assert.match(impostors, /const caster = new Mesh\(`treeShadow-/);
  assert.match(impostors, /VertexData\.ExtractFromMesh\(source, true, true\)/);
  assert.doesNotMatch(impostors, /source\.geometry\.applyToMesh\(caster\)/);
  assert.match(impostors, /thinInstanceSetBuffer\("matrix", matrices, 16, true\)/);
  assert.match(impostors, /"instanceLodBlend",[\s\S]*?new Float32Array\(matrices\.length \/ 16\)/);
  assert.match(impostors, /shadowOnly: true/);
  assert.match(solarLighting, /shadowMap\?\.onBeforeRenderObservable\.add/);
  assert.match(solarLighting, /shadowMap\?\.onAfterRenderObservable\.add/);
  assert.doesNotMatch(impostors, /getEngine\(\)\.isWebGPU \|\| modelMeshes\.length/);
  assert.match(
    game,
    /field\.shadowCasterMeshes\.length > 0 \? field\.shadowCasterMeshes : field\.meshes/,
  );
});

test("medium-range tree shadows use the full field instead of visual LOD buffers", () => {
  assert.match(impostors, /createTreeShadowCasters\([\s\S]*?ownMatrices/);
  assert.match(impostors, /thinInstanceSetBuffer\("matrix", matrices, 16, true\)/);
  const shadowRefresh = game.slice(
    game.indexOf("private refreshShadowCasters"),
    game.indexOf("private enableWaterReflections"),
  );
  assert.doesNotMatch(shadowRefresh, /modelMeshes|impostorMeshes|modelRangeMeters/);
});

test("staged vegetation rebuilds the expensive shadow caster list only once", () => {
  const stage = game.slice(
    game.indexOf("private stageTileField"),
    game.indexOf("private async activateTileVegetation"),
  );
  const activation = game.slice(
    game.indexOf("private async activateTileVegetation"),
    game.indexOf("private refreshShadowCasters"),
  );
  assert.doesNotMatch(stage, /refreshShadowCasters/);
  assert.equal(activation.match(/this\.refreshShadowCasters\(\)/g)?.length, 1);
});

test("keeps foliage alpha and LOD masks in model and impostor shadow passes", () => {
  assert.match(models, /new ShadowDepthWrapper\(material, scene/);
  assert.match(models, /if \(leafSample\.a < 0\.5\) discard/);
  assert.match(models, /vInstanceLodBlend <= bayer4/);
  assert.match(impostors, /new ShadowDepthWrapper\(material, scene/);
  assert.match(impostors, /vInstanceLodBlend > bayer4/);
  assert.match(impostors, /#if SM_DIRECTIONINLIGHTDATA == 1\s+vec3 direction = normalize\(vLocalSunDirection\)/);
});

test("softens dense impostor canopies only while writing shadow depth", () => {
  assert.match(
    impostors,
    /#if SM_DIRECTIONINLIGHTDATA == 1[\s\S]*?vec2 shadowTexel = tileInset \* 2\.5/,
  );
  assert.match(impostors, /float softShadowAlpha = color\.a \* 0\.5/);
  assert.match(impostors, /color\.a = clamp\(softShadowAlpha \* 0\.9 - 0\.02, 0\.0, 1\.0\)/);
  assert.match(impostors, /float alphaChoice = bayer8\(gl_FragCoord\.xy/);
  assert.match(
    impostors,
    /#else\s+float alphaChoice = bayer4\(gl_FragCoord\.xy/,
  );
});

test("does not rerender the static shadow map for camera-relative LOD changes", () => {
  const lodUpdate = game.slice(
    game.indexOf("private updateVegetationLod"),
    game.indexOf("private logVegetationLodStats"),
  );
  assert.doesNotMatch(lodUpdate, /refreshShadows\(\)/);
});

test("settles streamed shadows without rerendering the framebuffer every fade frame", () => {
  assert.match(layerFades, /if \(refreshShadows\) this\.options\.refreshShadowsDuringFade\(\)/);
  assert.match(game, /refreshShadowsDuringFade: \(\) => undefined/);
  assert.match(layerFades, /this\.options\.refreshShadows\(\)/);
});

test("grass models and impostors share terrain-root shadow sampling", () => {
  assert.match(impostors, /vegetationShadowAtInstanceRoot/);
  assert.match(models, /vegetationShadowAtInstanceRoot/);
  assert.match(impostors, /finalWorld \* vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/);
  assert.match(models, /finalWorld \* vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/);
});

test("shadowed grass retains enough fill to sit on the shaded terrain", () => {
  assert.match(grass, /const GRASS_SHADOW_DARKNESS = 0\.3/);
  const shadowFloorAssignments = grass.match(
    /setFloat\("vegetationShadowDarkness", GRASS_SHADOW_DARKNESS\)/g,
  ) ?? [];
  assert.equal(shadowFloorAssignments.length, 2);
});

test("shadows custom vegetation direct light while preserving ambient light", () => {
  for (const shader of [impostors, models]) {
    assert.match(shader, /float shadowVisibility = vegetationShadowVisibility\(\)/);
    assert.match(
      shader,
      /ambientColor \+ sunColor \* \(0\.16 \+ direct \* 0\.62\) \* shadowVisibility/,
    );
    assert.doesNotMatch(shader, /lighting \*= vegetationShadowVisibility\(\)/);
  }
  assert.match(receivers, /uniform sampler2D vegetationShadowSampler/);
  assert.doesNotMatch(receivers, /sampler2DShadow/);
  assert.match(receivers, /visibility \/= 9\.0/);
  assert.match(receivers, /SM_DIRECTIONINLIGHTDATA == 1/);
  assert.match(
    receivers,
    /#if SM_DIRECTIONINLIGHTDATA == 1[\s\S]*?#else[\s\S]*?uniform sampler2D vegetationShadowSampler/,
  );
  assert.match(receivers, /scene\.onBeforeRenderObservable\.add\(updateShadowUniforms\)/);
  assert.doesNotMatch(receivers, /material\.onBindObservable\.add/);
});

test("detaches vegetation shadow samplers while rendering their framebuffer", () => {
  assert.match(receivers, /export function suspendVegetationShadowReceivers/);
  assert.match(
    receivers,
    /setTexture\("vegetationShadowSampler", fallback\)/,
  );
  assert.match(receivers, /engine\.unbindAllTextures\(\)/);
  assert.doesNotMatch(receivers, /_boundTexturesCache/);
  assert.match(receivers, /scene\.resetCachedMaterial\(\)/);
  assert.match(receivers, /export function resumeVegetationShadowReceivers/);
  assert.match(
    solarLighting,
    /shadowMap\?\.onBeforeBindObservable\.add\([\s\S]*?suspendVegetationShadowReceivers\(scene, shadowMap\)/,
  );
  assert.match(
    solarLighting,
    /shadowMap\?\.onAfterUnbindObservable\.add\([\s\S]*?resumeVegetationShadowReceivers\(scene\)/,
  );
});

test("cloud footprints shadow both vegetation models and impostors", () => {
  for (const shader of [impostors, models]) {
    assert.match(shader, /cloudShadowVertexDeclaration/);
    assert.match(shader, /cloudShadowFragmentDeclaration/);
    assert.match(shader, /vCloudShadowWorldXZ = instanceOrigin\.xz/);
    assert.match(shader, /bindCloudShadowReceiver\(material, scene\)/);
  }
  assert.match(impostors, /lighting \*= vegetationCloudShadowVisibility\(\)/);
  assert.match(
    models,
    /lighting \*= mix\(1\.0, vegetationCloudShadowVisibility\(\), lightingEnabled\)/,
  );
  assert.match(cloudReceivers, /uniform sampler2D cloudShadowAtlas/);
  assert.match(
    cloudReceivers,
    /#if SM_DIRECTIONINLIGHTDATA == 1[\s\S]*?#else[\s\S]*?uniform sampler2D cloudShadowAtlas/,
  );
  assert.match(cloudReceivers, /CLOUD_SHADOW_DARKNESS = 0\.22/);
  assert.match(
    cloudReceivers,
    /coverage \* cloudShadowLighting\.x \* \$\{CLOUD_SHADOW_DARKNESS\}/,
  );
  assert.match(cloudReceivers, /material\.setTexture\("cloudShadowAtlas", texture\)/);
});

test("unpacks Babylon's unsigned-byte fallback before comparing grass shadows", () => {
  // Babylon's pack() stores the most significant depth component in alpha.
  // This sample represents 0.625 plus successively smaller packed components.
  const packed = [0.25, 0.5, 0.75, 0.625];
  const expected = 0.625 + 0.75 / 255 + 0.5 / (255 ** 2) + 0.25 / (255 ** 3);
  assert.ok(Math.abs(unpackVegetationShadowDepth(packed) - expected) < 1e-12);
  assert.equal(isFloatShadowTexture(0), false);
  assert.equal(isFloatShadowTexture(1), true);
  assert.equal(isFloatShadowTexture(2), true);
  assert.match(receivers, /mix\(packedDepth, shadowSample\.r, vegetationShadowFloatTexture\)/);
});

test("packed caster depth visibly darkens grass receiver samples", () => {
  const shadowedSamples = Array.from({ length: 9 }, () => [0, 0, 0, 0.4]);
  const litSamples = Array.from({ length: 9 }, () => [0, 0, 0, 0.9]);
  assert.equal(
    vegetationShadowVisibilityFromSamples(0.7, shadowedSamples, false, 0.3),
    0.3,
  );
  assert.equal(
    vegetationShadowVisibilityFromSamples(0.7, litSamples, false, 0.3),
    1,
  );
});

test("non-grazing shallow depth separation still shadows grass", () => {
  assert.match(solarLighting, /directLight\.autoCalcShadowZBounds = true/);
  const receiverDepth = 0.5;
  const casterDepth = receiverDepth - VEGETATION_SHADOW_RECEIVER_BIAS * 2;
  const samples = Array.from({ length: 9 }, () => [casterDepth, 0, 0, 1]);
  assert.equal(
    vegetationShadowVisibilityFromSamples(receiverDepth, samples, true, 0.3),
    0.3,
  );
});

test("scene changes invalidate cached directional shadow bounds", () => {
  const setCasters = solarLighting.slice(
    solarLighting.indexOf("setShadowCasters"),
    solarLighting.indexOf("private update(date"),
  );
  assert.match(setCasters, /directLight\.forceProjectionMatrixCompute\(\)/);
  assert.match(solarLighting, /directLight\.autoUpdateExtends = true/);
});
