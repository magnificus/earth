import assert from 'node:assert/strict';
import test from 'node:test';
import { TileGeneration, TILE_GENERATION_STAGES } from '../src/world/TileGeneration.ts';
import { TileGenerationCapture, renderTileGenerationReport, captureTileMeshes } from '../src/diagnostics/TileGenerationCapture.ts';
import { carveTerrainWaterways } from '../src/terrain/TerrainWaterways.ts';
import { conformTerrainToPlannedFeatures } from '../src/terrain/PlannedFeatureTerrain.ts';
import { planRoadsAndBuildings } from '../src/roads/RoadAndBuildingPlanner.ts';
import { planRoad } from '../src/roads/RoadPlanner.ts';

test('dependencies gate execution, skipped work satisfies dependencies, debug factories are lazy', () => {
  const stages = new TileGeneration();
  assert.throws(() => stages.begin('lake-terrain'), /requires/);
  assert.throws(() => stages.finish('sources'), /not started/);
  stages.begin('sources');
  assert.throws(() => stages.begin('sources'), /already running/);
  stages.finish('sources', () => { throw new Error('Disabled capture must not run'); });
  stages.begin('relief'); stages.finish('relief', undefined, 'Fixture omits relief');
  stages.begin('coastline'); stages.finish('coastline');
});

test('river and road stages preserve independent snapshots and expose channel filling', async () => {
  const capture = new TileGenerationCapture('fixture', true, 1);
  const stages = new TileGeneration(capture.record);
  const frame = { meshWidth: 40, meshDepth: 40, metersPerUnit: 1 };
  const terrain = { width: 41, height: 41, elevations: new Float32Array(1681).fill(50), minElevation: 50, maxElevation: 50 };
  const rivers = [{ start: { x: 0, z: -20 }, end: { x: 0, z: 20 }, halfWidth: 6 }];
  const output = () => ({ terrain, frame, rivers });
  for (const stage of ['sources', 'relief', 'coastline', 'water-selection', 'lake-terrain']) {
    stages.begin(stage); stages.finish(stage, output);
  }
  stages.begin('river-terrain');
  await carveTerrainWaterways(terrain, rivers, frame);
  stages.finish('river-terrain', output);
  stages.begin('site-plan');
  const plan = planRoadsAndBuildings([{ id: 'road', paths: [[{ x: -20, z: 0 }, { x: 20, z: 0 }]], appearance: planRoad({ class: 'minor' }) }], [], frame);
  stages.finish('site-plan', () => ({ ...output(), plan }));
  stages.begin('building-pads');
  await conformTerrainToPlannedFeatures(terrain, plan, { ...frame, onBuildingPadsComplete() {
    stages.finish('building-pads', output); stages.begin('road-grades');
  } });
  stages.finish('road-grades', output);
  const river = capture.report.stages.find(s => s.stage === 'river-terrain');
  const road = capture.report.stages.find(s => s.stage === 'road-grades');
  assert.equal(river.data.terrain.elevations[840], 48.5);
  assert.equal(road.data.terrain.elevations[840], 50);
  assert.equal(road.diagnostics.maximumRaiseMeters, 1.5);
  assert.equal(road.data.terrainChangeMeters[840], 1.5);
  terrain.elevations.fill(99);
  assert.equal(river.data.terrain.elevations[840], 48.5);
  assert.match(road.terrainChangeImage, /red = raised/);
  assert.match(road.image, /<svg/);
});

test('failures retain the last good output and do not unlock dependent stages', () => {
  const capture = new TileGenerationCapture('test', true, 1);
  const stages = new TileGeneration(capture.record);
  stages.begin('sources'); stages.finish('sources', () => ({ value: 'input' }));
  stages.begin('relief'); stages.abort(new Error('bad elevation'));
  assert.equal(capture.report.stages[1].status, 'failed');
  assert.equal(capture.report.stages[1].data.value, 'input');
  assert.throws(() => stages.begin('coastline'), /requires/);
  stages.begin('relief'); stages.abort('superseded', true);
  assert.equal(capture.report.stages[2].status, 'cancelled');
});

test('capture errors do not break generation and exports escape provider text', () => {
  const capture = new TileGenerationCapture('</script><script>bad()</script>', true, 1);
  const stages = new TileGeneration(capture.record);
  stages.begin('sources'); stages.finish('sources', () => { throw new Error('capture failed'); });
  stages.begin('relief'); stages.finish('relief', () => ({ tag: '</script><script>bad()</script>' }));
  assert.match(capture.report.stages[0].captureError, /capture failed/);
  const html = renderTileGenerationReport(capture.report);
  assert.ok(!html.includes('</script><script>bad()'));
  const data = html.match(/<script type="application\/json" id="report">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(data).stages[1].data.tag, '</script><script>bad()</script>');
});

test('mesh captures detach all buffers, transforms and thin-instance placement', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 0, 2, 1];
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const [mesh] = captureTileMeshes([{ name: 'mesh', getVerticesDataKinds: () => ['position'],
    getVerticesData: () => positions, getIndices: () => new Uint16Array([0, 1, 2]),
    computeWorldMatrix: () => ({ asArray: () => identity }), thinInstanceCount: 1,
    thinInstanceGetWorldMatrices: () => [{ asArray: () => identity }],
  }]);
  positions.fill(9); identity[12] = 99;
  assert.equal(mesh.attributes.position[0], 0);
  assert.equal(mesh.worldMatrix[12], 12);
  assert.equal(mesh.instanceMatrices[0][12], 12);
});

test('every declared stage can complete, including concurrent downstream branches', () => {
  const events = [];
  const stages = new TileGeneration(event => events.push(event));
  for (const stage of Object.keys(TILE_GENERATION_STAGES)) { stages.begin(stage); stages.finish(stage); }
  assert.equal(events.length, 16);
  stages.begin('buildings'); stages.begin('vegetation');
  stages.finish('vegetation'); stages.finish('buildings');
});

test('instance buffers are captured without interpreting them as per-vertex data', () => {
  const [mesh] = captureTileMeshes([{ name: 'instanced', getVerticesDataKinds: () => ['instanceColor'],
    getVerticesData: () => { throw new Error('Wrong element count'); }, getIndices: () => [],
    computeWorldMatrix: () => ({ asArray: () => [] }),
    getVertexBuffer: () => ({ getIsInstanced: () => true, getData: () => new Uint8Array([1, 2, 3, 4]),
      byteStride: 4, byteOffset: 0, type: 5121, normalized: true, getSize: () => 4 }),
  }]);
  assert.deepEqual(mesh.instanceAttributes.instanceColor.data, [1, 2, 3, 4]);
  assert.deepEqual(mesh.attributes, {});
});

test('clearing capture releases snapshots and stops detached in-flight writers', () => {
  const capture = new TileGenerationCapture('test', true, 1);
  const event = { stage: 'sources', status: 'complete', durationMilliseconds: 1 };
  capture.record(event, () => ({ value: 1 }));
  capture.clear();
  capture.record(event, () => { throw new Error('must not run'); });
  assert.equal(capture.report.stages.length, 0);
});
