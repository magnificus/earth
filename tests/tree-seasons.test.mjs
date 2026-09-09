import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { treeSeasonAt, treeSeasonProgressAt } = await import("../src/TreeSeason.ts");

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("temperate deciduous seasons follow the calendar and hemisphere", () => {
  const august = new Date(2026, 7, 23);
  const northern = treeSeasonAt(august, 59, "birch");
  const southern = treeSeasonAt(august, -41, "birch");

  assert.equal(northern.season, "summer");
  assert.equal(northern.leafCoverage, 1);
  assert.equal(southern.season, "winter");
  assert.ok(southern.leafCoverage < 0.1);
});

test("autumn colors and spring crown density are resolved per species", () => {
  const autumnMaple = treeSeasonAt(new Date(2026, 9, 1), 52, "maple");
  const springOak = treeSeasonAt(new Date(2026, 3, 1), 52, "oak");

  assert.equal(autumnMaple.season, "autumn");
  assert.ok(autumnMaple.foliageTint[0] > 1.4);
  assert.ok(autumnMaple.foliageTint[1] < 0.7);
  assert.equal(springOak.season, "spring");
  assert.ok(springOak.leafCoverage > 0.5 && springOak.leafCoverage < 0.7);
});

test("tropical and evergreen trees retain their crowns", () => {
  const tropicalOak = treeSeasonAt(new Date(2026, 0, 15), 8, "oak");
  const winterPine = treeSeasonAt(new Date(2026, 0, 15), 60, "pine");

  assert.equal(tropicalOak.key, "tropical");
  assert.equal(tropicalOak.leafCoverage, 1);
  assert.equal(winterPine.season, "winter");
  assert.equal(winterPine.leafCoverage, 1);
});

test("autumn colour spreads through the season instead of arriving at once", () => {
  assert.equal(treeSeasonProgressAt(new Date(2026, 8, 1), 52), 0);
  const early = treeSeasonProgressAt(new Date(2026, 8, 15), 52);
  const middle = treeSeasonProgressAt(new Date(2026, 9, 5), 52);
  assert.ok(early > 0.15 && early < 0.35, `early ${early}`);
  assert.ok(middle > 0.5 && middle < 0.7, `middle ${middle}`);
  assert.equal(treeSeasonProgressAt(new Date(2026, 10, 20), 52), 1);
  assert.equal(treeSeasonProgressAt(new Date(2026, 6, 10), 52), 0);
  assert.equal(treeSeasonProgressAt(new Date(2026, 0, 10), 52), 1);
  // Southern autumn starts in March.
  assert.equal(treeSeasonProgressAt(new Date(2026, 2, 1), -40), 0);
  assert.ok(treeSeasonProgressAt(new Date(2026, 3, 1), -40) > 0.4);
  assert.equal(treeSeasonProgressAt(undefined, 52), 0);
});

test("spring's fresh flush fades back toward summer green", () => {
  assert.equal(treeSeasonProgressAt(new Date(2026, 2, 1), 52), 1);
  const late = treeSeasonProgressAt(new Date(2026, 4, 5), 52);
  assert.ok(late > 0.05 && late < 0.25, `late spring ${late}`);
});

test("seasonal colour is applied live rather than baked into models or atlases", () => {
  const proceduralTree = source("../src/procedural/ProceduralTree.ts");
  const captureMaterial = source("../src/procedural/ProceduralCaptureMaterial.ts");
  const impostor = source("../src/Impostor.ts");
  const treeImpostor = source("../src/TreeImpostor.ts");
  const field = source("../src/TreeField.ts");
  const seasonal = source("../src/SeasonalFoliage.ts");

  // Geometry carries a per-leaf phase; vertex colours are no longer tinted.
  assert.match(proceduralTree, /bakeFoliageSeasonPhase\(branchBuffers, options\.seed \?\? 0\)/);
  assert.doesNotMatch(proceduralTree, /buffers\.colors\[color\] \* season\.foliageTint/);
  // The capture material exports the phase and foliage mask as a data band
  // and tints live geometry from it.
  assert.match(captureMaterial, /exposureCaptureBand > 2\.5[\s\S]*?vec4\(vColor\.a, foliageMask, 0\.0, 1\.0\)/);
  assert.match(captureMaterial, /seasonFoliageColor\(surfaceColor, vColor\.a, foliageMask\)/);
  // Tree atlases capture that band and the impostor shader samples it.
  assert.match(treeImpostor, /seasonalFoliage: true/);
  assert.match(impostor, /assets\.seasonPhaseTexture\] = await captureDataBandAtlases\(scene, captureOptions, "season-phase", \[SEASON_PHASE_CAPTURE_BAND\]\)/);
  assert.match(field, /#define SEASONAL_FOLIAGE/);
  assert.match(field, /texture2D\(seasonPhaseAtlas, dataAtlasUV\(face, selectedTile, imageUV\)\)\.rg/);
  // Every instance derives its own timing and tint depth from where it stands.
  assert.match(seasonal, /seasonInstanceProgress\(vec3 origin\)/);
  assert.match(seasonal, /seasonInstanceTint\(vec3 origin\)/);
  assert.match(field, /vSeasonProgress = seasonInstanceProgress\(instanceOrigin\)/);
  assert.match(captureMaterial, /vSeasonProgress = seasonInstanceProgress\(instanceOrigin\)/);
});

test("tree models and impostors receive one shared seasonal variant and its live tint", () => {
  const field = source("../src/TreeField.ts");
  const impostor = source("../src/TreeImpostor.ts");
  const game = source("../src/Game.ts");

  assert.match(field, /key: `\$\{tileRegion\.key\}\/local\/\$\{tileLocalVariant\}\/season\/\$\{season\.key\}`/);
  assert.match(field, /createTreeModels\([\s\S]*?variant\.season/);
  assert.match(impostor, /season: treeVariant\.season/);
  assert.match(field, /setSeasonalFoliage\(material, foliageTint, seasonProgress\)/);
  assert.match(game, /setTreeFieldSeasonProgress\(field, date, latitude\)/);
});
