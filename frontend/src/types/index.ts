// Mirrors backend Pydantic models

export interface Coordinate3D {
  x: number;
  y: number;
  z: number;
}

export interface Coordinate2D {
  x: number;
  y: number;
}

export interface CalibrationPoints {
  a1: Coordinate3D | null;
  a2: Coordinate3D;
}

export interface WellPlateConfig {
  type: "well_plate";
  name: string;
  model_name: string;
  rows: number;
  columns: number;
  length_mm: number;
  width_mm: number;
  height_mm: number;
  a1: Coordinate3D | null;
  calibration: CalibrationPoints;
  x_offset_mm: number;
  y_offset_mm: number;
  capacity_ul: number;
  working_volume_ul: number;
}

export interface VialConfig {
  type: "vial";
  name: string;
  model_name: string;
  height_mm: number;
  diameter_mm: number;
  location: Coordinate3D;
  capacity_ul: number;
  working_volume_ul: number;
}

export interface TipRackConfig {
  type: "tip_rack";
  name: string;
  model_name: string;
  load_name?: string;
  rows?: number;
  columns?: number;
  z_pickup?: number;
  z_drop?: number;
  tips?: Record<string, WellPosition>;
  tip_present?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface NestedWellPlateConfig {
  name?: string;
  model_name: string;
  rows: number;
  columns: number;
  calibration: {
    a1: Coordinate2D | Coordinate3D | null;
    a2: Coordinate2D | Coordinate3D;
  };
  x_offset_mm: number;
  y_offset_mm: number;
  length_mm?: number;
  width_mm?: number;
  height_mm?: number;
  capacity_ul?: number;
  working_volume_ul?: number;
  [key: string]: unknown;
}

export interface NestedVialConfig {
  name?: string;
  model_name: string;
  height_mm: number;
  diameter_mm: number;
  location: Coordinate2D | Coordinate3D;
  capacity_ul: number;
  working_volume_ul: number;
  [key: string]: unknown;
}

export interface WellPlateHolderConfig {
  type: "well_plate_holder";
  name: string;
  model_name?: string;
  location?: Coordinate3D;
  well_plate?: NestedWellPlateConfig | null;
  [key: string]: unknown;
}

export interface VialHolderConfig {
  type: "vial_holder";
  name: string;
  model_name?: string;
  location?: Coordinate3D;
  vials?: Record<string, NestedVialConfig>;
  [key: string]: unknown;
}

export interface TipDisposalConfig {
  type: "tip_disposal";
  name: string;
  model_name?: string;
  location?: Coordinate3D;
  [key: string]: unknown;
}

export type UnsupportedDeckConfig =
  | TipRackConfig
  | WellPlateHolderConfig
  | VialHolderConfig
  | TipDisposalConfig;

export type LabwareConfig = WellPlateConfig | VialConfig | UnsupportedDeckConfig;

export interface WellPosition {
  x: number;
  y: number;
  z: number;
}

export interface GeometryResponse {
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
}

export interface LabwareResponse {
  key: string;
  config: LabwareConfig;
  wells: Record<string, WellPosition> | null;
  location?: Coordinate3D;
  geometry?: GeometryResponse;
  positions?: Record<string, WellPosition>;
}

export interface DeckResponse {
  filename: string;
  labware: LabwareResponse[];
}

export interface DeckConfig {
  labware: Record<string, LabwareConfig>;
}

export interface InstrumentConfig {
  type: string;
  vendor: string;
  offset_x: number;
  offset_y: number;
  depth?: number;
  measurement_height?: number;
  safe_approach_height?: number | null;
  [key: string]: unknown;
}

export interface WorkingVolume {
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
  z_min: number;
  z_max: number;
}

export interface CncConfig {
  homing_strategy: "standard";
  total_z_range: number;
  y_axis_motion?: "head" | "bed";
  safe_z?: number | null;
}

export interface GrblSettingsConfig {
  dir_invert_mask?: number | null;
  status_report?: number | null;
  soft_limits?: boolean | null;
  hard_limits?: boolean | null;
  homing_enable?: boolean | null;
  homing_dir_mask?: number | null;
  homing_pull_off?: number | null;
  steps_per_mm_x?: number | null;
  steps_per_mm_y?: number | null;
  steps_per_mm_z?: number | null;
  max_rate_x?: number | null;
  max_rate_y?: number | null;
  max_rate_z?: number | null;
  accel_x?: number | null;
  accel_y?: number | null;
  accel_z?: number | null;
  max_travel_x?: number | null;
  max_travel_y?: number | null;
  max_travel_z?: number | null;
}

export interface GantryConfig {
  serial_port: string;
  gantry_type: "cub" | "cub_xl";
  cnc: CncConfig;
  working_volume: WorkingVolume;
  grbl_settings?: GrblSettingsConfig | null;
  instruments: Record<string, InstrumentConfig>;
}

export interface GantryResponse {
  filename: string;
  config: GantryConfig;
}

export interface GantryPosition {
  x: number;
  y: number;
  z: number;
  work_x: number | null;
  work_y: number | null;
  work_z: number | null;
  status: string;
  connected: boolean;
  calibration_warning?: string | null;
}

// Gantry-mounted instrument introspection (from CubOS)

export interface InstrumentTypeInfo {
  type: string;
  vendors: string[];
  is_mock: boolean;
}

export interface PipetteModelInfo {
  name: string;
  family: string;
  channels: number;
  max_volume: number;
  min_volume: number;
}

export interface InstrumentFieldInfo {
  name: string;
  type: string;
  required: boolean;
  default: unknown;
  choices: string[] | null;
}

export type InstrumentSchemas = Record<string, InstrumentFieldInfo[]>;

// Protocol

export interface CommandArg {
  name: string;
  type: string;
  required: boolean;
  default: unknown;
}

export interface CommandInfo {
  name: string;
  args: CommandArg[];
  description: string;
}

export interface ProtocolStep {
  command: string;
  args: Record<string, unknown>;
}

export interface ProtocolConfig {
  protocol: ProtocolStep[];
}

export interface ProtocolResponse {
  filename: string;
  steps: ProtocolStep[];
}

export interface ProtocolValidationResponse {
  valid: boolean;
  errors: string[];
}
