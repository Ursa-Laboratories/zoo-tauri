import { useState } from "react";
import type {
  GantryResponse,
  GantryConfig,
  GrblSettingsConfig,
  InstrumentConfig,
  InstrumentSchemas,
  InstrumentTypeInfo,
} from "../../types";
import { DirtyMarker, NumberField, SaveButton, TextField } from "./fields";
import { isFieldEqual } from "./field-utils";
import ImportFromFile from "./ImportFromFile";

interface Props {
  configs: string[];
  selectedFile: string | null;
  onSelectFile: (f: string) => void;
  gantry: GantryResponse | null;
  /** The server-loaded config; used to decide which fields show the
   * amber "*" dirty marker. Differs from ``gantry`` when the parent
   * is passing a local working copy with unsaved edits. */
  baseline: GantryResponse | null;
  instrumentTypes: InstrumentTypeInfo[];
  instrumentSchemas: InstrumentSchemas;
  onSave: (filename: string, body: GantryConfig) => void;
  /** Called on every local edit so the parent can persist the working
   * copy across tab switches (the editor unmounts on tab-away and would
   * otherwise lose its useState). */
  onLocalChange?: (gantry: GantryResponse) => void;
  onRefresh: () => void;
}

const HOMING_STRATEGIES = ["standard"] as const;
const Y_AXIS_MOTION_OPTIONS = ["head", "bed"] as const;

const EMPTY_GANTRY: GantryConfig = {
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
  instruments: {},
};

const GRBL_NUMBER_FIELDS: Array<{ key: keyof GrblSettingsConfig; label: string }> = [
  { key: "dir_invert_mask", label: "Dir invert mask" },
  { key: "status_report", label: "Status report" },
  { key: "homing_dir_mask", label: "Homing dir mask" },
  { key: "homing_pull_off", label: "Homing pull-off" },
  { key: "steps_per_mm_x", label: "Steps/mm X" },
  { key: "steps_per_mm_y", label: "Steps/mm Y" },
  { key: "steps_per_mm_z", label: "Steps/mm Z" },
  { key: "max_rate_x", label: "Max rate X" },
  { key: "max_rate_y", label: "Max rate Y" },
  { key: "max_rate_z", label: "Max rate Z" },
  { key: "accel_x", label: "Accel X" },
  { key: "accel_y", label: "Accel Y" },
  { key: "accel_z", label: "Accel Z" },
  { key: "max_travel_x", label: "Max travel X" },
  { key: "max_travel_y", label: "Max travel Y" },
  { key: "max_travel_z", label: "Max travel Z" },
];

const GRBL_BOOLEAN_FIELDS: Array<{ key: keyof GrblSettingsConfig; label: string }> = [
  { key: "soft_limits", label: "Soft limits" },
  { key: "hard_limits", label: "Hard limits" },
  { key: "homing_enable", label: "Homing enable" },
];

const INSTRUMENT_COLORS: Record<string, string> = {
  asmi: "#2563eb",
  uvvis_ccs: "#7c3aed",
  pipette: "#059669",
  filmetrics: "#d97706",
  potentiostat: "#dc2626",
  uv_curing: "#0891b2",
};

export default function GantryEditor({
  configs,
  selectedFile,
  onSelectFile,
  gantry,
  baseline,
  instrumentTypes,
  instrumentSchemas,
  onSave,
  onLocalChange,
}: Props) {
  const [config, setConfig] = useState<GantryConfig | null>(() => (
    gantry ? structuredClone(gantry.config) : null
  ));
  const [addType, setAddType] = useState<string>("");
  const [saveAs, setSaveAs] = useState("");

  const selectedAddType = addType || instrumentTypes[0]?.type || "";

  const commit = (next: GantryConfig) => {
    setConfig(next);
    onLocalChange?.({ filename: selectedFile ?? "unsaved", config: next });
  };

  const startNew = () => {
    commit(structuredClone(EMPTY_GANTRY));
  };

  const updateInstrument = (key: string, inst: InstrumentConfig) => {
    if (!config) return;
    commit({
      ...config,
      instruments: { ...config.instruments, [key]: inst },
    });
  };

  const removeInstrument = (key: string) => {
    if (!config) return;
    const next = { ...config.instruments };
    delete next[key];
    commit({ ...config, instruments: next });
  };

  const addInstrument = () => {
    if (!config || !selectedAddType) return;
    let idx = Object.keys(config.instruments).length + 1;
    let key = `${selectedAddType}_${idx}`;
    while (config.instruments[key]) {
      idx += 1;
      key = `${selectedAddType}_${idx}`;
    }

    const vendors = vendorsForType(instrumentTypes, selectedAddType);
    const template: InstrumentConfig = {
      type: selectedAddType,
      vendor: vendors[0] ?? "",
      offset_x: 0,
      offset_y: 0,
      depth: 0,
      measurement_height: 0,
      safe_approach_height: 0,
    };
    const fields = instrumentSchemas[selectedAddType] ?? [];
    for (const field of fields) {
      if (field.default != null) {
        (template as Record<string, unknown>)[field.name] = field.default;
      }
    }
    commit({ ...config, instruments: { ...config.instruments, [key]: template } });
  };

  const updateGrblSetting = (field: keyof GrblSettingsConfig, value: number | boolean | null) => {
    if (!config) return;
    const nextSettings = { ...(config.grbl_settings ?? {}) };
    if (value === null) {
      delete nextSettings[field];
    } else {
      (nextSettings as Record<string, number | boolean>)[field] = value;
    }
    commit({ ...config, grbl_settings: nextSettings });
  };

  // Per-field dirty compared against the last-saved config. A missing
  // baseline means there's nothing saved yet (brand-new config).
  const base = baseline?.config;
  const notDirty = (a: unknown, b: unknown) => !base || isFieldEqual(a, b);
  const wv = config?.working_volume;
  const bwv = base?.working_volume;
  const cnc = config?.cnc;
  const bcnc = base?.cnc;
  const d = {
    serial_port: !!config && !notDirty(config.serial_port, base?.serial_port ?? ""),
    gantry_type: !!config && !notDirty(config.gantry_type, base?.gantry_type),
    homing_strategy: !!cnc && !notDirty(cnc.homing_strategy, bcnc?.homing_strategy),
    total_z_range: !!cnc && !notDirty(cnc.total_z_range, bcnc?.total_z_range),
    safe_z: !!cnc && !notDirty(cnc.safe_z, bcnc?.safe_z),
    y_axis_motion: !!cnc && !notDirty(cnc.y_axis_motion, bcnc?.y_axis_motion),
    x_min: !!wv && !notDirty(wv.x_min, bwv?.x_min),
    x_max: !!wv && !notDirty(wv.x_max, bwv?.x_max),
    y_min: !!wv && !notDirty(wv.y_min, bwv?.y_min),
    y_max: !!wv && !notDirty(wv.y_max, bwv?.y_max),
    z_min: !!wv && !notDirty(wv.z_min, bwv?.z_min),
    z_max: !!wv && !notDirty(wv.z_max, bwv?.z_max),
  };

  const canSave = !!config && isValidGantry(config) && (!!saveAs.trim() || !!selectedFile);

  const handleSave = () => {
    if (!config || !canSave) return;
    const filename = saveAs.trim() || selectedFile || "";
    const normalized = filename.endsWith(".yaml") ? filename : filename + ".yaml";
    onSelectFile(normalized);
    onSave(normalized, config);
    setSaveAs("");
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <ImportFromFile configs={configs} onSelectFile={onSelectFile} label="Import gantry config" />
        {!config && <button onClick={startNew} style={addBtnStyle}>+ New Gantry Config</button>}
      </div>

      {config && (
        <>
          <div style={cardStyle}>
            <h4 style={{ margin: "0 0 8px", color: "#16a34a", fontSize: 13 }}>Connection</h4>
            <TextField
              label="Serial port"
              value={config.serial_port}
              onChange={(v) => commit({ ...config, serial_port: v })}
              dirty={d.serial_port}
            />
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <SelectField
                label="Gantry type"
                value={config.gantry_type}
                options={[
                  { value: "cub", label: "Cub" },
                  { value: "cub_xl", label: "Cub XL" },
                ]}
                onChange={(v) => commit({ ...config, gantry_type: v as "cub" | "cub_xl" })}
                dirty={d.gantry_type}
                required
              />
              <SelectField
                label="Homing strategy"
                value={config.cnc.homing_strategy}
                options={HOMING_STRATEGIES.map((s) => ({ value: s, label: s }))}
                onChange={() => commit({ ...config, cnc: { ...config.cnc, homing_strategy: "standard" } })}
                dirty={d.homing_strategy}
              />
              <SelectField
                label="Y-axis motion"
                value={config.cnc.y_axis_motion ?? "head"}
                options={Y_AXIS_MOTION_OPTIONS.map((s) => ({ value: s, label: s === "head" ? "Head moves" : "Bed moves" }))}
                onChange={(v) => commit({ ...config, cnc: { ...config.cnc, y_axis_motion: v as "head" | "bed" } })}
                dirty={d.y_axis_motion}
              />
              <NumberField
                label="Total Z range"
                value={config.cnc.total_z_range}
                onChange={(v) => commit({ ...config, cnc: { ...config.cnc, total_z_range: v } })}
                dirty={d.total_z_range}
                required
              />
              <NumberField
                label="Safe Z"
                value={Number(config.cnc.safe_z ?? config.working_volume.z_max)}
                onChange={(v) => commit({ ...config, cnc: { ...config.cnc, safe_z: v } })}
                dirty={d.safe_z}
              />
            </div>
          </div>

          <div style={cardStyle}>
            <h4 style={{ margin: "0 0 8px", color: "#16a34a", fontSize: 13 }}>Working Volume</h4>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <NumberField label="X min" value={config.working_volume.x_min} onChange={(v) => commit({ ...config, working_volume: { ...config.working_volume, x_min: v } })} dirty={d.x_min} />
              <NumberField label="X max" value={config.working_volume.x_max} onChange={(v) => commit({ ...config, working_volume: { ...config.working_volume, x_max: v } })} dirty={d.x_max} />
              <NumberField label="Y min" value={config.working_volume.y_min} onChange={(v) => commit({ ...config, working_volume: { ...config.working_volume, y_min: v } })} dirty={d.y_min} />
              <NumberField label="Y max" value={config.working_volume.y_max} onChange={(v) => commit({ ...config, working_volume: { ...config.working_volume, y_max: v } })} dirty={d.y_max} />
              <NumberField label="Z min" value={config.working_volume.z_min} onChange={(v) => commit({ ...config, working_volume: { ...config.working_volume, z_min: v } })} dirty={d.z_min} />
              <NumberField label="Z max" value={config.working_volume.z_max} onChange={(v) => commit({ ...config, working_volume: { ...config.working_volume, z_max: v } })} dirty={d.z_max} />
            </div>
          </div>

          <div style={cardStyle}>
            <h4 style={{ margin: "0 0 8px", color: "#16a34a", fontSize: 13 }}>GRBL Settings</h4>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {GRBL_BOOLEAN_FIELDS.map(({ key, label }) => (
                <OptionalBooleanField
                  key={key}
                  label={label}
                  value={config.grbl_settings?.[key] as boolean | null | undefined}
                  onChange={(v) => updateGrblSetting(key, v)}
                  dirty={!!config && !notDirty(config.grbl_settings?.[key], base?.grbl_settings?.[key])}
                />
              ))}
              {GRBL_NUMBER_FIELDS.map(({ key, label }) => (
                <OptionalNumberField
                  key={key}
                  label={label}
                  value={config.grbl_settings?.[key] as number | null | undefined}
                  onChange={(v) => updateGrblSetting(key, v)}
                  dirty={!!config && !notDirty(config.grbl_settings?.[key], base?.grbl_settings?.[key])}
                />
              ))}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <h4 style={{ margin: 0, color: "#16a34a", fontSize: 13 }}>Instruments</h4>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={selectedAddType} onChange={(e) => setAddType(e.target.value)} style={selectStyle}>
                  {instrumentTypes.map((it) => (
                    <option key={it.type} value={it.type}>{typeLabel(it.type)}{it.is_mock ? " (mock)" : ""}</option>
                  ))}
                </select>
                <button onClick={addInstrument} style={addBtnStyle} disabled={!selectedAddType}>+ Add</button>
              </div>
            </div>

            {Object.entries(config.instruments).map(([key, inst]) => {
              const color = INSTRUMENT_COLORS[inst.type] ?? INSTRUMENT_COLORS[inst.type.replace("mock_", "")] ?? "#666";
              const fields = instrumentSchemas[inst.type] ?? [];
              const vendors = vendorsForType(instrumentTypes, inst.type);
              return (
                <div key={key} style={instrumentCardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h4 style={{ margin: 0, color, fontSize: 13 }}>
                      {key} <span style={{ fontWeight: 400, color: "#888", fontSize: 11 }}>({typeLabel(inst.type)})</span>
                    </h4>
                    <button onClick={() => removeInstrument(key)} style={removeBtnStyle}>Remove</button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <TextField
                      label="Type"
                      value={inst.type}
                      onChange={(v) => updateInstrument(key, { ...inst, type: v })}
                      dirty={isInstrumentFieldDirty(baseline, key, "type", inst.type)}
                      required
                    />
                    {vendors.length > 0 ? (
                      <SelectField
                        label="Vendor"
                        value={inst.vendor}
                        options={vendors.map((v) => ({ value: v, label: v }))}
                        onChange={(v) => updateInstrument(key, { ...inst, vendor: v })}
                        dirty={isInstrumentFieldDirty(baseline, key, "vendor", inst.vendor)}
                        required
                      />
                    ) : (
                      <TextField
                        label="Vendor"
                        value={inst.vendor}
                        onChange={(v) => updateInstrument(key, { ...inst, vendor: v })}
                        dirty={isInstrumentFieldDirty(baseline, key, "vendor", inst.vendor)}
                        required
                      />
                    )}
                    <NumberField label="Offset X" value={inst.offset_x} onChange={(v) => updateInstrument(key, { ...inst, offset_x: v })} dirty={isInstrumentFieldDirty(baseline, key, "offset_x", inst.offset_x)} />
                    <NumberField label="Offset Y" value={inst.offset_y} onChange={(v) => updateInstrument(key, { ...inst, offset_y: v })} dirty={isInstrumentFieldDirty(baseline, key, "offset_y", inst.offset_y)} />
                    <NumberField label="Depth" value={Number(inst.depth ?? 0)} onChange={(v) => updateInstrument(key, { ...inst, depth: v })} dirty={isInstrumentFieldDirty(baseline, key, "depth", inst.depth)} />
                    <NumberField label="Measurement height" value={Number(inst.measurement_height ?? 0)} onChange={(v) => updateInstrument(key, { ...inst, measurement_height: v })} dirty={isInstrumentFieldDirty(baseline, key, "measurement_height", inst.measurement_height)} />
                    <NumberField label="Safe approach" value={Number(inst.safe_approach_height ?? inst.measurement_height ?? 0)} onChange={(v) => updateInstrument(key, { ...inst, safe_approach_height: v })} dirty={isInstrumentFieldDirty(baseline, key, "safe_approach_height", inst.safe_approach_height)} />
                  </div>

                  {fields.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                      {fields.map((field) => {
                        const value = (inst as Record<string, unknown>)[field.name];
                        const fieldDirty = isInstrumentFieldDirty(baseline, key, field.name, value);
                        if (field.choices) {
                          return (
                            <SelectField
                              key={field.name}
                              label={fieldLabel(field.name) + (field.required ? " *" : "")}
                              value={String(value ?? field.default ?? "")}
                              options={field.choices.map((c) => ({ value: c, label: c }))}
                              onChange={(v) => updateInstrument(key, { ...inst, [field.name]: v })}
                              dirty={fieldDirty}
                            />
                          );
                        }
                        if (field.type === "bool") {
                          return (
                            <SelectField
                              key={field.name}
                              label={fieldLabel(field.name) + (field.required ? " *" : "")}
                              value={String(value ?? field.default ?? false)}
                              options={[{ value: "true", label: "true" }, { value: "false", label: "false" }]}
                              onChange={(v) => updateInstrument(key, { ...inst, [field.name]: v === "true" })}
                              dirty={fieldDirty}
                            />
                          );
                        }
                        if (field.type === "float" || field.type === "int") {
                          return (
                            <NumberField
                              key={field.name}
                              label={fieldLabel(field.name) + (field.required ? " *" : "")}
                              value={Number(value ?? field.default ?? 0)}
                              onChange={(v) => updateInstrument(key, { ...inst, [field.name]: v })}
                              dirty={fieldDirty}
                            />
                          );
                        }
                        return (
                          <TextField
                            key={field.name}
                            label={fieldLabel(field.name) + (field.required ? " *" : "")}
                            value={String(value ?? field.default ?? "")}
                            onChange={(v) => updateInstrument(key, { ...inst, [field.name]: v })}
                            dirty={fieldDirty}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
            <input
              value={saveAs}
              onChange={(e) => setSaveAs(e.target.value)}
              placeholder={selectedFile ?? "my_gantry.yaml"}
              style={filenameInputStyle}
            />
            <SaveButton onClick={handleSave} disabled={!canSave} />
          </div>
        </>
      )}
    </div>
  );
}

function isValidGantry(config: GantryConfig): boolean {
  const wv = config.working_volume;
  if (wv.x_min >= wv.x_max || wv.y_min >= wv.y_max || wv.z_min >= wv.z_max) return false;
  if (config.cnc.total_z_range <= 0 || config.cnc.total_z_range < wv.z_max) return false;
  if (config.cnc.safe_z != null && (config.cnc.safe_z < wv.z_min || config.cnc.safe_z > wv.z_max)) return false;
  for (const inst of Object.values(config.instruments)) {
    if (!inst.type.trim() || !inst.vendor.trim()) return false;
    const measurement = Number(inst.measurement_height ?? 0);
    const safe = inst.safe_approach_height == null ? measurement : Number(inst.safe_approach_height);
    if (safe < measurement) return false;
  }
  return true;
}

function isInstrumentFieldDirty(
  baseline: GantryResponse | null,
  key: string,
  field: string,
  current: unknown,
): boolean {
  const base = baseline?.config.instruments?.[key];
  if (base === undefined) return false;
  return !isFieldEqual((base as Record<string, unknown>)[field], current);
}

function vendorsForType(instrumentTypes: InstrumentTypeInfo[], type: string): string[] {
  return instrumentTypes.find((it) => it.type === type)?.vendors ?? [];
}

function typeLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fieldLabel(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function SelectField({
  label,
  value,
  options,
  onChange,
  dirty,
  required,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  dirty?: boolean;
  required?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
      <span style={{ color: "#666" }}>
        {label}
        {required && <span style={{ color: "#dc2626" }}> *</span>}
        {dirty && <DirtyMarker />}
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function OptionalNumberField({
  label,
  value,
  onChange,
  dirty,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  dirty?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "end", gap: 4 }}>
      <div style={{ flex: 1 }}>
        <NumberField
          label={label}
          value={Number(value ?? 0)}
          onChange={(v) => onChange(v)}
          dirty={dirty}
        />
      </div>
      <button onClick={() => onChange(null)} disabled={value == null} style={clearBtnStyle}>Clear</button>
    </div>
  );
}

function OptionalBooleanField({
  label,
  value,
  onChange,
  dirty,
}: {
  label: string;
  value: boolean | null | undefined;
  onChange: (value: boolean | null) => void;
  dirty?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
      <span style={{ color: "#666" }}>
        {label}
        {dirty && <DirtyMarker />}
      </span>
      <select
        value={value == null ? "" : value ? "true" : "false"}
        onChange={(e) => {
          if (e.target.value === "") onChange(null);
          else onChange(e.target.value === "true");
        }}
        style={selectStyle}
      >
        <option value="">unset</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    </label>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#fafafa",
  border: "1px solid #e0e0e0",
  borderRadius: 6,
  padding: 12,
  marginTop: 8,
};

const instrumentCardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e0e0e0",
  borderRadius: 6,
  padding: 12,
  marginTop: 10,
};

const selectStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #ccc",
  color: "#1a1a1a",
  padding: "4px 6px",
  borderRadius: 4,
  fontSize: 13,
};

const addBtnStyle: React.CSSProperties = {
  background: "#fff",
  color: "#16a34a",
  border: "1px solid #16a34a",
  padding: "5px 14px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const removeBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#999",
  border: "1px solid #ddd",
  padding: "2px 10px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 11,
};

const clearBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#888",
  border: "1px solid #ddd",
  padding: "4px 8px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 11,
};

const filenameInputStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #ccc",
  color: "#1a1a1a",
  padding: "4px 8px",
  borderRadius: 4,
  fontSize: 13,
  flex: 1,
};
