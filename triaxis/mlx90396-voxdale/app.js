import { MLX90396_API } from './mlx_api.js';
import { Arduino_API } from './arduino_api.js';
import { 
  initSfiDemo, 
  resizeSfiCanvases, 
  updateSfiDomeKinematics, 
  setHardwareCoilCallback, 
  resetPlotLines,
  setSfiHardwareTracking,
  setCalibrationParams,
  resetCalibrationParams,
  getCalibrationParams
} from './sfi_demo.js';
// DOM Elements
const btnConnect = document.getElementById('btn-connect');
const btnStartDemo = document.getElementById('btn-start-demo');
const btnStopDemo = document.getElementById('btn-stop-demo');
const btnToggleDebug = document.getElementById('btn-toggle-debug');
const miniLogWindow = document.getElementById('mini-log-window');
const statusModeTxt = document.getElementById('status-mode-txt');

// Modal Elements
const connectModal = document.getElementById('connect-modal');
const selDriverType = document.getElementById('sel-driver-type');
const wrapConnType = document.getElementById('wrap-conn-type');
const selConnType = document.getElementById('sel-conn-type');
const selBaudRate = document.getElementById('sel-baud-rate');
const btnModalConnect = document.getElementById('btn-modal-connect');
const btnCloseModal = document.getElementById('btn-close-modal');

// State Variables
let port = null, reader = null, writer = null;
let isConnected = false, isReading = false, isDemoRunning = false;
let textDecoder, textEncoder;
let readableStreamClosed, writableStreamClosed;

let activeDevice = null;
let currentDriverType = 'scpi';

let scpiLock = Promise.resolve();
let scpiWaiter = null;
let rxBuffer = '';
let lastDataLine = '';

const magnetOffsets = { x: 0, y: 0 };
const latestRawMagnet = { x: 0, y: 0 };

window.addEventListener('DOMContentLoaded', () => {
  initSfiDemo();
  initTabNavigation();
  setHardwareCoilCallback(toggleHardwareCoilPin);
  window.addEventListener('resize', resizeSfiCanvases);
});

function initTabNavigation() {
  const tabButtons = document.querySelectorAll('.view-tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.dataset.tab;
      const targetContent = document.getElementById(targetId);
      if (targetContent) {
        targetContent.classList.add('active');
      }

      setTimeout(resizeSfiCanvases, 40);
    });
  });
}

function getSpiPrefix() {
  return selConnType ? selConnType.value : ':SPI';
}

function appendLog(text, cls = 'log-rx') {
  if (!text || !miniLogWindow) return;
  
  // Stop processing debug logs if the window is hidden (Massive Lag Fix)
  if (miniLogWindow.classList.contains('hidden')) return;

  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  miniLogWindow.appendChild(span);
  
  // Keep only the last 100 lines so the browser doesn't freeze
  while (miniLogWindow.childNodes.length > 100) {
    miniLogWindow.removeChild(miniLogWindow.firstChild);
  }
  miniLogWindow.scrollTop = miniLogWindow.scrollHeight;
}

function processRx(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') {
      if (rxBuffer.trim() !== '') {
        const line = rxBuffer.trim();
        if (currentDriverType === 'arduino' && activeDevice) {
          const sample = activeDevice.processLine(line);
          if (!sample.error) {
            setSfiHardwareTracking(true);
            updateSfiDomeKinematics(
              sample.posX_mm / 2,
              sample.posY_mm / 2,
              sample.rawZ / 1000,
              { p0Raw: { x: sample.rawX, y: sample.rawY, z: sample.rawZ }, diffRaw: { x: sample.rawX, y: sample.rawY, z: sample.rawZ } }
            );
          }
        } else {
          handlePrompt(line);
        }
      }
      rxBuffer = '';
    } else {
      rxBuffer += char;
      if (currentDriverType === 'scpi') {
        if (rxBuffer.endsWith('(OK)>') || rxBuffer.endsWith('(ERR)>') || rxBuffer.endsWith('(E2BIG)>') || rxBuffer.endsWith('(ERANGE)>')) {
          handlePrompt(rxBuffer.trim());
          rxBuffer = '';
        }
      }
    }
  }
}

function handlePrompt(line) {
  if (line.endsWith('(OK)>')) {
    let dataPart = line.slice(0, -5).trim();
    if (dataPart.includes(':SPI') || dataPart.includes(',') || dataPart.includes('0x')) {
      lastDataLine = dataPart;
    }
    if (dataPart) appendLog(dataPart + '\n', 'log-rx');
    appendLog('(OK)>\n', 'log-okprompt');

    if (scpiWaiter) {
      clearTimeout(scpiWaiter.timeoutId);
      scpiWaiter.resolve(lastDataLine);
      const rel = scpiWaiter.release;
      scpiWaiter = null;
      if (rel) rel();
    }
    lastDataLine = '';
  } else if (line.endsWith('(ERR)>') || line.endsWith('(E2BIG)>') || line.endsWith('(ERANGE)>')) {
    appendLog(line + '\n', 'log-badprompt');
    if (scpiWaiter) {
      clearTimeout(scpiWaiter.timeoutId);
      scpiWaiter.reject(new Error("Hardware Error: " + line));
      const rel = scpiWaiter.release;
      scpiWaiter = null;
      if (rel) rel();
    }
    lastDataLine = '';
  } else {
    appendLog(line + '\n', 'log-rx');
    if (line.includes(',') && !line.startsWith(':') && !line.startsWith('*')) {
      lastDataLine = line;
    }
  }
}

async function sendCommand(cmd) {
  if (!writer) return;
  const raw = cmd.trim();
  if (!raw) return;
  try {
    await writer.write(raw + '\n');
  } catch (err) {
    appendLog(`[TX ERROR]: ${err.message}\n`, 'log-badprompt');
  }
}

async function scpiQuery(cmd) {
  let releaseLock;
  const nextLock = new Promise(resolve => { releaseLock = resolve; });

  await scpiLock;
  scpiLock = nextLock;

  return new Promise((resolve, reject) => {
    lastDataLine = '';
    scpiWaiter = { resolve, reject, release: releaseLock };
    sendCommand(cmd);

    scpiWaiter.timeoutId = setTimeout(() => {
      if (scpiWaiter) {
        scpiWaiter.reject(new Error("Device Timeout on command: " + cmd));
        scpiWaiter = null;
        releaseLock();
      }
    }, 2500);
  });
}

// Requirement 4: Physical Hardware Coil Pin SCPI Trigger
async function toggleHardwareCoilPin(state) {
  if (!isConnected || currentDriverType !== 'scpi') return;
  try {
    const pinCmd = state ? ':A3:GPIO:SET:OUT 1' : ':A3:GPIO:SET:OUT 0';
    await scpiQuery(pinCmd);
    appendLog(`[HARDWARE COIL] Pin set to: ${state ? 'HIGH (5mT ON)' : 'LOW (OFF)'}\n`, 'log-okprompt');
  } catch (err) {
    console.warn('[COIL SCPI ERROR]', err);
  }
}

function setUIConnected(connected) {
  isConnected = connected;
  btnConnect.textContent = connected ? 'Disconnect' : 'Connect USB';
  btnConnect.className = connected ? 'ds-button ds-button--danger ds-button--md' : 'ds-button ds-button--primary ds-button--md';
  if (statusModeTxt) {
    statusModeTxt.textContent = connected 
      ? `Connected via ${currentDriverType.toUpperCase()} at ${selBaudRate.value} baud` 
      : 'Standby Mode (Disconnected)';
  }
}

async function connectSerial() {
  try {
    currentDriverType = selDriverType ? selDriverType.value : 'scpi';
    const baudRate = selBaudRate ? parseInt(selBaudRate.value, 10) : 115200;

    port = await navigator.serial.requestPort();
    await port.open({ baudRate });

    textDecoder = new TextDecoderStream();
    textEncoder = new TextEncoderStream();
    readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    writableStreamClosed = textEncoder.readable.pipeTo(port.writable);

    reader = textDecoder.readable.getReader();
    writer = textEncoder.writable.getWriter();
    isReading = true;

    if (currentDriverType === 'arduino') {
      activeDevice = new Arduino_API();
      appendLog(`[SYSTEM] Direct Arduino telemetry connected at ${baudRate} baud.\n`, 'log-okprompt');
    } else {
      activeDevice = new MLX90396_API(scpiQuery, getSpiPrefix);
      appendLog(`[SYSTEM] MLX90396 SCPI API connected on ${getSpiPrefix()} at ${baudRate} baud.\n`, 'log-okprompt');
    }

    setUIConnected(true);

    (async () => {
      try {
        while (isReading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) processRx(value);
        }
      } catch (err) {
        appendLog(`[RX ERROR]: ${err.message}\n`, 'log-badprompt');
      } finally {
        reader.releaseLock();
      }
    })();

  } catch (err) {
    appendLog(`[CONN ERROR]: ${err.message}\n`, 'log-badprompt');
  }
}

async function disconnectSerial() {
  isReading = false;
  isDemoRunning = false;
  if (reader) { await reader.cancel(); reader.releaseLock(); }
  if (writer) { await writer.close(); writer.releaseLock(); }
  if (readableStreamClosed) await readableStreamClosed.catch(() => {});
  if (writableStreamClosed) await writableStreamClosed.catch(() => {});
  if (port) await port.close();

  port = null; reader = null; writer = null; activeDevice = null;
  setSfiHardwareTracking(false);
  setUIConnected(false);
  btnStartDemo.disabled = false;
  btnStopDemo.disabled = true;
  appendLog('[SYSTEM] Port closed.\n', 'log-badprompt');
}

// --- EXACT UNCHANGED ORIGINAL LIVE STREAMING LOOP ---
async function runJoystickDemo() {
  btnStartDemo.disabled = true;
  btnStopDemo.disabled = false;
  isDemoRunning = true;

  if (isConnected && activeDevice) {
    try {
      appendLog('[SYSTEM] Starting Live Demo...\n', 'log-okprompt');

      if (currentDriverType === 'scpi') {
        const prefix = getSpiPrefix(); 
        await new Promise(r => setTimeout(r, 200));

        if (prefix.includes('SPI2') || prefix === ':SPI2') {
          console.log('[INIT] Configuring Melexis IO SPI2 Header Connection...');
          await scpiQuery(`${prefix}:Init 0`);
          await scpiQuery(`${prefix}:SET:CS0 0`);
          await scpiQuery(":A3:GPIO:INIT:OUT 0");
        } else {
          console.log('[INIT] Configuring Melexis IO Cable Connection...');
          await scpiQuery(`${prefix}:Init 0`);
          await scpiQuery(":CON:CS1:GPIO:INIT:OUT 0");
          await scpiQuery(`${prefix}:BUFfer 1,1,1,1,0`);
          await scpiQuery(":VDD:3V3");
        }
      }

      const K_ROT_X = 0.10, K_ROT_Y = 0.10;
      const SCALE_X = 0.02, SCALE_Y = 0.02;

      while (isDemoRunning) {
        try {
          let posX_mm = 0, posY_mm = 0, angleDeg = 0;
          let rawX = 0, rawY = 0, rawZ = 0;
          let p0Raw = { x: 0, y: 0, z: 0 };
          let diffRaw = { x: 0, y: 0, z: 0 };
          let hasLiveSample = false;

          if (currentDriverType === 'scpi') {
            await activeDevice.sm(0xFC000); 
            await new Promise(r => setTimeout(r, 2)); 
            const res01 = await activeDevice.rm(false, 0xFC000); 
            
            await activeDevice.sm(0x03F00); 
            await new Promise(r => setTimeout(r, 2)); 
            const res23 = await activeDevice.rm(false, 0x03F00); 

            // Request the dedicated 2px channels: X02, Z02, Y13 and Z13.
            await activeDevice.sm(0x000AC);
            await new Promise(r => setTimeout(r, 2));
            const resDiff = await activeDevice.rm(false, 0x000AC);

            if (!res01.error && !res23.error && !resDiff.error) {
              hasLiveSample = true;
              const avgX = (res01.x0 + res01.x1 + res23.x2 + res23.x3) / 4;
              const avgY = (res01.y0 + res01.y1 + res23.y2 + res23.y3) / 4;
              const avgZ = (res01.z0 + res01.z1 + res23.z2 + res23.z3) / 4;

              angleDeg = Math.atan2(-avgY, avgX) * (180 / Math.PI);

              const rawGradX = resDiff.x02;
              const rawGradY = resDiff.y13;
              const rawGradZx = resDiff.z02;
              const rawGradZy = resDiff.z13;

              const cleanGradX = rawGradX - (avgX * K_ROT_X);
              const cleanGradY = rawGradY - (avgY * K_ROT_Y);

              latestRawMagnet.x = cleanGradX * SCALE_X;
              latestRawMagnet.y = cleanGradY * SCALE_Y;

              posX_mm = latestRawMagnet.x - magnetOffsets.x;
              posY_mm = latestRawMagnet.y - magnetOffsets.y;
              rawX = avgX; rawY = avgY; rawZ = avgZ;

              // Extract actual individual pixel values for Requirement 1-3 Battle Matrix
              p0Raw = { x: res01.x0, y: res01.y0, z: res01.z0 };
              diffRaw = { x: rawGradX, y: rawGradY, z: rawGradZx, bzY: rawGradZy };
            }
          } else {
            const sample = await activeDevice.getSample();
            if (!sample.error) {
              hasLiveSample = true;
              latestRawMagnet.x = sample.posX_mm;
              latestRawMagnet.y = sample.posY_mm;
              posX_mm = latestRawMagnet.x - magnetOffsets.x;
              posY_mm = latestRawMagnet.y - magnetOffsets.y;
              angleDeg = sample.angleDeg;
              rawX = sample.rawX; rawY = sample.rawY; rawZ = sample.rawZ;
              p0Raw = { x: rawX, y: rawY, z: rawZ };
              diffRaw = { x: rawX, y: rawY, z: rawZ, bzY: rawZ };
            }
          }

          // A valid sample takes the dome seamlessly from its idle pattern to hardware tracking.
          if (hasLiveSample) {
            setSfiHardwareTracking(true);
            updateSfiDomeKinematics(rawX / 1000, rawY / 1000, rawZ / 1000, { p0Raw, diffRaw });
          }

          await new Promise(r => setTimeout(r, currentDriverType === 'scpi' ? 10 : 25));
        } catch (loopErr) {
          console.warn('[DEMO LOOP WARNING]', loopErr);
          await new Promise(r => setTimeout(r, 150));
        }
      }
    } catch (err) {
      appendLog(`[DEMO ERROR]: ${err.message}\n`, 'log-badprompt');
      isDemoRunning = false;
      btnStartDemo.disabled = false;
      btnStopDemo.disabled = true;
    }
  } else {
    // Standalone Emulation Mode
    let angle = 0;
    while (isDemoRunning) {
      angle += 0.08; 
      const emulatedX = Math.sin(angle * 0.7) * 1.8;
      const emulatedY = Math.cos(angle * 0.9) * 1.8;

      updateSfiDomeKinematics(emulatedX / 2, emulatedY / 2, 0);

      await new Promise(r => setTimeout(r, 33)); 
    }
  }
}

// Connection Modal Event Handlers
selDriverType?.addEventListener('change', (e) => {
  if (wrapConnType) {
    wrapConnType.style.display = e.target.value === 'scpi' ? 'block' : 'none';
  }
});

btnConnect?.addEventListener('click', () => {
  if (isConnected) disconnectSerial();
  else connectModal?.classList.remove('hidden');
});

btnCloseModal?.addEventListener('click', () => connectModal?.classList.add('hidden'));

btnModalConnect?.addEventListener('click', async () => {
  connectModal?.classList.add('hidden');
  await connectSerial();
});

btnStartDemo?.addEventListener('click', runJoystickDemo);
btnStopDemo?.addEventListener('click', () => {
  isDemoRunning = false;
  if (!isConnected) setSfiHardwareTracking(false);
  btnStartDemo.disabled = false;
  btnStopDemo.disabled = true;
  appendLog('[SYSTEM] Demo stopped.\n', 'log-badprompt');
});

btnToggleDebug?.addEventListener('click', () => {
  miniLogWindow?.classList.toggle('hidden');
});

// Append this function to app.js
export async function apply1PxGainBoost(targetGain = 37, persist = false) {
  if (!activeDevice || currentDriverType !== 'scpi') {
    appendLog('[GAIN ERROR] Active device must be connected in SCPI mode.\n', 'log-badprompt');
    return false;
  }
  try {
    const expectedGain = targetGain === 37 ? '~219' : '~72';
    appendLog(`[BAA GAIN] Writing GAINSEL_1PX = ${targetGain} (target gain ${expectedGain})...\n`, 'log-okprompt');
    const success = await activeDevice.setGain1Px(targetGain, persist);
    if (success) {
      appendLog(`[BAA GAIN] Successfully applied gain setting ${targetGain}!\n`, 'log-okprompt');
    } else {
      appendLog(`[BAA GAIN] Gain command sent with verification warning.\n`, 'log-badprompt');
    }
    return success;
  } catch (err) {
    appendLog(`[BAA GAIN ERROR] ${err.message}\n`, 'log-badprompt');
    return false;
  }
}

// Global hook for developer console or button triggers
window.apply1PxGainBoost = apply1PxGainBoost;

// --- 1. BAA ELECTRICAL GAIN TOGGLE (9 <-> 37) ---
const btnGainToggle = document.getElementById('btn-gain-toggle');
let isHighGain = false;

btnGainToggle?.addEventListener('click', async () => {
  if (!isConnected || currentDriverType !== 'scpi') {
    appendLog('[GAIN ERROR] Connect hardware via SCPI first to configure registers.\n', 'log-badprompt');
    return;
  }

  btnGainToggle.disabled = true;
  const targetGain = isHighGain ? 9 : 37;

  appendLog(`[BAA GAIN] Sending unlock sequence & writing GAINSEL_1PX = ${targetGain}...\n`, 'log-okprompt');
  const success = await apply1PxGainBoost(targetGain, false);

  if (success) {
    isHighGain = !isHighGain;
    btnGainToggle.textContent = isHighGain ? 'Gain 1px: 3x (219)' : 'Gain 1px: 1x (72)';
    btnGainToggle.className = isHighGain 
      ? 'ds-button ds-button--warning ds-button--sm' 
      : 'ds-button ds-button--secondary ds-button--sm';
  }
  btnGainToggle.disabled = false;
});

// --- 2. CALIBRATION PANEL & LIVE TUNING ---
const btnCalibToggle = document.getElementById('btn-calib-toggle');
const panelCalibration = document.getElementById('panel-calibration');
const btnCalibReset = document.getElementById('btn-calib-reset');

const calInputs = {
  k1: document.getElementById('cal-k1'),
  o11: document.getElementById('cal-o11'),
  o12: document.getElementById('cal-o12'),
  k2: document.getElementById('cal-k2'),
  o21: document.getElementById('cal-o21'),
  o22: document.getElementById('cal-o22')
};

// Toggle drawer visibility
btnCalibToggle?.addEventListener('click', () => {
  panelCalibration?.classList.toggle('hidden');
  btnCalibToggle.classList.toggle('active');
});

// Sync input changes directly to sfi_demo live calculation
Object.entries(calInputs).forEach(([key, inputEl]) => {
  inputEl?.addEventListener('input', () => {
    const val = parseFloat(inputEl.value);
    if (!isNaN(val)) {
      setCalibrationParams({ [key]: val });
    }
  });
});

// Reset calibration inputs to default values
btnCalibReset?.addEventListener('click', () => {
  const defs = resetCalibrationParams();
  Object.entries(defs).forEach(([k, val]) => {
    if (calInputs[k]) calInputs[k].value = val.toFixed(k.startsWith('k') ? 2 : 3);
  });
  appendLog('[CALIBRATION] Reset parameters to default (K=1.0, Ortho=0.0).\n', 'log-okprompt');
});