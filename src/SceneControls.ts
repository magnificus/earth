import { WEB_MERCATOR_MAX_LATITUDE } from "./Locations";
import type { WorldLocation } from "./Locations";
import { formatCalendarDate } from "./CalendarDate";
import { geocodeLocationName } from "./Geocoding";
import { getGameDate } from "./GameTime";
import { SCENE_SETTING_DEFINITIONS } from "./SceneSettings";
import type {
  SceneSettingDefinition,
  SceneSettingKey,
  SceneSettings,
} from "./SceneSettings";
import type { ClockMode, ClockSettings } from "./ClockSettings";

export interface SceneControlsOptions {
  settings: Readonly<SceneSettings>;
  clockSettings: Readonly<ClockSettings>;
  initialLocation: WorldLocation;
  onSettingChange: (key: SceneSettingKey, value: number) => void;
  onRoofsVisibilityChange: (visible: boolean) => void;
  onClockModeChange: (mode: ClockMode) => void;
  onDateChange: (date: string) => void;
  onTimeOfDayChange: (hours: number) => void;
  onLocationChange: (location: WorldLocation) => Promise<void>;
  onMenuOpenChange: (isOpen: boolean) => void;
}

const MINUTES_PER_HOUR = 60;
const TIME_STEP_HOURS = 0.25;
const CLOCK_UPDATE_INTERVAL_MS = 1_000;

export class SceneControls {
  private readonly element: HTMLElement;
  private readonly timeInput: HTMLInputElement;
  private readonly timeOutput: HTMLOutputElement;
  private readonly dateInput: HTMLInputElement;
  private readonly manualClockInput: HTMLInputElement;
  private readonly placeInput: HTMLInputElement;
  private readonly placeGoButton: HTMLButtonElement;
  private readonly latitudeInput: HTMLInputElement;
  private readonly longitudeInput: HTMLInputElement;
  private readonly locationStatus: HTMLOutputElement;
  private readonly goButton: HTMLButtonElement;
  private readonly clockTimer: number;
  private readonly rangeControls = new Map<SceneSettingKey, RangeControl>();
  private readonly onMenuOpenChange: (isOpen: boolean) => void;
  private isAutomaticClock = true;
  private manualDate = "";
  private manualTimeOfDay = 12;
  private menuOpen = false;

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    this.setMenuOpen(!this.menuOpen);
  };

  constructor(options: SceneControlsOptions) {
    this.onMenuOpenChange = options.onMenuOpenChange;
    this.element = document.createElement("aside");
    this.element.id = "sceneControls";
    this.element.setAttribute("aria-label", "Settings menu");
    this.element.setAttribute("aria-hidden", "true");
    this.element.inert = true;
    this.element.tabIndex = -1;

    const heading = document.createElement("h1");
    heading.textContent = "Settings";
    this.element.appendChild(heading);

    const sceneGroup = this.createGroup("Scene");
    const weatherGroup = this.createGroup("Weather");
    for (const definition of SCENE_SETTING_DEFINITIONS) {
      const control = this.createRangeControl(
        definition,
        options.settings[definition.key],
        (value) => options.onSettingChange(definition.key, value),
      );
      this.rangeControls.set(definition.key, control);
      const targetGroup = definition.key === "windSpeedMetersPerSecond"
        ? weatherGroup
        : sceneGroup;
      targetGroup.appendChild(control.row);
    }

    const roofsRow = document.createElement("label");
    roofsRow.className = "scene-control-row visibility-control-row";
    const roofsLabel = document.createElement("span");
    roofsLabel.textContent = "Show roofs";
    const roofsInput = document.createElement("input");
    roofsInput.type = "checkbox";
    roofsInput.checked = options.settings.showRoofs;
    roofsInput.setAttribute("aria-label", "Show building roofs");
    roofsInput.addEventListener("change", () => options.onRoofsVisibilityChange(roofsInput.checked));
    roofsRow.append(roofsLabel, roofsInput);
    sceneGroup.appendChild(roofsRow);

    const clockModeRow = document.createElement("label");
    clockModeRow.className = "scene-control-row clock-mode-row";
    const clockModeLabel = document.createElement("span");
    clockModeLabel.textContent = "Manual clock";
    this.manualClockInput = document.createElement("input");
    this.manualClockInput.type = "checkbox";
    this.manualClockInput.setAttribute("aria-label", "Use manual date and time");
    this.manualClockInput.addEventListener("change", () => {
      const mode: ClockMode = this.manualClockInput.checked ? "manual" : "automatic";
      this.setClockMode(mode);
      options.onClockModeChange(mode);
    });
    clockModeRow.append(clockModeLabel, this.manualClockInput);
    sceneGroup.appendChild(clockModeRow);

    const dateRow = document.createElement("label");
    dateRow.className = "scene-control-row date-control-row";
    const dateLabel = document.createElement("span");
    dateLabel.textContent = "Date";

    this.dateInput = document.createElement("input");
    this.dateInput.type = "date";
    this.dateInput.setAttribute("aria-label", "Date");

    this.dateInput.addEventListener("input", () => {
      if (!this.dateInput.value) return;
      this.manualDate = this.dateInput.value;
      options.onDateChange(this.dateInput.value);
    });

    dateRow.append(dateLabel, this.dateInput);
    sceneGroup.appendChild(dateRow);

    const timeRow = document.createElement("label");
    timeRow.className = "scene-control-row";
    const timeLabel = document.createElement("span");
    timeLabel.textContent = "Time of day";

    this.timeInput = document.createElement("input");
    this.timeInput.type = "range";
    this.timeInput.min = "0";
    this.timeInput.max = String(24 - TIME_STEP_HOURS);
    this.timeInput.step = String(TIME_STEP_HOURS);
    this.timeInput.setAttribute("aria-label", "Time of day");
    this.timeOutput = document.createElement("output");

    this.timeInput.addEventListener("input", () => {
      const hours = Number(this.timeInput.value);
      this.manualTimeOfDay = hours;
      this.updateTimeDisplay(hours);
      options.onTimeOfDayChange(hours);
    });

    timeRow.append(timeLabel, this.timeInput, this.timeOutput);
    sceneGroup.appendChild(timeRow);
    this.element.appendChild(sceneGroup);
    this.element.appendChild(weatherGroup);


    const locationGroup = this.createGroup("Location");
    const placeForm = document.createElement("form");
    placeForm.className = "place-form";
    this.placeInput = document.createElement("input");
    this.placeInput.type = "search";
    this.placeInput.required = true;
    this.placeInput.autocomplete = "street-address";
    this.placeInput.placeholder = "Oslo, Norway";
    this.placeInput.setAttribute("aria-label", "Place or address");
    placeForm.appendChild(this.wrapLocationInput("Place or address", this.placeInput, "place-field"));

    this.placeGoButton = document.createElement("button");
    this.placeGoButton.type = "submit";
    this.placeGoButton.className = "place-go";
    this.placeGoButton.textContent = "Go";
    placeForm.appendChild(this.placeGoButton);
    placeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.navigateToPlace(options.onLocationChange);
    });
    locationGroup.appendChild(placeForm);

    const locationForm = document.createElement("form");
    locationForm.className = "coordinate-form";
    this.latitudeInput = this.createCoordinateInput(
      "Latitude",
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE,
    );
    this.longitudeInput = this.createCoordinateInput("Longitude", -180, 180);
    locationForm.append(
      this.wrapCoordinateInput("Latitude", this.latitudeInput),
      this.wrapCoordinateInput("Longitude", this.longitudeInput),
    );

    this.goButton = document.createElement("button");
    this.goButton.type = "submit";
    this.goButton.className = "coordinate-go";
    this.goButton.textContent = "Go";
    locationForm.appendChild(this.goButton);

    this.locationStatus = document.createElement("output");
    this.locationStatus.className = "coordinate-status";
    this.locationStatus.setAttribute("aria-live", "polite");
    locationForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.navigateToCoordinates(options.onLocationChange);
    });
    locationGroup.appendChild(locationForm);
    locationGroup.appendChild(this.locationStatus);
    this.element.appendChild(locationGroup);

    document.body.appendChild(this.element);
    document.addEventListener("keydown", this.handleKeyDown, true);
    this.setLocation(options.initialLocation);
    this.manualDate = options.clockSettings.manualDate;
    this.manualTimeOfDay = options.clockSettings.manualTimeOfDay;
    this.dateInput.value = this.manualDate;
    this.timeInput.value = String(this.manualTimeOfDay);
    this.updateTimeDisplay(this.manualTimeOfDay);
    this.setClockMode(options.clockSettings.mode);
    this.clockTimer = window.setInterval(() => {
      const gameDate = getGameDate();
      this.updateAutomaticDate(gameDate);
      this.updateAutomaticTime(gameDate);
    }, CLOCK_UPDATE_INTERVAL_MS);
  }

  get isOpen(): boolean {
    return this.menuOpen;
  }

  dispose(): void {
    window.clearInterval(this.clockTimer);
    document.removeEventListener("keydown", this.handleKeyDown, true);
    this.element.remove();
  }

  setSettings(settings: Readonly<SceneSettings>): void {
    for (const definition of SCENE_SETTING_DEFINITIONS) {
      this.rangeControls.get(definition.key)?.setValue(settings[definition.key]);
    }
  }

  setLocation(location: WorldLocation): void {
    this.latitudeInput.value = formatCoordinate(location.lat);
    this.longitudeInput.value = formatCoordinate(location.lon);
    this.locationStatus.value = "";
  }

  setMenuOpen(isOpen: boolean): void {
    if (this.menuOpen === isOpen) return;
    this.menuOpen = isOpen;
    this.element.classList.toggle("open", isOpen);
    this.element.setAttribute("aria-hidden", String(!isOpen));
    this.element.inert = !isOpen;
    this.onMenuOpenChange(isOpen);
    if (isOpen) this.element.focus({ preventScroll: true });
  }

  private createGroup(title: string): HTMLElement {
    const group = document.createElement("section");
    group.className = "scene-control-group";
    const heading = document.createElement("h2");
    heading.textContent = title;
    group.appendChild(heading);
    return group;
  }

  private createCoordinateInput(
    ariaLabel: string,
    minimum: number,
    maximum: number,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(minimum);
    input.max = String(maximum);
    input.step = "any";
    input.required = true;
    input.setAttribute("aria-label", ariaLabel);
    return input;
  }

  private wrapCoordinateInput(labelText: string, input: HTMLInputElement): HTMLLabelElement {
    return this.wrapLocationInput(labelText, input, "coordinate-field");
  }

  private wrapLocationInput(
    labelText: string,
    input: HTMLInputElement,
    className: string,
  ): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = className;
    const text = document.createElement("span");
    text.textContent = labelText;
    label.append(text, input);
    return label;
  }

  private async navigateToPlace(
    onLocationChange: (location: WorldLocation) => Promise<void>,
  ): Promise<void> {
    if (!this.placeInput.reportValidity()) return;
    this.setLocationBusy(true);
    this.locationStatus.value = "Finding location...";
    try {
      const result = await geocodeLocationName(this.placeInput.value);
      if (!result) {
        this.locationStatus.value = "No matching location found.";
        return;
      }
      const location = { lat: result.lat, lon: result.lon };
      this.latitudeInput.value = formatCoordinate(location.lat);
      this.longitudeInput.value = formatCoordinate(location.lon);
      this.locationStatus.value = `Loading ${result.displayName}...`;
      await onLocationChange(location);
      this.setLocation(location);
      this.setMenuOpen(false);
    } catch (error) {
      console.error("Failed to find location:", error);
      this.locationStatus.value = "Could not search for this location.";
    } finally {
      this.setLocationBusy(false);
    }
  }

  private async navigateToCoordinates(
    onLocationChange: (location: WorldLocation) => Promise<void>,
  ): Promise<void> {
    if (!this.latitudeInput.reportValidity() || !this.longitudeInput.reportValidity()) return;
    const location = {
      lat: Number(this.latitudeInput.value),
      lon: Number(this.longitudeInput.value),
    };
    this.setLocationBusy(true);
    this.locationStatus.value = "Loading location...";
    try {
      await onLocationChange(location);
      this.setLocation(location);
      this.setMenuOpen(false);
    } catch (error) {
      console.error("Failed to load coordinates:", error);
      this.locationStatus.value = "Could not load this location.";
    } finally {
      this.setLocationBusy(false);
    }
  }

  private setLocationBusy(isBusy: boolean): void {
    this.placeInput.disabled = isBusy;
    this.latitudeInput.disabled = isBusy;
    this.longitudeInput.disabled = isBusy;
    this.placeGoButton.disabled = isBusy;
    this.goButton.disabled = isBusy;
  }

  private createRangeControl(
    definition: SceneSettingDefinition,
    initialValue: number,
    onChange: (value: number) => void,
  ): RangeControl {
    const row = document.createElement("label");
    row.className = "scene-control-row";
    const label = document.createElement("span");
    label.textContent = definition.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(definition.minimum);
    input.max = String(definition.maximum);
    input.step = String(definition.step);
    input.value = String(initialValue);
    input.setAttribute("aria-label", definition.ariaLabel);

    const output = document.createElement("output");
    const setValue = (value: number): void => {
      input.value = String(value);
      output.value = definition.format(value);
    };
    setValue(initialValue);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      output.value = definition.format(value);
      onChange(value);
    });

    row.append(label, input, output);
    return { row, input, setValue };
  }

  private updateAutomaticTime(gameDate = getGameDate()): void {
    if (!this.isAutomaticClock) return;
    const hours = gameDate.getHours() + gameDate.getMinutes() / MINUTES_PER_HOUR;
    this.timeInput.value = String(hours);
    this.updateTimeDisplay(hours);
  }

  private updateAutomaticDate(gameDate = getGameDate()): void {
    if (!this.isAutomaticClock) return;
    this.dateInput.value = formatCalendarDate(gameDate);
  }

  private setClockMode(mode: ClockMode): void {
    this.isAutomaticClock = mode === "automatic";
    this.manualClockInput.checked = !this.isAutomaticClock;
    this.dateInput.disabled = this.isAutomaticClock;
    this.timeInput.disabled = this.isAutomaticClock;
    if (this.isAutomaticClock) {
      const gameDate = getGameDate();
      this.updateAutomaticDate(gameDate);
      this.updateAutomaticTime(gameDate);
    } else {
      this.dateInput.value = this.manualDate;
      this.timeInput.value = String(this.manualTimeOfDay);
      this.updateTimeDisplay(this.manualTimeOfDay);
    }
  }

  private updateTimeDisplay(hours: number): void {
    const totalMinutes = Math.round(hours * MINUTES_PER_HOUR);
    const displayHours = Math.floor(totalMinutes / MINUTES_PER_HOUR) % 24;
    const displayMinutes = totalMinutes % MINUTES_PER_HOUR;
    this.timeOutput.value = `${String(displayHours).padStart(2, "0")}:${String(displayMinutes).padStart(2, "0")}`;
  }
}

interface RangeControl {
  row: HTMLLabelElement;
  input: HTMLInputElement;
  setValue: (value: number) => void;
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(6)).toString();
}
