import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { launchBrowser, sleep } from '../tests/browser-harness.mjs';

export async function createTileDebugBrowser(chrome) {
  await mkdir('.cache/tile-cli', { recursive: true });
  const directory = await mkdtemp(path.resolve('.cache/tile-cli/run-'));
  const reservation = createSocketServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const browser = await launchBrowser([`--remote-debugging-port=${port}`, `--user-data-dir=${directory}/profile`,
    '--headless=new', '--window-size=1000,1000', '--enable-unsafe-swiftshader', '--no-first-run', 'about:blank'],
  chrome ?? process.env.CHROME_PATH);
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  return { browser, directory };
}

export async function captureLiveTile(browser, directory, { lat, lon, timeout, seed }) {
  console.log('Building isolated tile-generation app...');
  const { default: webpack } = await import('webpack');
  const { default: configuration } = await import('../webpack.config.js');
  const config = configuration({}, { mode: 'development' });
  delete config.devServer;
  const bundle = path.join(directory, 'bundle');
  const compiler = webpack({ ...config, devtool: false, output: { ...config.output, path: bundle } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    compiler.close(closeError => {
      if (error || closeError || stats?.hasErrors()) reject(error ?? closeError ?? new Error(stats.toString('errors-only')));
      else resolve();
    });
  }));
  const capturePath = path.join(directory, 'capture.json');
  let uploaded = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/capture') {
        await pipeline(request, createWriteStream(capturePath));
        uploaded = true; response.end('ok'); return;
      }
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const filename = path.resolve(bundle, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(bundle + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
      response.setHeader('Content-Type', types[path.extname(filename)] ?? 'application/octet-stream');
      const stream = createReadStream(filename);
      stream.on('error', () => response.writeHead(404).end());
      stream.pipe(response);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source:
      `if(location.origin===${JSON.stringify(origin)})localStorage.setItem('earth.location.v1',${JSON.stringify(JSON.stringify({ lat, lon }))});` });
    await browser.send('Page.navigate', { url: `${origin}/?tile-debug&terrain-size=1&detail-size=1&clouds=off&seed=${seed}` });
    console.log(`Generating tile at ${lat}, ${lon}...`);
    const deadline = Date.now() + timeout * 1000;
    let lastCount = -1, complete = false;
    while (Date.now() < deadline) {
      const reports = await browser.evaluate('window.tileGenerationDebug?.list()');
      const stages = reports?.[0]?.stages ?? [];
      if (stages.length !== lastCount) {
        lastCount = stages.length;
        console.log(`${stages.length}/16 stages${stages.length ? ': ' + stages.at(-1).stage : ' (loading sources)'}`);
      }
      if (stages.some(stage => stage.status === 'failed' || stage.status === 'cancelled')) break;
      if (stages.some(stage => stage.stage === 'props')) { complete = true; break; }
      await sleep(500);
    }
    const available = await browser.evaluate('!!window.tileGenerationDebug?.list().length');
    if (!available) throw new Error('Tile capture unavailable; check source downloads or increase --timeout');
    await browser.evaluate(`(async () => {
      const report = tileGenerationDebug.get();
      const response = await fetch('/capture', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(report) });
      if (!response.ok) throw new Error('Capture upload failed');
    })()`);
    if (!uploaded) throw new Error('Capture was not written');
    const report = JSON.parse(await readFile(capturePath, 'utf8'));
    if (!complete) report.cliError = 'Generation failed or timed out; partial stage outputs retained';
    if (report.stages.some(stage => stage.captureError)) report.cliError = 'One or more stage captures failed';
    return report;
  } finally {
    await browser.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

/** Rasterize the actual stage SVGs, not screenshots of report controls. */
export async function writeTileImages(browser, report, directory) {
  await browser.send('Page.navigate', { url: 'about:blank' });
  await browser.evaluate(`window.tileSheet=document.createElement('canvas');tileSheet.width=1600;tileSheet.height=${Math.ceil(report.stages.length / 4) * 425};
    window.tileSheetContext=tileSheet.getContext('2d');tileSheetContext.fillStyle='#fff';tileSheetContext.fillRect(0,0,tileSheet.width,tileSheet.height);
    window.previousStageImage=null;window.stageComparison=null;`);
  const images = [];
  for (const [index, stage] of report.stages.entries()) {
    const name = `${String(stage.sequence).padStart(2, '0')}-${stage.stage}`.replace(/[^a-z0-9_-]/gi, '_');
    for (const [suffix, svg] of [['', stage.image], ['-change', stage.terrainChangeImage]]) {
      if (!svg) continue;
      const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      const png = await browser.evaluate(`(async () => {
        const image=new Image();image.src=${JSON.stringify(source)};await image.decode();
        const canvas=document.createElement('canvas');canvas.width=image.naturalWidth*2;canvas.height=image.naturalHeight*2;
        if(!canvas.width||!canvas.height)throw new Error('Empty stage image');
        const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);
        ${suffix ? '' : `tileSheetContext.drawImage(image,${index % 4 * 400},${Math.floor(index / 4) * 425},400,425);
          if(previousStageImage){
            const pair=document.createElement('canvas');pair.width=1600;pair.height=950;
            const ctx=pair.getContext('2d');ctx.fillStyle='#f6f7f8';ctx.fillRect(0,0,1600,950);
            ctx.fillStyle='#17232b';ctx.font='bold 26px sans-serif';
            ctx.fillText(${JSON.stringify(index ? `${report.stages[index-1].sequence}. ${report.stages[index-1].stage}` : '')},40,40);
            ctx.fillText(${JSON.stringify(`${stage.sequence}. ${stage.stage}`)},840,40);
            ctx.drawImage(previousStageImage,0,65,800,850);ctx.drawImage(image,800,65,800,850);
            ctx.font='18px sans-serif';ctx.fillText(${JSON.stringify(`This step: ${stage.diagnostics.changedSamples} terrain samples changed | max fill ${stage.diagnostics.maximumRaiseMeters.toFixed(2)} m | max cut ${stage.diagnostics.maximumCutMeters.toFixed(2)} m`)},40,937);
            stageComparison=pair.toDataURL('image/png').split(',')[1];
          }
          previousStageImage=image;`}
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const filename = `${name}${suffix}.png`;
      await writeFile(path.join(directory, filename), Buffer.from(png, 'base64'));
      images.push(filename);
      if (!suffix && index > 0) {
        const comparison = `compare-${String(report.stages[index - 1].sequence).padStart(2, '0')}-${String(stage.sequence).padStart(2, '0')}.png`;
        await writeFile(path.join(directory, comparison), Buffer.from(await browser.evaluate('stageComparison'), 'base64'));
        images.push(comparison);
      }
    }
  }
  if (report.stages.length) {
    const sheet = await browser.evaluate('tileSheet.toDataURL("image/png").split(",")[1]');
    await writeFile(path.join(directory, 'stages.png'), Buffer.from(sheet, 'base64'));
  }
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const panels = report.stages.map(stage => {
    const name = `${String(stage.sequence).padStart(2, '0')}-${stage.stage}`.replace(/[^a-z0-9_-]/gi, '_');
    return `<section id="stage-${stage.sequence}"><h2>${stage.sequence}. ${escape(stage.stage)}</h2><p>${escape(stage.status)} | ${stage.diagnostics.changedSamples} terrain samples changed | fill ${stage.diagnostics.maximumRaiseMeters.toFixed(2)} m | cut ${stage.diagnostics.maximumCutMeters.toFixed(2)} m</p><a href="${name}.png"><img loading="lazy" src="${name}.png" width="1600" height="1700" alt="${escape(stage.stage)}"></a></section>`;
  }).join('');
  await writeFile(path.join(directory, 'sequence.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tile stage sequence</title><style>body{margin:24px auto;padding:0 20px;max-width:1200px;font:16px system-ui;background:#f6f7f8;color:#17232b}nav{display:flex;flex-wrap:wrap;gap:12px}a{color:#006d86}section{border-top:1px solid #aebac0;margin-top:40px;padding-top:16px}img{display:block;width:100%;height:auto}h2{font-size:26px}</style><h1>Tile ${escape(report.tile)}</h1><nav>${report.stages.map(s=>`<a href="#stage-${s.sequence}">${s.sequence}. ${escape(s.stage)}</a>`).join('')}</nav>${panels}</html>`);
  return images;
}
