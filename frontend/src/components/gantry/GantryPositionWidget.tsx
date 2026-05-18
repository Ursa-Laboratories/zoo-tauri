import { useCallback, useEffect, useRef, useState } from "react";
import { gantryApi } from "../../api/client";
import type { GantryConfig, GantryPosition, GantryResponse, WorkingVolume } from "../../types";
import CalibrationWizard from "./CalibrationWizard";

interface Props {
  position: GantryPosition | null;
  workingVolume: WorkingVolume | null;
  gantryFile: string | null;
  gantry: GantryResponse | null;
  onSaveCalibrated: (filename: string, config: GantryConfig) => Promise<void>;
}

const JOG_INTERVAL_MS = 150;

export default function GantryPositionWidget({
  position,
  workingVolume,
  gantryFile,
  gantry,
  onSaveCalibrated,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [jogBusy, setJogBusy] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [stepXY, setStepXY] = useState("0.5");
  const [stepZ, setStepZ] = useState("0.5");
  const [moveX, setMoveX] = useState("");
  const [moveY, setMoveY] = useState("");
  const [moveZ, setMoveZ] = useState("");
  const jogTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const configSelected = !!gantryFile;
  const connected = configSelected && (position?.connected ?? false);
  const status = position?.status ?? "Not connected";
  const isAlarm = status.toLowerCase().includes("alarm");
  const isMoving = status === "Run" || status === "Jog";
  const calibrationWarning = connected ? position?.calibration_warning : null;

  const jog = useCallback((x: number, y: number, z: number) => {
    if (!connected) return;
    gantryApi.jog(x, y, z).catch((e) => console.error("Jog failed:", e));
  }, [connected]);

  const startJog = useCallback((x: number, y: number, z: number) => {
    jog(x, y, z);
    if (jogTimer.current) clearInterval(jogTimer.current);
    jogTimer.current = setInterval(() => jog(x, y, z), JOG_INTERVAL_MS);
  }, [jog]);

  const stopJog = useCallback(() => {
    if (jogTimer.current) {
      clearInterval(jogTimer.current);
      jogTimer.current = null;
    }
  }, []);

  // Clean up on unmount
  useEffect(() => () => stopJog(), [stopJog]);

  // Keyboard support: arrow keys for XY, X/Z for Z axis
  useEffect(() => {
    const held = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!connected) return;
      // Don't capture if user is typing in an input
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const key = e.key;
      if (held.has(key)) return; // already held
      held.add(key);

      const xy = Math.max(0.001, parseFloat(stepXY) || 0.5);
      const z = Math.max(0.001, parseFloat(stepZ) || 0.5);

      switch (key) {
        case "ArrowLeft":  e.preventDefault(); startJog(-xy, 0, 0); break;
        case "ArrowRight": e.preventDefault(); startJog(xy, 0, 0); break;
        case "ArrowUp":    e.preventDefault(); startJog(0, xy, 0); break;
        case "ArrowDown":  e.preventDefault(); startJog(0, -xy, 0); break;
        case "x": case "X": startJog(0, 0, z); break;
        case "z": case "Z": startJog(0, 0, -z); break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.key);
      if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","z","Z","x","X"].includes(e.key)) {
        stopJog();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [connected, stepXY, stepZ, startJog, stopJog]);

  const handleConnect = async () => {
    if (!gantryFile) return;
    setLoading(true);
    try {
      await gantryApi.connect(gantryFile);
    } catch (e) {
      alert(`Connection failed: ${e}`);
    }
    setLoading(false);
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await gantryApi.disconnect();
    } catch (e) {
      alert(`Disconnect failed: ${e}`);
    }
    setLoading(false);
  };

  const handleUnlock = async () => {
    if (!connected) return;
    setJogBusy(true);
    try {
      await gantryApi.unlock();
    } catch (e) {
      console.error("Unlock failed:", e);
    }
    setJogBusy(false);
  };

  const handleHome = async () => {
    if (!connected) return;
    if (!window.confirm("Confirm you want to go to home?")) return;
    setJogBusy(true);
    try {
      await gantryApi.home();
    } catch (e) {
      console.error("Homing failed:", e);
    }
    setJogBusy(false);
  };

  const handleMoveTo = () => {
    if (!connected) return;
    const x = parseFloat(moveX);
    const y = parseFloat(moveY);
    const z = parseFloat(moveZ);
    if (isNaN(x) || isNaN(y) || isNaN(z)) {
      alert("Enter valid X, Y, and Z coordinates");
      return;
    }
    if (x < 0 || y < 0 || z < 0) {
      alert("Coordinates must be positive (user space)");
      return;
    }
    gantryApi.moveTo(x, y, z).catch((e) => alert(`Move failed: ${e}`));
  };

  // 800 steps/mm → min 0.00125mm; clamp to 0.001mm floor
  const MIN_STEP = 0.001;
  const xyStep = Math.max(MIN_STEP, parseFloat(stepXY) || 0.5);
  const zStep = Math.max(MIN_STEP, parseFloat(stepZ) || 0.5);
  const xyBelowMin = (parseFloat(stepXY) || 0) > 0 && (parseFloat(stepXY) || 0) < MIN_STEP;
  const zBelowMin = (parseFloat(stepZ) || 0) > 0 && (parseFloat(stepZ) || 0) < MIN_STEP;
  const jogDisabled = !connected || jogBusy;
  const canCalibrate = !!gantry;

  const jogBtnProps = (x: number, y: number, z: number) => ({
    onMouseDown: () => !jogDisabled && startJog(x, y, z),
    onMouseUp: stopJog,
    onMouseLeave: stopJog,
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); if (!jogDisabled) startJog(x, y, z); },
    onTouchEnd: stopJog,
  });

  // Status color and label
  const statusColor = isAlarm ? "#dc2626" : status === "Idle" ? "#22c55e" : status === "Run" || status === "Jog" ? "#2563eb" : "#888";

  return (
    <div>
      <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Gantry Control</h3>

      {/* Alarm banner */}
      {isAlarm && connected && (
        <div style={{
          background: "#fef2f2",
          border: "1px solid #dc2626",
          borderRadius: 4,
          padding: "8px 12px",
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ color: "#dc2626", fontWeight: 700, fontSize: 13 }}>ALARM</span>
          <span style={{ color: "#991b1b", fontSize: 11 }}>
            {status} — Unlock to clear, then jog back to safety.
          </span>
          <button
            onClick={handleUnlock}
            disabled={jogBusy}
            style={{
              background: "#dc2626",
              color: "#fff",
              border: "none",
              padding: "4px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              marginLeft: "auto",
            }}
          >
            Unlock ($X)
          </button>
        </div>
      )}

      {calibrationWarning && (
        <div style={{
          background: "#fffbeb",
          border: "1px solid #f59e0b",
          borderRadius: 4,
          padding: "8px 12px",
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ color: "#b45309", fontWeight: 700, fontSize: 13 }}>CALIBRATION NEEDED</span>
          <span style={{ color: "#92400e", fontSize: 11 }}>
            {calibrationWarning}
          </span>
        </div>
      )}

      {/* Top row: D-pad + Z on left, XYZ readout on right */}
      <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
        {/* Jog controls */}
        <div>
          <div style={{ display: "flex", gap: 24, alignItems: "center", marginBottom: 8 }}>
            {/* XY D-pad */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 40px)", gridTemplateRows: "repeat(3, 40px)", gap: 2 }}>
              <div />
              <button className="jog-btn" style={jogBtnStyle} disabled={jogDisabled} {...jogBtnProps(0, xyStep, 0)} title="Y+">
                ↑
              </button>
              <div />
              <button className="jog-btn" style={jogBtnStyle} disabled={jogDisabled} {...jogBtnProps(-xyStep, 0, 0)} title="X-">
                ←
              </button>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#bbb" }}>
                XY
              </div>
              <button className="jog-btn" style={jogBtnStyle} disabled={jogDisabled} {...jogBtnProps(xyStep, 0, 0)} title="X+">
                →
              </button>
              <div />
              <button className="jog-btn" style={jogBtnStyle} disabled={jogDisabled} {...jogBtnProps(0, -xyStep, 0)} title="Y-">
                ↓
              </button>
              <div />
            </div>

            {/* Z controls */}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <button className="jog-btn" style={jogBtnStyle} disabled={jogDisabled} {...jogBtnProps(0, 0, zStep)} title="Z+">
                Z+
              </button>
              <div style={{ fontSize: 10, color: "#bbb", textAlign: "center" }}>Z</div>
              <button className="jog-btn" style={jogBtnStyle} disabled={jogDisabled} {...jogBtnProps(0, 0, -zStep)} title="Z-">
                Z−
              </button>
            </div>
          </div>

          {/* Step size inputs */}
          <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#888" }}>XY mm</span>
              <input
                type="text"
                inputMode="decimal"
                value={stepXY}
                onChange={(e) => setStepXY(e.target.value)}
                style={{ ...inputStyle, width: 48, fontSize: 11, padding: "2px 4px", borderColor: xyBelowMin ? "#dc2626" : "#ccc" }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#888" }}>Z mm</span>
              <input
                type="text"
                inputMode="decimal"
                value={stepZ}
                onChange={(e) => setStepZ(e.target.value)}
                style={{ ...inputStyle, width: 48, fontSize: 11, padding: "2px 4px", borderColor: zBelowMin ? "#dc2626" : "#ccc" }}
              />
            </label>
            {(xyBelowMin || zBelowMin) && (
              <span style={{ color: "#dc2626", fontSize: 10, alignSelf: "center" }}>min {MIN_STEP}mm</span>
            )}
          </div>
        </div>

        {/* XYZ Readout */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
          {(["X", "Y", "Z"] as const).map((axis) => {
            const rawMpos = connected ? position![axis.toLowerCase() as "x" | "y" | "z"] : null;
            const mpos = rawMpos;
            const wKey = `work_${axis.toLowerCase()}` as "work_x" | "work_y" | "work_z";
            const rawWpos = connected ? position![wKey] : null;
            const wpos = rawWpos;
            return (
              <div key={axis} style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ color: "#888", fontSize: 13, fontWeight: 600, width: 14 }}>{axis}</span>
                <span style={coordStyle}>
                  {wpos != null ? wpos.toFixed(3) : mpos != null ? mpos.toFixed(3) : "\u2014"}
                </span>
                {wpos != null && mpos != null && (
                  <span style={{ color: "#bbb", fontSize: 10 }}>M{mpos.toFixed(1)}</span>
                )}
              </div>
            );
          })}
          <div style={{
            fontSize: 12,
            color: statusColor,
            fontWeight: isAlarm ? 700 : 500,
            marginTop: 2,
          }}>
            {status}
          </div>
        </div>
      </div>

      {/* Home and calibration */}
      <div style={{ marginBottom: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={handleHome} disabled={jogDisabled} style={homeBtnStyle}>
          Home
        </button>
        <button
          onClick={() => setCalibrationOpen(true)}
          disabled={!canCalibrate}
          style={{
            ...calibrateBtnStyle,
            opacity: canCalibrate ? 1 : 0.45,
            cursor: canCalibrate ? "pointer" : "not-allowed",
          }}
          title={canCalibrate ? "Open gantry calibration" : "Load a gantry config first"}
        >
          Calibrate
        </button>
      </div>

      {workingVolume && (
        <div style={{ fontSize: 10, color: "#bbb", marginBottom: 8 }}>
          Vol: X[{workingVolume.x_min}, {workingVolume.x_max}] Y[{workingVolume.y_min},{" "}
          {workingVolume.y_max}] Z[{workingVolume.z_min}, {workingVolume.z_max}]
        </div>
      )}

      {/* Move To */}
      {connected && (
        <div style={{ marginBottom: 10, borderTop: "1px solid #eee", paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#444" }}>Move To</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["X", "Y", "Z"] as const).map((axis) => {
              const setter = axis === "X" ? setMoveX : axis === "Y" ? setMoveY : setMoveZ;
              const value = axis === "X" ? moveX : axis === "Y" ? moveY : moveZ;
              return (
                <label key={axis} style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11 }}>
                  <span style={{ color: "#888" }}>{axis}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={value}
                    onChange={(e) => setter(e.target.value)}
                    placeholder="0"
                    style={{ ...inputStyle, width: 52, fontSize: 11, padding: "3px 4px" }}
                  />
                </label>
              );
            })}
            <button
              onClick={handleMoveTo}
              disabled={!connected || isMoving}
              style={{
                ...btnStyle,
                background: "#2563eb",
                color: "#fff",
                border: "1px solid #2563eb",
                fontWeight: 600,
                opacity: isMoving ? 0.6 : 1,
              }}
            >
              {isMoving ? "Moving..." : "Go"}
            </button>
          </div>
        </div>
      )}

      {/* Connection controls — bottom */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", borderTop: "1px solid #eee", paddingTop: 10 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: isAlarm ? "#dc2626" : connected ? "#22c55e" : "#888",
          display: "inline-block",
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 11, color: isAlarm ? "#dc2626" : connected ? "#22c55e" : "#888" }}>
          {connected ? (isAlarm ? "Alarm" : "Connected") : "Not connected"}
        </span>
        {!connected ? (
          <button onClick={handleConnect} disabled={loading || !configSelected} style={btnStyle}>
            {!configSelected ? "Select config first" : loading ? "Scanning..." : "Connect"}
          </button>
        ) : (
          <button onClick={handleDisconnect} disabled={loading} style={btnStyle}>
            {loading ? "..." : "Disconnect"}
          </button>
        )}
      </div>

      <div style={{ fontSize: 10, color: "#bbb", marginTop: 8 }}>
        Keyboard: Arrow keys = XY, X/Z keys = Z up/down
      </div>
      <CalibrationWizard
        open={calibrationOpen}
        onClose={() => setCalibrationOpen(false)}
        gantry={gantry}
        position={position}
        onSaveCalibrated={onSaveCalibrated}
      />
    </div>
  );
}

const coordStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 26,
  fontWeight: 700,
  minWidth: 100,
  textAlign: "right",
  display: "inline-block",
  color: "#1a1a1a",
};

const btnStyle: React.CSSProperties = {
  background: "#f5f5f5",
  color: "#1a1a1a",
  border: "1px solid #ccc",
  padding: "4px 12px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

const inputStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #ccc",
  color: "#1a1a1a",
  padding: "4px 8px",
  borderRadius: 4,
  fontSize: 12,
};

const homeBtnStyle: React.CSSProperties = {
  background: "#fff",
  color: "#d97706",
  border: "1px solid #d97706",
  padding: "5px 16px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};

const calibrateBtnStyle: React.CSSProperties = {
  background: "#0f766e",
  color: "#fff",
  border: "1px solid #0f766e",
  padding: "5px 16px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
};

const jogBtnStyle: React.CSSProperties = {
  width: 40,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f5f5f5",
  border: "1px solid #ccc",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 16,
  fontWeight: 600,
  color: "#1a1a1a",
  transition: "background 0.1s, transform 0.1s",
};
