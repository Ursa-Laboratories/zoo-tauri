import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TouchEvent } from "react";
import { gantryApi } from "../../api/client";
import type { GantryConfig, GantryPosition, GantryResponse } from "../../types";

interface Props {
  open: boolean;
  onClose: () => void;
  gantry: GantryResponse | null;
  position: GantryPosition | null;
  onSaveCalibrated: (filename: string, config: GantryConfig) => Promise<void>;
}

type CapturedPosition = {
  x: number;
  y: number;
  z: number;
};

const JOG_INTERVAL_MS = 150;
const MIN_STEP = 0.001;

export default function CalibrationWizard({
  open,
  onClose,
  gantry,
  position,
  onSaveCalibrated,
}: Props) {
  const [step, setStep] = useState(0);
  const [xyStep, setXyStep] = useState("0.5");
  const [zStep, setZStep] = useState("0.5");
  const [blockHeight, setBlockHeight] = useState("10");
  const [programSoftLimits, setProgramSoftLimits] = useState(true);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [xyOrigin, setXyOrigin] = useState<CapturedPosition | null>(null);
  const [zReference, setZReference] = useState<CapturedPosition | null>(null);
  const [xyBounds, setXyBounds] = useState<CapturedPosition | null>(null);
  const [centerPosition, setCenterPosition] = useState<CapturedPosition | null>(null);
  const [measuredVolume, setMeasuredVolume] = useState<CapturedPosition | null>(null);
  const [instrumentPositions, setInstrumentPositions] = useState<Record<string, CapturedPosition>>({});
  const [outputFile, setOutputFile] = useState("");
  const [referenceInstrument, setReferenceInstrument] = useState("");
  const [lowestInstrument, setLowestInstrument] = useState("");
  const [saved, setSaved] = useState(false);
  const jogTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const filename = gantry?.filename ?? "";
  const config = gantry?.config ?? null;
  const instruments = useMemo(() => Object.keys(config?.instruments ?? {}), [config]);
  const isMulti = instruments.length > 1;
  const connected = position?.connected ?? false;
  const current = currentWpos(position);
  const normalizedOutput = outputFile.trim() || defaultOutputFilename(filename);
  const selectedReference = referenceInstrument || instruments[0] || "";
  const selectedLowest = lowestInstrument || instruments[0] || "";
  const instrumentSequence = useMemo(
    () => unique([selectedReference, ...instruments]).filter((name) => name && name !== selectedLowest),
    [instruments, selectedLowest, selectedReference],
  );
  const nextInstrumentToRecord = instrumentSequence.find((name) => !instrumentPositions[name]) ?? null;
  const readyForSave = !!zReference && (!isMulti || allInstrumentPositionsReady(instruments, instrumentPositions, selectedReference, selectedLowest));

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setBusy(false);
    setOperation(null);
    setError(null);
    setStatusNote(null);
    setXyOrigin(null);
    setZReference(null);
    setXyBounds(null);
    setCenterPosition(null);
    setMeasuredVolume(null);
    setInstrumentPositions({});
    setOutputFile(defaultOutputFilename(filename));
    setReferenceInstrument(instruments[0] ?? "");
    setLowestInstrument(instruments[0] ?? "");
    setSaved(false);
  }, [filename, instruments, open]);

  const resetFlow = () => {
    setStep(0);
    setOperation(null);
    setError(null);
    setStatusNote(null);
    setXyOrigin(null);
    setZReference(null);
    setXyBounds(null);
    setCenterPosition(null);
    setMeasuredVolume(null);
    setInstrumentPositions({});
    setOutputFile(defaultOutputFilename(filename));
    setReferenceInstrument(instruments[0] ?? "");
    setLowestInstrument(instruments[0] ?? "");
    setSaved(false);
  };

  const close = () => {
    if (busy) return;
    stopJog();
    gantryApi.restoreCalibrationSoftLimits().catch(console.error);
    onClose();
  };

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setOperation(label);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperation(null);
      setBusy(false);
    }
  };

  // Step 0 → 1: just navigate, no hardware action yet.
  const goToHome = () => {
    if (!filename || instruments.length === 0) return;
    setStatusNote(null);
    setSaved(false);
    setStep(1);
  };

  // Step 1: connect (if needed) then home. This is the first hardware action.
  const homeForCalibration = () => runAction("Connecting, homing, and disabling stale soft limits", async () => {
    if (!filename) throw new Error("Select a gantry config first.");
    if (!connected) {
      await gantryApi.connect(filename);
    }
    const result = await gantryApi.prepareCalibrationOrigin();
    setStatusNote(formatCaptured("Homed and ready to set origin", requirePosition(result)));
    setStep(2);
  });

  const setXY = () => runAction(
    isMulti
      ? "Setting XY origin, re-homing, capturing XY bounds, and moving to deck center"
      : "Restoring soft limits and setting XY origin",
    async () => {
    if (!isMulti) {
      await gantryApi.restoreCalibrationSoftLimits();
    }
    const result = await gantryApi.setWorkCoordinates({ x: 0, y: 0 });
    const captured = requirePosition(result);
    setXyOrigin(captured);
    if (isMulti) {
      const centered = await gantryApi.homeAndCenterForCalibration();
      const bounds = capturedFromPlain(centered.xy_bounds);
      const center = capturedFromPlain(centered.position);
      setXyBounds(bounds);
      setCenterPosition(center);
      setStatusNote(
        `XY origin set. Homed bounds X=${bounds.x.toFixed(3)} Y=${bounds.y.toFixed(3)} Z=${bounds.z.toFixed(3)}; moved to center X=${center.x.toFixed(3)} Y=${center.y.toFixed(3)} Z=${center.z.toFixed(3)}.`,
      );
      setStep(3);
    } else {
      setStatusNote(formatCaptured("XY origin set — now jog to the block and set Z", captured));
    }
  });

  const setZ = () => runAction(
    isMulti && selectedLowest
      ? `Setting Z reference with ${selectedLowest} and retracting Z`
      : "Setting Z reference",
    async () => {
    const height = parsePositive(blockHeight, "Calibration block height");
    const result = await gantryApi.setWorkCoordinates({ z: height });
    const captured = requirePosition(result);
    setZReference(captured);
    if (isMulti && selectedLowest) {
      setInstrumentPositions((prev) => ({ ...prev, [selectedLowest]: captured }));
      await gantryApi.jogBlocking(0, 0, 15, 15);
      setStatusNote(formatCaptured(`Recorded ${selectedLowest} and retracted Z`, captured));
    } else {
      setStatusNote(formatCaptured("Z reference set", captured));
    }
    setStep(isMulti ? 4 : 3);
  });

  const recordCurrentInstrument = (name: string) => runAction(`Recording ${name} and retracting Z`, async () => {
    if (!name) return;
    const captured = requirePosition(await gantryApi.getPosition());
    const nextPositions = { ...instrumentPositions, [name]: captured };
    setInstrumentPositions(nextPositions);
    await gantryApi.jogBlocking(0, 0, 15, 15);
    setStatusNote(formatCaptured(`Recorded ${name} and retracted Z`, captured));
    if (allInstrumentPositionsReady(instruments, nextPositions, selectedReference, selectedLowest)) {
      setStep(5);
    }
  });

  const save = () => runAction("Re-homing, measuring working volume, programming limits, and saving YAML", async () => {
    if (!config) throw new Error("No gantry config is loaded.");
    if (!readyForSave) throw new Error("Complete the calibration positions before saving.");
    const result = await gantryApi.home();
    const captured = requirePosition(result);
    setMeasuredVolume(captured);
    const zMin = isMulti ? 0 : parsePositive(blockHeight, "Calibration block height");
    const maxTravel = {
      x: roundMm(captured.x),
      y: roundMm(captured.y),
      z: roundMm(captured.z - zMin),
    };
    if (maxTravel.x <= 0 || maxTravel.y <= 0 || maxTravel.z <= 0) {
      throw new Error("Measured travel spans must be positive.");
    }
    if (programSoftLimits) {
      await gantryApi.configureSoftLimits({
        max_travel_x: maxTravel.x,
        max_travel_y: maxTravel.y,
        max_travel_z: maxTravel.z,
      });
    }
    await onSaveCalibrated(normalizedOutput, buildCalibratedConfig({
      config,
      measuredVolume: captured,
      zMin,
      maxTravel,
      isMulti,
      instruments,
      instrumentPositions,
      referenceInstrument: selectedReference,
      lowestInstrument: selectedLowest,
    }));
    if (!programSoftLimits) {
      await gantryApi.restoreCalibrationSoftLimits();
    }
    setSaved(true);
    setStatusNote(`Saved ${normalizedOutput}.`);
  });

  const stopJog = () => {
    if (jogTimer.current) {
      clearInterval(jogTimer.current);
      jogTimer.current = null;
    }
  };

  const jog = useCallback((x: number, y: number, z: number) => {
    if (!connected || busy) return;
    gantryApi.jog(x, y, z).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [busy, connected]);

  const startJog = (x: number, y: number, z: number) => {
    if (busy) return;
    stopJog();
    jog(x, y, z);
    jogTimer.current = setInterval(() => jog(x, y, z), JOG_INTERVAL_MS);
  };

  const xy = Math.max(MIN_STEP, parseFloat(xyStep) || 0.5);
  const z = Math.max(MIN_STEP, parseFloat(zStep) || 0.5);

  if (!open) return null;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Gantry calibration">
      <div style={modalStyle}>
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>Calibrate gantry</h2>
            <div style={{ marginTop: 3, fontSize: 12, color: "#666" }}>
              {filename || "No file selected"} · {isMulti ? "multi-instrument board" : "single-instrument deck origin"}
            </div>
          </div>
          <button
            onClick={close}
            disabled={busy}
            style={buttonStateStyle(closeButtonStyle, busy)}
            aria-label="Close calibration"
          >
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          <aside style={stepsStyle}>
            {stepLabels(isMulti).map((label, index) => (
              <div
                key={label}
                style={index === step ? activeStepStyle : index < step ? completedStepStyle : stepButtonStyle}
                aria-current={index === step ? "step" : undefined}
              >
                <span style={stepNumberStyle}>{index + 1}</span>
                {label}
              </div>
            ))}
          </aside>

          <section style={contentStyle}>
            {error && <div style={errorStyle}>{error}</div>}
            {operation && <div style={busyStyle}>{operation}. Controls are locked while the gantry finishes.</div>}
            {statusNote && <div style={noteStyle}>{statusNote}</div>}

            {step === 0 && (
              <div>
                <h3 style={sectionTitleStyle}>Prepare</h3>
                <div style={summaryGridStyle}>
                  <Readout label="Connection" value={connected ? "Connected" : "Not connected"} tone={connected ? "good" : "muted"} />
                  <Readout label="Status" value={position?.status ?? "Unknown"} />
                  <Readout label="Instruments" value={String(instruments.length)} />
                  <Readout label="Current WPos" value={current ? `${current.x.toFixed(3)}, ${current.y.toFixed(3)}, ${current.z.toFixed(3)}` : "Unavailable"} />
                </div>
                <div style={fieldRowStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Output YAML</span>
                    <input
                      value={normalizedOutput}
                      onChange={(event) => setOutputFile(event.target.value)}
                      disabled={busy}
                      style={buttonStateStyle(inputStyle, busy)}
                    />
                  </label>
                  {isMulti && (
                    <>
                      <label style={fieldStyle}>
                        <span style={labelStyle}>Reference instrument</span>
                        <select
                          value={selectedReference}
                          onChange={(event) => setReferenceInstrument(event.target.value)}
                          disabled={busy}
                          style={buttonStateStyle(inputStyle, busy)}
                        >
                          {instruments.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </label>
                      <label style={fieldStyle}>
                        <span style={labelStyle}>Lowest instrument</span>
                        <select
                          value={selectedLowest}
                          onChange={(event) => setLowestInstrument(event.target.value)}
                          disabled={busy}
                          style={buttonStateStyle(inputStyle, busy)}
                        >
                          {instruments.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                <div style={actionRowStyle}>
                  <button onClick={goToHome} disabled={busy || !filename || instruments.length === 0} style={buttonStateStyle(primaryButtonStyle, busy || !filename || instruments.length === 0)}>Continue</button>
                  <button onClick={resetFlow} disabled={busy} style={buttonStateStyle(buttonStyle, busy)}>Reset wizard</button>
                </div>
              </div>
            )}

            {step === 1 && (
              <div>
                <h3 style={sectionTitleStyle}>Home gantry</h3>
                <p style={instructionStyle}>
                  Homing drives each axis to its hardware end-stops to establish a known machine position. The gantry will move to its limits — clear the deck and make sure nothing is in the travel path before proceeding.
                </p>
                <div style={actionRowStyle}>
                  <button onClick={homeForCalibration} disabled={busy} style={buttonStateStyle(primaryButtonStyle, busy)}>Home gantry</button>
                </div>
              </div>
            )}

            {!isMulti && step === 2 && (
              <div>
                <h3 style={sectionTitleStyle}>Set XYZ Origin</h3>
                <p style={instructionStyle}>
                  Place the calibration block at the front-left origin. Jog the tool over the mark and set X=0 Y=0, then lower the tool to the block surface, enter the block height, and set Z.
                </p>
                <JogPanel
                  xyStep={xyStep}
                  zStep={zStep}
                  setXyStep={setXyStep}
                  setZStep={setZStep}
                  disabled={!connected || busy}
                  onStartJog={startJog}
                  onStopJog={stopJog}
                  xy={xy}
                  z={z}
                />
                <div style={actionRowStyle}>
                  <button onClick={setXY} disabled={busy || !connected || !!xyOrigin} style={buttonStateStyle(primaryButtonStyle, busy || !connected || !!xyOrigin)}>Set XY origin</button>
                  {xyOrigin && <Readout label="XY origin" value={`${xyOrigin.x.toFixed(3)}, ${xyOrigin.y.toFixed(3)}, ${xyOrigin.z.toFixed(3)}`} />}
                </div>
                {xyOrigin && (
                  <>
                    <div style={{ ...fieldRowStyle, marginTop: 14 }}>
                      <label style={fieldStyle}>
                        <span style={labelStyle}>Calibration block height mm</span>
                        <input
                          value={blockHeight}
                          onChange={(event) => setBlockHeight(event.target.value)}
                          disabled={busy}
                          style={buttonStateStyle(inputStyle, busy)}
                          inputMode="decimal"
                        />
                      </label>
                    </div>
                    <div style={actionRowStyle}>
                      <button onClick={setZ} disabled={busy || !connected} style={buttonStateStyle(primaryButtonStyle, busy || !connected)}>Set Z reference and continue</button>
                      {zReference && <Readout label="Z reference" value={`${zReference.x.toFixed(3)}, ${zReference.y.toFixed(3)}, ${zReference.z.toFixed(3)}`} />}
                    </div>
                  </>
                )}
              </div>
            )}

            {isMulti && step === 2 && (
              <div>
                <h3 style={sectionTitleStyle}>Set XY Origin</h3>
                <p style={instructionStyle}>
                  Place the calibration block at the front-left origin. Use the jog controls until the active tool point is over the mark, then set X=0 and Y=0.
                </p>
                <JogPanel
                  xyStep={xyStep}
                  zStep={zStep}
                  setXyStep={setXyStep}
                  setZStep={setZStep}
                  disabled={!connected || busy}
                  onStartJog={startJog}
                  onStopJog={stopJog}
                  xy={xy}
                  z={z}
                />
                <div style={actionRowStyle}>
                  <button onClick={setXY} disabled={busy || !connected} style={buttonStateStyle(primaryButtonStyle, busy || !connected)}>Set XY origin and continue</button>
                  {xyOrigin && <Readout label="XY origin" value={`${xyOrigin.x.toFixed(3)}, ${xyOrigin.y.toFixed(3)}, ${xyOrigin.z.toFixed(3)}`} />}
                </div>
              </div>
            )}

            {isMulti && step === 3 && (
              <div>
                <h3 style={sectionTitleStyle}>Set Z Reference</h3>
                <p style={instructionStyle}>
                  The gantry has been re-homed and moved to deck center. Jog {selectedLowest || "the lowest instrument"} to the shared block point, then set Z to the block height there.
                </p>
                <div style={fieldRowStyle}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Calibration block height mm</span>
                    <input
                      value={blockHeight}
                      onChange={(event) => setBlockHeight(event.target.value)}
                      disabled={busy}
                      style={buttonStateStyle(inputStyle, busy)}
                      inputMode="decimal"
                    />
                  </label>
                </div>
                <div style={summaryGridStyle}>
                  {xyBounds && <Readout label="XY bounds" value={`${xyBounds.x.toFixed(3)}, ${xyBounds.y.toFixed(3)}, ${xyBounds.z.toFixed(3)}`} />}
                  {centerPosition && <Readout label="Deck center" value={`${centerPosition.x.toFixed(3)}, ${centerPosition.y.toFixed(3)}, ${centerPosition.z.toFixed(3)}`} />}
                  <Readout label="Lowest instrument" value={selectedLowest || "Unset"} />
                </div>
                <JogPanel
                  xyStep={xyStep}
                  zStep={zStep}
                  setXyStep={setXyStep}
                  setZStep={setZStep}
                  disabled={!connected || busy}
                  onStartJog={startJog}
                  onStopJog={stopJog}
                  xy={xy}
                  z={z}
                />
                <div style={actionRowStyle}>
                  <button onClick={setZ} disabled={busy || !connected || !xyOrigin} style={buttonStateStyle(primaryButtonStyle, busy || !connected || !xyOrigin)}>
                    {`Set Z reference with ${selectedLowest} and retract`}
                  </button>
                  {zReference && <Readout label="Z reference" value={`${zReference.x.toFixed(3)}, ${zReference.y.toFixed(3)}, ${zReference.z.toFixed(3)}`} />}
                </div>
              </div>
            )}

            {isMulti && step === 4 && (
              <div>
                <h3 style={sectionTitleStyle}>Record Instruments</h3>
                <p style={instructionStyle}>
                  Keep the block fixed. For each tool, jog its active point to the same physical block point and record the pose.
                </p>
                <div style={instrumentListStyle}>
                  {instruments.map((name) => (
                    <div key={name} style={instrumentRowStyle}>
                      <strong>{name}</strong>
                      <span style={{ color: "#666" }}>
                        {instrumentPositions[name]
                          ? `${instrumentPositions[name].x.toFixed(3)}, ${instrumentPositions[name].y.toFixed(3)}, ${instrumentPositions[name].z.toFixed(3)}`
                          : name === nextInstrumentToRecord ? "ready" : "pending"}
                      </span>
                    </div>
                  ))}
                </div>
                {nextInstrumentToRecord ? (
                  <div style={activeInstrumentStyle}>
                    <div style={{ marginBottom: 10 }}>
                      <span style={labelStyle}>Active instrument</span>
                      <h4 style={{ margin: "2px 0 0", fontSize: 15 }}>{nextInstrumentToRecord}</h4>
                    </div>
                    <JogPanel
                      xyStep={xyStep}
                      zStep={zStep}
                      setXyStep={setXyStep}
                      setZStep={setZStep}
                      disabled={!connected || busy}
                      onStartJog={startJog}
                      onStopJog={stopJog}
                      xy={xy}
                      z={z}
                    />
                    <div style={actionRowStyle}>
                      <button
                        onClick={() => recordCurrentInstrument(nextInstrumentToRecord)}
                        disabled={busy || !connected}
                        style={buttonStateStyle(primaryButtonStyle, busy || !connected)}
                      >
                        Record {nextInstrumentToRecord} and retract
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={noteStyle}>All instruments recorded.</div>
                )}
              </div>
            )}

            {((!isMulti && step === 3) || (isMulti && step === 5)) && (
              <div>
                <h3 style={sectionTitleStyle}>Measure And Save</h3>
                <p style={instructionStyle}>
                  The next action re-homes, captures the calibrated WPos maxima, optionally programs GRBL soft-limit spans, and writes the calibrated YAML.
                </p>
                {measuredVolume && (
                  <div style={summaryGridStyle}>
                    <Readout
                      label="Measured maxima"
                      value={`${measuredVolume.x.toFixed(3)}, ${measuredVolume.y.toFixed(3)}, ${measuredVolume.z.toFixed(3)}`}
                    />
                    <Readout label="X travel" value={roundMm(measuredVolume.x).toFixed(3)} />
                    <Readout label="Y travel" value={roundMm(measuredVolume.y).toFixed(3)} />
                    <Readout label="Z travel" value={roundMm(measuredVolume.z - (isMulti ? 0 : parseFloat(blockHeight) || 0)).toFixed(3)} />
                    <Readout label="Output" value={normalizedOutput} />
                  </div>
                )}
                <label style={checkboxStyle}>
                  <input type="checkbox" checked={programSoftLimits} disabled={busy || saved} onChange={(event) => setProgramSoftLimits(event.target.checked)} />
                  Program GRBL soft-limit travel spans before saving
                </label>
                <div style={actionRowStyle}>
                  <button onClick={save} disabled={busy || !readyForSave || saved} style={buttonStateStyle(primaryButtonStyle, busy || !readyForSave || saved)}>
                    {saved ? "Saved" : "Save"}
                  </button>
                  <button onClick={close} disabled={busy} style={buttonStateStyle(buttonStyle, busy)}>Done</button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function JogPanel({
  xyStep,
  zStep,
  setXyStep,
  setZStep,
  disabled,
  onStartJog,
  onStopJog,
  xy,
  z,
}: {
  xyStep: string;
  zStep: string;
  setXyStep: (value: string) => void;
  setZStep: (value: string) => void;
  disabled: boolean;
  onStartJog: (x: number, y: number, z: number) => void;
  onStopJog: () => void;
  xy: number;
  z: number;
}) {
  const props = (x: number, y: number, dz: number) => ({
    onMouseDown: () => !disabled && onStartJog(x, y, dz),
    onMouseUp: onStopJog,
    onMouseLeave: onStopJog,
    onTouchStart: (event: TouchEvent) => {
      event.preventDefault();
      if (!disabled) onStartJog(x, y, dz);
    },
    onTouchEnd: onStopJog,
  });

  return (
    <div style={jogPanelStyle}>
      <div style={dpadStyle}>
        <div />
        <button style={buttonStateStyle(jogButtonStyle, disabled)} disabled={disabled} {...props(0, xy, 0)} title="Y+">↑</button>
        <div />
        <button style={buttonStateStyle(jogButtonStyle, disabled)} disabled={disabled} {...props(-xy, 0, 0)} title="X-">←</button>
        <div style={padCenterStyle}>XY</div>
        <button style={buttonStateStyle(jogButtonStyle, disabled)} disabled={disabled} {...props(xy, 0, 0)} title="X+">→</button>
        <div />
        <button style={buttonStateStyle(jogButtonStyle, disabled)} disabled={disabled} {...props(0, -xy, 0)} title="Y-">↓</button>
        <div />
      </div>
      <div style={zPadStyle}>
        <button style={buttonStateStyle(jogButtonStyle, disabled)} disabled={disabled} {...props(0, 0, z)} title="Z+">Z+</button>
        <div style={padCenterStyle}>Z</div>
        <button style={buttonStateStyle(jogButtonStyle, disabled)} disabled={disabled} {...props(0, 0, -z)} title="Z-">Z-</button>
      </div>
      <div style={stepFieldsStyle}>
        <label style={stepFieldStyle}>
          <span style={labelStyle}>XY mm</span>
          <input
            value={xyStep}
            onChange={(event) => setXyStep(event.target.value)}
            disabled={disabled}
            inputMode="decimal"
            style={buttonStateStyle(smallInputStyle, disabled)}
          />
        </label>
        <label style={stepFieldStyle}>
          <span style={labelStyle}>Z mm</span>
          <input
            value={zStep}
            onChange={(event) => setZStep(event.target.value)}
            disabled={disabled}
            inputMode="decimal"
            style={buttonStateStyle(smallInputStyle, disabled)}
          />
        </label>
      </div>
    </div>
  );
}

function Readout({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "good" | "muted" }) {
  return (
    <div style={readoutStyle}>
      <span style={readoutLabelStyle}>{label}</span>
      <span style={{ ...readoutValueStyle, color: tone === "good" ? "#15803d" : tone === "muted" ? "#777" : "#111" }}>{value}</span>
    </div>
  );
}

function defaultOutputFilename(filename: string): string {
  return filename || "gantry.yaml";
}

function currentWpos(position: GantryPosition | null): CapturedPosition | null {
  if (!position?.connected) return null;
  return {
    x: Number(position.work_x ?? position.x),
    y: Number(position.work_y ?? position.y),
    z: Number(position.work_z ?? position.z),
  };
}

function requirePosition(position: GantryPosition): CapturedPosition {
  const captured = currentWpos(position);
  if (!captured) throw new Error("Connected position did not include readable coordinates.");
  return captured;
}

function capturedFromPlain(position: { x: number; y: number; z: number }): CapturedPosition {
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function parsePositive(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function roundMm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatCaptured(label: string, position: CapturedPosition): string {
  return `${label}: X=${position.x.toFixed(3)} Y=${position.y.toFixed(3)} Z=${position.z.toFixed(3)}`;
}

function buttonStateStyle(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  if (!disabled) return base;
  return {
    ...base,
    opacity: 0.45,
    cursor: "not-allowed",
  };
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function allInstrumentPositionsReady(
  instruments: string[],
  positions: Record<string, CapturedPosition>,
  referenceInstrument: string,
  lowestInstrument: string,
): boolean {
  const required = unique([referenceInstrument, lowestInstrument, ...instruments]);
  return required.length > 0 && required.every((name) => !!positions[name]);
}

function buildCalibratedConfig({
  config,
  measuredVolume,
  zMin,
  maxTravel,
  isMulti,
  instruments,
  instrumentPositions,
  referenceInstrument,
  lowestInstrument,
}: {
  config: GantryConfig;
  measuredVolume: CapturedPosition;
  zMin: number;
  maxTravel: CapturedPosition;
  isMulti: boolean;
  instruments: string[];
  instrumentPositions: Record<string, CapturedPosition>;
  referenceInstrument: string;
  lowestInstrument: string;
}): GantryConfig {
  const next = structuredClone(config);
  next.working_volume = {
    x_min: 0,
    x_max: roundMm(measuredVolume.x),
    y_min: 0,
    y_max: roundMm(measuredVolume.y),
    z_min: roundMm(zMin),
    z_max: roundMm(measuredVolume.z),
  };
  next.cnc = {
    ...next.cnc,
    total_z_range: roundMm(measuredVolume.z),
  };
  if (next.cnc.safe_z != null) {
    next.cnc.safe_z = Math.min(Math.max(roundMm(next.cnc.safe_z), roundMm(zMin)), roundMm(measuredVolume.z));
  }
  next.grbl_settings = {
    ...(next.grbl_settings ?? {}),
    status_report: 0,
    soft_limits: true,
    homing_enable: true,
    max_travel_x: maxTravel.x,
    max_travel_y: maxTravel.y,
    max_travel_z: maxTravel.z,
  };

  if (isMulti) {
    const reference = instrumentPositions[referenceInstrument];
    const lowest = instrumentPositions[lowestInstrument];
    if (!reference || !lowest) {
      throw new Error("Reference and lowest instrument positions are required.");
    }
    for (const name of instruments) {
      const coords = instrumentPositions[name];
      if (!coords || !next.instruments[name]) continue;
      next.instruments[name] = {
        ...next.instruments[name],
        offset_x: roundMm(reference.x - coords.x),
        offset_y: roundMm(reference.y - coords.y),
        depth: roundMm(coords.z - lowest.z),
      };
    }
  }

  return next;
}

function stepLabels(isMulti: boolean): string[] {
  return isMulti
    ? ["Prepare", "Home", "XY origin", "Z reference", "Instruments", "Save"]
    : ["Prepare", "Home", "Set origin", "Save"];
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.36)",
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const modalStyle: React.CSSProperties = {
  width: "min(920px, 96vw)",
  maxHeight: "92vh",
  background: "#fff",
  border: "1px solid #d4d4d8",
  borderRadius: 8,
  boxShadow: "0 18px 60px rgba(15, 23, 42, 0.22)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  padding: "16px 18px",
  borderBottom: "1px solid #e5e7eb",
};

const bodyStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px, 170px) minmax(0, 1fr)",
  minHeight: 0,
  overflow: "hidden",
};

const stepsStyle: React.CSSProperties = {
  padding: 12,
  borderRight: "1px solid #e5e7eb",
  background: "#f8fafc",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const contentStyle: React.CSSProperties = {
  padding: 18,
  overflow: "auto",
};

const stepButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: "#334155",
  borderRadius: 6,
  padding: "8px 9px",
  fontSize: 12,
  textAlign: "left",
  cursor: "default",
};

const activeStepStyle: React.CSSProperties = {
  ...stepButtonStyle,
  background: "#fff",
  border: "1px solid #cbd5e1",
  color: "#0f172a",
  fontWeight: 700,
};

const completedStepStyle: React.CSSProperties = {
  ...stepButtonStyle,
  color: "#0f766e",
  background: "#ecfdf5",
  border: "1px solid #bbf7d0",
};

const stepNumberStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "#e2e8f0",
  color: "#0f172a",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  flexShrink: 0,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 16,
};

const instructionStyle: React.CSSProperties = {
  margin: "0 0 12px",
  color: "#444",
  fontSize: 13,
  lineHeight: 1.45,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
  marginBottom: 12,
};

const readoutStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: "7px 9px",
  minWidth: 0,
};

const readoutLabelStyle: React.CSSProperties = {
  display: "block",
  color: "#64748b",
  fontSize: 11,
  marginBottom: 2,
};

const readoutValueStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 700,
  overflowWrap: "anywhere",
};

const fieldRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 10,
  marginBottom: 12,
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};

const labelStyle: React.CSSProperties = {
  color: "#666",
  fontSize: 11,
};

const inputStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #cbd5e1",
  color: "#111",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
  minWidth: 0,
};

const smallInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: 58,
  padding: "4px 6px",
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 12,
};

const buttonStyle: React.CSSProperties = {
  background: "#f8fafc",
  color: "#111",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  padding: "6px 11px",
  fontSize: 12,
  cursor: "pointer",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#0f766e",
  border: "1px solid #0f766e",
  color: "#fff",
  fontWeight: 700,
};

const closeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #d4d4d8",
  borderRadius: 4,
  color: "#444",
  cursor: "pointer",
  fontSize: 18,
  lineHeight: 1,
  width: 28,
  height: 28,
};

const errorStyle: React.CSSProperties = {
  border: "1px solid #fca5a5",
  background: "#fef2f2",
  color: "#991b1b",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
  marginBottom: 10,
};

const noteStyle: React.CSSProperties = {
  border: "1px solid #bfdbfe",
  background: "#eff6ff",
  color: "#1e3a8a",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
  marginBottom: 10,
};

const busyStyle: React.CSSProperties = {
  border: "1px solid #fed7aa",
  background: "#fff7ed",
  color: "#9a3412",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
  marginBottom: 10,
};

const jogPanelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 18,
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: 12,
  width: "fit-content",
  maxWidth: "100%",
  flexWrap: "wrap",
};

const dpadStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 40px)",
  gridTemplateRows: "repeat(3, 40px)",
  gap: 2,
};

const zPadStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const jogButtonStyle: React.CSSProperties = {
  width: 40,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f8fafc",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  color: "#111",
  fontWeight: 700,
  cursor: "pointer",
};

const padCenterStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#94a3b8",
  fontSize: 10,
};

const stepFieldsStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const stepFieldStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const instrumentListStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 8,
  marginBottom: 12,
};

const instrumentRowStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: "7px 9px",
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
};

const activeInstrumentStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  padding: 12,
  background: "#f8fafc",
};

const checkboxStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "#333",
  marginTop: 12,
};
