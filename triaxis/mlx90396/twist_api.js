/**
 * twist_api.js
 * Twist-mode signal processing for the MLX90396.
 *
 *  1px mode (units: mT)   : X0 (Bx), Y0 (By), Z0 (Bz)
 *     alpha = atan2(Z0, X0)               strength = sqrt(Z0^2 + X0^2)
 *     beta  = atan2(Z0, Y0)               strength = sqrt(Z0^2 + Y0^2)
 *
 *  2px mode (units: mT/mm): X02 (dBx/dx), Z02 (dBz/dx), Y13 (dBy/dy), Z13 (dBz/dy)
 *     alpha = atan2(Z02, X02)             strength = sqrt(Z02^2 + X02^2)
 *     beta  = atan2(Z13, Y13)             strength = sqrt(Z13^2 + Y13^2)
 *
 *  The calibrated (Desmos) angles are computed by the shared ../angle_calib.js
 *  module so the thumbstick and the Voxdale page run one and the same engine.
 */

import {
  DEFAULT_CALIBRATION_PARAMS as CALIB_DEFAULTS,
  normalizeParams,
  calculateDesmosAngles
} from '../angle_calib.js';

const toDeg = (rad) => (rad * 180) / Math.PI;

export function calcTwist1px({ X0, Y0, Z0 }) {
  const alpha = Math.atan2(Z0, X0);
  const beta = Math.atan2(Z0, Y0);
  return {
    alphaRad: alpha,
    betaRad: beta,
    alphaDeg: toDeg(alpha),
    betaDeg: toDeg(beta),
    strengthAlpha: Math.hypot(Z0, X0),
    strengthBeta: Math.hypot(Z0, Y0),
    unit: 'mT',
    mode: '1px',
  };
}

export function calcTwist2px({ X02, Z02, Y13, Z13 }) {
  const alpha = Math.atan2(Z02, X02);
  const beta = Math.atan2(Z13, Y13);
  return {
    alphaRad: alpha,
    betaRad: beta,
    alphaDeg: toDeg(alpha),
    betaDeg: toDeg(beta),
    strengthAlpha: Math.hypot(Z02, X02),
    strengthBeta: Math.hypot(Z13, Y13),
    unit: 'mT/mm',
    mode: '2px',
  };
}

// --- Calibration (Desmos model, rad -> deg) ---
//   a1 = atan2( sqrt( z1^2 + (k1 * (y1 - o11 * z1))^2 ), (x1 - o12 * z1) )
//   b1 = atan2( sqrt( z1^2 + (k2 * (x1 - o21 * z1))^2 ), (y1 - o22 * z1) )
// Live params follow the module's defaults; normalizeParams drops NaN input.
export const TWIST_CAL = { ...CALIB_DEFAULTS };

export function applyTwistCalibration(x, y, z) {
  // One angle definition only. The old identity fast-path hand-rolled
  // atan2(z, x) with a SIGNED z: a negative vertical field then gave negative
  // alpha/beta, and the radar's (90-α)/90 mapping pushed the needle past the
  // rim into the corner until a K or offset was changed. Delegating to the
  // Desmos core keeps atan2's first argument a magnitude (hypot), so the
  // calibrated angles stay in the 0..180° band at every parameter set -
  // including the k1=k2=1, o=0 default.
  const p = normalizeParams(TWIST_CAL);
  return calculateDesmosAngles(x, y, z, p);
}

// Combined pipeline: raw alpha/beta + strengths for the selected mode, then
// Desmos calibration applied and returned in degrees. 2px cross-terms use the
// perpendicular differential pair (alpha consumes Y13, beta consumes X02).
export function computeTwistSignals(mode = '1px', input = null) {
  const is2px = mode === '2px';
  const src = input || (is2px
    ? { X02: 0, Z02: 0, Y13: 0, Z13: 0 }
    : { X0: 0, Y0: 0, Z0: 0 });
  const raw = is2px ? calcTwist2px(src) : calcTwist1px(src);

  const alphaIn = is2px
    ? { x: src.X02, y: src.Y13, z: src.Z02 }
    : { x: src.X0, y: src.Y0, z: src.Z0 };
  const betaIn = is2px
    ? { x: src.X02, y: src.Y13, z: src.Z13 }
    : { x: src.X0, y: src.Y0, z: src.Z0 };

  const calA = applyTwistCalibration(alphaIn.x, alphaIn.y, alphaIn.z);
  const calB = applyTwistCalibration(betaIn.x, betaIn.y, betaIn.z);

  return {
    ...raw,
    alphaCalDeg: calA.alphaDeg,
    alphaCalRad: calA.alphaRad,
    betaCalDeg: calB.betaDeg,
    betaCalRad: calB.betaRad,
  };
}

// Derive 1px + 2px inputs from the 4 pixel readouts.
export function deriveTwistInputsFromPoints(points) {
  const p0 = points?.[0] || {};
  const p1 = points?.[1] || {};
  const p2 = points?.[2] || {};
  const p3 = points?.[3] || {};
  return {
    X0: p0.x ?? 0, Y0: p0.y ?? 0, Z0: p0.z ?? 0,
    X02: ((p2.x ?? 0) - (p0.x ?? 0)) / 2,
    Z02: ((p2.z ?? 0) - (p0.z ?? 0)) / 2,
    Y13: ((p3.y ?? 0) - (p1.y ?? 0)) / 2,
    Z13: ((p3.z ?? 0) - (p1.z ?? 0)) / 2,
  };
}

// --- Gain Configuration (MLX90396 GAINSEL register) ---
// Defaults are zeroed per user request so the page opens with the electrical
// gain at minimum. NOTE: switching 1px<->2px mode writes the table value below
// to the chip, and typing in the gain field writes it (debounced); starting
// the live demo re-reads the chip and adopts whatever it actually holds. If
// live readings look dead after a mode switch, type the trimmed gain back in
// (the previous production trim was 37/0b100101 for 1px, 9/0b001001 for 2px).
// TODO(hw-trim): during the physical Arduino hardware validation session,
// adjust this literal to the final trimmed value and confirm bits against
// the GAINSEL register table in the MLX90396 datasheet before flashing.
export const GAINSEL = {
  '1px': 0b000000, // 0 — user-requested zero start (was 37, ~219)
  '2px': 0b000000, // 0 — user-requested zero start (was 9, ~72)
};

export function setGainSel(mode, value) {
  GAINSEL[mode] = value & 0x3F;
  return GAINSEL[mode];
}

export function getGainSel(mode) {
  return GAINSEL[mode] ?? 0;
}