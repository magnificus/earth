import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Vector3 } from "@babylonjs/core";
import {
  bakeExposureGeometry, EXPOSURE_DIRECTIONS,
  packExposureFace,
} from "../src/DirectionalExposure.ts";

const impostorSource = readFileSync(new URL("../src/Impostor.ts", import.meta.url), "utf8");

test("raw exposure captures skip atlas canvases and release runtime canvases early", () => {
  assert.match(impostorSource, /options\.captureRawFace \? \[\] : faces\.map/);
  const capture = impostorSource.slice(
    impostorSource.indexOf("const assets = await captureImpostorAtlases"),
    impostorSource.indexOf("console.log(`${definition.name}: capture complete"),
  );
  assert.ok(
    capture.indexOf("releaseAtlasCanvases(assets)") <
      capture.indexOf('captureDataBandAtlases(scene, captureOptions, "exposure"'),
  );
});

function card(center, size, sun, cutout) {
  const right = Vector3.Cross(Vector3.Up(), sun).normalize().scale(size);
  const up = Vector3.Cross(sun, right).normalize().scale(size);
  return {
    positions: [-1, 1].flatMap((y) => [-1, 1].flatMap((x) => center.add(right.scale(x)).add(up.scale(y)).asArray())),
    indices: [0, 1, 2, 2, 1, 3],
    uvs: [0, 0, 1, 0, 0, 1, 1, 1],
    cutout,
  };
}

test("packed exposure retains zero fourth-channel values and aligns every face with color capture", () => {
  const pixels = new Uint8Array([10, 20, 30, 0, 40, 50, 60, 128]);
  const atlas = new Uint8Array(3 * 4 * 4).fill(255);
  for (let face = 0; face < 5; face++) packExposureFace(atlas, pixels, face, 1, 2);
  for (let face = 0; face < 5; face++) {
    const top = (Math.floor(face / 3) * 2 * 3 + face % 3) * 4;
    assert.deepEqual([...atlas.subarray(top, top + 4)], [40, 50, 60, 128]);
    assert.deepEqual([...atlas.subarray(top + 12, top + 16)], [10, 20, 30, 0]);
  }
  assert.deepEqual([...atlas.subarray(44, 48)], [255, 255, 255, 255]);
});

test("isolated leaves remain exposed; a sunward leaf blocks only the relevant directions", async () => {
  const sun = EXPOSURE_DIRECTIONS[0];
  const receiver = card(Vector3.Zero(), 0.1, sun);
  const blocker = card(sun.scale(0.4), 0.35, sun);
  const [alone] = await bakeExposureGeometry([receiver], 128);
  for (let v = 0; v < 4; v++) assert.ok(alone[v * 8] > 0.95);
  const [blocked, exposed] = await bakeExposureGeometry([receiver, blocker], 128);
  for (let v = 0; v < 4; v++) {
    assert.ok(blocked[v * 8] < 0.1, `sunward occlusion: ${blocked[v * 8]}`);
    assert.ok(blocked[v * 8 + 2] > 0.95, "opposite direction stays open");
    assert.ok(exposed[v * 8] > 0.95, "front leaf stays exposed");
  }
});

test("transparent cutouts transmit sunlight and missing seasonal triangles cannot occlude", async () => {
  const sun = EXPOSURE_DIRECTIONS[0];
  const receiver = card(Vector3.Zero(), 0.1, sun);
  const hole = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 0]) };
  const blocker = card(sun.scale(0.4), 0.35, sun, hole);
  const [throughHole] = await bakeExposureGeometry([receiver, blocker], 128);
  blocker.cutout = undefined;
  blocker.indices = [];
  const [withoutLeaves] = await bakeExposureGeometry([receiver, blocker], 128);
  for (let v = 0; v < 4; v++) {
    assert.ok(throughHole[v * 8] > 0.95);
    assert.ok(withoutLeaves[v * 8] > 0.95);
  }
});

test("exposure is invariant to tree scale and cooperatively yields", async () => {
  const sun = EXPOSURE_DIRECTIONS[0];
  const geometry = [card(Vector3.Zero(), 0.1, sun), card(sun.scale(0.4), 0.35, sun)];
  let yields = 0;
  const original = await bakeExposureGeometry(geometry, 128, async () => { yields++; });
  const scaled = await bakeExposureGeometry(geometry.map((mesh) => ({ ...mesh, positions: mesh.positions.map((n) => n * 20) })), 128);
  assert.ok(yields >= 8);
  for (let m = 0; m < original.length; m++) for (let i = 0; i < original[m].length; i++) {
    assert.ok(Math.abs(original[m][i] - scaled[m][i]) < 0.01);
    assert.ok(original[m][i] >= 0 && original[m][i] <= 1);
  }
});
