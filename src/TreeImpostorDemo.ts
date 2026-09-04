import {
  AbstractEngine,
  ArcRotateCamera,
  Color4,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  TransformNode,
  Texture,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { FpsCounter } from "./FpsCounter";
import {
  captureImpostorAtlases,
  CubeFace,
  IMPOSTOR_CUBE_FACES,
} from "./Impostor";
import {
  createProceduralTree,
  measureFoliageTextures,
  PROCEDURAL_TREE_CAPTURE_DIAMETER,
  PROCEDURAL_TREE_SOURCE_HEIGHT,
} from "./procedural/ProceduralTree";

interface CaptureSettings {
  gridSize: number;
  resolution: number;
}

interface NamedCubeFace extends CubeFace {
  name: string;
}

interface CaptureSet {
  atlases: HTMLCanvasElement[];
  textures: Texture[];
  settings: CaptureSettings;
}

const CUBE_FACE_NAMES = ["pos-x", "neg-x", "pos-y", "pos-z", "neg-z", "neg-y"] as const;
const CUBE_FACES: readonly NamedCubeFace[] = IMPOSTOR_CUBE_FACES.map((face, index) => ({
  ...face,
  name: CUBE_FACE_NAMES[index],
}));

const vertexShader = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform vec3 center;
uniform vec3 billboardRight;
uniform vec3 billboardUp;
uniform float diameter;
varying vec2 vUV;
void main(void) {
  vec3 worldPosition = center + (billboardRight * position.x + billboardUp * position.y) * diameter;
  gl_Position = viewProjection * vec4(worldPosition, 1.0);
  vUV = vec2(uv.x, 1.0 - uv.y);
}`;

const fragmentShader = `
#define DISABLE_UNIFORMITY_ANALYSIS
precision highp float;
varying vec2 vUV;
uniform sampler2D atlas0;
uniform sampler2D atlas1;
uniform sampler2D atlas2;
uniform sampler2D atlas3;
uniform sampler2D atlas4;
uniform sampler2D atlas5;
uniform vec2 samplePosition;
uniform float gridSize;
uniform float faceIndex;
uniform float tileInset;

vec4 atlasSample(vec2 uv) {
  if (faceIndex < 0.5) return texture2D(atlas0, uv);
  if (faceIndex < 1.5) return texture2D(atlas1, uv);
  if (faceIndex < 2.5) return texture2D(atlas2, uv);
  if (faceIndex < 3.5) return texture2D(atlas3, uv);
  if (faceIndex < 4.5) return texture2D(atlas4, uv);
  return texture2D(atlas5, uv);
}

vec4 frame(float x, float y) {
  vec2 inset = vec2(tileInset);
  vec2 localUV = mix(inset, vec2(1.0) - inset, vUV);
  return atlasSample((vec2(x, y) + localUV) / gridSize);
}

void main(void) {
  vec2 low = floor(samplePosition);
  vec2 high = min(low + 1.0, vec2(gridSize - 1.0));
  vec2 blend = fract(samplePosition);
  vec4 bottom = mix(frame(low.x, low.y), frame(high.x, low.y), blend.x);
  vec4 top = mix(frame(low.x, high.y), frame(high.x, high.y), blend.x);
  vec4 color = mix(bottom, top, blend.y);
  if (color.a < 0.01) discard;
  vec3 straightColor = color.rgb / max(color.a, 1.0 / 255.0);
  gl_FragColor = vec4(straightColor, color.a);
}`;

export class TreeImpostorDemo {
  private readonly engine: AbstractEngine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly status: HTMLElement;
  private readonly preview: HTMLCanvasElement;
  private sourceRoot?: TransformNode;
  private sourceMeshes: Mesh[] = [];
  private center = Vector3.Zero();
  private diameter = 1;
  private captureSet?: CaptureSet;
  private proxy?: Mesh;
  private proxyMaterial?: ShaderMaterial;
  private readonly fpsCounter: FpsCounter;

  constructor(canvas: HTMLCanvasElement, engine: AbstractEngine) {
    this.engine = engine;
    this.scene = new Scene(this.engine);
    this.fpsCounter = new FpsCounter(this.scene);
    this.scene.clearColor = new Color4(0.055, 0.065, 0.075, 1);
    this.camera = new ArcRotateCamera("impostorOrbitCamera", -Math.PI / 2, Math.PI / 2.4, 4, Vector3.Zero(), this.scene);
    this.camera.lowerRadiusLimit = 1;
    this.camera.upperRadiusLimit = 20;
    this.camera.wheelPrecision = 40;
    this.camera.attachControl(canvas, true);
    ({ status: this.status, preview: this.preview } = this.createControls());
  }

  async initialize(onProgress?: (step: string, progress: number) => void): Promise<void> {
    onProgress?.("Generating source tree", 25);
    this.setStatus("Generating source tree...");
    await measureFoliageTextures();
    const source = createProceduralTree(this.scene, { name: "treeCaptureSource" });
    const sourceRoot = new TransformNode("treeCaptureSourceRoot", this.scene);
    source.log.parent = sourceRoot;
    source.branches.parent = sourceRoot;
    this.sourceRoot = sourceRoot;
    this.sourceMeshes = [source.log, source.branches];
    this.center = Vector3.Zero();
    this.diameter = PROCEDURAL_TREE_CAPTURE_DIAMETER;
    await this.scene.whenReadyAsync();
    onProgress?.("Preparing preview", 80);
    this.camera.target.copyFrom(this.center);
    this.camera.radius = this.diameter * 1.35;
    this.setStatus("Procedural source ready. Capture uses the source only; preview uses only atlases.");
    onProgress?.("Ready", 100);
  }

  run(): void {
    this.engine.runRenderLoop(() => {
      this.updateProxyView();
      this.scene.render();
      this.fpsCounter.update(this.engine);
    });
  }

  resize(): void {
    this.engine.resize();
  }

  private async capture(settings: CaptureSettings): Promise<void> {
    if (!this.sourceRoot) return;
    this.disposeCaptureSet();
    this.proxy?.dispose();
    this.proxy = undefined;
    this.sourceRoot.setEnabled(true);

    const total = CUBE_FACES.length * settings.gridSize * settings.gridSize;
    const assets = await captureImpostorAtlases(this.scene, {
      name: "treeImpostorDemo",
      meshes: this.sourceMeshes,
      gridWidth: settings.gridSize,
      gridHeight: settings.gridSize,
      resolution: settings.resolution,
      sourceHeight: PROCEDURAL_TREE_SOURCE_HEIGHT,
      captureDiameter: this.diameter,
      faces: CUBE_FACES,
      onProgress: (completed, _total, faceIndex, x, y) => {
        this.setStatus(
          `Capturing ${completed}/${total}: ${CUBE_FACES[faceIndex].name} ${x + 1},${y + 1}`,
        );
      },
    });
    const textures = assets.textures;
    const atlases = assets.atlasCanvases;
    this.captureSet = { atlases, textures, settings };
    this.createProxy();
    this.sourceRoot.setEnabled(false);
    this.drawPreview(atlases[3]);
    this.setStatus(`Done. ${total} binary-alpha captures; source mesh is now disabled.`);
  }

  private createProxy(): void {
    const set = this.captureSet!;
    this.proxy = MeshBuilder.CreatePlane("treeImpostor", { size: 1 }, this.scene);
    this.proxy.alwaysSelectAsActiveMesh = true;
    this.proxyMaterial = new ShaderMaterial("treeImpostorMaterial", this.scene, { vertexSource: vertexShader, fragmentSource: fragmentShader }, {
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", "viewProjection", "center", "billboardRight", "billboardUp", "diameter", "samplePosition", "gridSize", "faceIndex", "tileInset"],
      samplers: ["atlas0", "atlas1", "atlas2", "atlas3", "atlas4", "atlas5"],
      needAlphaBlending: true,
    });
    this.proxyMaterial.backFaceCulling = false;
    this.proxyMaterial.setVector3("center", this.center);
    this.proxyMaterial.setFloat("diameter", this.diameter);
    this.proxyMaterial.setFloat("gridSize", set.settings.gridSize);
    this.proxyMaterial.setFloat("tileInset", 0.5 / set.settings.resolution);
    set.textures.forEach((texture, index) => this.proxyMaterial!.setTexture(`atlas${index}`, texture));
    this.proxy.material = this.proxyMaterial;
  }

  private updateProxyView(): void {
    if (!this.proxyMaterial || !this.captureSet) return;
    const direction = this.camera.globalPosition.subtract(this.center).normalize();
    const faceIndex = dominantFace(direction);
    const face = CUBE_FACES[faceIndex];
    const denominator = Math.max(0.0001, Vector3.Dot(direction, face.normal));
    const u = Vector3.Dot(direction, face.right) / denominator;
    const v = Vector3.Dot(direction, face.up) / denominator;
    const maxSample = this.captureSet.settings.gridSize - 1;
    this.proxyMaterial.setFloat("faceIndex", faceIndex);
    this.proxyMaterial.setVector2(
      "samplePosition",
      new Vector2(((u + 1) * 0.5) * maxSample, ((v + 1) * 0.5) * maxSample),
    );
    const right = Vector3.Cross(direction, face.up).normalize();
    const up = Vector3.Cross(right, direction).normalize();
    this.proxyMaterial.setVector3("billboardRight", right);
    this.proxyMaterial.setVector3("billboardUp", up);
  }

  private createControls(): { panel: HTMLElement; status: HTMLElement; preview: HTMLCanvasElement } {
    document.body.classList.add("impostor-mode");
    const panel = document.createElement("aside");
    panel.id = "impostorControls";
    panel.innerHTML = `
      <h1>Tree impostor capture</h1>
      <label>Samples per face edge <input id="captureGrid" type="number" min="1" max="16" value="10"></label>
      <label>Capture resolution <input id="captureResolution" type="number" min="64" max="256" step="64" value="256"></label>
      <div class="impostor-actions"><button id="captureButton">Capture</button><button id="exportButton" disabled>Export ZIP</button></div>
      <canvas id="capturePreview" width="240" height="240"></canvas>
      <output id="captureStatus">Preparing...</output>`;
    document.body.appendChild(panel);
    const status = panel.querySelector("#captureStatus") as HTMLElement;
    const preview = panel.querySelector("#capturePreview") as HTMLCanvasElement;
    const captureButton = panel.querySelector("#captureButton") as HTMLButtonElement;
    const exportButton = panel.querySelector("#exportButton") as HTMLButtonElement;
    captureButton.addEventListener("click", async () => {
      captureButton.disabled = true;
      exportButton.disabled = true;
      try {
        const gridSize = Number((panel.querySelector("#captureGrid") as HTMLInputElement).value);
        const resolution = Number((panel.querySelector("#captureResolution") as HTMLInputElement).value);
        await this.capture({ gridSize, resolution });
        exportButton.disabled = false;
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        captureButton.disabled = false;
      }
    });
    exportButton.addEventListener("click", () => void this.exportCapture());
    return { panel, status, preview };
  }

  private drawPreview(atlas: HTMLCanvasElement): void {
    const context = this.preview.getContext("2d")!;
    context.clearRect(0, 0, this.preview.width, this.preview.height);
    context.drawImage(atlas, 0, 0, this.preview.width, this.preview.height);
  }

  private async exportCapture(): Promise<void> {
    if (!this.captureSet) return;
    this.setStatus("Encoding ZIP...");
    const files: ZipEntry[] = [];
    for (let index = 0; index < this.captureSet.atlases.length; index++) {
      const blob = await canvasToBlob(this.captureSet.atlases[index]);
      files.push({ name: `${CUBE_FACES[index].name}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const manifest = {
      version: 1,
      layout: "five-face-atlases",
      gridSize: this.captureSet.settings.gridSize,
      resolution: this.captureSet.settings.resolution,
      alpha: "binary",
      transparentRgb: "black",
      faceOrder: CUBE_FACES.map((face) => face.name),
    };
    files.push({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    downloadBlob(createStoredZip(files), "tree-impostor-captures.zip");
    this.setStatus("Exported tree-impostor-captures.zip.");
  }

  private disposeCaptureSet(): void {
    this.captureSet?.textures.forEach((texture) => texture.dispose());
    this.captureSet = undefined;
    this.proxyMaterial?.dispose();
    this.proxyMaterial = undefined;
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }
}

function dominantFace(direction: Vector3): number {
  const x = Math.abs(direction.x);
  const y = Math.abs(direction.y);
  const z = Math.abs(direction.z);
  if (y >= x && y >= z) return direction.y >= 0 ? 2 : 5;
  if (x >= z) return direction.x >= 0 ? 0 : 1;
  return direction.z >= 0 ? 3 : 4;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed.")), "image/png"));
}

interface ZipEntry { name: string; data: Uint8Array }

function createStoredZip(entries: ZipEntry[]): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const data = Uint8Array.from(entry.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const header = new Uint8Array(46 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, data.length, true);
    view.setUint32(24, data.length, true);
    view.setUint16(28, name.length, true);
    view.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  const bytes = [...parts, ...central, end];
  const size = bytes.reduce((sum, part) => sum + part.byteLength, 0);
  const zip = new Uint8Array(size);
  let cursor = 0;
  for (const part of bytes) {
    zip.set(part, cursor);
    cursor += part.byteLength;
  }
  return new Blob([zip.buffer], { type: "application/zip" });
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
