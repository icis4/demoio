# MLX90396 Voxdale Demo Help

## Connection (top bar)

- **Connect USB** — Opens the hardware connection window. When already connected, the button toggles to disconnect instead.

- **Open Serial Port** — Confirms the serial baud rate/SPI settings and opens the available ports list to choose from. If no hardware is present, the app still runs in emulation mode.

- **?** — Closes the connection modal without connecting.

## Stream controls

These sit in the controls bar below the top bar, separate from **Connect USB** and **Help**.

- **Start Live Stream** — Starts the demo loop. With hardware connected it reads 4 pixels (X02/Z02/Y13/Z13 via SCPI) and drives the joystick with live telemetry; otherwise it runs a standalone joystick emulation.

- **Stop** — Stops the stream and releases the loop.

- **Auto-Pattern** — Toggles the idle showcase pattern (dome tilts/presses through a repeating 24s sequence). Dimmed = off. Clicking/dragging the dome knob also turns it off.

- **Stray Field Coil (5 mT)** — Toggles the simulated external uniform stray field that aims to interfere with the MLX90396's raw data readings. The purpose of the operation is to demonstrate that an external magnetic field does not alter the sensor's work.

- **pulse (seconds)** — Pulse width for the coil injection, 0.5–60 s, default 5. The coil is a *timed pulse, never a latch*: clicking **Stray Field Coil** energises it and counts the dwell down to 0, then releases the pin. Clicking again while a pulse is running aborts it early instead of queueing a second one.

- **Gain preset (1x / 3x)** (in the Calibration Tuning panel) — Writes both `GAINSEL_1PX` and `GAINSEL_2PX` to the chip (SCPI only). Two factory presets, **1x** (gain 9 → ~72) and **3x** (gain 37 → ~219, the default per the AE's "1px needs 3×" guidance), plus a free **trim** field (0–63) for the final-test value; both fields are trimmed together. The gain literally re-ranges the chip's internal amplifier; the number in parentheses is the resulting full-scale count for the standard Bx channel.

- **Clear Trajectories** — Clears the plotted 3D field traces (streaming continues).

## Help

- **Help** — sits next to **Connect USB** in the top bar. Opens this document in-app, read from `voxdale_help_readme.md` at the moment you click.

## Tabs

- **Live Telemetry & Battle Matrix** — Shows signal meters, magnitude gauges, the two 3D field plots (legacy mT and differential mT/mm, each with magnet head + trace, re-centred together by the **Zero Graphs** button in the controls bar), and the two radar plots. Each radar carries a field-strength readout (|B| for standard 3D Hall, |∇B| for differential), which flags **weak** or **no magnet** below 8/2 mT (standard) and 3/1 mT/mm (differential), plus α/β. Differential angles default to the reviewed normal formula `ATAN2(X02, Z02)` / `ATAN2(Y13, Z13)`; select Enhanced in Calibration Tuning to apply the optional cross-axis formula. The selected formula feeds the differential readout, radar, and live gimbal.

- **Idle / Auto-Pattern & Dome Kinematics** — The CAD GLB dome scene. In SCPI mode the gimbal follows the differential X02/Z02 and Y13/Z13 angles, not the absolute-field X/Y average. **Zero Position** captures current differential α/β as neutral; Tilt X/Y show commanded movement relative to this reference (bounded to ±90°). The stick gimbals about the middle of the sensor board (the blue EVB90396 PCB under the magnet), so it leans over the chip rather than swinging around the ball joint. Drag the knob to inspect it and scroll to zoom. Camera pan/rotate is disabled ("Fixed XYZ view"). **Press** reads **PUSHED** when `sqrt(Z02² + Z13²)` reaches ~20 mT/mm.

- **Sensor Diagnostics** — Mirrors the MLX90396 thumbstick diagnostics: a Frame Health card (source, decoded status byte, per-transfer CRC, averaged loop period), raw signed 12-bit LSB tables for the twelve absolute pixels and the four 2px gradient channels (X02, Z02, Y13, Z13, mask `0x000AC`), and a Dome Output card (tilt X/Y and press state). Frame-level cards populate while the SCPI stream runs; in simulation they stay at `--`.

## Calibration panel (hidden by default)

Not a tab — a drawer toggled by the **Calibration Tuning** button, which sits in the controls bar but renders inside the "Live Telemetry & Battle Matrix" section.

- **GAINSEL (electrical gain)** — Same control as the Thumbstick page: two presets, **1x** (gain 9) and **3x** (gain 37, the default), plus a free **trim** field (0–63) for the final-test value. Choosing a value writes it to **both** `GAINSEL_1PX` (reg 0x00 bits [5:0]) and `GAINSEL_2PX` (bits [11:6]) over SCPI, with the unlock sequence + readback verify, then confirms both in the **Device confirmed** line; without hardware it stays local ("Device: not read"). The hint shows the selected 6-bit value. The control lives in this Calibration Tuning panel next to the k/o constants.

- **Pixel pitch (mm)** — Sets the ∇B display scale: the chip's 2px channels are raw counts, converted to mT/mm by `20 × pitch` (`20` = the single-pixel LSB per mT). The preliminary datasheet does not publish the pitch, so it is **live-trimmable** here and defaults to **1.0 mm**. Both this page and the Thumbstick page read the same constant from `angle_calib.js`, so they can never disagree. Trim it until the ∇B magnitude matches the physics; changing it does **not** move the α/β angles (a uniform divide cancels in `atan2`). It only rescales the magnitude and therefore the weak/no-magnet and press thresholds.

- **Reset Defaults** — Restores K-factors to 1.0, orthogonality to 0.0 and the pixel pitch to 1.0 mm.

- **Differential angle formula** — Defaults to the reviewed normal formula `ATAN2(X02, Z02)` / `ATAN2(Y13, Z13)`. Select **Enhanced** to use the cross-axis formula shown in the panel. Note the two modes agree only inside the normal operating band: Enhanced folds the other plane's gradient into each magnitude, so flipping the selector with the magnet far off-centre jumps discontinuously by design (reviewer slide 12 specifies the cross terms explicitly).

- **k1/k2/o11/o12/o21/o22 inputs** — Enhanced formula parameters: α uses `sqrt(X02² + (k1·(Z13 − o11·X02))²)` over `Z02 − o12·X02`; β uses `sqrt(Y13² + (k2·(Z02 − o21·Y13))²)` over `Z13 − o22·Y13`. The selected formula feeds the radars, readouts and live gimbal.