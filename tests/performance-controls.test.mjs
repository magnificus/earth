import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settings = readFileSync(new URL("../src/SceneSettings.ts", import.meta.url), "utf8");
const controls = readFileSync(new URL("../src/SceneControls.ts", import.meta.url), "utf8");
const geocoding = readFileSync(new URL("../src/Geocoding.ts", import.meta.url), "utf8");
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const playerControls = readFileSync(
  new URL("../src/PlayerControls.ts", import.meta.url),
  "utf8",
);
const playerPresence = readFileSync(
  new URL("../src/integration/PlayerPresence.ts", import.meta.url),
  "utf8",
);
const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const solarLighting = readFileSync(new URL("../src/SolarLighting.ts", import.meta.url), "utf8");
const gameTime = readFileSync(new URL("../src/GameTime.ts", import.meta.url), "utf8");
const clockSettings = readFileSync(new URL("../src/ClockSettings.ts", import.meta.url), "utf8");

test("defaults to three by three and allows exact even-sized detail windows", () => {
  assert.match(settings, /key: "detailTilesAcross"[\s\S]*?defaultValue: 3/);
  assert.match(settings, /key: "detailTilesAcross"[\s\S]*?step: 1/);
  assert.match(settings, /key: "terrainTilesAcross"[\s\S]*?defaultValue: 17/);
  assert.match(game, /worldTileWindowOffsetsAtLocation\(/);
  assert.match(game, /dx >= detailWindow\.minimumX[\s\S]*?dy <= detailWindow\.maximumY/);
});

test("renders scene sliders from shared setting definitions", () => {
  assert.match(settings, /label: "Full detail"/);
  assert.match(settings, /label: "Far terrain"/);
  assert.match(settings, /label: "Cloud density"/);
  assert.match(controls, /for \(const definition of SCENE_SETTING_DEFINITIONS\)/);
  assert.match(controls, /onSettingChange\(definition\.key, value\)/);
});

test("restores coarse terrain outside the selected detailed window", () => {
  assert.match(
    game,
    /!wantDetail && record\.nativeTerrain && !record\.detailed/,
  );
  assert.match(game, /record\.detailed && !wantDetail/);
  assert.match(game, /ring > this\.terrainTileRadius/);
});

test("cloud density ranges from zero to one and refreshes the cloud layer", () => {
  assert.match(settings, /key: "cloudDensity"[\s\S]*?minimum: 0[\s\S]*?maximum: 1/);
  assert.match(game, /density: this\.cloudDensity/);
  assert.match(game, /this\.cloudLayer\?\.setDensity\(next\.cloudDensity\)/);
  assert.doesNotMatch(settings, /grassDensity|Grass density/);
});

test("the settings menu toggles with Escape and supports coordinate navigation", () => {
  assert.match(controls, /event\.key !== "Escape"/);
  assert.match(controls, /this\.setMenuOpen\(!this\.menuOpen\)/);
  assert.match(controls, /createCoordinateInput\("Longitude", -180, 180\)/);
  assert.match(controls, /onLocationChange\(location\)/);
});

test("a URL time override fixes both the sun and the settings clock", () => {
  assert.match(clockSettings, /query\.get\("time"\)/);
  assert.match(clockSettings, /mode: "manual"/);
  assert.match(game, /this\.solarLighting\.setTimeOfDay\(this\.initialTimeOfDay\)/);
  assert.match(controls, /clockSettings: Readonly<ClockSettings>/);
  assert.match(controls, /this\.setClockMode\(options\.clockSettings\.mode\)/);
});

test("live date and time share the shifted automatic game clock", () => {
  assert.match(gameTime, /GAME_YEAR_OFFSET = 100/);
  assert.match(gameTime, /GAME_TIME_OFFSET_HOURS = -4/);
  assert.match(solarLighting, /const date = getGameDate\(\)/);
  assert.match(controls, /const gameDate = getGameDate\(\)/);
  assert.match(controls, /CLOCK_UPDATE_INTERVAL_MS = 1_000/);
});

test("the simulation date can be fixed from the settings menu or URL", () => {
  assert.match(clockSettings, /query\.get\("date"\)/);
  assert.match(game, /this\.solarLighting\.setDate\(this\.initialDate\)/);
  assert.match(controls, /this\.dateInput\.type = "date"/);
  assert.match(controls, /options\.onDateChange\(this\.dateInput\.value\)/);
  assert.match(controls, /this\.manualClockInput\.type = "checkbox"/);
  assert.match(controls, /options\.onClockModeChange\(mode\)/);
  assert.match(solarLighting, /get currentDate\(\): Date/);
  assert.match(solarLighting, /setDate\(date\?: string\)/);
});

test("location names are geocoded and passed through destination navigation", () => {
  assert.match(controls, /aria-label", "Place or address"/);
  assert.match(controls, /geocodeLocationName\(this\.placeInput\.value\)/);
  assert.match(controls, /onLocationChange\(location\)/);
  assert.match(game, /onLocationChange: \(target\) => this\.reloadAtLocation\(target\)/);
  assert.match(geocoding, /q: normalizedQuery/);
  assert.match(geocoding, /format: "jsonv2"/);
  assert.match(geocoding, /limit: "1"/);
  assert.match(geocoding, /REQUEST_INTERVAL_MS = 1_000/);
  assert.match(geocoding, /sessionStorage\.setItem/);
});

test("gameplay uses pointer lock and only the open menu restores the cursor", () => {
  const menuOpenHandler = playerControls.match(
    /setMenuOpen\([\s\S]*?(?=\n  applyRestoredPose)/,
  );
  assert.ok(menuOpenHandler);
  assert.match(playerControls, /canvas\.requestPointerLock\(\)/);
  assert.match(playerControls, /document\.addEventListener\("pointerlockchange"/);
  assert.match(game, /this\.sceneControls\?\.setMenuOpen\(true\)/);
  assert.match(playerControls, /document\.exitPointerLock\(\)/);
  assert.match(playerControls, /classList\.toggle\("gameplay-input", !isOpen\)/);
  assert.doesNotMatch(menuOpenHandler[0], /this\.requestPointerLock\(\)/);
  assert.match(game, /this\.playerControls\?\.setMenuOpen\(isOpen\)/);
  assert.match(html, /body\.gameplay-input \*[\s\S]*?cursor: none !important/);
});

test("changing worlds discards the outgoing camera's local position offset", () => {
  assert.match(
    game,
    /private async startWorld\([\s\S]*?this\.resetCameraForWorldChange\(\);[\s\S]*?this\.disposeAllTiles\(\)/,
  );
  assert.match(game, /resetCameraForWorldChange\(\)[\s\S]*?playerControls\?\.resetForWorldChange\(\)/);
  assert.match(playerControls, /resetForWorldChange\(\)[\s\S]*?position\.x = 0/);
  assert.match(playerControls, /resetForWorldChange\(\)[\s\S]*?position\.z = 0/);
  assert.match(playerControls, /resetForWorldChange\(\)[\s\S]*?cameraDirection\.setAll\(0\)/);
});

test("remote players render as red geographic orbs and the local player stays hidden", () => {
  assert.match(playerPresence, /if \(event\.actorId === this\.actorId\) return/);
  assert.match(playerPresence, /MeshBuilder\.CreateSphere\(`remote-player-\$\{actorId\}`/);
  assert.match(playerPresence, /material\.diffuseColor = new Color3\(1, 0, 0\)/);
  assert.match(
    playerPresence,
    /lonLatToScene\([\s\S]*?player\.pose\.longitude[\s\S]*?player\.pose\.latitude/,
  );
  assert.match(playerPresence, /event\.type === "player\.left"[\s\S]*?\.dispose\(\)/);
  assert.doesNotMatch(game, /remotePlayerMarkers|handleGameEvent|MeshBuilder\.CreateSphere/);
});

test("all location controls reload a clean scene", () => {
  assert.match(
    game,
    /private async reloadAtLocation\(target: WorldLocation\): Promise<void>[\s\S]*?this\.worldLocation\.update\(target\);[\s\S]*?playerPresence\.publishDestination[\s\S]*?window\.location\.reload\(\)/,
  );
  assert.match(playerPresence, /publishDestination[\s\S]*?this\.dispatchPose/);
  assert.match(game, /onLocationChange: \(target\) => this\.reloadAtLocation\(target\)/);
  assert.match(game, /void this\.reloadAtLocation\(EXAMPLE_LOCATIONS\[locationIndex\]\)/);
  assert.match(game, /Random location:[\s\S]*?await this\.reloadAtLocation\(target\)/);
  assert.doesNotMatch(game, /terrainLocationIndex|changeTerrainLocation/);
});

test("persists normalized controls through one scene settings store", () => {
  assert.match(settings, /earth\.scene-settings\.v1/);
  assert.match(settings, /storage\?\.setItem\(STORAGE_KEY, JSON\.stringify\(this\.current\)\)/);
  assert.match(game, /private changeSceneSetting\(key: SceneSettingKey, value: number\)/);
});

test("persists automatic or manual clock selection and manual values", () => {
  assert.match(clockSettings, /earth\.clock-settings\.v1/);
  assert.match(clockSettings, /setMode\(mode: ClockMode\)/);
  assert.match(clockSettings, /setManualDate\(date: string\)/);
  assert.match(clockSettings, /setManualTimeOfDay\(hours: number\)/);
  assert.match(game, /private changeClockMode\(mode: ClockMode\)/);
});
