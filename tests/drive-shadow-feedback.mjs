// Manual WebGL regression driver for shadow-map sampler feedback loops.
// Run while the dev server is active: node tests/drive-shadow-feedback.mjs
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = Number(process.env.EARTH_DEBUG_PORT ?? 9341);
const APP_URL = process.env.EARTH_APP_URL ?? "http://localhost:3000/?performance-debug";
const INITIAL_LOCATION = process.env.EARTH_LOCATION;
const profile = mkdtempSync(join(tmpdir(), "earth-shadow-feedback-"));
const chromeArguments = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--window-size=1280,720",
  "--no-first-run",
  "about:blank",
];
if (process.env.EARTH_CHROME_GPU !== "hardware") {
  chromeArguments.splice(-2, 0, "--enable-unsafe-swiftshader");
}
const chrome = spawn(CHROME, chromeArguments, { stdio: "ignore" });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      const targets = await response.json();
      target = targets.find((candidate) => candidate.type === "page");
    } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error("Chrome debug endpoint never came up");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  const browserLogs = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else if (message.method === "Log.entryAdded") {
      browserLogs.push(message.params.entry.text);
    } else if (message.method === "Runtime.consoleAPICalled") {
      browserLogs.push(message.params.args
        .map((argument) => argument.value ?? argument.description ?? "")
        .join(" "));
    } else if (message.method === "Runtime.exceptionThrown") {
      browserLogs.push(JSON.stringify(message.params.exceptionDetails));
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const samplerTypes = new Set([
        0x8B5E, 0x8B60, 0x8B62, 0x8DC1, 0x8DC4, 0x8DC5, 0x8DCA,
        0x8DCB, 0x8DCC, 0x8DCF, 0x8DD2, 0x8DD3, 0x8DD4, 0x8DD7,
      ]);
      for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!Context || Context.prototype.__earthDrawInstrumented) continue;
        Context.prototype.__earthDrawInstrumented = true;
        const original = Context.prototype.drawElements;
        Context.prototype.drawElements = function(...args) {
          while (this.getError() !== this.NO_ERROR) {}
          original.apply(this, args);
          const error = this.getError();
          if (error === this.NO_ERROR) return;
          const framebuffer = this.getParameter(this.FRAMEBUFFER_BINDING);
          const attachment = framebuffer && this.getFramebufferAttachmentParameter(
            this.FRAMEBUFFER,
            this.COLOR_ATTACHMENT0,
            this.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
          );
          const program = this.getParameter(this.CURRENT_PROGRAM);
          const activeTexture = this.getParameter(this.ACTIVE_TEXTURE);
          const samplers = [];
          if (program) {
            const count = this.getProgramParameter(program, this.ACTIVE_UNIFORMS);
            for (let index = 0; index < count; index++) {
              const uniform = this.getActiveUniform(program, index);
              if (!uniform || !samplerTypes.has(uniform.type)) continue;
              const location = this.getUniformLocation(program, uniform.name);
              const unit = this.getUniform(program, location);
              this.activeTexture(this.TEXTURE0 + unit);
              const texture2d = this.getParameter(this.TEXTURE_BINDING_2D);
              samplers.push({
                name: uniform.name,
                type: uniform.type,
                unit,
                feedback: texture2d === attachment,
              });
            }
          }
          this.activeTexture(activeTexture);
          console.error("EARTH_WEBGL_DRAW_ERROR", JSON.stringify({ error, samplers }));
        };
      }
    })()`,
  });
  if (INITIAL_LOCATION) {
    const location = JSON.parse(INITIAL_LOCATION);
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("earth.location.v1", ${JSON.stringify(JSON.stringify(location))})`,
    });
  }
  await send("Page.navigate", { url: APP_URL });
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await evaluate("!document.getElementById('loading')")) break;
    await sleep(500);
  }

  await evaluate(`(() => {
    const chunkKey = Object.keys(window).find((key) => key.startsWith("webpackChunk"));
    let requireModule;
    window[chunkKey].push([["shadow-feedback-probe"], {}, (value) => { requireModule = value; }]);
    for (const id of Object.keys(requireModule.c)) {
      const exportsObject = requireModule.c[id]?.exports;
      if (exportsObject?.EngineStore) {
        window.__earthScene = exportsObject.EngineStore.LastCreatedScene;
        return true;
      }
    }
    throw new Error("EngineStore not found in module cache");
  })()`);

  const moveTiles = Number(process.env.EARTH_MOVE_TILES ?? 0);
  if (moveTiles !== 0) {
    await evaluate(`window.__earthScene.activeCamera.position.x += ${JSON.stringify(moveTiles * 25)}`);
    await sleep(1_000);
  }

  for (let refresh = 0; refresh < 8; refresh++) {
    await evaluate(`(() => {
      const sun = window.__earthScene.getLightByName("sunLight");
      sun.getShadowGenerator().getShadowMap().resetRefreshCounter();
    })()`);
    await sleep(500);
  }
  await sleep(Number(process.env.EARTH_STREAM_WAIT_MS ?? 0));

  const vegetationInstances = await evaluate(`window.__earthScene.meshes.reduce(
    (total, mesh) => total + (/tree|grass|bush|fern|plant|wheat/i.test(mesh.name)
      && mesh.isEnabled() ? (mesh.thinInstanceCount ?? 0) : 0), 0)`);
  const feedbackWarnings = browserLogs.filter((line) => line.includes("Feedback loop formed"));
  const instrumentedErrors = browserLogs.filter((line) => line.includes("EARTH_WEBGL_DRAW_ERROR"));
  console.log(`vegetation instances: ${vegetationInstances}`);
  console.log(`framebuffer feedback warnings: ${feedbackWarnings.length}`);
  if (instrumentedErrors.length > 0) console.log(instrumentedErrors.slice(0, 10).join("\n"));
  socket.close();

  if (vegetationInstances <= 0) throw new Error("Vegetation disappeared during shadow refresh");
  if (feedbackWarnings.length > 0 || instrumentedErrors.length > 0) {
    throw new Error(feedbackWarnings[0] ?? instrumentedErrors[0]);
  }
} finally {
  if (chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([once(chrome, "exit"), sleep(3_000)]);
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
