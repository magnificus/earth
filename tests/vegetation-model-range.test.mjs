import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("the configured model range applies to vegetation except short-range mature grass", () => {
  assert.doesNotMatch(game, /lodDistanceCapMeters/);
  assert.match(
    game,
    /kind === "grassField"[\s\S]*?Math\.min\(this\.vegetationLodDistanceMeters, GRASS_MODEL_RANGE_CAP_METERS\)[\s\S]*?: this\.vegetationLodDistanceMeters/,
  );
  assert.match(
    game,
    /for \(const kind of VEGETATION_FIELD_KINDS\)[\s\S]*?updateField\([\s\S]*?field,[\s\S]*?this\.fieldLodDistance\(kind\)/,
  );
  assert.match(
    game,
    /record\.barrierField[\s\S]*?updateField\([\s\S]*?this\.vegetationLodDistanceMeters/,
  );
});
