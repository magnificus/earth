import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createTileDebugBrowser, captureLiveTile, writeTileImages } from './tile-debug-browser.mjs';
import { TileGenerationCapture, renderTileGenerationReport } from '../src/diagnostics/TileGenerationCapture.ts';
import { TileGeneration } from '../src/world/TileGeneration.ts';
import { carveTerrainWaterways } from '../src/terrain/TerrainWaterways.ts';
import { conformTerrainToPlannedFeatures } from '../src/terrain/PlannedFeatureTerrain.ts';
import { planRoadsAndBuildings } from '../src/roads/RoadAndBuildingPlanner.ts';
import { planRoad } from '../src/roads/RoadPlanner.ts';

const args = process.argv.slice(2);
// parseArgs treats a separate negative number as an option unless joined with '='.
for (let index = 0; index < args.length - 1; index++) {
  if (['--lat', '--lon', '--seed', '--timeout'].includes(args[index]) && /^-\d/.test(args[index + 1])) {
    args.splice(index, 2, `${args[index]}=${args[index + 1]}`);
  }
}
const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
  lat: { type: 'string' }, lon: { type: 'string' }, out: { type: 'string' },
  chrome: { type: 'string' }, timeout: { type: 'string', default: '240' },
  seed: { type: 'string', default: '1337' }, example: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage:\n  yarn tiles:debug --lat 59.9047 --lon 10.6110 [--out data/tile-generation]\n  yarn tiles:debug capture.json [output-directory]\n  yarn tiles:debug --example [output-directory]\nOptions: --chrome <executable>, --timeout <seconds>, --seed <integer>');
  process.exit(0);
}
const live = values.lat !== undefined || values.lon !== undefined;
const input = values.example ? '--example' : positionals[0];
if (!live && !input) throw new Error('Specify --lat and --lon, --example, or a capture JSON file; see --help');
if (live && (values.example || positionals.length)) throw new Error('Choose coordinates, an example, or a saved capture');
const lat = Number(values.lat), lon = Number(values.lon), timeout = Number(values.timeout), seed = Number(values.seed);
if (live && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85.05112878 || Math.abs(lon) > 180)) {
  throw new Error('Provide valid --lat (-85.05112878..85.05112878) and --lon (-180..180)');
}
if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isInteger(seed)) throw new Error('Invalid --timeout or --seed');
const directory = path.resolve(values.out ?? (values.example ? positionals[0] : positionals[1]) ?? 'data/tile-generation');
await mkdir(directory, { recursive: true });
const { browser, directory: temporaryDirectory } = await createTileDebugBrowser(values.chrome);
try {
let report;
if (live) {
  report = await captureLiveTile(browser, temporaryDirectory, { lat, lon, timeout, seed });
} else if (input === '--example') {
  const capture = new TileGenerationCapture('synthetic-river-crossing', true, 1);
  const stages = new TileGeneration(capture.record);
  const frame = { meshWidth: 80, meshDepth: 80, metersPerUnit: 1 };
  const terrain = { width: 81, height: 81, elevations: new Float32Array(81 * 81).fill(50), minElevation: 50, maxElevation: 50 };
  const rivers = [{ start: { x: 0, z: -40 }, end: { x: 0, z: 40 }, halfWidth: 6 }];
  const output = () => ({ terrain, frame, rivers, fixture: 'Synthetic crossing; numerical stages only' });
  stages.begin('sources'); stages.finish('sources', output);
  for (const stage of ['relief', 'coastline', 'water-selection', 'lake-terrain']) {
    stages.begin(stage); stages.finish(stage, output, 'Synthetic fixture has flat terrain and one river');
  }
  stages.begin('river-terrain');
  await carveTerrainWaterways(terrain, rivers, frame);
  stages.finish('river-terrain', output);
  stages.begin('site-plan');
  const plan = planRoadsAndBuildings([{ id: 'crossing-road',
    paths: [[{ x: -40, z: 0 }, { x: 40, z: 0 }]], appearance: planRoad({ class: 'secondary' }),
  }], [{ id: 'house', outline: [{ x: 17, z: 12 }, { x: 29, z: 12 }, { x: 29, z: 25 }, { x: 17, z: 25 }] }], frame);
  const plannedOutput = () => ({ ...output(), plan });
  stages.finish('site-plan', plannedOutput);
  stages.begin('building-pads');
  await conformTerrainToPlannedFeatures(terrain, plan, { ...frame, onBuildingPadsComplete() {
    stages.finish('building-pads', plannedOutput); stages.begin('road-grades');
  } });
  stages.finish('road-grades', plannedOutput);
  report = capture.report;
} else {
  report = JSON.parse(await readFile(input, 'utf8'));
  if (report.format !== 'earth-tile-generation' || report.version !== 1 || !Array.isArray(report.stages)) {
    throw new Error('Expected an earth-tile-generation version 1 capture');
  }
}
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'index.html'), renderTileGenerationReport(report));
await writeFile(path.join(directory, 'capture.json'), JSON.stringify(report));
for (const stage of report.stages) {
  const name = `${String(stage.sequence).padStart(2, '0')}-${stage.stage}`.replace(/[^a-z0-9_-]/gi, '_');
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify(stage, null, 2));
  await writeFile(path.join(directory, `${name}.svg`), stage.image);
  if (stage.terrainChangeImage) await writeFile(path.join(directory, `${name}-change.svg`), stage.terrainChangeImage);
}
console.log(`Exported ${report.stages.length} stages to ${directory}`);
const images = await writeTileImages(browser, report, directory);
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ tile: report.tile, stages: report.stages.length,
  images, contactSheet: report.stages.length ? 'stages.png' : null, error: report.cliError }, null, 2));
console.log(`Wrote ${images.length} PNG images and ${path.join(directory, 'stages.png')}`);
if (report.cliError) throw new Error(report.cliError);
} finally {
  browser.socket.close(); browser.chrome.kill();
}
