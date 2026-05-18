const BASE = "/api";

export type SettingsResponse = {
  config_dir: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// Deck
export const deckApi = {
  listConfigs: () => request<string[]>("/deck/configs"),
  get: (filename: string) =>
    request<import("../types").DeckResponse>(`/deck/${filename}`),
  put: (filename: string, body: import("../types").DeckConfig) =>
    request<import("../types").DeckResponse>(`/deck/${filename}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  previewWells: (config: import("../types").WellPlateConfig) =>
    request<Record<string, import("../types").WellPosition>>("/deck/preview-wells", {
      method: "POST",
      body: JSON.stringify(config),
    }),
};

// Gantry
export const gantryApi = {
  listConfigs: () => request<string[]>("/gantry/configs"),
  listInstrumentTypes: () =>
    request<import("../types").InstrumentTypeInfo[]>("/gantry/instrument-types"),
  listPipetteModels: () =>
    request<import("../types").PipetteModelInfo[]>("/gantry/pipette-models"),
  getInstrumentSchemas: () =>
    request<import("../types").InstrumentSchemas>("/gantry/instrument-schemas"),
  get: (filename: string) =>
    request<import("../types").GantryResponse>(`/gantry/${filename}`),
  put: (filename: string, body: import("../types").GantryConfig) =>
    request<import("../types").GantryResponse>(`/gantry/${filename}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  getPosition: () =>
    request<import("../types").GantryPosition>("/gantry/position"),
  connect: (filename: string) =>
    request<import("../types").GantryPosition>("/gantry/connect", {
      method: "POST",
      body: JSON.stringify({ filename }),
    }),
  disconnect: () =>
    request<import("../types").GantryPosition>("/gantry/disconnect", {
      method: "POST",
    }),
  jog: (x = 0, y = 0, z = 0) =>
    request<{ status: string }>("/gantry/jog", {
      method: "POST",
      body: JSON.stringify({ x, y, z }),
    }),
  home: () =>
    request<import("../types").GantryPosition>("/gantry/home", {
      method: "POST",
    }),
  moveTo: (x: number, y: number, z: number) =>
    request<{ status: string }>("/gantry/move-to", {
      method: "POST",
      body: JSON.stringify({ x, y, z }),
    }),
  moveToBlocking: (x: number, y: number, z: number) =>
    request<import("../types").GantryPosition>("/gantry/move-to-blocking", {
      method: "POST",
      body: JSON.stringify({ x, y, z }),
    }),
  jogBlocking: (x = 0, y = 0, z = 0, timeout_s = 10) =>
    request<import("../types").GantryPosition>("/gantry/jog-blocking", {
      method: "POST",
      body: JSON.stringify({ x, y, z, timeout_s }),
    }),
  setWorkCoordinates: (body: { x?: number; y?: number; z?: number }) =>
    request<import("../types").GantryPosition>("/gantry/work-coordinates", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  prepareCalibrationOrigin: () =>
    request<import("../types").GantryPosition>("/gantry/calibration/prepare-origin", {
      method: "POST",
    }),
  homeAndCenterForCalibration: () =>
    request<{
      xy_bounds: { x: number; y: number; z: number };
      position: { x: number; y: number; z: number };
    }>("/gantry/calibration/home-and-center", {
      method: "POST",
    }),
  restoreCalibrationSoftLimits: () =>
    request<import("../types").GantryPosition>("/gantry/calibration/restore-soft-limits", {
      method: "POST",
    }),
  configureSoftLimits: (body: {
    max_travel_x: number;
    max_travel_y: number;
    max_travel_z: number;
    tolerance_mm?: number;
  }) =>
    request<{ status: string }>("/gantry/soft-limits", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  unlock: () =>
    request<import("../types").GantryPosition>("/gantry/unlock", {
      method: "POST",
    }),
};

// Protocol
export const protocolApi = {
  listCommands: () =>
    request<import("../types").CommandInfo[]>("/protocol/commands"),
  listConfigs: () => request<string[]>("/protocol/configs"),
  get: (filename: string) =>
    request<import("../types").ProtocolResponse>(`/protocol/${filename}`),
  put: (filename: string, body: import("../types").ProtocolConfig) =>
    request<{ status: string; filename: string }>(`/protocol/${filename}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  validate: (body: import("../types").ProtocolConfig) =>
    request<import("../types").ProtocolValidationResponse>(
      "/protocol/validate",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  run: (body: {
    gantry_file: string;
    deck_file: string;
    protocol_file: string;
  }) =>
    request<{ status: string; steps_executed: number }>("/protocol/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

// Settings
export const settingsApi = {
  get: () => request<SettingsResponse>("/settings"),
  update: (config_dir: string) =>
    request<SettingsResponse>("/settings", {
      method: "PUT",
      body: JSON.stringify({ config_dir }),
    }),
  browse: () =>
    request<SettingsResponse>("/settings/browse", {
      method: "POST",
    }),
};

// Raw YAML
export const rawApi = {
  get: (filename: string) =>
    request<{ content: string }>(`/raw/${filename}`),
  put: (filename: string, content: string) =>
    request<{ content: string }>(`/raw/${filename}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
};
