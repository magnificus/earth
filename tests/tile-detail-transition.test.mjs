import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const treeField = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");

test("loads fast stand-ins across the core before revealing a location", () => {
  assert.match(
    game,
    /const coreTiles:[\s\S]*?detailWindow\.minimumY[\s\S]*?detailWindow\.maximumY[\s\S]*?detailWindow\.minimumX[\s\S]*?detailWindow\.maximumX/,
  );
  assert.match(game, /coreTiles\.sort\(\(a, b\) => a\.distanceSquared - b\.distanceSquared\)/);
  assert.match(
    game,
    /for \(let index = 0; index < coreTileCount; index\+\+\)[\s\S]*?await this\.streamTile\([\s\S]*?item\.id,[\s\S]*?index === 0,[\s\S]*?tileProgress,[\s\S]*?index === 0[\s\S]*?true/,
  );
  assert.match(
    game,
    /if \(standInsOnly\)[\s\S]*?buildFarTrees\(record, generation, onProgress \? "fast" : "cooperative"\)/,
  );
});

test("does not let the player enter a bare terrain tile before its impostors are ready", () => {
  assert.match(game, /isScenePositionLoaded: \(x, z\) => this\.isScenePositionReady\(x, z\)/);
  assert.match(
    game,
    /private isScenePositionReady[\s\S]*?record\.detailed \|\| record\.farTreeField !== undefined/,
  );
});

test("keeps far-tree impostors visible through the native terrain upgrade", () => {
  assert.match(
    game,
    /const carriedFarTreeField = previous\?\.farTreeField;[\s\S]*?if \(previous\) \{[\s\S]*?previous\.farTreeField = undefined;/,
  );
  assert.match(game, /farTreeField: carriedFarTreeField,/);
});

test("applies the mapped vegetation exclusions to distant trees", () => {
  const farTreeBuild = game.slice(
    game.indexOf("private async buildFarTrees"),
    game.indexOf("private async buildFarBuildings"),
  );
  assert.match(farTreeBuild, /OpenStreetMap\.createVegetationExclusionMask\(/);
  assert.match(farTreeBuild, /createTreeField[\s\S]*?exclusionMask,/);
});

test("renders forced far-tree impostors with detailed dithered coverage", () => {
  const farTreeBuild = game.slice(
    game.indexOf("private async buildFarTrees"),
    game.indexOf("private async buildFarBuildings"),
  );
  assert.match(farTreeBuild, /forceLowestImpostorLod: true/);
  assert.match(treeField, /float lodBlend = max\(\s*forceLowestLod,/);
  assert.match(treeField, /float alpha = highColor\.a/);
  assert.doesNotMatch(
    treeField,
    /if \(forceLowestLod > 0\.5\)[\s\S]*?return lowColor/,
  );
});

test("keeps far building massing visible through the native terrain upgrade", () => {
  assert.match(game, /const carriedFarBuildings = previous\?\.farBuildings;/);
  assert.match(game, /farBuildings: carriedFarBuildings,/);
  assert.match(
    game,
    /record\.mapFeatures = mapFeatures\.root;[\s\S]*?record\.farBuildings = undefined;[\s\S]*?setMapLayerFade\(farBuildings, fade\)/,
  );
});

test("keeps far roads visible through native upgrades and detail transitions", () => {
  assert.match(game, /const carriedFarRoads = previous\?\.farRoads;/);
  assert.match(game, /farRoads: carriedFarRoads,/);
  assert.match(
    game,
    /record\.mapFeatures = mapFeatures\.root;[\s\S]*?record\.farRoads = undefined;[\s\S]*?setMapLayerFade\(farRoads, fade\)/,
  );
  assert.match(
    game,
    /const farRoads = record\.farRoads;[\s\S]*?farRoads\.setEnabled\(true\);[\s\S]*?setMapLayerFade\(farRoads, fade\)/,
  );
});

test("prebuilds every distant stand-in before demoting tile detail", () => {
  assert.match(game, /record\.farTreeField && record\.farBuildings && record\.farRoads/);
  assert.match(game, /\(!record\.farTreeField \|\| !record\.farBuildings \|\| !record\.farRoads\)/);
  assert.match(
    game,
    /const farBuildings = record\.farBuildings;[\s\S]*?farBuildings\.setEnabled\(true\);[\s\S]*?setMapLayerFade\(farBuildings, fade\)/,
  );
});

test("cross-fades all detailed vegetation with the retained tree impostors", () => {
  assert.match(
    game,
    /this\.stageTileField\(record, "fernField", fernField, generation\)[\s\S]*?this\.activateTileVegetation\(record, generation\);/,
  );
  assert.match(
    game,
    /private async activateTileVegetation[\s\S]*?this\.layerFades\.begin\(0, 1, \(fade\) => \{[\s\S]*?field\.setFade\(fade\);[\s\S]*?farTrees\.setFade\(1 - fade\);/,
  );
  assert.match(
    game,
    /private async activateTileVegetation[\s\S]*?this\.updateVegetationLod\(record\);[\s\S]*?this\.layerFades\.begin\(0, 1/,
  );
});
