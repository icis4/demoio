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

- **pulse (seconds)** — Pulse width for the coil injection, 0.5–60 s, default 5.

- **Gain 1px: 1x (72)** — Writes `GAINSEL_1PX` to the chip (SCPI only): toggles between gain 37 (→ ~219, shown as "3x") and gain 9 (→ ~72, "1x").

- **Clear Trajectories** — Clears the plotted 3D field traces (streaming continues).

## Help

- **Help** — sits next to **Connect USB** in the top bar. Opens this document in-app, read from `voxdale_help_readme.md` at the moment you click.

## Tabs

- **Live Telemetry & Battle Matrix** — Shows signal meters, magnitude gauges, the two 3D field plots (legacy mT and differential mT/mm, each with magnet head + trace), and the two polar radar plots. Each radar carries θ, α and β readouts.

- **Idle / Auto-Pattern & Dome Kinematics** — The CAD GLB dome scene. The stick pivots ~11° where it exits the dome; drag the knob to observe from different angles, scroll to zoom. Camera pan/rotate is disabled ("Fixed XYZ view").

- **Sensor Diagnostics** — Explains legacy vs differential signals and shows live range/stability watch values.

## Calibration panel (hidden by default)

Not a tab — a drawer toggled by the **Calibration Tuning** button, which sits in the controls bar but renders inside the "Live Telemetry & Battle Matrix" section.

- **Reset Defaults** — Restores K-factors to 1.0 and orthogonality to 0.0.

- **k1/k2/o11/o12/o21/o22 inputs** — Live Desmos calibration: K-factors scale axis strength, orthogonality terms compensate cross-axis/Z feedthrough. Values apply instantly as you type.