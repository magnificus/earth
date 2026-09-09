import { directionalExposureDeclaration, registerExposureCutout } from "../DirectionalExposure";
import {
  Color3,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  Mesh,
  RawTexture,
  Scene,
  ShadowDepthWrapper,
  ShaderMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { createSeededRandom } from "../Random";
import {
  bindCloudShadowReceiver,
  cloudShadowFragmentDeclaration,
  cloudShadowVertexDeclaration,
  CLOUD_SHADOW_UNIFORMS,
} from "../CloudShadows";
import {
  bindVegetationShadowReceiver,
  vegetationShadowFragmentDeclaration,
  vegetationShadowVertexDeclaration,
} from "../VegetationShadowReceiver";
import {
  bindWindPhase,
  setWindShear,
  windPhaseVertexDeclaration,
  windShearVertexDeclaration,
  WIND_PHASE_UNIFORMS,
  WIND_SHEAR_UNIFORMS,
} from "../Wind";
import {
  initializeSeasonalFoliage,
  seasonalFoliageFragmentDeclaration,
  seasonalFoliageVertexDeclaration,
  SEASONAL_FOLIAGE_UNIFORMS,
} from "../SeasonalFoliage";

const BARK_TEXTURE_SIZE = 512;

export type TreeBarkStyle =
  | "acacia"
  | "beech"
  | "birch"
  | "eucalyptus"
  | "fir"
  | "kapok"
  | "mangrove"
  | "maple"
  | "oak"
  | "palm"
  | "pine"
  | "spruce";

const barkTextures = new WeakMap<Scene, Map<TreeBarkStyle, DynamicTexture>>();
const textureReadiness = new WeakMap<ShaderMaterial, Promise<void>>();
const fallbackWhiteTextures = new WeakMap<Scene, RawTexture>();

function fallbackWhiteTexture(scene: Scene): RawTexture {
  const cached = fallbackWhiteTextures.get(scene);
  if (cached) return cached;
  const texture = RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  texture.name = "fallbackWhiteTexture";
  fallbackWhiteTextures.set(scene, texture);
  return texture;
}

const BARK_SEEDS: Record<TreeBarkStyle, number> = {
  acacia: 0x41434143,
  beech: 0x42454543,
  birch: 0x42495243,
  eucalyptus: 0x45554341,
  fir: 0x46495221,
  kapok: 0x4b41504f,
  mangrove: 0x4d414e47,
  maple: 0x4d41504c,
  oak: 0x4f414b21,
  palm: 0x50414c4d,
  pine: 0x50494e45,
  spruce: 0x53505255,
};

const BARK_BASE: Record<TreeBarkStyle, readonly [number, number, number]> = {
  acacia: [157, 139, 111],
  beech: [181, 181, 169],
  birch: [229, 226, 216],
  eucalyptus: [174, 158, 128],
  fir: [151, 143, 128],
  kapok: [164, 160, 142],
  mangrove: [139, 124, 99],
  maple: [160, 148, 127],
  oak: [151, 133, 105],
  palm: [165, 137, 98],
  pine: [157, 128, 94],
  spruce: [145, 137, 122],
};

/** Builds and caches a seamless, deterministic bark texture for each species. */
export function getTreeBarkTexture(scene: Scene, species: TreeBarkStyle): DynamicTexture {
  let sceneTextures = barkTextures.get(scene);
  if (!sceneTextures) {
    sceneTextures = new Map();
    barkTextures.set(scene, sceneTextures);
  }
  const cached = sceneTextures.get(species);
  if (cached) return cached;

  const size = BARK_TEXTURE_SIZE;
  const texture = new DynamicTexture(
    `procedural${species[0].toUpperCase()}${species.slice(1)}Bark`,
    { width: size, height: size },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  const pixels = context.createImageData(size, size);

  const base = BARK_BASE[species];
  const verticalSpecies = species !== "birch" && species !== "beech" && species !== "palm";
  const seedPhase = (BARK_SEEDS[species] & 0xff) / 255 * Math.PI * 2;
  // Several periodic frequencies make a seamless, non-flat substrate. Drawing
  // the large bark structures over this retains fine detail in close-up.
  for (let y = 0; y < size; y++) {
    const vertical = Math.PI * 2 * y / size;
    for (let x = 0; x < size; x++) {
      const horizontal = Math.PI * 2 * x / size;
      const grain = verticalSpecies
        ? Math.sin(horizontal * 29 + Math.sin(vertical * 3 + seedPhase) * 1.5) * 5.5
        : Math.sin(vertical * 35 + Math.sin(horizontal * 3 + seedPhase) * 0.9) * 3.5;
      const broadMottle = Math.sin(horizontal * 3 + vertical * 2 + seedPhase) * 7
        + Math.cos(horizontal * 8 - vertical * 5 - seedPhase) * 3
        + Math.sin(horizontal * 17 + vertical * 13) * 1.5;
      const offset = (y * size + x) * 4;
      pixels.data[offset] = base[0] + grain + broadMottle;
      pixels.data[offset + 1] = base[1] + grain + broadMottle;
      pixels.data[offset + 2] = base[2] + grain + broadMottle * 0.7;
      pixels.data[offset + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);

  const random = createSeededRandom(BARK_SEEDS[species]);
  const wrapped = (draw: (xShift: number, yShift: number) => void): void => {
    for (const yShift of [-size, 0, size]) {
      for (const xShift of [-size, 0, size]) draw(xShift, yShift);
    }
  };
  const strokeHorizontal = (
    x: number,
    y: number,
    width: number,
    bend: number,
    lineWidth: number,
    color: string,
  ): void => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    wrapped((xShift, yShift) => {
      context.beginPath();
      context.moveTo(x + xShift - width / 2, y + yShift);
      context.bezierCurveTo(
        x + xShift - width * 0.18, y + yShift + bend,
        x + xShift + width * 0.2, y + yShift - bend * 0.35,
        x + xShift + width / 2, y + yShift + bend * 0.15,
      );
      context.stroke();
    });
  };
  const strokeVertical = (
    x: number,
    y: number,
    height: number,
    sway: number,
    lineWidth: number,
    color: string,
  ): void => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    wrapped((xShift, yShift) => {
      context.beginPath();
      context.moveTo(x + xShift, y + yShift - height / 2);
      context.bezierCurveTo(
        x + xShift + sway, y + yShift - height * 0.18,
        x + xShift - sway, y + yShift + height * 0.2,
        x + xShift + sway * 0.25, y + yShift + height / 2,
      );
      context.stroke();
    });
  };
  const barkChip = (
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    outline?: string,
  ): void => {
    wrapped((xShift, yShift) => {
      context.beginPath();
      context.moveTo(x + xShift - width * 0.46, y + yShift - height * 0.25);
      context.lineTo(x + xShift - width * 0.2, y + yShift - height * 0.5);
      context.lineTo(x + xShift + width * 0.42, y + yShift - height * 0.34);
      context.lineTo(x + xShift + width * 0.5, y + yShift + height * 0.18);
      context.lineTo(x + xShift + width * 0.12, y + yShift + height * 0.5);
      context.lineTo(x + xShift - width * 0.5, y + yShift + height * 0.28);
      context.closePath();
      context.fillStyle = color;
      context.fill();
      if (outline) {
        context.strokeStyle = outline;
        context.lineWidth = 1.2;
        context.stroke();
      }
    });
  };

  if (species === "birch") {
    for (let index = 0; index < 190; index++) {
      strokeHorizontal(random() * size, random() * size, 5 + random() * 25,
        (random() - 0.5) * 2.2, 0.45 + random() * 1.1,
        `rgba(58, 54, 48, ${0.16 + random() * 0.3})`);
    }
    for (let index = 0; index < 24; index++) {
      const x = random() * size;
      const y = random() * size;
      const width = 25 + random() * 72;
      const bend = (random() - 0.5) * 5;
      strokeHorizontal(x, y + 1.4, width, bend, 4 + random() * 4, "rgba(65,60,52,0.13)");
      strokeHorizontal(x, y, width, bend, 1.2 + random() * 2.2, "rgba(42,40,36,0.68)");
      strokeHorizontal(x, y - 1.2, width * 0.76, -bend * 0.5, 0.8, "rgba(255,252,240,0.7)");
    }
  } else if (species === "beech") {
    // Smooth elephant-grey bark with subtle horizontal lenticels and old scars.
    for (let mark = 0; mark < 130; mark++) {
      strokeHorizontal(random() * size, random() * size, 4 + random() * 19,
        (random() - 0.5) * 1.6, 0.5 + random() * 1.3, "rgba(52,58,49,0.28)");
    }
    for (let scar = 0; scar < 18; scar++) {
      const x = random() * size;
      const y = random() * size;
      const radius = 4 + random() * 11;
      const rotation = random() - 0.5;
      context.strokeStyle = "rgba(69,67,57,0.42)";
      context.lineWidth = 1 + random() * 2;
      wrapped((xs, ys) => {
        context.beginPath();
        context.ellipse(x + xs, y + ys, radius, radius * 0.45, rotation, 0, Math.PI * 2);
        context.stroke();
      });
    }
  } else if (species === "palm") {
    // Overlapping diamond-shaped frond bases with loose vertical fibres.
    const rows = 14;
    const columns = 11;
    for (let row = -1; row <= rows; row++) {
      for (let column = -1; column <= columns; column++) {
        const x = (column + 0.5 * (row & 1)) * size / columns;
        const y = row * size / rows;
        barkChip(x, y, size / columns * 0.92, size / rows * 0.9,
          "rgba(202,165,111,0.34)", "rgba(76,50,28,0.48)");
      }
    }
    for (let fibre = 0; fibre < 55; fibre++) {
      strokeVertical(random() * size, random() * size, 18 + random() * 65,
        (random() - 0.5) * 6, 0.6 + random() * 1.5, "rgba(73,48,27,0.34)");
    }
  } else if (species === "eucalyptus") {
    // Long peeling ribbons expose cream, ochre, sage and cinnamon layers.
    const peelColors = [
      "rgba(246,230,190,0.62)", "rgba(145,113,80,0.44)",
      "rgba(116,128,100,0.33)", "rgba(218,171,113,0.46)",
    ];
    for (let strip = 0; strip < 45; strip++) {
      const x = random() * size;
      strokeVertical(x, random() * size, 90 + random() * 330, 6 + random() * 22,
        7 + random() * 24, peelColors[Math.floor(random() * peelColors.length)]);
      strokeVertical(x + 2, random() * size, 70 + random() * 180, 8 + random() * 13,
        0.7 + random() * 1.4, "rgba(78,57,39,0.32)");
    }
  } else if (species === "oak") {
    // Massive interrupted ridges and dark, block-forming fissures.
    for (let groove = 0; groove < 28; groove++) {
      strokeVertical((groove + random() * 0.65) * size / 28, size * 0.5,
        size * 1.15, 12 + random() * 22, 5 + random() * 7, "rgba(55,46,34,0.58)");
    }
    for (let cross = 0; cross < 115; cross++) {
      strokeHorizontal(random() * size, random() * size, 10 + random() * 34,
        (random() - 0.5) * 7, 1.5 + random() * 3.5, "rgba(61,49,35,0.46)");
    }
  } else if (species === "pine") {
    // Warm puzzle-like plates sit over nearly black red-brown crevices.
    for (let chip = 0; chip < 165; chip++) {
      barkChip(random() * size, random() * size, 15 + random() * 32, 12 + random() * 42,
        random() < 0.45 ? "rgba(207,164,109,0.4)" : "rgba(151,111,73,0.34)",
        "rgba(72,56,40,0.56)");
    }
  } else if (species === "spruce") {
    // Small cool-grey scales flake away in irregular vertical columns.
    for (let chip = 0; chip < 230; chip++) {
      barkChip(random() * size, random() * size, 7 + random() * 18, 12 + random() * 29,
        random() < 0.3 ? "rgba(183,170,143,0.3)" : "rgba(82,72,60,0.28)",
        "rgba(62,57,49,0.34)");
    }
  } else if (species === "fir") {
    // Fir is finely plated, with horizontal resin blisters and pitch marks.
    for (let groove = 0; groove < 58; groove++) {
      strokeVertical((groove + random() * 0.8) * size / 58, size * 0.5,
        size * 1.1, 3 + random() * 9, 1 + random() * 2.4, "rgba(65,58,48,0.4)");
    }
    for (let blister = 0; blister < 90; blister++) {
      strokeHorizontal(random() * size, random() * size, 5 + random() * 18,
        (random() - 0.5) * 2, 1 + random() * 2.5,
        random() < 0.18 ? "rgba(224,177,99,0.5)" : "rgba(66,58,47,0.4)");
    }
  } else if (species === "maple") {
    // Narrow curling plates create the shaggy vertical character of old maple.
    for (let strip = 0; strip < 78; strip++) {
      const x = random() * size;
      strokeVertical(x, random() * size, 35 + random() * 150, 4 + random() * 12,
        4 + random() * 8, "rgba(205,188,154,0.25)");
      strokeVertical(x - 3, random() * size, 30 + random() * 120, 3 + random() * 8,
        1 + random() * 2, "rgba(62,53,42,0.44)");
    }
  } else if (species === "kapok") {
    // A smooth pale bole in constant damp: broad moss and lichen patches over
    // the grey, with the small dark scars of shed thorns scattered between.
    for (let patch = 0; patch < 70; patch++) {
      barkChip(random() * size, random() * size, 22 + random() * 64, 14 + random() * 44,
        random() < 0.62 ? "rgba(92,122,70,0.24)" : "rgba(176,182,152,0.22)",
        "rgba(84,108,66,0.1)");
    }
    for (let scar = 0; scar < 80; scar++) {
      strokeHorizontal(random() * size, random() * size, 3 + random() * 7,
        (random() - 0.5) * 2, 1.5 + random() * 2, "rgba(58,50,40,0.42)");
    }
  } else if (species === "mangrove") {
    // Wet, rope-like ridges with pale horizontal lenticels.
    for (let ridge = 0; ridge < 25; ridge++) {
      const x = (ridge + random() * 0.7) * size / 25;
      strokeVertical(x, size * 0.5, size * 1.15, 16 + random() * 28,
        8 + random() * 11, "rgba(67,57,43,0.5)");
      strokeVertical(x + 3, size * 0.5, size * 1.15, 10 + random() * 22,
        2 + random() * 4, "rgba(147,127,88,0.32)");
    }
    for (let mark = 0; mark < 75; mark++) {
      strokeHorizontal(random() * size, random() * size, 5 + random() * 18,
        (random() - 0.5) * 3, 0.8 + random() * 1.5, "rgba(195,178,136,0.32)");
    }
  } else {
    // Acacia: interlocking dry plates crossed by angular, charcoal fissures.
    for (let chip = 0; chip < 145; chip++) {
      barkChip(random() * size, random() * size, 16 + random() * 35, 18 + random() * 50,
        random() < 0.35 ? "rgba(201,174,126,0.34)" : "rgba(119,94,62,0.25)",
        "rgba(48,38,28,0.62)");
    }
  }

  texture.gammaSpace = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.update(false);
  sceneTextures.set(species, texture);
  return texture;
}

/** Preserves capture colors and optionally gives live models soft sun lighting. */
export function createVertexColorCaptureMaterial(
  scene: Scene,
  name: string,
  liveLighting = false,
  leafTextureUrl?: string,
  barkTexture?: Texture,
  lowLightAlbedoScale = 1,
): ShaderMaterial {
  const material = new ShaderMaterial(
    name,
    scene,
    {
      vertexSource: `
        precision highp float;
        attribute vec3 position;
        attribute vec3 normal;
        attribute vec4 color;
        attribute vec2 uv;
        #ifdef THIN_INSTANCES
        attribute vec3 vegetationColor;
        attribute float instanceLodBlend;
        #endif
        uniform mat4 viewProjection;
        uniform float modelHeight;
        #ifdef TREE_EXPOSURE
        attribute vec4 sunExposureLow;
        attribute vec4 sunExposureHigh;
        uniform vec3 sunDirection;
        varying vec4 vSunExposureLow;
        varying vec4 vSunExposureHigh;
        varying vec3 vExposureSunDirection;
        #endif
        ${vegetationShadowVertexDeclaration}
        ${cloudShadowVertexDeclaration}
        ${windPhaseVertexDeclaration}
        ${windShearVertexDeclaration}
        ${seasonalFoliageVertexDeclaration}
        #include<instancesDeclaration>
        varying vec4 vColor;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vObjectPosition;
        varying float vHeight01;
        varying vec3 vInstanceColor;
        varying float vInstanceLodBlend;
        void main(void) {
          #include<instancesVertex>
          mat3 rotation = mat3(
            normalize(finalWorld[0].xyz),
            normalize(finalWorld[1].xyz),
            normalize(finalWorld[2].xyz)
          );
          vColor = color;
          #ifdef TREE_EXPOSURE
          vSunExposureLow = sunExposureLow;
          vSunExposureHigh = sunExposureHigh;
          vExposureSunDirection = vec3(dot(sunDirection, rotation[0]), dot(sunDirection, rotation[1]), dot(sunDirection, rotation[2]));
          #endif
          vUv = uv;
          vWorldNormal = normalize(rotation * normal);
          vObjectPosition = position / max(modelHeight, 0.0001);
          vHeight01 = clamp(position.y / max(modelHeight, 0.0001), 0.0, 1.0);
          #ifdef THIN_INSTANCES
          vInstanceColor = vegetationColor;
          vInstanceLodBlend = instanceLodBlend;
          #else
          vInstanceColor = vec3(1.0);
          vInstanceLodBlend = 1.0;
          #endif
          vec3 instanceOrigin = finalWorld[3].xyz;
          vSeasonProgress = seasonInstanceProgress(instanceOrigin);
          vSeasonTint = seasonInstanceTint(instanceOrigin);
          vec3 windPosition = position + windShearOffset(
            position,
            0.0,
            windLocalDirection(rotation[0], rotation[2]),
            windBend(instanceOrigin)
          );
          vec4 worldPosition = finalWorld * vec4(windPosition, 1.0);
          vCloudShadowWorldXZ = instanceOrigin.xz;
          vec4 shadowWorldPosition = mix(
            worldPosition,
            finalWorld * vec4(0.0, 0.0, 0.0, 1.0),
            vegetationShadowAtInstanceRoot
          );
          vVegetationShadowPosition = vegetationShadowMatrix * shadowWorldPosition;
          gl_Position = viewProjection * worldPosition;
        }
      `,
      fragmentSource: `
        precision highp float;
        varying vec4 vColor;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vObjectPosition;
        varying float vHeight01;
        varying vec3 vInstanceColor;
        varying float vInstanceLodBlend;
        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        uniform vec3 skyColor;
        uniform vec3 groundColor;
        uniform float lightingEnabled;
        uniform float leafTextureEnabled;
        uniform float barkTextureEnabled;
        uniform float lowLightAlbedoScale;
        uniform float rockTextureStrength;
        uniform float instanceColorCoverage;
        uniform float fieldFade;
        uniform float groundColorBlend;
        uniform vec3 distanceGroundColor;
        uniform sampler2D leafTexture;
        uniform sampler2D barkTexture;
        uniform float exposureCaptureBand;
        #ifdef TREE_EXPOSURE
        varying vec4 vSunExposureLow;
        varying vec4 vSunExposureHigh;
        varying vec3 vExposureSunDirection;
        #endif
        ${directionalExposureDeclaration}
        ${vegetationShadowFragmentDeclaration}
        ${cloudShadowFragmentDeclaration}
        ${seasonalFoliageFragmentDeclaration}
        float bayer4(vec2 pixel) {
          vec2 p = mod(floor(pixel), 4.0);
          vec2 low = mod(p, 2.0);
          vec2 high = floor(p * 0.5);
          float lowValue = 2.0 * low.x + low.y * (3.0 - 4.0 * low.x);
          float highValue = 2.0 * high.x + high.y * (3.0 - 4.0 * high.x);
          return (4.0 * lowValue + highValue) / 16.0;
        }
        float rockHash(vec3 point) {
          return fract(sin(dot(point, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        float rockNoise(vec3 point) {
          vec3 cell = floor(point);
          vec3 local = fract(point);
          local = local * local * (3.0 - 2.0 * local);
          return mix(
            mix(
              mix(rockHash(cell), rockHash(cell + vec3(1.0, 0.0, 0.0)), local.x),
              mix(rockHash(cell + vec3(0.0, 1.0, 0.0)), rockHash(cell + vec3(1.0, 1.0, 0.0)), local.x),
              local.y
            ),
            mix(
              mix(rockHash(cell + vec3(0.0, 0.0, 1.0)), rockHash(cell + vec3(1.0, 0.0, 1.0)), local.x),
              mix(rockHash(cell + vec3(0.0, 1.0, 1.0)), rockHash(cell + vec3(1.0, 1.0, 1.0)), local.x),
              local.y
            ),
            local.z
          );
        }
        void main(void) {
          if (vInstanceLodBlend <= bayer4(gl_FragCoord.xy + vec2(2.0, 1.0))) discard;
          // Whole-field dither lets streamed tiles fade their vegetation in
          // and out without true transparency.
          if (fieldFade < 0.999 && bayer4(gl_FragCoord.xy + vec2(1.0, 3.0)) >= fieldFade) discard;
          vec3 surfaceColor = vColor.rgb;
          // Rock sources opt into a scale-stable mineral texture. Unlike
          // per-vertex tint, this is evaluated for every captured/live pixel,
          // preserving fine detail across even the low-poly beach pebbles.
          vec3 rockPoint = vObjectPosition;
          float rockMottle = rockNoise(rockPoint * 18.0) - 0.5;
          float rockGrain = rockNoise(rockPoint * 67.0 + vec3(9.7, 3.1, 5.3)) - 0.5;
          float mineralFleck = smoothstep(
            0.91,
            0.98,
            rockNoise(rockPoint * 103.0 + vec3(17.0, 29.0, 11.0))
          );
          vec3 rockTexture = vec3(1.0 + rockMottle * 0.16 + rockGrain * 0.075)
            + mineralFleck * vec3(0.08, 0.075, 0.065);
          surfaceColor *= mix(vec3(1.0), rockTexture, rockTextureStrength);
          if (vUv.x >= 1.5) {
            if (barkTextureEnabled > 0.5) {
              surfaceColor *= texture2D(barkTexture, vec2(vUv.x - 2.0, vUv.y)).rgb;
            }
          } else if (leafTextureEnabled > 0.5 && vUv.x >= 0.0) {
            vec4 leafSample = texture2D(leafTexture, vUv);
            if (leafSample.a < 0.5) discard;
            surfaceColor *= leafSample.rgb;
          }
          vec3 normal = normalize(vWorldNormal);
          if (normal.y < 0.0) normal = -normal;
          // A foliage card's normal describes the arbitrary plane used to hold
          // the cutout, not the direction of the many leaves pictured on it.
          // Lighting that plane directly makes otherwise identical needles
          // jump between dark and bright as different crossed cards come into
          // view. Give foliage a stable canopy normal; retain shaped normals
          // for bark and cut branch ends.
          float foliageMask = step(0.0, vUv.x) * (1.0 - step(1.5, vUv.x));
          // Seasonal data band: each leaf's baked turning phase (vertex colour
          // alpha) and the foliage mask that keeps bark untinted in impostors.
          if (exposureCaptureBand > 2.5) {
            gl_FragColor = vec4(vColor.a, foliageMask, 0.0, 1.0);
            return;
          }
          surfaceColor = seasonFoliageColor(surfaceColor, vColor.a, foliageMask);
          float exposureScale = 1.0;
          #ifdef TREE_EXPOSURE
          if (exposureCaptureBand > 0.5) {
            gl_FragColor = mix(vec4(0.7884615385), exposureCaptureBand < 1.5 ? vSunExposureLow : vSunExposureHigh, foliageMask);
            return;
          }
          exposureScale = mix(1.0, exposureSunlightScale(directionalExposure(
            vSunExposureLow, vSunExposureHigh, normalize(vExposureSunDirection)
          )), foliageMask);
          #endif
          normal = normalize(mix(
            normal,
            vec3(0.0, 1.0, 0.0),
            mix(0.58, 1.0, foliageMask)
          ));

          float upward = normal.y * 0.5 + 0.5;
          vec3 ambientColor = mix(groundColor, skyColor, upward);
          float direct = max(0.0, (dot(normal, sunDirection) + 0.42) / 1.42);
          float shadowVisibility = vegetationShadowVisibility();
          vec3 lighting = clamp(
            ambientColor + sunColor * (0.16 + direct * 0.62) * shadowVisibility * exposureScale,
            vec3(0.0),
            vec3(1.25)
          );
          float crownLight = mix(0.62, 1.10, smoothstep(0.08, 0.92, vHeight01));
          // Keep live vegetation readable when direct sunlight has faded out.
          lighting = clamp(lighting * crownLight, vec3(0.18), vec3(1.25));
          lighting = mix(vec3(1.0), lighting, lightingEnabled);
          lighting *= mix(1.0, vegetationCloudShadowVisibility(), lightingEnabled);
          float sceneBrightness = max(
            max(skyColor.r, max(skyColor.g, skyColor.b)),
            max(sunColor.r, max(sunColor.g, sunColor.b))
          );
          float lowLightBlend = (1.0 - smoothstep(0.22, 0.58, sceneBrightness))
            * lightingEnabled;
          surfaceColor *= mix(1.0, lowLightAlbedoScale, lowLightBlend);
          float petalMask = smoothstep(0.68, 0.86, min(surfaceColor.r, min(surfaceColor.g, surfaceColor.b)));
          float instanceColorMask = max(petalMask, instanceColorCoverage);
          vec3 instanceColor = mix(surfaceColor, surfaceColor * vInstanceColor, instanceColorMask);
          instanceColor = mix(
            instanceColor,
            distanceGroundColor * vInstanceColor,
            groundColorBlend
          );
          gl_FragColor = vec4(instanceColor * lighting, 1.0);
        }
      `,
    },
    {
      // WebGPU's ShaderMaterial path automatically adds the conventional
      // color buffer. Listing it again assigns the same shader location twice
      // and invalidates the pipeline.
      attributes: scene.getEngine().isWebGPU
        ? ["position", "normal", "uv", "vegetationColor", "instanceLodBlend"]
        : ["position", "normal", "color", "uv", "vegetationColor", "instanceLodBlend"],
      uniforms: [
        "world",
        "viewProjection",
        "sunDirection",
        "sunColor",
        "skyColor",
        "groundColor",
        "lightingEnabled",
        "exposureCaptureBand",
        "modelHeight",
        "leafTextureEnabled",
        "barkTextureEnabled",
        "lowLightAlbedoScale",
        "rockTextureStrength",
        "instanceColorCoverage",
        "fieldFade",
        "groundColorBlend",
        "distanceGroundColor",
        "vegetationShadowMatrix",
        "vegetationShadowAtInstanceRoot",
        "vegetationShadowTexelSize",
        "vegetationShadowDepthValues",
        "vegetationShadowEnabled",
        "vegetationShadowReverseDepth",
        "vegetationShadowDarkness",
        "vegetationShadowFloatTexture",
        ...CLOUD_SHADOW_UNIFORMS,
        ...WIND_PHASE_UNIFORMS,
        ...WIND_SHEAR_UNIFORMS,
        ...SEASONAL_FOLIAGE_UNIFORMS,
      ],
      samplers: ["leafTexture", "barkTexture", "vegetationShadowSampler", "cloudShadowAtlas"],
      needAlphaBlending: false,
    },
  );
  material.backFaceCulling = false;
  // Keep the model shader's leaf alpha test and complementary LOD dither in
  // the shadow pass, rather than casting the opaque bounds of the cards.
  const shadowDepthWrapper = new ShadowDepthWrapper(material, scene, {
    remappedVariables: ["worldPos", "worldPosition"],
  });
  material.shadowDepthWrapper = shadowDepthWrapper;
  material.onDisposeObservable.addOnce(() => shadowDepthWrapper.dispose());
  bindVegetationShadowReceiver(material, scene);
  bindCloudShadowReceiver(material, scene);
  // WebGPU requires every declared sampler to have a binding even when a
  // uniform-controlled branch does not sample it.
  const fallbackTexture = fallbackWhiteTexture(scene);
  material.setTexture("leafTexture", fallbackTexture);
  material.setTexture("barkTexture", fallbackTexture);
  material.setFloat("lightingEnabled", liveLighting ? 1 : 0);
  material.setFloat("exposureCaptureBand", 0);
  initializeSeasonalFoliage(material);
  registerExposureCutout(material, leafTextureUrl);
  material.setFloat("modelHeight", 1);
  material.setFloat("leafTextureEnabled", 0);
  material.setFloat("barkTextureEnabled", barkTexture ? 1 : 0);
  material.setFloat("lowLightAlbedoScale", lowLightAlbedoScale);
  material.setFloat("rockTextureStrength", 0);
  material.setFloat("instanceColorCoverage", 0);
  // Species opt into wind explicitly; trees remain still.
  setWindShear(material, 0);
  material.setFloat("fieldFade", 1);
  material.setFloat("groundColorBlend", 0);
  material.setColor3("distanceGroundColor", Color3.White());
  let resolveTextureReadiness: (() => void) | undefined;
  const ready = leafTextureUrl
    ? new Promise<void>((resolve) => { resolveTextureReadiness = resolve; })
    : Promise.resolve();
  textureReadiness.set(material, ready);
  if (leafTextureUrl) {
    const leafTexture = new Texture(
      leafTextureUrl,
      scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        material.setFloat("leafTextureEnabled", 1);
        resolveTextureReadiness?.();
        resolveTextureReadiness = undefined;
      },
      () => {
        material.setFloat("leafTextureEnabled", 0);
        leafTexture.dispose();
        resolveTextureReadiness?.();
        resolveTextureReadiness = undefined;
      },
    );
    leafTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    leafTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    material.setTexture("leafTexture", leafTexture);
    // The leaf texture is created per material, so the material owns it.
    // Callers must not force-dispose material textures instead: the shared
    // shadow map and the scene-cached bark texture are bound here too.
    material.onDisposeObservable.addOnce(() => leafTexture.dispose());
  }
  if (barkTexture) {
    material.setTexture("barkTexture", barkTexture);
  }

  const black = Color3.Black();
  const fallbackSky = new Color3(0.38, 0.42, 0.48);
  const fallbackGround = new Color3(0.08, 0.09, 0.07);
  material.onBindObservable.add(() => {
    bindWindPhase(material);
    const sun = scene.lights.find((light): light is DirectionalLight => (
      light instanceof DirectionalLight && light.name === "sunLight"
    ));
    const ambient = scene.lights.find((light): light is HemisphericLight => (
      light instanceof HemisphericLight && light.name === "skyAmbientLight"
    ));

    material.setVector3(
      "sunDirection",
      sun?.isEnabled() ? sun.direction.scale(-1).normalize() : Vector3.Up(),
    );
    material.setColor3(
      "sunColor",
      sun?.isEnabled() ? sun.diffuse.scale(sun.intensity) : black,
    );
    material.setColor3(
      "skyColor",
      ambient ? ambient.diffuse.scale(ambient.intensity) : fallbackSky,
    );
    material.setColor3(
      "groundColor",
      ambient ? ambient.groundColor.scale(ambient.intensity) : fallbackGround,
    );
  });
  return material;
}

/** Waits for optional cutout textures before a hidden source is atlas-captured. */
export async function waitForVertexColorTextures(meshes: readonly Mesh[]): Promise<void> {
  await Promise.all(meshes.map((mesh) => (
    mesh.material instanceof ShaderMaterial
      ? textureReadiness.get(mesh.material) ?? Promise.resolve()
      : Promise.resolve()
  )));
}

/**
 * Leans models by a shear. Their impostors reproduce the same shear by warping
 * their proxy, so both stay in step without animated atlas frames.
 */
export function setVegetationWindShear(
  meshes: readonly Mesh[],
  shearFraction: number,
): void {
  for (const mesh of meshes) {
    if (mesh.material instanceof ShaderMaterial) setWindShear(mesh.material, shearFraction);
  }
}

/** Sets the normalized-height range used by live vegetation model lighting. */
export function setVertexColorModelHeight(
  mesh: Mesh,
  modelHeight: number,
): void {
  if (mesh.material instanceof ShaderMaterial) {
    mesh.material.setFloat("modelHeight", modelHeight);
  }
}
