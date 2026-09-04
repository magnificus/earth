import {
  AbstractEngine,
  Color4,
  FreeCamera,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  RenderTargetTexture,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { createTreeImpostorPrototype } from "./TreeField";
import { TreeImpostorAssets } from "./TreeImpostor";
import { IMPOSTOR_CUBE_FACES as TREE_IMPOSTOR_FACES } from "./Impostor";
import { FpsCounter } from "./FpsCounter";

interface FaceValidation {
  face: string;
  iou: number;
  mismatch: number;
  atlasCoverage: number;
  bestTransform: string;
  bestIou: number;
}

interface GeometryValidation {
  vertices: number;
  indices: number;
  extents: [number, number, number];
  faceNormals: string[];
  frontFaceWinding: boolean;
  passed: boolean;
}

const FACE_NAMES = ["pos-x", "neg-x", "pos-y", "pos-z", "neg-z"];

/** Pixel-validates the production cube against the generated atlas center frames. */
export class TreeImpostorValidation {
  private readonly engine: AbstractEngine;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly fpsCounter: FpsCounter;

  constructor(engine: AbstractEngine) {
    this.engine = engine;
    this.scene = new Scene(this.engine);
    this.fpsCounter = new FpsCounter(this.scene);
    this.scene.clearColor = new Color4(0.055, 0.065, 0.075, 1);
    const light = new HemisphericLight("validationAmbient", Vector3.Up(), this.scene);
    light.intensity = 1;
    this.camera = new FreeCamera("validationCamera", new Vector3(0, 0, -4), this.scene);
    this.scene.activeCamera = this.camera;
  }

  async initialize(onProgress?: (step: string, progress: number) => void): Promise<void> {
    onProgress?.("Generating validation assets", 10);
    document.body.classList.add("impostor-mode");
    document.getElementById("attribution")?.remove();
    const prototype = await createTreeImpostorPrototype(this.scene, 2, "validationTree");
    onProgress?.("Validating cube faces", 50);
    const { mesh, assets, captureSize } = prototype;
    const geometry = validateCubeGeometry(mesh);
    mesh.thinInstanceSetBuffer("matrix", Float32Array.from(Matrix.Identity().asArray()), 16, true);
    mesh.thinInstanceRefreshBoundingInfo(true);
    (mesh.material as ShaderMaterial).setFloat("cameraOrthographic", 1);
    const resolution = assets.resolution;
    const centerSample = (assets.gridSize - 1) / 2;

    const target = new RenderTargetTexture(
      "treeImpostorValidationTarget",
      resolution,
      this.scene,
      false,
      false,
    );
    target.clearColor = new Color4(0, 0, 0, 0);
    target.renderList = [mesh];
    target.activeCamera = this.camera;
    target.ignoreCameraViewport = true;

    const panel = this.createPanel();
    const results: FaceValidation[] = [];
    const center = new Vector3(0, 1, 0);
    let frontView: Uint8ClampedArray | undefined;
    let topView: Uint8ClampedArray | undefined;
    let viewVariation = 0;
    let aboveVariation = 0;
    let aboveCoverage = 0;
    let topCoverage = 0;
    let minimumOrbitCoverage = 1;
    let maximumOrbitCoverage = 0;
    let maximumOrbitCoverageJump = 0;
    let minimumFaceSeamIou = 1;
    let demoIou = 0;
    let demoCoverageRatio = 0;
    let opaqueOutput = false;
    let minimumPerspectiveDemoIou = 1;
    let maximumPerspectiveCoverageError = 0;
    let maximumPerspectiveScaleError = 0;
    let maximumPerspectiveCenterError = 0;
    const perspectiveMeasurements: Array<Record<string, number>> = [];
    let firstOrbitCoverage = 0;
    let previousOrbitCoverage = 0;
    const demoReference = createDemoReference(this.scene, assets, captureSize, center);
    try {
      for (let index = 0; index < TREE_IMPOSTOR_FACES.length; index++) {
        const face = TREE_IMPOSTOR_FACES[index];
        this.camera.position.copyFrom(center.add(face.normal.scale(captureSize * 2)));
        this.camera.upVector.copyFrom(face.up);
        this.camera.setTarget(center);
        this.camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
        this.camera.minZ = 0.01;
        this.camera.maxZ = captureSize * 4;
        this.camera.orthoLeft = -captureSize / 2;
        this.camera.orthoRight = captureSize / 2;
        this.camera.orthoTop = captureSize / 2;
        this.camera.orthoBottom = -captureSize / 2;

        target.render(true);
        const rendered = await target.readPixels();
        if (!rendered) throw new Error(`GPU readback failed for ${FACE_NAMES[index]}.`);
        const actual = topDownPixels(rendered, resolution);
        if (index === 3) frontView = actual;
        if (index === 2) topView = actual;
        const context = assets.atlasCanvases[index].getContext("2d", { alpha: true })!;
        const expected = interpolatedAtlasFrame(
          context,
          resolution,
          assets.gridSize,
          centerSample,
          centerSample,
        );
        const comparisons = [
          compareAlpha(actual, expected, resolution, false, false),
          compareAlpha(actual, expected, resolution, true, false),
          compareAlpha(actual, expected, resolution, false, true),
          compareAlpha(actual, expected, resolution, true, true),
        ];
        const transformNames = ["none", "flip-x", "flip-y", "flip-xy"];
        let bestIndex = 0;
        for (let candidate = 1; candidate < comparisons.length; candidate++) {
          if (comparisons[candidate].iou > comparisons[bestIndex].iou) bestIndex = candidate;
        }
        const result: FaceValidation = {
          face: FACE_NAMES[index],
          iou: comparisons[0].iou,
          mismatch: comparisons[0].mismatch,
          atlasCoverage: alphaCoverage(expected),
          bestTransform: transformNames[bestIndex],
          bestIou: comparisons[bestIndex].iou,
        };
        results.push(result);
        panel.grid.appendChild(this.createComparisonCard(result, expected, actual, resolution));
      }

      const angledDirection = new Vector3(0.45, 0.15, 1).normalize();
      this.camera.position.copyFrom(center.add(angledDirection.scale(captureSize * 2)));
      this.camera.upVector.copyFrom(Vector3.Up());
      this.camera.setTarget(center);
      target.render(true);
      const angledPixels = await target.readPixels();
      if (!angledPixels || !frontView) throw new Error("Angled-view validation readback failed.");
      viewVariation = imageDifference(frontView, topDownPixels(angledPixels, resolution));

      const aboveDirection = new Vector3(0.45, 1, 0.35).normalize();
      this.camera.position.copyFrom(center.add(aboveDirection.scale(captureSize * 2)));
      this.camera.upVector.copyFrom(new Vector3(0, 0, -1));
      this.camera.setTarget(center);
      target.render(true);
      const abovePixels = await target.readPixels();
      if (!abovePixels || !topView) throw new Error("Above-view validation readback failed.");
      const obliqueAboveView = topDownPixels(abovePixels, resolution);
      topCoverage = alphaCoverage(topView);
      aboveVariation = imageDifference(topView, obliqueAboveView);
      aboveCoverage = alphaCoverage(obliqueAboveView);
      configureDemoReference(demoReference.material, aboveDirection, assets.gridSize, center);
      target.renderList = [demoReference.mesh];
      target.render(true);
      const demoPixels = await target.readPixels();
      if (!demoPixels) throw new Error("Demo-reference validation readback failed.");
      const demoView = topDownPixels(demoPixels, resolution);
      const demoCoverage = alphaCoverage(demoView);
      demoIou = compareAlpha(obliqueAboveView, demoView, resolution, false, false).iou;
      demoCoverageRatio = demoCoverage === 0 ? 0 : aboveCoverage / demoCoverage;
      opaqueOutput = hasOnlyBinaryAlpha(obliqueAboveView);
      panel.grid.appendChild(
        this.createAboveCard(topView, obliqueAboveView, demoView, resolution, aboveVariation, aboveCoverage, demoIou),
      );

      target.renderList = [mesh];
      for (let step = 0; step < 48; step++) {
        const azimuth = (step / 48) * Math.PI * 2;
        const orbitDirection = new Vector3(Math.cos(azimuth), 0.3, Math.sin(azimuth)).normalize();
        this.camera.position.copyFrom(center.add(orbitDirection.scale(captureSize * 2)));
        this.camera.upVector.copyFrom(Vector3.Up());
        this.camera.setTarget(center);
        target.render(true);
        const orbitPixels = await target.readPixels();
        if (!orbitPixels) throw new Error(`Orbit validation readback failed at step ${step}.`);
        const coverage = alphaCoverage(topDownPixels(orbitPixels, resolution));
        if (step === 0) firstOrbitCoverage = coverage;
        else maximumOrbitCoverageJump = Math.max(maximumOrbitCoverageJump, Math.abs(coverage - previousOrbitCoverage));
        previousOrbitCoverage = coverage;
        minimumOrbitCoverage = Math.min(minimumOrbitCoverage, coverage);
        maximumOrbitCoverage = Math.max(maximumOrbitCoverage, coverage);
      }
      maximumOrbitCoverageJump = Math.max(
        maximumOrbitCoverageJump,
        Math.abs(previousOrbitCoverage - firstOrbitCoverage),
      );

      for (let seam = 0; seam < 4; seam++) {
        const boundary = Math.PI / 4 + seam * Math.PI / 2;
        const seamViews: Uint8ClampedArray[] = [];
        for (const offset of [-0.005, 0.005]) {
          const direction = new Vector3(
            Math.cos(boundary + offset),
            0.3,
            Math.sin(boundary + offset),
          ).normalize();
          this.camera.position.copyFrom(center.add(direction.scale(captureSize * 2)));
          this.camera.upVector.copyFrom(Vector3.Up());
          this.camera.setTarget(center);
          target.render(true);
          const seamPixels = await target.readPixels();
          if (!seamPixels) throw new Error(`Face-seam validation failed at seam ${seam}.`);
          seamViews.push(topDownPixels(seamPixels, resolution));
        }
        minimumFaceSeamIou = Math.min(
          minimumFaceSeamIou,
          compareAlpha(seamViews[0], seamViews[1], resolution, false, false).iou,
        );
      }

      this.camera.mode = FreeCamera.PERSPECTIVE_CAMERA;
      this.camera.fov = 0.9;
      (mesh.material as ShaderMaterial).setFloat("cameraOrthographic", 0);
      const perspectiveDirection = new Vector3(0.45, 0.3, 1).normalize();
      for (const distance of [captureSize * 3, captureSize * 1.5]) {
        this.camera.position.copyFrom(center.add(perspectiveDirection.scale(distance)));
        this.camera.upVector.copyFrom(Vector3.Up());
        this.camera.setTarget(center);
        target.renderList = [mesh];
        target.render(true);
        const cubePixels = await target.readPixels();
        if (!cubePixels) throw new Error("Perspective cube validation readback failed.");
        const cubeView = topDownPixels(cubePixels, resolution);

        configureDemoReference(demoReference.material, perspectiveDirection, assets.gridSize, center);
        target.renderList = [demoReference.mesh];
        target.render(true);
        const referencePixels = await target.readPixels();
        if (!referencePixels) throw new Error("Perspective demo validation readback failed.");
        const referenceView = topDownPixels(referencePixels, resolution);
        minimumPerspectiveDemoIou = Math.min(
          minimumPerspectiveDemoIou,
          compareAlpha(cubeView, referenceView, resolution, false, false).iou,
        );
        maximumPerspectiveCoverageError = Math.max(
          maximumPerspectiveCoverageError,
          Math.abs(alphaCoverage(cubeView) - alphaCoverage(referenceView)),
        );
        const cubeBounds = alphaBounds(cubeView, resolution);
        const referenceBounds = alphaBounds(referenceView, resolution);
        maximumPerspectiveScaleError = Math.max(
          maximumPerspectiveScaleError,
          Math.abs(cubeBounds.width / referenceBounds.width - 1),
          Math.abs(cubeBounds.height / referenceBounds.height - 1),
        );
        maximumPerspectiveCenterError = Math.max(
          maximumPerspectiveCenterError,
          Math.hypot(cubeBounds.centerX - referenceBounds.centerX, cubeBounds.centerY - referenceBounds.centerY) / resolution,
        );
        perspectiveMeasurements.push({
          distance: distance / captureSize,
          cubeWidth: cubeBounds.width,
          cubeHeight: cubeBounds.height,
          referenceWidth: referenceBounds.width,
          referenceHeight: referenceBounds.height,
        });
        if (distance === captureSize * 1.5) {
          const card = document.createElement("article");
          card.innerHTML = `<h2>near perspective</h2><p>Cube versus demo at 1.5 proxy diameters</p><div><figure><figcaption>Cube</figcaption></figure><figure><figcaption>Demo</figcaption></figure></div>`;
          const figures = card.querySelectorAll("figure");
          figures[0].appendChild(imageCanvas(cubeView, resolution));
          figures[1].appendChild(imageCanvas(referenceView, resolution));
          panel.grid.appendChild(card);
        }
      }
    } finally {
      target.dispose();
      demoReference.mesh.dispose(false, true);
      demoReference.material.dispose(false, false);
    }

    const passed =
      geometry.passed &&
      results.every((result) => result.iou >= 0.9 && result.atlasCoverage >= 0.015) &&
      viewVariation >= 0.005 &&
      aboveVariation >= 0.01 &&
      minimumOrbitCoverage >= 0.015 &&
      minimumFaceSeamIou >= 0.7 &&
      demoIou >= 0.9 &&
      demoCoverageRatio >= 0.9 && demoCoverageRatio <= 1.1 &&
      opaqueOutput &&
      maximumPerspectiveCoverageError <= 0.01 &&
      maximumPerspectiveScaleError <= 0.05 &&
      maximumPerspectiveCenterError <= 0.02;
    panel.summary.textContent = passed
      ? `PASS: opaque cube proxy matches the demo across face seams and camera distances.`
      : "FAIL: cube geometry, face matching, or above-view rendering is invalid.";
    panel.summary.dataset.result = passed ? "pass" : "fail";
    panel.report.textContent = JSON.stringify(
      { geometry, viewVariation, topCoverage, aboveVariation, aboveCoverage, demoIou, demoCoverageRatio, opaqueOutput, minimumPerspectiveDemoIou, maximumPerspectiveCoverageError, maximumPerspectiveScaleError, maximumPerspectiveCenterError, perspectiveMeasurements, minimumOrbitCoverage, maximumOrbitCoverage, maximumOrbitCoverageJump, minimumFaceSeamIou, results },
      null,
      2,
    );
    (window as Window & { __impostorValidation?: unknown }).__impostorValidation = {
      complete: true,
      passed,
      geometry,
      viewVariation,
      topCoverage,
      aboveVariation,
      aboveCoverage,
      demoIou,
      demoCoverageRatio,
      opaqueOutput,
      minimumPerspectiveDemoIou,
      maximumPerspectiveCoverageError,
      maximumPerspectiveScaleError,
      maximumPerspectiveCenterError,
      perspectiveMeasurements,
      minimumOrbitCoverage,
      maximumOrbitCoverage,
      maximumOrbitCoverageJump,
      minimumFaceSeamIou,
      results,
    };
    console.log(
      "TREE_IMPOSTOR_VALIDATION",
      JSON.stringify({ passed, geometry, viewVariation, topCoverage, aboveVariation, aboveCoverage, demoIou, demoCoverageRatio, opaqueOutput, minimumPerspectiveDemoIou, maximumPerspectiveCoverageError, maximumPerspectiveScaleError, maximumPerspectiveCenterError, minimumOrbitCoverage, maximumOrbitCoverage, maximumOrbitCoverageJump, minimumFaceSeamIou, results }),
    );
    onProgress?.("Ready", 100);
  }

  run(): void {
    this.engine.runRenderLoop(() => {
      this.scene.render();
      this.fpsCounter.update(this.engine);
    });
  }

  resize(): void {
    this.engine.resize();
  }

  private createPanel(): { grid: HTMLElement; summary: HTMLElement; report: HTMLElement } {
    const panel = document.createElement("main");
    panel.id = "impostorValidation";
    panel.innerHTML = `
      <h1>Tree impostor validation</h1>
      <p id="validationSummary" data-result="running">Rendering five canonical views...</p>
      <section id="validationGrid"></section>
      <pre id="validationReport"></pre>`;
    document.body.appendChild(panel);
    return {
      grid: panel.querySelector("#validationGrid") as HTMLElement,
      summary: panel.querySelector("#validationSummary") as HTMLElement,
      report: panel.querySelector("#validationReport") as HTMLElement,
    };
  }

  private createComparisonCard(
    result: FaceValidation,
    expected: Uint8ClampedArray,
    actual: Uint8ClampedArray,
    size: number,
  ): HTMLElement {
    const card = document.createElement("article");
    card.innerHTML = `
      <h2>${result.face}</h2>
      <p>IoU ${result.iou.toFixed(4)} | atlas coverage ${(result.atlasCoverage * 100).toFixed(2)}% | best ${result.bestTransform}</p>
      <div><figure><figcaption>Atlas</figcaption></figure><figure><figcaption>Cube</figcaption></figure></div>`;
    const figures = card.querySelectorAll("figure");
    figures[0].appendChild(imageCanvas(expected, size));
    figures[1].appendChild(imageCanvas(actual, size));
    return card;
  }

  private createAboveCard(
    top: Uint8ClampedArray,
    oblique: Uint8ClampedArray,
    demo: Uint8ClampedArray,
    size: number,
    variation: number,
    coverage: number,
    demoIou: number,
  ): HTMLElement {
    const card = document.createElement("article");
    card.innerHTML = `
      <h2>above views</h2>
      <p>variation ${(variation * 100).toFixed(2)}% | coverage ${(coverage * 100).toFixed(2)}% | demo IoU ${demoIou.toFixed(4)}</p>
      <div><figure><figcaption>Straight down</figcaption></figure><figure><figcaption>Cube oblique</figcaption></figure><figure><figcaption>Demo reference</figcaption></figure></div>`;
    const figures = card.querySelectorAll("figure");
    figures[0].appendChild(imageCanvas(top, size));
    figures[1].appendChild(imageCanvas(oblique, size));
    figures[2].appendChild(imageCanvas(demo, size));
    return card;
  }
}

const demoVertexShader = `
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

const demoFragmentShader = `
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
uniform vec2 atlasTileCounts;
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
vec4 frame(vec2 tile) {
  vec2 localUV = mix(vec2(tileInset), vec2(1.0 - tileInset), vUV);
  return atlasSample((tile + localUV) / atlasTileCounts);
}
float bayer4(vec2 pixel) {
  vec2 p = mod(floor(pixel), 4.0);
  float i = p.x + p.y * 4.0;
  if (i < 0.5) return 0.0 / 16.0; if (i < 1.5) return 8.0 / 16.0;
  if (i < 2.5) return 2.0 / 16.0; if (i < 3.5) return 10.0 / 16.0;
  if (i < 4.5) return 12.0 / 16.0; if (i < 5.5) return 4.0 / 16.0;
  if (i < 6.5) return 14.0 / 16.0; if (i < 7.5) return 6.0 / 16.0;
  if (i < 8.5) return 3.0 / 16.0; if (i < 9.5) return 11.0 / 16.0;
  if (i < 10.5) return 1.0 / 16.0; if (i < 11.5) return 9.0 / 16.0;
  if (i < 12.5) return 15.0 / 16.0; if (i < 13.5) return 7.0 / 16.0;
  if (i < 14.5) return 13.0 / 16.0; return 5.0 / 16.0;
}
void main(void) {
  vec2 low = floor(samplePosition);
  vec2 high = min(low + 1.0, vec2(gridSize - 1.0));
  vec2 blend = fract(samplePosition);
  vec4 weights = vec4((1.0-blend.x)*(1.0-blend.y), blend.x*(1.0-blend.y), (1.0-blend.x)*blend.y, blend.x*blend.y);
  float choice = bayer4(gl_FragCoord.xy);
  vec4 color;
  if (choice < weights.x) color = frame(vec2(low.x, low.y));
  else if (choice < weights.x + weights.y) color = frame(vec2(high.x, low.y));
  else if (choice < weights.x + weights.y + weights.z) color = frame(vec2(low.x, high.y));
  else color = frame(vec2(high.x, high.y));
  float alphaChoice = bayer4(gl_FragCoord.xy + vec2(1.0, 2.0));
  if (color.a <= alphaChoice) discard;
  vec3 straightColor = color.rgb / max(color.a, 1.0 / 255.0);
  gl_FragColor = vec4(straightColor, 1.0);
}`;

function createDemoReference(
  scene: Scene,
  assets: TreeImpostorAssets,
  diameter: number,
  center: Vector3,
): { mesh: Mesh; material: ShaderMaterial } {
  const mesh = MeshBuilder.CreatePlane("demoReference", { size: 1 }, scene);
  const material = new ShaderMaterial("demoReferenceMaterial", scene, {
    vertexSource: demoVertexShader,
    fragmentSource: demoFragmentShader,
  }, {
    attributes: ["position", "uv"],
    uniforms: ["viewProjection", "center", "billboardRight", "billboardUp", "diameter", "samplePosition", "gridSize", "atlasTileCounts", "faceIndex", "tileInset"],
    samplers: ["atlas0", "atlas1", "atlas2", "atlas3", "atlas4", "atlas5"],
    needAlphaBlending: false,
  });
  material.backFaceCulling = false;
  material.setVector3("center", center);
  material.setFloat("diameter", diameter);
  material.setFloat("gridSize", assets.gridSize);
  material.setVector2("atlasTileCounts", new Vector2(assets.gridWidth, assets.gridHeight));
  material.setFloat("tileInset", 0.5 / assets.resolution);
  assets.textures.forEach((texture, index) => material.setTexture(`atlas${index}`, texture));
  mesh.material = material;
  return { mesh, material };
}

function configureDemoReference(
  material: ShaderMaterial,
  direction: Vector3,
  gridSize: number,
  center: Vector3,
): void {
  const absolute = new Vector3(Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z));
  const faceIndex = absolute.y >= absolute.x && absolute.y >= absolute.z
    ? direction.y >= 0 ? 2 : 5
    : absolute.x >= absolute.z
      ? direction.x >= 0 ? 0 : 1
      : direction.z >= 0 ? 3 : 4;
  const face = TREE_IMPOSTOR_FACES[faceIndex];
  const denominator = Math.max(0.0001, Vector3.Dot(direction, face.normal));
  const maxSample = gridSize - 1;
  material.setFloat("faceIndex", faceIndex);
  material.setVector2("samplePosition", new Vector2(
    Math.min(1, Math.max(0, (Vector3.Dot(direction, face.right) / denominator + 1) * 0.5)) * maxSample,
    Math.min(1, Math.max(0, (Vector3.Dot(direction, face.up) / denominator + 1) * 0.5)) * maxSample,
  ));
  material.setVector3("center", center);
  const right = Vector3.Cross(direction, face.up).normalize();
  material.setVector3("billboardRight", right);
  material.setVector3("billboardUp", Vector3.Cross(right, direction).normalize());
}

function validateCubeGeometry(mesh: import("@babylonjs/core").Mesh): GeometryValidation {
  const positions = mesh.getVerticesData("position") ?? [];
  const normals = mesh.getVerticesData("normal") ?? [];
  const indices = mesh.getIndices() ?? [];
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  const extents = maximum.map((value, axis) => value - minimum[axis]) as [number, number, number];
  const faceNormals = new Set<string>();
  for (let index = 0; index < normals.length; index += 3) {
    faceNormals.add(`${Math.round(normals[index])},${Math.round(normals[index + 1])},${Math.round(normals[index + 2])}`);
  }
  const expectedNormals = ["1,0,0", "-1,0,0", "0,1,0", "0,0,1", "0,0,-1", "0,-1,0"];
  let frontFaceWinding = true;
  for (let index = 0; index < indices.length; index += 3) {
    const first = Vector3.FromArray(positions, indices[index] * 3);
    const second = Vector3.FromArray(positions, indices[index + 1] * 3);
    const third = Vector3.FromArray(positions, indices[index + 2] * 3);
    const geometricNormal = Vector3.Cross(second.subtract(first), third.subtract(first)).normalize();
    const storedNormal = Vector3.FromArray(normals, indices[index] * 3);
    if (Vector3.Dot(geometricNormal, storedNormal) > -0.99) frontFaceWinding = false;
  }
  return {
    vertices: positions.length / 3,
    indices: indices.length,
    extents,
    faceNormals: [...faceNormals].sort(),
    frontFaceWinding,
    passed:
      positions.length / 3 === 24 &&
      indices.length === 36 &&
      extents.every((extent) => extent > 0) &&
      frontFaceWinding &&
      expectedNormals.every((normal) => faceNormals.has(normal)),
  };
}

function topDownPixels(pixels: ArrayBufferView, size: number): Uint8ClampedArray {
  const input = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const output = new Uint8ClampedArray(input.length);
  for (let y = 0; y < size; y++) {
    const source = (size - 1 - y) * size * 4;
    output.set(input.subarray(source, source + size * 4), y * size * 4);
  }
  return output;
}

function interpolatedAtlasFrame(
  context: CanvasRenderingContext2D,
  resolution: number,
  gridSize: number,
  sampleX: number,
  sampleY: number,
): Uint8ClampedArray {
  const lowX = Math.floor(sampleX);
  const lowY = Math.floor(sampleY);
  const highX = Math.min(lowX + 1, gridSize - 1);
  const highY = Math.min(lowY + 1, gridSize - 1);
  const blendX = sampleX - lowX;
  const blendY = sampleY - lowY;
  const thresholds = [
    (1 - blendX) * (1 - blendY),
    (1 - blendX) * (1 - blendY) + blendX * (1 - blendY),
    (1 - blendX) * (1 - blendY) + blendX * (1 - blendY) + (1 - blendX) * blendY,
  ];
  const tiles = [
    [lowX, lowY],
    [highX, lowY],
    [lowX, highY],
    [highX, highY],
  ].map(([x, y]) => context.getImageData(
    x * resolution,
    y * resolution,
    resolution,
    resolution,
  ).data);
  const output = new Uint8ClampedArray(resolution * resolution * 4);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const choice = bayer4Cpu(x, resolution - 1 - y);
      const tileIndex = choice < thresholds[0] ? 0 : choice < thresholds[1] ? 1 : choice < thresholds[2] ? 2 : 3;
      const pixel = (y * resolution + x) * 4;
      output.set(tiles[tileIndex].subarray(pixel, pixel + 4), pixel);
    }
  }
  return output;
}

function bayer4Cpu(x: number, y: number): number {
  const values = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  return values[(x & 3) + (y & 3) * 4] / 16;
}

function compareAlpha(
  actual: Uint8ClampedArray,
  expected: Uint8ClampedArray,
  size: number,
  flipX: boolean,
  flipY: boolean,
): { iou: number; mismatch: number } {
  let intersection = 0;
  let union = 0;
  let mismatches = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const expectedX = flipX ? size - 1 - x : x;
      const expectedY = flipY ? size - 1 - y : y;
      const actualOpaque = actual[(y * size + x) * 4 + 3] >= 128;
      const expectedOpaque = expected[(expectedY * size + expectedX) * 4 + 3] >= 128;
      if (actualOpaque && expectedOpaque) intersection++;
      if (actualOpaque || expectedOpaque) union++;
      if (actualOpaque !== expectedOpaque) mismatches++;
    }
  }
  return {
    iou: union === 0 ? 1 : intersection / union,
    mismatch: mismatches / (size * size),
  };
}

function alphaCoverage(pixels: Uint8ClampedArray): number {
  let opaque = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] >= 128) opaque++;
  }
  return opaque / (pixels.length / 4);
}

function hasOnlyBinaryAlpha(pixels: Uint8ClampedArray): boolean {
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 0 && pixels[index] !== 255) return false;
  }
  return true;
}

function alphaBounds(
  pixels: Uint8ClampedArray,
  size: number,
): { width: number; height: number; centerX: number; centerY: number } {
  let minimumX = size;
  let minimumY = size;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pixels[(y * size + x) * 4 + 3] < 128) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  if (maximumX < minimumX || maximumY < minimumY) {
    return { width: 0, height: 0, centerX: 0, centerY: 0 };
  }
  return {
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
    centerX: (minimumX + maximumX) / 2,
    centerY: (minimumY + maximumY) / 2,
  };
}

function imageDifference(first: Uint8ClampedArray, second: Uint8ClampedArray): number {
  let difference = 0;
  for (let index = 0; index < first.length; index++) {
    difference += Math.abs(first[index] - second[index]);
  }
  return difference / (first.length * 255);
}

function imageCanvas(pixels: Uint8ClampedArray, size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.putImageData(new ImageData(Uint8ClampedArray.from(pixels), size, size), 0, 0);
  return canvas;
}
