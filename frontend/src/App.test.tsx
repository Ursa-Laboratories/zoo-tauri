import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type {
  DeckConfig,
  DeckResponse,
  GantryConfig,
  GantryResponse,
  ProtocolConfig,
  ProtocolResponse,
} from "./types";

type ApiState = {
  decks: Record<string, DeckResponse>;
  gantries: Record<string, GantryResponse>;
  protocols: Record<string, ProtocolResponse>;
};

function createState(): ApiState {
  return {
    decks: {
      "deck.yaml": {
        filename: "deck.yaml",
        labware: [
          {
            key: "plate_1",
            config: {
              type: "well_plate",
              name: "Deck Plate",
              model_name: "plate-model",
              rows: 8,
              columns: 12,
              length_mm: 127.76,
              width_mm: 85.47,
              height_mm: 14.22,
              a1: null,
              calibration: {
                a1: { x: 10, y: 20, z: 30 },
                a2: { x: 20, y: 20, z: 30 },
              },
              x_offset_mm: 9,
              y_offset_mm: 9,
              capacity_ul: 200,
              working_volume_ul: 150,
            },
            wells: null,
          },
        ],
      },
    },
    gantries: {
      "cubos.yaml": {
        filename: "cubos.yaml",
        config: {
          serial_port: "",
          gantry_type: "cub_xl",
          cnc: {
            homing_strategy: "standard",
            total_z_range: 80,
            y_axis_motion: "head",
            safe_z: 80,
          },
          working_volume: { x_min: 0, x_max: 300, y_min: 0, y_max: 200, z_min: 0, z_max: 80 },
          grbl_settings: {},
          instruments: {
            pipette_1: {
              type: "pipette",
              vendor: "opentrons",
              offset_x: 1,
              offset_y: 2,
              depth: 0,
              measurement_height: 0,
              safe_approach_height: 0,
              port: "/dev/ttyUSB0",
            },
          },
        },
      },
    },
    protocols: {
      "move.yaml": {
        filename: "move.yaml",
        steps: [
          {
            command: "move",
            args: { x: 1, y: 2, z: 3 },
          },
        ],
      },
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function toDeckResponse(filename: string, body: DeckConfig): DeckResponse {
  return {
    filename,
    labware: Object.entries(body.labware).map(([key, config]) => ({
      key,
      config,
      wells: null,
    })),
  };
}

function toGantryResponse(filename: string, body: GantryConfig): GantryResponse {
  return {
    filename,
    config: body,
  };
}

function toProtocolResponse(filename: string, body: ProtocolConfig): ProtocolResponse {
  return {
    filename,
    steps: body.protocol,
  };
}

function installFetchMock(state: ApiState) {
  let gantryConnected = false;
  const gantryPosition = (x = 0, y = 0, z = 0) => ({
    x,
    y,
    z,
    work_x: x,
    work_y: y,
    work_z: z,
    status: "Idle",
    connected: gantryConnected,
  });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      "http://localhost",
    );
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (path === "/api/settings" && method === "GET") {
      return jsonResponse({ config_dir: "/mock/Zoo/configs" });
    }
    if (path === "/api/settings/browse" && method === "POST") {
      return jsonResponse({ config_dir: "/mock/Zoo/selected-configs" });
    }
    if (path === "/api/settings" && method === "PUT") {
      return jsonResponse({ config_dir: body?.config_dir ?? "/mock/Zoo/configs" });
    }
    if (path === "/api/deck/configs") {
      return jsonResponse(Object.keys(state.decks));
    }
    if (path === "/api/gantry/configs") {
      return jsonResponse(Object.keys(state.gantries));
    }
    if (path === "/api/protocol/configs") {
      return jsonResponse(Object.keys(state.protocols));
    }
    if (path === "/api/gantry/instrument-types") {
      return jsonResponse([{ type: "pipette", vendors: ["opentrons"], is_mock: false }]);
    }
    if (path === "/api/gantry/instrument-schemas") {
      return jsonResponse({
        pipette: [
          { name: "port", type: "str", required: true, default: "/dev/ttyUSB0", choices: null },
        ],
      });
    }
    if (path === "/api/protocol/commands") {
      return jsonResponse([
        {
          name: "move",
          args: [
            { name: "x", type: "float", required: true, default: 0 },
            { name: "y", type: "float", required: true, default: 0 },
            { name: "z", type: "float", required: true, default: 0 },
          ],
          description: "Move gantry",
        },
      ]);
    }
    if (path === "/api/gantry/position") {
      return jsonResponse(gantryPosition());
    }
    if (path === "/api/gantry/connect" && method === "POST") {
      gantryConnected = true;
      return jsonResponse(gantryPosition());
    }
    if (path === "/api/gantry/calibration/prepare-origin" && method === "POST") {
      gantryConnected = true;
      return jsonResponse(gantryPosition());
    }
    if (path === "/api/gantry/calibration/home-and-center" && method === "POST") {
      gantryConnected = true;
      return jsonResponse({
        xy_bounds: { x: 300, y: 200, z: 80 },
        position: { x: 150, y: 100, z: 80 },
      });
    }
    if (path === "/api/gantry/calibration/restore-soft-limits" && method === "POST") {
      return jsonResponse(gantryPosition());
    }
    if (path === "/api/gantry/work-coordinates" && method === "POST") {
      return jsonResponse(gantryPosition(body?.x ?? 0, body?.y ?? 0, body?.z ?? 0));
    }
    if (path === "/api/gantry/jog-blocking" && method === "POST") {
      return jsonResponse(gantryPosition(0, 0, body?.z ?? 0));
    }
    if (path === "/api/gantry/home" && method === "POST") {
      return jsonResponse(gantryPosition(300, 200, 80));
    }
    if (path === "/api/gantry/soft-limits" && method === "POST") {
      return jsonResponse({ status: "ok" });
    }
    if (path === "/api/deck/preview-wells" && method === "POST") {
      return jsonResponse({});
    }

    const [, api, kind, filename] = path.split("/");
    if (api !== "api" || !filename) {
      return new Response("Not found", { status: 404 });
    }

    if (kind === "deck") {
      if (method === "GET") return jsonResponse(state.decks[filename]);
      if (method === "PUT") {
        state.decks[filename] = toDeckResponse(filename, body as DeckConfig);
        return jsonResponse(state.decks[filename]);
      }
    }
    if (kind === "gantry") {
      if (method === "GET") return jsonResponse(state.gantries[filename]);
      if (method === "PUT") {
        state.gantries[filename] = toGantryResponse(filename, body as GantryConfig);
        return jsonResponse(state.gantries[filename]);
      }
    }
    if (kind === "protocol") {
      if (method === "GET") return jsonResponse(state.protocols[filename]);
      if (method === "PUT") {
        state.protocols[filename] = toProtocolResponse(filename, body as ProtocolConfig);
        return jsonResponse({ status: "ok", filename });
      }
    }

    return new Response("Not found", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });

  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

async function importConfig(user: ReturnType<typeof userEvent.setup>, label: string, filename: string) {
  await user.click(screen.getByRole("button", { name: label }));
  await user.selectOptions(screen.getByRole("combobox", { name: label }), filename);
}

async function waitForSettingsLoad() {
  await screen.findByDisplayValue("/mock/Zoo/configs");
}

async function loadRequiredProtocolDependencies(user: ReturnType<typeof userEvent.setup>) {
  await importConfig(user, "Import gantry config", "cubos.yaml");
  await user.click(screen.getByRole("button", { name: "Deck" }));
  await importConfig(user, "Import deck config", "deck.yaml");
}

describe("Zoo editor interactions", () => {
  beforeEach(() => {
    installFetchMock(createState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a browse button for the config directory", async () => {
    renderApp();
    await waitForSettingsLoad();

    expect(screen.getByDisplayValue("/mock/Zoo/configs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse" })).toBeInTheDocument();
  });

  it("updates the config directory from browse selection", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitForSettingsLoad();

    await user.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() => expect(screen.getByDisplayValue("/mock/Zoo/selected-configs")).toBeInTheDocument());
  });

  it("loads and saves a gantry config across tab switches", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitForSettingsLoad();

    await importConfig(user, "Import gantry config", "cubos.yaml");
    const serialPort = await screen.findByLabelText("Serial port");
    expect(serialPort).toHaveValue("");

    await user.type(serialPort, "/dev/ttyUSB9");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Deck" }));
    await user.click(screen.getByRole("button", { name: "Gantry" }));

    await waitFor(() => expect(screen.getByLabelText("Serial port")).toHaveValue("/dev/ttyUSB9"));
  });

  it("loads and saves a deck config across tab switches", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitForSettingsLoad();

    await user.click(screen.getByRole("button", { name: "Deck" }));
    await importConfig(user, "Import deck config", "deck.yaml");
    const nameField = await screen.findByDisplayValue("Deck Plate");
    expect(nameField).toHaveValue("Deck Plate");

    await user.clear(nameField);
    await user.type(nameField, "Renamed Plate");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Gantry" }));
    await user.click(screen.getByRole("button", { name: "Deck" }));

    await waitFor(() => expect(screen.getByDisplayValue("Renamed Plate")).toBeInTheDocument());
  });

  it("imports a deck config into panda-deck.yaml", async () => {
    const user = userEvent.setup();
    const state = createState();
    installFetchMock(state);
    renderApp();
    await waitForSettingsLoad();

    await user.click(screen.getByRole("button", { name: "Deck" }));
    await importConfig(user, "Import deck config", "deck.yaml");

    expect(await screen.findByDisplayValue("Deck Plate")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText("panda-deck.yaml")).toBeInTheDocument());
    expect(state.decks["panda-deck.yaml"]?.labware).toEqual(state.decks["deck.yaml"]?.labware);
  });

  it("loads and saves gantry instruments across tab switches", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitForSettingsLoad();

    await importConfig(user, "Import gantry config", "cubos.yaml");
    const portField = await screen.findByLabelText("Port *");
    expect(portField).toHaveValue("/dev/ttyUSB0");

    await user.clear(portField);
    await user.type(portField, "/dev/ttyUSB4");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Deck" }));
    await user.click(screen.getByRole("button", { name: "Gantry" }));

    await waitFor(() => expect(screen.getByLabelText("Port *")).toHaveValue("/dev/ttyUSB4"));
  });

  it("opens the gantry calibration wizard from the control panel", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    renderApp();
    await waitForSettingsLoad();

    await importConfig(user, "Import gantry config", "cubos.yaml");
    await user.click(await screen.findByRole("button", { name: "Calibrate" }));

    expect(screen.getByRole("dialog", { name: "Gantry calibration" })).toBeInTheDocument();
    expect(screen.getByText(/single-instrument deck origin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /XY origin/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("button", { name: "Home gantry" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Home gantry" }));

    expect(await screen.findByRole("button", { name: "Set XY origin" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gantry/calibration/prepare-origin",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("loads and saves a protocol config across tab switches", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitForSettingsLoad();
    await loadRequiredProtocolDependencies(user);

    await user.click(screen.getByRole("button", { name: "Protocol" }));
    await importConfig(user, "Import protocol config", "move.yaml");
    const xField = await screen.findByDisplayValue("1");
    expect(xField).toHaveValue("1");

    await user.clear(xField);
    await user.type(xField, "42");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Gantry" }));
    await user.click(screen.getByRole("button", { name: "Protocol" }));

    await waitFor(() => expect(screen.getByDisplayValue("42")).toBeInTheDocument());
  });
});
