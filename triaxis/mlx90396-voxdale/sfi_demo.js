/**
 * sfi_demo.js
 * Standalone SFI Joystick, 3D Dome Kinematics, Centered Z-UP XYZ Chart, Polar Radar & Battle Matrix
 */

// --- GLTFLoader (r128 non-module build, matches the global THREE loaded in index.html) ---
let gltfLoaderPromise = null;

// The three.js itself comes from cdnjs, so that CDN is tried first: a single
// hard-coded jsdelivr source silently leaves the 3D tab as an empty canvas
// whenever that one host is blocked or stalling. Each source gets a timeout,
// then the chain moves on.
const GLTF_LOADER_SOURCES = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/examples/js/loaders/GLTFLoader.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
  'https://unpkg.com/three@0.128.0/examples/js/loaders/GLTFLoader.js'
];

function loadGltfLoaderScript() {
  const attempt = (src, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (script.parentNode) script.parentNode.removeChild(script);
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error('GLTFLoader script timeout: ' + src)), timeoutMs);
      script.src = src;
      script.onload = () => finish(resolve, THREE.GLTFLoader);
      script.onerror = () => finish(reject, new Error('GLTFLoader script error: ' + src));
      document.head.appendChild(script);
    });

  return (async () => {
    for (const src of GLTF_LOADER_SOURCES) {
      try {
        const loader = await attempt(src);
        if (loader) return loader;
      } catch (err) {
        console.warn('[GLTFLOADER]', err.message);
      }
    }
    throw new Error('GLTFLoader unavailable from all CDNs');
  })();
}

function ensureGLTFLoader() {
  if (!gltfLoaderPromise) {
    gltfLoaderPromise = window.THREE && THREE.GLTFLoader
      ? Promise.resolve(THREE.GLTFLoader)
      : loadGltfLoaderScript();
  }
  return gltfLoaderPromise;
}

// --- Calibration & Signal Math Engine ---
// The Desmos math lives in the shared ../angle_calib.js module (one source of
// truth, also used by the Thumbstick page). The exports below keep the exact
// sfi_demo.js API, so the rest of this file and app.js stay untouched.
import {
  DEFAULT_CALIBRATION_PARAMS as ENGINE_DEFAULTS,
  normalizeParams,
  calculateDesmosAngles as moduleDesmosAngles,
  calculate1pxAngles,
  calculateSfiDifferentialAngles,
  calculateDifferentialGimbalInput
} from '../angle_calib.js';

export const DEFAULT_CALIBRATION_PARAMS = { ...ENGINE_DEFAULTS };

let activeCalibrationParams = { ...DEFAULT_CALIBRATION_PARAMS };
let differentialFormula = 'normal';

export function setCalibrationParams(newParams) {
  activeCalibrationParams = normalizeParams({ ...activeCalibrationParams, ...newParams });
}

export function getCalibrationParams() {
  return { ...activeCalibrationParams };
}

export function resetCalibrationParams() {
  activeCalibrationParams = { ...DEFAULT_CALIBRATION_PARAMS };
  return activeCalibrationParams;
}

export function setDifferentialFormula(formula) {
  differentialFormula = formula === 'enhanced' ? 'enhanced' : 'normal';
}

export function calculateDesmosAngles(x, y, z, params = DEFAULT_CALIBRATION_PARAMS) {
  return moduleDesmosAngles(x, y, z, params);
}

export function computeSfi1Px(bx, by, bz, params = DEFAULT_CALIBRATION_PARAMS) {
  const r = calculate1pxAngles({ Bx: bx, By: by, Bz: bz }, params);
  return {
    mode: '1px',
    alphaStrength: r.alphaStrength,
    betaStrength: r.betaStrength,
    signalStrength: r.signalStrength,
    alphaSignal: { z: r.alphaSignal.z, x: r.alphaSignal.x },
    betaSignal: { z: r.betaSignal.z, y: r.betaSignal.y },
    alphaRad: r.alphaRad,
    betaRad: r.betaRad,
    alphaDeg: r.alphaDeg,
    betaDeg: r.betaDeg
  };
}

export function computeSfi2Px(dbx_dx, dbz_dx, dby_dy, dbz_dy, params = DEFAULT_CALIBRATION_PARAMS) {
  const angles = calculateSfiDifferentialAngles(
    { X02: dbx_dx, Z02: dbz_dx, Y13: dby_dy, Z13: dbz_dy },
    params,
    differentialFormula
  );

  const alphaStrength = Math.hypot(dbx_dx, dbz_dx);
  const betaStrength = Math.hypot(dby_dy, dbz_dy);
  const signalStrength = Math.hypot(dbx_dx, dbz_dx, dby_dy, dbz_dy);

  return {
    mode: '2px',
    alphaStrength,
    betaStrength,
    signalStrength,
    alphaSignal: { dbz_dx, dbx_dx },
    betaSignal: { dbz_dy, dby_dy },
    alphaRad: angles.alphaRad,
    betaRad: angles.betaRad,
    alphaDeg: angles.alphaDeg,
    betaDeg: angles.betaDeg,
    valid: angles.valid
  };
}

// --- Simulation & Telemetry State ---
let autoPattern = true;
let coilActive = false; // owned by setCoilState(); drives the simulated stray field below
let animTime = 0;
let joyX = 0, joyY = 0, joyZ = 0;
let targetJoyX = 0, targetJoyY = 0, targetJoyZ = 0;

let displayStdBx = 0, displayStdBy = 0, displayStdBz = 0;
let displayMlxDBx = 0, displayMlxDBy = 0, displayMlxDBz = 0, displayMlxDBzY = 0;
let targetStdBx = 0, targetStdBy = 0, targetStdBz = 0;
let targetMlxDBx = 0, targetMlxDBy = 0, targetMlxDBz = 0, targetMlxDBzY = 0;
let isLiveHardwareConnected = false;

let stdTraceHistory = [];
let mlxTraceHistory = [];

let mainSceneObj = null;
let stdPlot = null;
let mlxPlot = null;
let joyAssemblyRef = null;
let joyRestPosition = new THREE.Vector3();
let joyPivotPoint = new THREE.Vector3();
let joyTipMarker = null;
let joyTrailMesh = null;
let joyTrailHistory = [];
const tmpVec = new THREE.Vector3();

let radarCanvasStd = null, radarCtxStd = null;
let radarCanvasMlx = null, radarCtxMlx = null;

let liveHardwarePacket = null;
let liveSfiAngles = { alpha: 90, beta: 90 };
let gimbalZeroAngles = { alpha: 90, beta: 90 };
const SINGLE_PIXEL_LSB_PER_MT = 20;
const DIFFERENTIAL_LSB_PER_MT_MM = 120;
const TRACE_HISTORY_POINTS = 45;

// Unwrap each axis against the previous frame so the angle remains continuous
// across the ±180° seam, then clamp to the 0..180° range used by the radar.
const unwrapPrevDeg = { alpha: null, beta: null };

function unwrapAngleDeg(deg, key) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return 90;

  const prev = unwrapPrevDeg[key];
  if (prev === null) {
    unwrapPrevDeg[key] = deg;
    return Math.min(180, Math.max(0, deg));
  }

  let d = deg - prev;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;

  let out = prev + d;
  if (out - deg > 360) out = deg + 360;
  else if (deg - out > 360) out = deg - 360;

  unwrapPrevDeg[key] = out;
  return Math.min(180, Math.max(0, out));
}

function resetAngleUnwrap() {
  unwrapPrevDeg.alpha = null;
  unwrapPrevDeg.beta = null;
}

// PDF review: the previous Y orientation was opposite to the actual joystick
// movement, so it is reversed once at the single source ("fJoyY") and every
// consumer (dome tilt, readouts, radars, traces) inherits the flipped sign.
const ORIENT_Y_FLIP = -1;

// PDF review: a button press is defined by the differential gradient magnitude
// crossing ~20 mT/mm. Below that it reads "no press"; the two field-strength
// hats on the radars flag weak / missing magnets (values are adjustable).
const SFI_PRESS_THRESHOLD_MT_MM = 20;
const WEAK_MAG_STD_MT = 8;
const NO_MAG_STD_MT = 2;
const WEAK_MAG_DIFF_MT_MM = 3;
const NO_MAG_DIFF_MT_MM = 1;

// --- Stray field coil controls ---
// The button is a timed pulse, never a latch: the coil energises, the badge counts
// the dwell down, and the pin is driven low again when it hits zero. Clicking while
// a pulse is running aborts it early instead of queueing a second one.
// This module only renders and counts; app.js owns the pin and the authoritative
// shut-off timer.
const COIL_DWELL_DEFAULT_S = 5;
const COIL_DWELL_MIN_S = 0.5;
const COIL_DWELL_MAX_S = 60;

let onHardwareCoilCommand = null;
let coilView = { active: false, hardware: false, fault: false, endsAt: 0 };
let coilCountdownTimer = null;
let coilStartPending = false;

export function setHardwareCoilCallback(cb) {
  onHardwareCoilCommand = cb;
}

function clampCoilDwellS(value) {
  const parsed = parseFloat(value);
  if (!isFinite(parsed)) return COIL_DWELL_DEFAULT_S;
  return Math.min(COIL_DWELL_MAX_S, Math.max(COIL_DWELL_MIN_S, parsed));
}

export { clampCoilDwellS };

function coilRemainingS() {
  return Math.max(0, (coilView.endsAt - Date.now()) / 1000);
}

function renderCoilState() {
  const btnCoil = document.getElementById('btn-coil');
  const btnCoilToggle = document.getElementById('btn-coil-toggle');
  const dwellInput = document.getElementById('coil-dwell-seconds');
  const panelLbl = document.getElementById('coil-readout-lbl');

  // The dwell is latched when the pulse starts, so it cannot be edited mid-pulse.
  if (dwellInput) dwellInput.disabled = coilView.active;

  const fault = coilView.fault;
  const remaining = coilRemainingS().toFixed(1);

  // Kept in sync for the Requirement 4 panel, which is hidden by default but
  // stays correct if it is ever brought back.
  if (panelLbl) {
    if (fault) {
      panelLbl.textContent = 'COIL: FAULT — NOT DRIVEN';
      panelLbl.style.color = '#ef4444';
    } else if (coilView.active) {
      panelLbl.textContent = `COIL: ACTIVE (+5.0 mT STRAY FIELD, ${remaining}s)`;
      panelLbl.style.color = '#ef4444';
    } else {
      panelLbl.textContent = 'COIL: OFF (0.0 mT)';
      panelLbl.style.color = '#94a3b8';
    }
  }

  // The button is the only visible surface for the coil now, so the fault has to
  // read on it rather than on a readout that is no longer there.
  if (btnCoil) {
    btnCoil.classList.toggle('ds-button--on', coilView.active && !fault);
    btnCoil.classList.toggle('ds-button--fault', fault);
    if (fault) {
      btnCoil.textContent = 'Coil Fault — A0 not driven';
      btnCoil.title = 'The last pulse could not energise the coil. A0 is held low — press to try again.';
    } else {
      btnCoil.textContent = coilView.active ? `Coil ON — ${remaining}s` : 'Stray Field Coil (5 mT)';
      if (coilView.active) {
        // The real/simulated distinction now lives only here, so it has to be
        // stated explicitly rather than colour-coded.
        btnCoil.title = coilView.hardware
          ? 'Melexis IO A0 is driving the MOSFET gate. Click to drop the coil now instead of waiting out the pulse'
          : 'No Melexis IO link — this pulse is simulated and drives no pin. Click to stop it.';
      } else {
        btnCoil.title = 'Pulse the 5 mT stray field coil on Melexis IO pin A0';
      }
    }
  }

  if (btnCoilToggle) {
    btnCoilToggle.classList.toggle('ds-button--on', coilView.active && !fault);
    btnCoilToggle.classList.toggle('ds-button--fault', fault);
    btnCoilToggle.textContent = fault
      ? 'Retry Coil Pulse'
      : (coilView.active ? 'Abort Coil Pulse' : 'Pulse Coil (5 mT)');
  }
}

export function setCoilState(next) {
  coilView = {
    active: Boolean(next && next.active),
    hardware: Boolean(next && next.hardware),
    fault: Boolean(next && next.fault),
    endsAt: (next && next.endsAt) || 0
  };

  if (coilCountdownTimer !== null) {
    clearInterval(coilCountdownTimer);
    coilCountdownTimer = null;
  }

  renderCoilState();

  if (coilView.active) {
    coilCountdownTimer = setInterval(renderCoilState, 100);
  }
}

export function initCoilControls() {
  const btnCoil = document.getElementById('btn-coil');
  const btnCoilToggle = document.getElementById('btn-coil-toggle');
  const dwellInput = document.getElementById('coil-dwell-seconds');

  const onCoilClick = async () => {
    if (coilView.active) {
      if (typeof onHardwareCoilCommand === 'function') {
        try {
          await onHardwareCoilCommand({ action: 'off' });
        } catch (err) {
          console.warn('[COIL] abort failed', err);
        }
      }
      return;
    }

    if (coilStartPending) return;
    coilStartPending = true;

    const dwellS = clampCoilDwellS(dwellInput ? dwellInput.value : COIL_DWELL_DEFAULT_S);
    if (dwellInput) dwellInput.value = String(dwellS);

    try {
      if (typeof onHardwareCoilCommand === 'function') {
        await onHardwareCoilCommand({ action: 'pulse', dwellS });
      } else {
        // No bridge attached: run the dwell locally so the UI stays testable.
        setCoilState({ active: true, hardware: false, endsAt: Date.now() + dwellS * 1000 });
        setTimeout(() => setCoilState({ active: false, hardware: false }), dwellS * 1000);
      }
    } catch (err) {
      console.warn('[COIL] pulse request failed', err);
    } finally {
      coilStartPending = false;
    }
  };

  btnCoil?.addEventListener('click', onCoilClick);
  btnCoilToggle?.addEventListener('click', onCoilClick);

  setCoilState({ active: false, hardware: false });
}

export function setSfiHardwareTracking(enabled) {
  isLiveHardwareConnected = Boolean(enabled);
  if (!isLiveHardwareConnected) {
    liveHardwarePacket = null;
    liveSfiAngles = { alpha: 90, beta: 90 };
    gimbalZeroAngles = { alpha: 90, beta: 90 };
    targetJoyX = 0;
    targetJoyY = 0;
    targetJoyZ = 0;
    const zeroStatus = document.getElementById('gimbal-zero-status');
    if (zeroStatus) zeroStatus.textContent = 'Zero: α 90.0°, β 90.0°';
  }
}

export function updateSfiDomeKinematics(x, y, z, telemetryPayload = null) {
  targetJoyX = Math.max(-1, Math.min(1, x));
  targetJoyY = Math.max(-1, Math.min(1, y));
  targetJoyZ = Math.max(-1, Math.min(1, z));

  if (telemetryPayload) {
    liveHardwarePacket = telemetryPayload;
  }
}

export function updateSfiHardwareTelemetry(telemetryPayload) {
  liveHardwarePacket = telemetryPayload;
}

export function initSfiDemo() {
  const container = document.getElementById('canvas3d-container');
  if (!container || !window.THREE) return;

  const btnPattern = document.getElementById('btn-pattern');
  const btnResetTrace = document.getElementById('btn-reset-trace');
  const btnZeroGimbal = document.getElementById('btn-zero-gimbal');
  const gimbalZeroStatus = document.getElementById('gimbal-zero-status');
  btnPattern?.addEventListener('click', () => {
    autoPattern = !autoPattern;
    btnPattern.style.opacity = autoPattern ? '1' : '0.5';
  });

  btnResetTrace?.addEventListener('click', () => {
    resetPlotLines();
  });

  btnZeroGimbal?.addEventListener('click', () => {
    gimbalZeroAngles = { ...liveSfiAngles };
    if (gimbalZeroStatus) {
      gimbalZeroStatus.textContent =
        `Zero captured: α ${gimbalZeroAngles.alpha.toFixed(1)}°, β ${gimbalZeroAngles.beta.toFixed(1)}°`;
    }
  });

  // Per-plot Zero buttons live in the battle-card headers. They centre the
  // magnet model on its grid by capturing the current bias as the zero offset.
  const wirePlotZero = (btnId, isLegacy) => {
    const btn = document.getElementById(btnId);
    btn?.addEventListener('click', () => {
      const state = togglePlotZero(isLegacy);
      if (state === 'captured') btn.textContent = 'Zeroed';
      else if (state === 'cleared') btn.textContent = 'Zero';
    });
  };
  wirePlotZero('btn-zero-std-plot', true);
  wirePlotZero('btn-zero-mlx-plot', false);

  // --- 1. THREE.JS SCENE SETUP (CAD GLB MODEL) ---
  const scene = new THREE.Scene();
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 560;

  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 1000);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 4;
  controls.maxDistance = 60;

  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const dirLight = new THREE.DirectionalLight(0x00d2ff, 1.4);
  dirLight.position.set(10, 25, 15);
  scene.add(dirLight);
  const hemiLight = new THREE.HemisphereLight(0xb0d0ff, 0x334455, 0.6);
  scene.add(hemiLight);

  const MODEL_URL = 'resources/CAD-MLX90396_Demo.glb';
  const DOME_WORLD_RADIUS = 5.2;

  const joyAssembly = new THREE.Group();
  joyAssemblyRef = joyAssembly;

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let isDraggingKnob = false;

  function setupMouseInteractions(interactiveObj) {
    container.addEventListener('mousedown', (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / container.clientWidth) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / container.clientHeight) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      if ((interactiveObj && raycaster.intersectObject(interactiveObj, true).length > 0) || e.shiftKey) {
        isDraggingKnob = true;
        controls.enabled = false;
        autoPattern = false;
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingKnob) return;
      targetJoyX = Math.max(-1, Math.min(1, (((e.clientX - renderer.domElement.getBoundingClientRect().left) / container.clientWidth) * 2 - 1) * 1.5));
      targetJoyY = Math.max(-1, Math.min(1, (-((e.clientY - renderer.domElement.getBoundingClientRect().top) / container.clientHeight) * 2 + 1) * 1.5));
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingKnob) {
        isDraggingKnob = false;
        controls.enabled = true;
      }
    });
  }

  const loadingHint = container.querySelector('.hint-overlay');
  if (loadingHint) loadingHint.textContent = 'Loading 3D model…';

  (async () => {
    try {
      const GLTFLoaderClass = await ensureGLTFLoader();
      const gltf = await new GLTFLoaderClass().loadAsync(MODEL_URL);
      const model = gltf.scene;

      // Remove CAD camera nodes; they are not part of the visible model.
      const cameraNodes = [];
      model.traverse((node) => {
        if (node.isCamera) cameraNodes.push(node);
      });
      cameraNodes.forEach((node) => node.parent && node.parent.remove(node));

      // Reparent the moving joystick parts (as whole top-level nodes) into the
      // animated assembly group. Moving whole subtrees keeps every child's
      // transform (e.g. the magnet's meshes under its group) intact. Static by
      // construction: dome, base, PCB, compass, coil, unnamed nodes, or
      // instanced duplicates (mesh_9_instance_1 = the mirrored coil).
      const STATIC_PART_NAMES = new Set([
        'DomeAssy',
        'BottomBodyCoilTest2-1',
        'MelexisPCB-1',
        'TestCompass2-1',
        'CoilRoundLarge-1',
        'current camera'
      ]);
      const isStaticName = (name) =>
        STATIC_PART_NAMES.has(name) || name === '' || name.includes('_instance_');

      const partsContainer = model.getObjectByName('Snowglobe') || model;
      const movingParts = [];
      Array.from(partsContainer.children).forEach((child) => {
        if (!isStaticName(child.name)) movingParts.push(child);
      });
      movingParts.forEach((node) => joyAssembly.add(node));
      console.log('[CAD GLB] moving parts:', movingParts.map((n) => n.name));

      scene.add(model);
      if (joyAssembly.children.length > 0) scene.add(joyAssembly);

      // Normalize the CAD dome radius to the world scale used by dome kinematics.
      const domeNode = model.getObjectByName('DomeAssy') || model.getObjectByName('Dome-1') || model;
      const domeBox = new THREE.Box3().setFromObject(domeNode);
      const domeHeight = Math.max(0.0001, domeBox.max.y - domeBox.min.y);
      const scale = DOME_WORLD_RADIUS / domeHeight;
      model.scale.setScalar(scale);
      if (joyAssembly.children.length > 0) joyAssembly.scale.setScalar(scale);

      // Center on X/Z.
      const wholeBox = new THREE.Box3().setFromObject(model);
      const center = wholeBox.getCenter(new THREE.Vector3());
      model.position.x = -center.x;
      model.position.z = -center.z;
      if (joyAssembly.children.length > 0) {
        // Keep the assembly at its CAD rest position so the magnet keeps the
        // ~11 mm CAD airgap above the sensor when untilted.
        joyAssembly.position.x = -center.x;
        joyAssembly.position.z = -center.z;
        joyRestPosition.copy(joyAssembly.position);
      }

      // Frame the camera on the model bounding box.
      const finalBox = new THREE.Box3().setFromObject(model);
      const size = finalBox.getSize(new THREE.Vector3());
      const yCenter = (finalBox.min.y + finalBox.max.y) / 2;
      controls.target.set(0, yCenter, 0);
      controls.update();
      camera.position.set(size.x * 1.5, yCenter + size.y * 0.8, size.z * 2.1);
      camera.lookAt(controls.target);

      if (loadingHint) loadingHint.textContent = 'Fixed XYZ view | Scroll: Zoom';

      // PDF review: make it a proper 3D gimbal joystick - pivot at the
      // assembly coordinate-zero (the housing/sensor base, i.e. the very bottom
      // center of the model) so the magnet holder sweeps a fixed-radius arc
      // about that point with its axis always aimed at the zero position.
      const pivotBox = new THREE.Box3().setFromObject(joyAssembly);
      joyPivotPoint.set(
        (pivotBox.min.x + pivotBox.max.x) / 2,
        pivotBox.min.y,
        (pivotBox.min.z + pivotBox.max.z) / 2
      );

      const knob = joyAssembly.getObjectByName('JoystickButton-1') || joyAssembly;
      setupMouseInteractions(knob);

      // Bright marker on the lower tip of the M3 rod (the magnet holder) that
      // tracks the stick; leaves a short fading trail behind it. Values are in
      // CAD units because the marker is a child of the scaled assembly group.
      const markerRadius = 0.0035;
      joyTipMarker = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius, 16, 16),
        new THREE.MeshStandardMaterial({
          color: 0xff3b30,
          emissive: 0xff2200,
          emissiveIntensity: 2.5,
          roughness: 0.3,
          metalness: 0.1
        })
      );
      const magnetNode = joyAssembly.getObjectByName('mesh_7') ||
        joyAssembly.getObjectByName('mesh_7_1') || null;
      const rodNode = joyAssembly.getObjectByName('M3_rod-1') || joyAssembly;
      if (magnetNode) {
        joyTipMarker.position.copy(magnetNode.position);
        joyTipMarker.position.y = magnetNode.position.y + 0.0004;
      } else {
        joyTipMarker.position.set(0, 0.0252, 0);
      }
      joyAssembly.add(joyTipMarker);

      joyTrailHistory = [];
      const TRAIL_POINTS = 14;
      joyTrailMesh = new THREE.Group();
      for (let i = 0; i < TRAIL_POINTS; i++) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(markerRadius * scale * (1 - i * 0.045), 8, 8),
          new THREE.MeshBasicMaterial({
            color: 0xff6030,
            transparent: true,
            opacity: Math.max(0, 0.55 - i * 0.042),
            depthWrite: false
          })
        );
        dot.userData.index = i;
        joyTrailMesh.add(dot);
      }
      joyTrailMesh.visible = true;
      scene.add(joyTrailMesh);
    } catch (err) {
      console.error('[CAD GLB LOAD ERROR]', err);
      const hint = loadingHint || (() => { const h = document.createElement('div'); h.className = 'hint-overlay'; container.appendChild(h); return h; })();
      hint.textContent = '3D model failed to load (network or CAD-MLX90396_Demo.glb missing). Reload to retry.';
    }
  })();

  mainSceneObj = { scene, camera, renderer, controls, container };

  // Setup subplots and radars
  stdPlot = create3DFieldPlot('canvas3d-std-plot', 0xef4444, 16.0);
  mlxPlot = create3DFieldPlot('canvas3d-mlx-plot', 0x10b981, 2.5);
  initRadarCanvases();

  let previousFrameTime = performance.now();
  let telemetryVisualElapsed = 0;

  function animate() {
    requestAnimationFrame(animate);
    const frameTime = performance.now();
    const deltaSeconds = Math.min(0.05, Math.max(0, (frameTime - previousFrameTime) / 1000));
    previousFrameTime = frameTime;
    const smoothing = 1 - Math.exp(-14 * deltaSeconds);

    if (autoPattern && !isLiveHardwareConnected) {
      animTime += deltaSeconds * 1.5;
      let cycle = (animTime % 24) / 24;

      if (cycle < 0.25) {
        let t = (cycle / 0.25) * Math.PI * 2;
        targetJoyX = Math.cos(t) * 0.85; targetJoyY = Math.sin(t) * 0.85; targetJoyZ = 0;
      } else if (cycle < 0.50) {
        let t = ((cycle - 0.25) / 0.25) * Math.PI * 4;
        if (Math.sin(t) > 0) { targetJoyX = Math.sin(t * 2) * 0.9; targetJoyY = 0; }
        else { targetJoyX = 0; targetJoyY = Math.cos(t * 2) * 0.9; }
        targetJoyZ = 0;
      } else if (cycle < 0.75) {
        targetJoyX = Math.sin(animTime * 2) * 0.25; targetJoyY = Math.cos(animTime * 2) * 0.25;
        targetJoyZ = Math.sin((cycle - 0.50) * Math.PI * 8) * 0.8;
      } else {
        targetJoyX = Math.sin(animTime * 1.7) * 0.75 + Math.cos(animTime * 0.5) * 0.2;
        targetJoyY = Math.cos(animTime * 1.3) * 0.75 + Math.sin(animTime * 0.7) * 0.2;
        targetJoyZ = Math.sin(animTime * 2.5) * 0.4;
      }
    }

    joyX += (targetJoyX - joyX) * smoothing;
    joyY += (targetJoyY - joyY) * smoothing;
    joyZ += (targetJoyZ - joyZ) * smoothing;

    const TILT_MAX_RAD = 0.19;
    const fJoyY = ORIENT_Y_FLIP * joyY;
    let tiltAngle = Math.sqrt(joyX * joyX + fJoyY * fJoyY) * TILT_MAX_RAD;
    // The 3D assembly was tilting to the opposite side of the live magnet, so
    // reverse the tilt direction by half a turn (both X and Y at once).
    let tiltDir = Math.atan2(fJoyY, joyX) + Math.PI;

    // Rotate the joystick assembly rigidly about the spherical joint where the
    // stick passes through the dome opening. Every point of the assembly keeps
    // its distance to the pivot, so the stick stays centered in the dome hole
    // for all tilt angles and the hole never limits the stick's movement.
    if (joyAssemblyRef) {
      const q = new THREE.Quaternion();
      if (tiltAngle > 0.0001) {
        const axis = new THREE.Vector3(Math.sin(tiltDir), 0, -Math.cos(tiltDir));
        q.setFromAxisAngle(axis, tiltAngle);
      }
      // Rebuild from the stored rest position each frame to avoid drift.
      joyAssemblyRef.quaternion.copy(q);
      joyAssemblyRef.position.copy(joyRestPosition).sub(joyPivotPoint).applyQuaternion(q).add(joyPivotPoint);
      // Z press: the M3 rod (magnet holder) slides down its rotated shaft axis,
      // pushing the magnet toward the sensor (smaller airgap -> stronger Bz).
      joyAssemblyRef.position.add(new THREE.Vector3(0, -joyZ * 0.3, 0).applyQuaternion(q));
    }

    // Update the marker trail: record the marker's world position, keep a short
    // history, and lay trail dots along it (fading and shrinking with age).
    if (joyTipMarker && joyTrailMesh) {
      joyTipMarker.getWorldPosition(tmpVec);
      joyTrailHistory.unshift(tmpVec.clone());
      if (joyTrailHistory.length > 32) joyTrailHistory.length = 32;
      joyTrailMesh.children.forEach((dot) => {
        const idx = dot.userData.index;
        const histIdx = Math.min(joyTrailHistory.length - 1, idx + 1);
        dot.position.copy(joyTrailHistory[histIdx] || tmpVec);
      });
    }

    // Nominal magnetic field components
    let trueBx = joyX * 18.0;
    let trueBy = fJoyY * 18.0;
    let trueBz = joyZ * 12.0;

    let noiseX = coilActive ? 6.2 + (Math.random() - 0.5) * 0.6 : 0;
    let noiseY = coilActive ? -5.8 + (Math.random() - 0.5) * 0.6 : 0;
    let noiseZ = coilActive ? 4.5 + (Math.random() - 0.5) * 0.4 : 0;

    let stdBx = trueBx + noiseX;
    let stdBy = trueBy + noiseY;
    let stdBz = 22.0 + trueBz + noiseZ;

    let mlxDBx = 6.5;
    let mlxDBy = 6.5;
    let mlxDBz = joyX * 2.5;
    let mlxDBzY = fJoyY * 2.5;

    if (isLiveHardwareConnected && liveHardwarePacket && liveHardwarePacket.p0Raw) {
      stdBx = liveHardwarePacket.p0Raw.x / SINGLE_PIXEL_LSB_PER_MT + noiseX;
      stdBy = liveHardwarePacket.p0Raw.y / SINGLE_PIXEL_LSB_PER_MT + noiseY;
      stdBz = (liveHardwarePacket.p0Raw.z / SINGLE_PIXEL_LSB_PER_MT + noiseZ);

      mlxDBx = liveHardwarePacket.diffRaw.x / DIFFERENTIAL_LSB_PER_MT_MM;
      mlxDBy = liveHardwarePacket.diffRaw.y / DIFFERENTIAL_LSB_PER_MT_MM;
      mlxDBz = (liveHardwarePacket.diffRaw.z || 0) / DIFFERENTIAL_LSB_PER_MT_MM;
      mlxDBzY = (liveHardwarePacket.diffRaw.bzY || liveHardwarePacket.diffRaw.z || 0) / DIFFERENTIAL_LSB_PER_MT_MM;
    }

    targetStdBx = stdBx;
    targetStdBy = stdBy;
    targetStdBz = stdBz;
    targetMlxDBx = mlxDBx;
    targetMlxDBy = mlxDBy;
    targetMlxDBz = mlxDBz;
    targetMlxDBzY = mlxDBzY;

    // Interpolate frame-rate display state toward raw telemetry targets
    displayStdBx += (targetStdBx - displayStdBx) * smoothing;
    displayStdBy += (targetStdBy - displayStdBy) * smoothing;
    displayStdBz += (targetStdBz - displayStdBz) * smoothing;
    displayMlxDBx += (targetMlxDBx - displayMlxDBx) * smoothing;
    displayMlxDBy += (targetMlxDBy - displayMlxDBy) * smoothing;
    displayMlxDBz += (targetMlxDBz - displayMlxDBz) * smoothing;
    displayMlxDBzY += (targetMlxDBzY - displayMlxDBzY) * smoothing;

    // Process SFI formulas from interpolated display values
    const sfi1px = computeSfi1Px(displayStdBx, displayStdBy, displayStdBz, activeCalibrationParams);
    const sfi2px = computeSfi2Px(displayMlxDBx, displayMlxDBz, displayMlxDBy, displayMlxDBzY, activeCalibrationParams);

    // With no signal, park at the 90° neutral position instead of feeding
    // atan2(0, 0) to the radar.
    const mlxHasSignal = sfi2px.signalStrength > NO_MAG_DIFF_MT_MM;
    if (!mlxHasSignal) resetAngleUnwrap();
    const dispAlpha = unwrapAngleDeg(mlxHasSignal ? sfi2px.alphaDeg : 90, 'alpha');
    const dispBeta = unwrapAngleDeg(mlxHasSignal ? sfi2px.betaDeg : 90, 'beta');
    const angleAlpha = mlxHasSignal ? sfi2px.alphaDeg : 90;
    const angleBeta = mlxHasSignal ? sfi2px.betaDeg : 90;
    const gimbalInput = calculateDifferentialGimbalInput(
      angleAlpha,
      angleBeta,
      gimbalZeroAngles.alpha,
      gimbalZeroAngles.beta
    );
    const tiltX = gimbalInput.valid ? gimbalInput.x * 90 : 0;
    const tiltY = gimbalInput.valid ? gimbalInput.y * 90 : 0;
    liveSfiAngles = { alpha: angleAlpha, beta: angleBeta };

    const joyPosTxt = document.getElementById('joy-pos-text');
    if (joyPosTxt) {
      const pressMag = Math.hypot(displayMlxDBz, displayMlxDBzY);
      const pressed = pressMag >= SFI_PRESS_THRESHOLD_MT_MM;
      joyPosTxt.innerText = `Tilt X: ${tiltX.toFixed(1)}° | Tilt Y: ${tiltY.toFixed(1)}° | Press: ${pressed ? 'PUSHED' : '\u2014'} (${pressMag.toFixed(1)} mT/mm)`;
    }

    if (isLiveHardwareConnected && liveHardwarePacket?.hasDifferential) {
      const pressMag = Math.hypot(displayMlxDBz, displayMlxDBzY);
      const pressed = pressMag >= SFI_PRESS_THRESHOLD_MT_MM;
      if (gimbalInput.valid) {
        targetJoyX = gimbalInput.x;
        targetJoyY = gimbalInput.y;
      }
      targetJoyZ = pressed ? 1 : 0;
    }

    updateSignalBarsUI(
      displayStdBx, displayStdBy, displayStdBz,
      displayMlxDBx, displayMlxDBy, displayMlxDBz, displayMlxDBzY,
      sfi1px.signalStrength,
      sfi2px.signalStrength,
      tiltX,
      tiltY
    );

    // PDF review: the θ (heading) readouts are removed; the two radars now show
    // the calibrated α/β plus a field-strength head that flags weak / missing
    // magnets (P5).
    const magFlag = (mag, noMag, weakMag) => (mag < noMag ? 'no magnet' : mag < weakMag ? 'weak' : '');

    // Top Summary (if unhidden) - alpha/beta from the differential formula.
    const angleAlphaEl = document.getElementById('angle-alpha');
    const angleBetaEl = document.getElementById('angle-beta');
    if (angleAlphaEl) angleAlphaEl.innerText = dispAlpha.toFixed(1) + '°';
    if (angleBetaEl) angleBetaEl.innerText = dispBeta.toFixed(1) + '°';

    // Standard 3D Hall Radar Readouts
    const magStdEl = document.getElementById('radar-mag-std');
    const alphaStdEl = document.getElementById('radar-alpha-std');
    const betaStdEl = document.getElementById('radar-beta-std');

    if (magStdEl) {
      const flag = magFlag(sfi1px.signalStrength, NO_MAG_STD_MT, WEAK_MAG_STD_MT);
      magStdEl.innerText = sfi1px.signalStrength.toFixed(1) + ' mT' + (flag ? ` (${flag})` : '');
    }
    if (alphaStdEl) alphaStdEl.innerText = sfi1px.alphaDeg.toFixed(1) + '°';
    if (betaStdEl) betaStdEl.innerText = sfi1px.betaDeg.toFixed(1) + '°';

    // MLX90396 Differential SFI Radar Readouts (Desmos Calibrated)
    const magMlxEl = document.getElementById('radar-mag-mlx');
    const alphaMlxEl = document.getElementById('radar-alpha-mlx');
    const betaMlxEl = document.getElementById('radar-beta-mlx');

    if (magMlxEl) {
      const flag = magFlag(sfi2px.signalStrength, NO_MAG_DIFF_MT_MM, WEAK_MAG_DIFF_MT_MM);
      magMlxEl.innerText = sfi2px.signalStrength.toFixed(1) + ' mT/mm' + (flag ? ` (${flag})` : '');
    }
    if (alphaMlxEl) alphaMlxEl.innerText = dispAlpha.toFixed(1) + '°';
    if (betaMlxEl) betaMlxEl.innerText = dispBeta.toFixed(1) + '°';

    const activeTab = document.querySelector('.tab-content.active')?.id;

    if (activeTab === 'tab-telemetry') {
      telemetryVisualElapsed += deltaSeconds;
      if (telemetryVisualElapsed >= 1 / 30) {
        telemetryVisualElapsed %= 1 / 30;

        const lastStd = stdTraceHistory[stdTraceHistory.length - 1];
        const lastMlx = mlxTraceHistory[mlxTraceHistory.length - 1];

        // Keep both magnet heads centred on the joint; Z remains a readout.
        if (!lastStd || Math.abs(lastStd.x - displayStdBx) > 0.05 || Math.abs(lastStd.y - displayStdBy) > 0.05) {
          stdTraceHistory.push({ 
            x: displayStdBx, 
            y: displayStdBy, 
            z: 0,
            rawZ: displayStdBz 
          });
        }
        
        // Preserve the differential plot's Z-gradient XY trajectory.
        if (!lastMlx || Math.abs(lastMlx.x - displayMlxDBz) > 0.05 || Math.abs(lastMlx.y - displayMlxDBzY) > 0.05) {
          mlxTraceHistory.push({ 
            x: displayMlxDBz,
            y: displayMlxDBzY,
            z: 0,
            rawX: displayMlxDBx,
            rawY: displayMlxDBy,
            rawZx: displayMlxDBz,
            rawZy: displayMlxDBzY
          });
        }

        if (stdTraceHistory.length > TRACE_HISTORY_POINTS) stdTraceHistory.shift();
        if (mlxTraceHistory.length > TRACE_HISTORY_POINTS) mlxTraceHistory.shift();

        if (stdPlot) update3DPlot(stdPlot, stdTraceHistory, true);
        if (mlxPlot) update3DPlot(mlxPlot, mlxTraceHistory, false);

        // Render the differential radar from its calibrated α/β angles.
        const radarTargetStd = isLiveHardwareConnected ? null : { x: trueBx, y: trueBy };
        // The dashed sim ring tracks the magnet only while the differential
        // field is meaningful; on the all-zero start frame the gradients vanish
        // (dead null), so atan2(0,0)=0 would pin the ring to the right corner
        // and read as a broken element. Same threshold as the needle gate.
        const radarTargetMlx = isLiveHardwareConnected ? null
          : (Math.hypot(targetMlxDBx, targetMlxDBz, targetMlxDBy, targetMlxDBzY) > NO_MAG_DIFF_MT_MM
            ? {
                x: Math.atan2(targetMlxDBx, targetMlxDBz) * 180 / Math.PI,
                y: Math.atan2(targetMlxDBy, targetMlxDBzY) * 180 / Math.PI
              }
            : null);

        drawRadar(radarCtxStd, displayStdBx, displayStdBy, radarTargetStd, '#ef4444', 'LEGACY 3D HALL', 28.0);
        drawAngleRadar(radarCtxMlx, dispAlpha, dispBeta, radarTargetMlx, '#10b981', 'MLX90396 SFI · α×β');
      }
    } else if (activeTab === 'tab-idle' && mainSceneObj) {
      controls.update();
      renderer.render(scene, camera);
    }
  }

  animate();
}

function updateSignalBarsUI(bx0, by0, bz0, dbx, dby, dbz_x, dbz_y, magStd, magDiff, tiltX, tiltY) {
  const updateBar = (meterId, txtId, val, unit = 'mT', maxRange = 35) => {
    const meter = document.getElementById(meterId);
    const txt = document.getElementById(txtId);
    if (!meter || !txt) return;

    txt.innerText = val.toFixed(1) + ' ' + unit;
    const percent = Math.min(100, Math.max(0, ((val + maxRange) / (maxRange * 2)) * 100));
    meter.style.width = percent + '%';
  };

  updateBar('meter-raw-bx', 'txt-raw-bx', bx0, 'mT');
  updateBar('meter-raw-by', 'txt-raw-by', by0, 'mT');
  updateBar('meter-raw-bz', 'txt-raw-bz', bz0, 'mT');

  updateBar('meter-diff-bx', 'txt-diff-bx', dbx, 'mT/mm');
  updateBar('meter-diff-by', 'txt-diff-by', dby, 'mT/mm');
  updateBar('meter-diff-bz', 'txt-diff-bz', dbz_x, 'mT/mm');
  updateBar('meter-diff-bz-y', 'txt-diff-bz-y', dbz_y, 'mT/mm');

  const elMagStd = document.getElementById('mag-val-std');
  const elMagDiff = document.getElementById('mag-val-diff');
  if (elMagStd) elMagStd.innerText = magStd.toFixed(1) + ' mT';
  if (elMagDiff) elMagDiff.innerText = magDiff.toFixed(1) + ' mT/mm';

  updateSensorDiagnostics(bx0, by0, bz0, dbx, dby, dbz_x, dbz_y, magStd, magDiff, tiltX, tiltY);
}

function updateSensorDiagnostics(bx0, by0, bz0, dbx, dby, dbz_x, dbz_y, magStd, magDiff, tiltX, tiltY) {
  const pressMag = Math.hypot(dbz_x, dbz_y);
  const pressed = pressMag >= SFI_PRESS_THRESHOLD_MT_MM;
  const values = {
    'diag-joy-x': typeof tiltX === 'number' ? `${tiltX.toFixed(1)}°` : '--',
    'diag-joy-y': typeof tiltY === 'number' ? `${tiltY.toFixed(1)}°` : '--',
    'diag-press-mag': `${pressMag.toFixed(2)} mT/mm`,
    'diag-press': pressed ? 'PUSHED' : '\u2014'
  };

  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
}

function initRadarCanvases() {
  radarCanvasStd = document.getElementById('radarCanvasStd');
  radarCanvasMlx = document.getElementById('radarCanvasMlx');
  if (radarCanvasStd) radarCtxStd = radarCanvasStd.getContext('2d');
  if (radarCanvasMlx) radarCtxMlx = radarCanvasMlx.getContext('2d');
  resizeRadarCanvases();
}

function resizeRadarCanvases() {
  [radarCanvasStd, radarCanvasMlx].forEach(can => {
    if (!can) return;
    can.width = can.clientWidth || 300;
    can.height = can.clientHeight || 280;
  });
}

function drawRadar(ctx, curX, curY, target, themeColor, label, maxScale = 28.0) {
  if (!ctx || !ctx.canvas) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 25;

  ctx.clearRect(0, 0, w, h);

  // Background Reticle
  ctx.fillStyle = '#030816';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  for (let r = 0.25; r <= 1.0; r += 0.25) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('0° (+X)', cx + radius - 15, cy - 6);
  ctx.fillText('90° (+Y)', cx, cy - radius + 14);
  ctx.fillText('180° (-X)', cx - radius + 22, cy - 6);
  ctx.fillText('270° (-Y)', cx, cy + radius - 8);

  // Target reticle (simulation reference)
  if (target) {
    const targetDist = Math.hypot(target.x, target.y);
    const clampedTargetDist = Math.min(targetDist, maxScale);
    const targetScale = targetDist > 0 ? (clampedTargetDist / targetDist) : 1;
    const targetPxX = cx + ((target.x * targetScale) / maxScale) * radius;
    const targetPxY = cy - ((target.y * targetScale) / maxScale) * radius;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(targetPxX, targetPxY, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Measured vector (Solid arrow) with boundary clamping
  const measuredDist = Math.hypot(curX, curY);
  const clampedMeasuredDist = Math.min(measuredDist, maxScale);
  const measuredScale = measuredDist > 0 ? (clampedMeasuredDist / measuredDist) : 1;
  const measuredPxX = cx + ((curX * measuredScale) / maxScale) * radius;
  const measuredPxY = cy - ((curY * measuredScale) / maxScale) * radius;

  ctx.strokeStyle = themeColor;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(measuredPxX, measuredPxY);
  ctx.stroke();

  ctx.fillStyle = themeColor;
  ctx.shadowColor = themeColor;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(measuredPxX, measuredPxY, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

// The frame centre is α/β = 90°; a 90° change reaches the radar rim.
function drawAngleRadar(ctx, alphaDeg, betaDeg, target, themeColor, label) {
  if (!ctx || !ctx.canvas) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 25;
  const xOf = (a) => (90 - a) / 90;
  const yOf = (b) => (90 - b) / 90;

  // Clamp to the circular rim (same boundary behaviour as the legacy drawRadar).
  const clampPoint = (vx, vy) => {
    const dist = Math.hypot(vx, vy);
    const s = dist > 1 ? 1 / dist : 1;
    return [vx * s, vy * s];
  };

  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#030816';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  for (let r = 0.25; r <= 1.0; r += 0.25) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('α 180°', cx - radius + 16, cy - 6);
  ctx.fillText('β 180°', cx, cy + radius - 8);
  ctx.fillText('α 0°', cx + radius - 22, cy - 6);
  ctx.fillText('β 0°', cx, cy - radius + 14);

  // Simulation reference: dashed ring at the true α/β position.
      if (target && !isNaN(target.x) && !isNaN(target.y)) {
        // The target comes from a raw atan2 (−180…180) while xOf/yOf assume
        // the 0…180 band, so it goes through the same rim clamp as the needle
        // instead of drawing radii outside the disc.
        const [tx, ty] = clampPoint(xOf(target.x), yOf(target.y));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(cx + tx * radius, cy - ty * radius, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (!isNaN(alphaDeg) && !isNaN(betaDeg)) {
    const [mx, my] = clampPoint(xOf(alphaDeg), yOf(betaDeg));
    const px = cx + mx * radius;
    const py = cy - my * radius;

    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(px, py);
    ctx.stroke();

    ctx.fillStyle = themeColor;
    ctx.shadowColor = themeColor;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(px, py, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  ctx.fillStyle = themeColor;
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(label, 6, 12);
}

// Shared floor height for the 3D field plots: the grid, the axis triad and the
// magnet hover height all key off this so they can never drift apart.
const PLOT_FLOOR_Y = -3.2;
// Hover of the magnet head above the floor: it sits on the grid, low and centred.
const PLOT_HEAD_HOVER = 0.4;
// Clamp radius for the head/trail: a spike pins at the rim instead of leaving
// the grid, mirroring how the radars clamp to their rim.
const PLOT_MAX_R = 3.0;

function create3DFieldPlot(elementId, ringColor, fullScale = 28.0) {  const el = document.getElementById(elementId);
  if (!el) return null;

  const plotScene = new THREE.Scene();
  plotScene.background = new THREE.Color(0x020612);

  const w = el.clientWidth || 320;
  const h = el.clientHeight || 260;
  const plotCamera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
  plotCamera.position.set(7, 4.5, 9);

  const plotRenderer = new THREE.WebGLRenderer({ antialias: true });
  plotRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  plotRenderer.setSize(w, h);
  el.appendChild(plotRenderer.domElement);

  const plotControls = new THREE.OrbitControls(plotCamera, plotRenderer.domElement);
  plotControls.target.set(0, 0, 0);
  plotControls.enableDamping = true;
  plotControls.dampingFactor = 0.05;
  plotControls.enablePan = false;
  plotControls.enableRotate = true;
  plotControls.minDistance = 10;
  plotControls.maxDistance = 16;

  plotScene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(6, 12, 8);
  plotScene.add(dirLight);

  // World Y is the screen vertical axis, so the default X-Z grid is the floor.
  // PLOT_FLOOR_Y is shared with the axis triad and the magnet hover height below.
  const gridHelper = new THREE.GridHelper(12, 12, 0x334155, 0x1e293b);
  gridHelper.position.set(0, PLOT_FLOOR_Y, -1.5);
  plotScene.add(gridHelper);

  // Origin Axes: one triad tucked into the floor corner, clear of the centred
  // action, so it reads as an orientation legend instead of colliding with the
  // magnet head and its trail. Short 2.0 legs stay inside the 12x12 floor.
  const axisOrigin = new THREE.Vector3(-4.5, PLOT_FLOOR_Y, -6.0);
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), axisOrigin, 2.0, 0xef4444));
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), axisOrigin, 2.0, 0x10b981));
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), axisOrigin, 2.0, 0x00d2ff));

  const maxPoints = TRACE_HISTORY_POINTS;
  const linePositions = new Float32Array(maxPoints * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  const traceMaterial = new THREE.LineBasicMaterial({
    color: ringColor,
    linewidth: 1
  });
  const traceMesh = new THREE.Line(lineGeo, traceMaterial);
  plotScene.add(traceMesh);

  // 6mm Cylindrical Magnet Assembly
  const magnetGroup = new THREE.Group();

  const northPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.35, 24),
    new THREE.MeshStandardMaterial({ color: 0xff1144, roughness: 0.25, metalness: 0.4 })
  );
  northPole.position.y = -0.175;
  magnetGroup.add(northPole);

  const southPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.35, 24),
    new THREE.MeshStandardMaterial({ color: 0x0088ff, roughness: 0.25, metalness: 0.4 })
  );
  southPole.position.y = 0.175;
  magnetGroup.add(southPole);

  const ringBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.56, 0.56, 0.05, 24),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0.9 })
  );
  magnetGroup.add(ringBand);

  plotScene.add(magnetGroup);

  return {
    scene: plotScene,
    camera: plotCamera,
    renderer: plotRenderer,
    controls: plotControls,
    lineGeo,
    traceMaterial,
    headMesh: magnetGroup,
    maxPoints,
    fullScale,
    // Zero offset in channel units, captured by the card's Zero button.
    zero: { x: 0, y: 0 },
    el
  };
}

function update3DPlot(plot, history, isLegacy) {
  const positions = plot.lineGeo.attributes.position.array;
  const len = history.length;
  // Fixed per-plot scale: the same channel value must always land at the same
  // world position. The old per-frame min(2.4/refScale, 2.4/maxAbs) "breathing"
  // rescaled the whole scene whenever history evolved, so the head jittered and
  // walked off-centre on a steady signal. fullScale is the channel range that
  // maps to ~2.4 world units; spikes are rim-clamped below instead of rescaling.
  const refScale = plot.fullScale || 28.0;
  const SCALE = 2.4 / refScale;
  // Zero is stored in channel units so it stays valid for this fixed scale.
  // Subtract before scaling so head and trail recentre together.
  const zx = (plot.zero && Number.isFinite(plot.zero.x)) ? plot.zero.x : 0;
  const zy = (plot.zero && Number.isFinite(plot.zero.y)) ? plot.zero.y : 0;
  // Height is a fixed hover just above the floor, NOT the absolute Bz: mapping
  // absolute Bz (~28 mT live) to height parked the magnet several units up and
  // made it bob with field strength. Bz still drives the numeric boxes, the
  // radar and the press threshold - the 3D head shows horizontal position only.
  const hoverY = PLOT_FLOOR_Y + PLOT_HEAD_HOVER;

  const clampR = (hx, hz) => {
    const r = Math.hypot(hx, hz);
    if (r <= PLOT_MAX_R || r === 0) return [hx, hz];
    return [hx * PLOT_MAX_R / r, hz * PLOT_MAX_R / r];
  };

  for (let i = 0; i < len; i++) {
    const pt = history[i];
    const [hx, hz] = clampR(-(pt.x - zx) * SCALE, -(pt.y - zy) * SCALE);
    positions[i * 3 + 0] = hx;
    positions[i * 3 + 1] = hoverY;
    positions[i * 3 + 2] = hz;
  }

  // Draw range ensures uninitialized slots in the buffer do not stretch to the origin
  plot.lineGeo.setDrawRange(0, len);
  plot.lineGeo.attributes.position.needsUpdate = true;

  if (len > 0) {
    const last = history[len - 1];
    const zOffset = last.z || 0;
    const [px, pz] = clampR(-(last.x - zx) * SCALE, -(last.y - zy) * SCALE);
    let velocity = 0;

    if (len > 1) {
      const previous = history[len - 2];
      velocity = Math.hypot(
        (last.x - previous.x) * SCALE,
        (last.y - previous.y) * SCALE
      );
      plot.traceMaterial.linewidth = Math.min(8, Math.max(1, 1 + velocity * 30));
    }

    const velocityEl = document.getElementById(isLegacy ? 'plot-std-velocity' : 'plot-mlx-velocity');
    if (velocityEl) velocityEl.textContent = `v ${(velocity * 30).toFixed(1)} px/s`;

    // The head rides the floor at the fixed hover height and stays upright: the
    // old code leaned it by ±px/pz, a fake tilt unrelated to any measurement.
    plot.headMesh.position.set(px, hoverY, pz);
    plot.headMesh.rotation.set(0, 0, 0);

    if (isLegacy) {
      setBoxVal('plot-std-bx', last.x);
      setBoxVal('plot-std-by', last.y);
      setBoxVal('plot-std-bz', last.rawZ ?? last.z ?? 0);
    } else {
      setBoxVal('plot-mlx-dbx', last.rawX ?? 0);
      setBoxVal('plot-mlx-dby', last.rawY ?? 0);
      setBoxVal('plot-mlx-dbzdx', last.rawZx ?? last.x);
      setBoxVal('plot-mlx-dbzdy', last.rawZy ?? last.y);
    }
  }

  plot.controls.update();
  plot.renderer.render(plot.scene, plot.camera);
}

function setBoxVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

export function resetPlotLines() {
  stdTraceHistory = [];
  mlxTraceHistory = [];

  [stdPlot, mlxPlot].forEach(p => {
    if (!p) return;
    p.lineGeo.setDrawRange(0, 0);
    p.lineGeo.attributes.position.needsUpdate = true;
  });
}

// Zero (centre) one magnet model on its grid. Captures the head's current
// channel values as the zero offset. Pressing again clears it.
export function togglePlotZero(isLegacy) {
  const plot = isLegacy ? stdPlot : mlxPlot;
  const history = isLegacy ? stdTraceHistory : mlxTraceHistory;
  if (!plot) return 'none';
  if (plot.zero.x !== 0 || plot.zero.y !== 0) {
    plot.zero.x = 0;
    plot.zero.y = 0;
    return 'cleared';
  }
  if (history.length === 0) return 'none';
  const last = history[history.length - 1];
  if (!Number.isFinite(last.x) || !Number.isFinite(last.y)) return 'none';
  plot.zero.x = last.x;
  plot.zero.y = last.y;
  return 'captured';
}

export function resizeSfiCanvases() {
  if (mainSceneObj && mainSceneObj.container) {
    const w = mainSceneObj.container.clientWidth;
    const h = mainSceneObj.container.clientHeight;
    if (w > 0 && h > 0) {
      mainSceneObj.camera.aspect = w / h;
      mainSceneObj.camera.updateProjectionMatrix();
      mainSceneObj.renderer.setSize(w, h);
    }
  }

  resizeRadarCanvases();

  [stdPlot, mlxPlot].forEach(p => {
    if (p && p.el) {
      const w = p.el.clientWidth;
      const h = p.el.clientHeight;
      if (w > 0 && h > 0) {
        p.camera.aspect = w / h;
        p.camera.updateProjectionMatrix();
        p.renderer.setSize(w, h);
      }
    }
  });
}
