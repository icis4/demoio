/**
 * sfi_demo.js
 * Standalone SFI Joystick, 3D Dome Kinematics, Centered Z-UP XYZ Chart, Polar Radar & Battle Matrix
 */

// --- GLTFLoader (r128 non-module build, matches the global THREE loaded in index.html) ---
let gltfLoaderPromise = null;
function ensureGLTFLoader() {
  if (!gltfLoaderPromise) {
    gltfLoaderPromise = new Promise((resolve, reject) => {
      if (window.THREE && THREE.GLTFLoader) { resolve(THREE.GLTFLoader); return; }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js';
      script.onload = () => resolve(THREE.GLTFLoader);
      script.onerror = () => reject(new Error('Failed to load GLTFLoader'));
      document.head.appendChild(script);
    });
  }
  return gltfLoaderPromise;
}

// --- Calibration & Signal Math Engine ---
export const DEFAULT_CALIBRATION_PARAMS = {
  k1: 1.0,   // Alpha K-factor
  o11: 0.0,  // Alpha upper orthogonality
  o12: 0.0,  // Alpha lower orthogonality
  k2: 1.0,   // Beta K-factor
  o21: 0.0,  // Beta upper orthogonality
  o22: 0.0   // Beta lower orthogonality
};

let activeCalibrationParams = { ...DEFAULT_CALIBRATION_PARAMS };

export function setCalibrationParams(newParams) {
  activeCalibrationParams = { ...activeCalibrationParams, ...newParams };
}

export function getCalibrationParams() {
  return { ...activeCalibrationParams };
}

export function resetCalibrationParams() {
  activeCalibrationParams = { ...DEFAULT_CALIBRATION_PARAMS };
  return activeCalibrationParams;
}

export function calculateDesmosAngles(x, y, z, params = DEFAULT_CALIBRATION_PARAMS) {
  const { k1, o11, o12, k2, o21, o22 } = params;

  const crossY = k1 * (y - o11 * z);
  const numA = Math.sqrt(z * z + crossY * crossY);
  const denA = x - o12 * z;
  const a1_rad = Math.atan2(numA, denA);

  const crossX = k2 * (x - o21 * z);
  const numB = Math.sqrt(z * z + crossX * crossX);
  const denB = y - o22 * z;
  const b1_rad = Math.atan2(numB, denB);

  const radToDeg = 180 / Math.PI;

  return {
    alphaDeg: a1_rad * radToDeg,
    betaDeg: b1_rad * radToDeg,
    alphaRad: a1_rad,
    betaRad: b1_rad
  };
}

export function computeSfi1Px(bx, by, bz, params = DEFAULT_CALIBRATION_PARAMS) {
  const alphaStrength = Math.sqrt(bz * bz + bx * bx);
  const betaStrength = Math.sqrt(bz * bz + by * by);
  const signalStrength = Math.sqrt(bx * bx + by * by + bz * bz);
  const angles = calculateDesmosAngles(bx, by, bz, params);

  return {
    mode: '1px',
    alphaStrength,
    betaStrength,
    signalStrength,
    alphaSignal: { z: bz, x: bx },
    betaSignal: { z: bz, y: by },
    ...angles
  };
}

export function computeSfi2Px(dbx_dx, dbz_dx, dby_dy, dbz_dy, params = DEFAULT_CALIBRATION_PARAMS) {
  const alphaStrength = Math.sqrt(dbz_dx * dbz_dx + dbx_dx * dbx_dx);
  const betaStrength = Math.sqrt(dbz_dy * dbz_dy + dby_dy * dby_dy);
  const signalStrength = Math.sqrt(
    dbx_dx * dbx_dx + dby_dy * dby_dy + dbz_dx * dbz_dx + dbz_dy * dbz_dy
  );

  const alphaZ = params.k1 * (dbz_dx - params.o11 * dbx_dx);
  const alphaX = dbx_dx - params.o12 * dbz_dx;
  const betaZ = params.k2 * (dbz_dy - params.o21 * dby_dy);
  const betaY = dby_dy - params.o22 * dbz_dy;
  const radToDeg = 180 / Math.PI;
  const angles = {
    alphaRad: Math.atan2(Math.abs(alphaZ), alphaX),
    betaRad: Math.atan2(Math.abs(betaZ), betaY)
  };
  angles.alphaDeg = angles.alphaRad * radToDeg;
  angles.betaDeg = angles.betaRad * radToDeg;

  return {
    mode: '2px',
    alphaStrength,
    betaStrength,
    signalStrength,
    alphaSignal: { dbz_dx, dbx_dx },
    betaSignal: { dbz_dy, dby_dy },
    ...angles
  };
}

// --- Simulation & Telemetry State ---
let autoPattern = true;
let coilActive = false;
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

let onHardwareCoilToggle = null;
let liveHardwarePacket = null;
const SINGLE_PIXEL_LSB_PER_MT = 20;
const DIFFERENTIAL_LSB_PER_MT_MM = 120;
const TRACE_HISTORY_POINTS = 45;

export function setHardwareCoilCallback(cb) {
  onHardwareCoilToggle = cb;
}

export function setSfiHardwareTracking(enabled) {
  isLiveHardwareConnected = Boolean(enabled);
}

export function updateSfiDomeKinematics(x, y, z, telemetryPayload = null) {
  targetJoyX = Math.max(-1, Math.min(1, x));
  targetJoyY = Math.max(-1, Math.min(1, y));
  targetJoyZ = Math.max(-1, Math.min(1, z));

  if (telemetryPayload) {
    liveHardwarePacket = telemetryPayload;
  }
}

export function initSfiDemo() {
  const container = document.getElementById('canvas3d-container');
  if (!container || !window.THREE) return;

  const btnPattern = document.getElementById('btn-pattern');
  const btnCoil = document.getElementById('btn-coil');
  const btnCoilToggle = document.getElementById('btn-coil-toggle');
  const btnResetTrace = document.getElementById('btn-reset-trace');
  const coilLbl = document.getElementById('coil-readout-lbl');

  const toggleCoilAction = () => {
    coilActive = !coilActive;
    if (coilActive) {
      btnCoil?.classList.add('active');
      btnCoilToggle?.classList.add('active');
      if (coilLbl) {
        coilLbl.innerText = 'COIL: ACTIVE (+5.0 mT STRAY FIELD)';
        coilLbl.style.color = '#ef4444';
      }
    } else {
      btnCoil?.classList.remove('active');
      btnCoilToggle?.classList.remove('active');
      if (coilLbl) {
        coilLbl.innerText = 'COIL: INACTIVE (0.0 mT)';
        coilLbl.style.color = '#94a3b8';
      }
    }
    if (typeof onHardwareCoilToggle === 'function') {
      onHardwareCoilToggle(coilActive);
    }
  };

  btnCoil?.addEventListener('click', toggleCoilAction);
  btnCoilToggle?.addEventListener('click', toggleCoilAction);

  btnPattern?.addEventListener('click', () => {
    autoPattern = !autoPattern;
    btnPattern.style.opacity = autoPattern ? '1' : '0.5';
  });

  btnResetTrace?.addEventListener('click', () => {
    resetPlotLines();
  });

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

      // Mark the pivot point in world space. A real joystick pivots where the
      // stick passes through the housing opening (the ball joint / sleeve), not
      // at the PCB below it. Pivoting the assembly about the JoystickInnerPart
      // sleeve keeps the stick centered in the dome opening at every tilt
      // angle, so the dome hole never limits the stick's movement.
      const sleeve = joyAssembly.getObjectByName('JoystickInnerPart-1') ||
        model.getObjectByName('JoystickInnerPart-1') || model;
      const sleeveBox = new THREE.Box3().setFromObject(sleeve);
      joyPivotPoint.set(
        (sleeveBox.min.x + sleeveBox.max.x) / 2,
        (sleeveBox.min.y + sleeveBox.max.y) / 2,
        (sleeveBox.min.z + sleeveBox.max.z) / 2
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
    let tiltAngle = Math.sqrt(joyX * joyX + joyY * joyY) * TILT_MAX_RAD;
    let tiltDir = Math.atan2(joyY, joyX);

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

    const joyPosTxt = document.getElementById('joy-pos-text');
    if (joyPosTxt) {
      joyPosTxt.innerText = `Tilt X: ${(joyX * 22).toFixed(1)}° | Tilt Y: ${(joyY * 22).toFixed(1)}° | Press Z: ${(joyZ * 2.0).toFixed(1)} mm`;
    }

    // Nominal magnetic field components
    let trueBx = joyX * 18.0;
    let trueBy = joyY * 18.0;
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
    let mlxDBzY = joyY * 2.5;

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

    updateSignalBarsUI(
      displayStdBx, displayStdBy, displayStdBz,
      displayMlxDBx, displayMlxDBy, displayMlxDBz, displayMlxDBzY,
      sfi1px.signalStrength,
      sfi2px.signalStrength
    );

    let trueAngleDeg = (Math.atan2(joyY, joyX) * 180 / Math.PI + 360) % 360;
    let stdAngleDeg = (Math.atan2(displayStdBy, displayStdBx) * 180 / Math.PI + 360) % 360;
    let diffAngleDeg = (Math.atan2(displayMlxDBzY, displayMlxDBz) * 180 / Math.PI + 360) % 360;

    let stdError = Math.abs(stdAngleDeg - trueAngleDeg);
    if (stdError > 180) stdError = 360 - stdError;

    let diffError = Math.abs(diffAngleDeg - trueAngleDeg);
    if (diffError > 180) diffError = 360 - diffError;

    // Top Summary (if unhidden)
    const angleAlphaEl = document.getElementById('angle-alpha');
    const angleBetaEl = document.getElementById('angle-beta');
    const angleThetaEl = document.getElementById('angle-theta');
    if (angleAlphaEl) angleAlphaEl.innerText = sfi2px.alphaDeg.toFixed(1) + '°';
    if (angleBetaEl) angleBetaEl.innerText = sfi2px.betaDeg.toFixed(1) + '°';
    if (angleThetaEl) angleThetaEl.innerText = diffAngleDeg.toFixed(1) + '°';

    // Standard 3D Hall Radar Readouts
    const angleStdEl = document.getElementById('radar-angle-std');
    const errorStdEl = document.getElementById('radar-error-std');
    const alphaStdEl = document.getElementById('radar-alpha-std');
    const betaStdEl = document.getElementById('radar-beta-std');

    if (angleStdEl) angleStdEl.innerText = stdAngleDeg.toFixed(1) + '°';
    if (errorStdEl) errorStdEl.innerText = stdError.toFixed(1) + '°';
    if (alphaStdEl) alphaStdEl.innerText = sfi1px.alphaDeg.toFixed(1) + '°';
    if (betaStdEl) betaStdEl.innerText = sfi1px.betaDeg.toFixed(1) + '°';

    // MLX90396 Differential SFI Radar Readouts (Desmos Calibrated)
    const angleMlxEl = document.getElementById('radar-angle-mlx');
    const errorMlxEl = document.getElementById('radar-error-mlx');
    const alphaMlxEl = document.getElementById('radar-alpha-mlx');
    const betaMlxEl = document.getElementById('radar-beta-mlx');

    if (angleMlxEl) angleMlxEl.innerText = diffAngleDeg.toFixed(1) + '°';
    if (errorMlxEl) errorMlxEl.innerText = diffError.toFixed(1) + '°';
    if (alphaMlxEl) alphaMlxEl.innerText = sfi2px.alphaDeg.toFixed(1) + '°';
    if (betaMlxEl) betaMlxEl.innerText = sfi2px.betaDeg.toFixed(1) + '°';

    const activeTab = document.querySelector('.tab-content.active')?.id;

    if (activeTab === 'tab-telemetry') {
      telemetryVisualElapsed += deltaSeconds;
      if (telemetryVisualElapsed >= 1 / 30) {
        telemetryVisualElapsed %= 1 / 30;

        const lastStd = stdTraceHistory[stdTraceHistory.length - 1];
        const lastMlx = mlxTraceHistory[mlxTraceHistory.length - 1];

        // Left Plot: Push z: 0 so the magnet head starts and pivots centered on the joint
        if (!lastStd || Math.abs(lastStd.x - displayStdBx) > 0.05 || Math.abs(lastStd.y - displayStdBy) > 0.05) {
          stdTraceHistory.push({ 
            x: displayStdBx, 
            y: displayStdBy, 
            z: 0,
            rawZ: displayStdBz 
          });
        }
        
        // Right Plot: Push tilt gradients (Z02, Z13) centered on the joint
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

        // Render 2D Polar Radars with dedicated scales using smoothed display values
        const radarTargetStd = isLiveHardwareConnected ? null : { x: trueBx, y: trueBy };
        const radarTargetMlx = isLiveHardwareConnected ? null : { x: joyX * 2.5, y: joyY * 2.5 };

        drawRadar(radarCtxStd, displayStdBx, displayStdBy, radarTargetStd, '#ef4444', 'LEGACY 3D HALL', 28.0);
        drawRadar(radarCtxMlx, displayMlxDBz, displayMlxDBzY, radarTargetMlx, '#10b981', 'MLX90396 SFI', 3.5);
      }
    } else if (activeTab === 'tab-idle' && mainSceneObj) {
      controls.update();
      renderer.render(scene, camera);
    }
  }

  animate();
}

function updateSignalBarsUI(bx0, by0, bz0, dbx, dby, dbz_x, dbz_y, magStd, magDiff) {
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

  updateSensorDiagnostics(bx0, by0, bz0, dbx, dby, dbz_x, dbz_y, magStd, magDiff);
}

function updateSensorDiagnostics(bx0, by0, bz0, dbx, dby, dbz_x, dbz_y, magStd, magDiff) {
  const values = {
    'diag-source': isLiveHardwareConnected ? 'Live hardware' : 'Simulation',
    'diag-health': [bx0, by0, bz0, dbx, dby, dbz_x, dbz_y].some(value => Math.abs(value) >= 100)
      ? 'Range watch: possible clipping'
      : 'Range watch: no obvious clipping',
    'diag-bx': `${bx0.toFixed(2)} mT`,
    'diag-by': `${by0.toFixed(2)} mT`,
    'diag-bz': `${bz0.toFixed(2)} mT`,
    'diag-dbx': `${dbx.toFixed(2)} mT/mm`,
    'diag-dby': `${dby.toFixed(2)} mT/mm`,
    'diag-dbz-x': `${dbz_x.toFixed(2)} mT/mm`,
    'diag-dbz-y': `${dbz_y.toFixed(2)} mT/mm`,
    'diag-std-magnitude': `${magStd.toFixed(2)} mT`,
    'diag-diff-magnitude': `${magDiff.toFixed(2)} mT/mm`
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

function create3DFieldPlot(elementId, ringColor, fullScale = 28.0) {
  const el = document.getElementById(elementId);
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
  plotControls.enableRotate = false;
  plotControls.minDistance = 10;
  plotControls.maxDistance = 16;

  plotScene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(6, 12, 8);
  plotScene.add(dirLight);

  // World Y is the screen vertical axis, so the default X-Z grid is the floor.
  const gridHelper = new THREE.GridHelper(8, 8, 0x334155, 0x1e293b);
  gridHelper.position.y = -2.2;
  plotScene.add(gridHelper);

  // Origin Axes
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 3.2, 0xef4444));
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 3.2, 0x10b981));
  plotScene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 3.2, 0x00d2ff));

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
    el
  };
}

function update3DPlot(plot, history, isLegacy) {
  const positions = plot.lineGeo.attributes.position.array;
  const len = history.length;
  const maxAbs = Math.max(1, ...history.map(pt => Math.max(
    Math.abs(pt.x),
    Math.abs(pt.y),
    Math.abs(pt.z || 0)
  )));
  // Each plot scales its own channel range onto the grid, so the magnet head
  // swings a similar distance for the legacy (mT) and the differential
  // (mT/mm) signals. fullScale is the channel range that maps to ~2.4 world
  // units; the maxAbs term keeps a small signal from over-zooming the head.
  const refScale = plot.fullScale || 28.0;
  const SCALE = Math.min(2.4 / refScale, 2.4 / maxAbs);

  for (let i = 0; i < len; i++) {
    const pt = history[i];
    const zOffset = pt.z || 0;
    positions[i * 3 + 0] = pt.x * SCALE;
    positions[i * 3 + 1] = zOffset * SCALE;
    positions[i * 3 + 2] = pt.y * SCALE;
  }

  // Draw range ensures uninitialized slots in the buffer do not stretch to the origin
  plot.lineGeo.setDrawRange(0, len);
  plot.lineGeo.attributes.position.needsUpdate = true;

  if (len > 0) {
    const last = history[len - 1];
    const zOffset = last.z || 0;
    const px = last.x * SCALE;
    const py = zOffset * SCALE;
    const pz = last.y * SCALE;
    let velocity = 0;

    if (len > 1) {
      const previous = history[len - 2];
      const previousZ = previous.z || 0;
      velocity = Math.hypot(
        (last.x - previous.x) * SCALE,
        (last.y - previous.y) * SCALE,
        (zOffset - previousZ) * SCALE
      );
      plot.traceMaterial.linewidth = Math.min(8, Math.max(1, 1 + velocity * 30));
    }

    const velocityEl = document.getElementById(isLegacy ? 'plot-std-velocity' : 'plot-mlx-velocity');
    if (velocityEl) velocityEl.textContent = `v ${(velocity * 30).toFixed(1)} px/s`;

    plot.headMesh.position.set(px, py, pz);
    plot.headMesh.rotation.z = -px * 0.4;
    plot.headMesh.rotation.x = pz * 0.4;

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