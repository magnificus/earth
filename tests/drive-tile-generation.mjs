import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { launchBrowser, sleep } from './browser-harness.mjs';

const output = path.resolve('.cache/tile-generation-validation');
await mkdir(output, { recursive: true });
const report = await readFile('data/tile-generation/index.html');
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html'); response.end(report);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchBrowser(['--remote-debugging-port=9377', `--user-data-dir=${output}/profile`,
    '--headless=new', '--window-size=1280,1000', '--enable-unsafe-swiftshader', '--no-first-run', 'about:blank']);
  const { send, evaluate } = browser;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  for (let i = 0; i < 50; i++) {
    if (await evaluate('document.getElementById("image")?.naturalWidth === 800')) break;
    await sleep(100);
  }
  assert.equal(await evaluate('document.querySelectorAll("#stage option").length'), 9);
  await evaluate('document.getElementById("stage").value="8";document.getElementById("view").value="terrainChangeImage";document.getElementById("stage").dispatchEvent(new Event("change"))');
  await sleep(200);
  for (const [name, width, height] of [['desktop', 1280, 1100], ['mobile', 390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const metrics = await evaluate(`(() => {
      const img=document.getElementById('image'), canvas=document.createElement('canvas');
      canvas.width=800;canvas.height=850;const context=canvas.getContext('2d');context.drawImage(img,0,0);
      const pixel=context.getImageData(400,400,1,1).data;
      return { loaded:img.complete&&img.naturalWidth===800, overflow:document.documentElement.scrollWidth>innerWidth,
        center:[...pixel], diagnostics:document.getElementById('details').textContent };
    })()`);
    assert.equal(metrics.loaded, true); assert.equal(metrics.overflow, false);
    assert.ok(metrics.center[0] > metrics.center[2] + 30, 'Road fill must appear red in terrain change image');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(name, metrics);
  }
  if (process.argv.includes('--live')) {
    const location = process.argv.find(arg => arg.startsWith('--query='))?.slice(8)
      ?? 'lat=58.79605454187253&lon=11.182361556113896';
    const query = new URLSearchParams(location);
    await send('Page.addScriptToEvaluateOnNewDocument', { source:
      `if(location.port==='3002')localStorage.setItem('earth.location.v1',${JSON.stringify(JSON.stringify({ lat: Number(query.get('lat')), lon: Number(query.get('lon')) }))});` });
    await send('Page.navigate', { url: `http://localhost:3002/?tile-debug&terrain-size=1&detail-size=1&clouds=off&${location}` });
    let captures;
    for (let i = 0; i < 180; i++) {
      captures = await evaluate('window.tileGenerationDebug?.list()');
      if (captures?.some(c => c.stages.some(s => s.stage === 'props'))) break;
      if (captures?.some(c => c.stages.some(s => s.status === 'failed'))) break;
      if (i % 10 === 0) console.log('Live progress', JSON.stringify(captures));
      await sleep(1000);
    }
    await writeFile(path.join(output, 'live-stages.json'), JSON.stringify(captures, null, 2));
    assert.ok(captures?.length, 'Live app must create a tile capture');
    assert.ok(captures[0].stages.some(s => s.stage === 'props'), 'Live native tile must complete all stages');
    assert.ok(captures[0].stages.every(s => s.status !== 'failed'), 'No failed live stages');
    const checks = await evaluate(`(() => { const r=tileGenerationDebug.get();return { errors:r.stages.filter(s=>s.captureError),
      sources:r.stages[0].data.providerTiles.length, buildings:r.stages.find(s=>s.stage==='buildings').data.plans.length,
      layouts:r.stages.find(s=>s.stage==='buildings').data.layouts.length,
      stages:r.stages.map(s=>s.stage) }; })()`);
    assert.deepEqual(checks.errors, []);
    assert.ok(checks.sources > 0);
    if (process.argv.includes('--buildings')) assert.ok(checks.buildings > 0 && checks.layouts > 0);
    console.log('Live capture verified', JSON.stringify(checks));
    const downloads = path.join(output, `download-${Date.now()}`);
    await mkdir(downloads, { recursive: true });
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await evaluate('tileGenerationDebug.download()');
    let files = [];
    for (let i = 0; i < 100; i++) {
      files = (await readdir(downloads)).filter(name => name.endsWith('.html'));
      if (files.length) break;
      await sleep(100);
    }
    assert.equal(files.length, 1, 'Standalone report downloads successfully');
    console.log('Downloaded live report:', path.join(downloads, files[0]));
  }
  console.log('Artifacts:', output);
} finally {
  browser?.socket.close(); browser?.chrome.kill();
  server.closeAllConnections(); server.close();
}
