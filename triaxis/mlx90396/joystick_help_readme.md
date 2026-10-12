# MLX90396 GUI Help

## Start screen / toolbar

- **Start** — begins the live demo loop. **Requires a connection first** — the button stays disabled until USB is connected.

- **Stop** — halts the loop, resets joystick + magnet disk to center, status returns to Idle.

- **Status badge** — Idle / Running / Error.

- **Connect USB (or Disconnect when active)** — opens the hardware connection dialog / tears the port down.

- **Help** — sits next to **Connect USB** in the toolbar. Opens this document in-app, read from `joystick_help_readme.md` at the moment you click.

## Connection modal

*Pick your setup before the Chrome port-picker appears:*

- **Target Device Driver** — two modes:

    - **SCPI Bridge (MLX90396 SPI API)** — full access: raw SPI register reads, NVRAM, pixel data.
    - **Direct Arduino Telemetry (Frame Stream)** — just receives the Arduino's field frame (angle comes from the TFLite model on the MCU; no register controls).

- **Serial Baud Rate** — 115200 default, also 230400 / 500000 / 9600.

- **SPI Bus Type (SCPI mode only)** — Cable Connection (`:SPI`) vs Header Connection (`:SPI2`); the loop initializes the bus accordingly.

- **Browser-Authorized Ports** — lists previously-permitted ports as `Serial Port · VID 0xXXXX · PID 0xXXXX`.

- **Open Serial Port** — triggers Chrome's device picker (lists all serial devices, nothing filtered).

- **✕ close button** — dismisses the dialog.

- *If something fails, a red error box appears inside the modal with an explanatory hint (e.g. port already held by another program, browser not supporting Web Serial).*

## Tabs (top of demo area): Thumbstick with twist · Thumbstick

*Only the active tab animates.*

### 1. Thumbstick tab

- **3D stick** — moves with X/Y position (X/20, Y/20), clamped to its max radius, with a 3D tilt effect.

- **28-LED ring** — outer LEDs; the one closest to the vector angle lights bright with dimmer neighbors on either side. Off when the stick is centered.

- **Polar radar** — Voxdale-style field-vector scope under the stick: dark reticle with 25% rings and compass labels (`0° (+X)`, `90° (+Y)`, `180° (-X)`, `270° (-Y)`), plus a teal measured vector with a glowing head. The radar XY is computed by the **angular formula (plain atan2 without calibration) applied to the averaged 4-pixel XYZ**; at rest the field is straight up, so the resting vector sits at the origin and grows in the direction of tilt. Readout line: **Azimuth: 0.0° | Range: 0.0%**, with `Azimuth = atan2(y, x)`.

### 2. Thumbstick with twist tab

- **Magnet disk** (half red **N** / half blue **S**) — rides a **fixed ±2.5 mm 1 mm-pitch grid** laid out like the sensor die. It positions with X/Y and spins with the twist angle. A rightward physical rotation shows as clockwise on screen.

    - The grid never rescales, so a pure rotation doesn't jump the disk.

    - Position/angle are lightly smoothed (EMA) to damp tremor + model fuzz.

- **Zero Position button** — captures current raw X/Y as the reference; the disk recentres there.

- **Motion mode selector** — `XY + Twist` (default), `XY only` or `Twist only`. `XY only` keeps the disk tracking position and holds the twist angle where it was; `Twist only` stops the disk translating so it only spins, for a clean twist demo. Replaces the old `Lock XY (twist only)` checkbox. The smoother keeps tracking behind the scenes, so switching modes never snaps.

- **Signal & Calibration button** — toggles the twist panel below the grid.

**Twist panel (when opened):**

- **Mode selector**: 1px mode (single pixel · mT) — angles from pixel 0 fields; 2px mode (differential · mT/mm) — angles from gradient pairs between pixels.

- **Readouts (6 boxes)**: `Alpha (calibrated)` / `Beta (calibrated)` (post-calibration angles), `Alpha (raw)` / `Beta (raw)` (pure atan2), and `Alpha Strength` / `Beta Strength` (field magnitude, in mT or mT/mm).

**Gain & Calibration Config card** *(always visible in every motion mode so GAINSEL and the k/o constants stay reachable while tuning; per reviewer slide 4 the k/o formula itself applies to the no-twist XY demo, while twist calibration is covered by Zero Position.)*

- **GAINSEL field** — 0–63 electrical gain register; the hint shows the 6-bit value (starts at 0 = `0b000000`). Over SCPI the change is written to the chip (unlock + readback verify) and confirmed in the "Device confirmed" line; without hardware it stays local. Switching 1px↔2px mode restores each mode's default (0 / 0) on the device; starting the demo re-reads the chip and adopts whatever it actually holds.

- **Calibration constants k1 k2 o11 o12 o21 o22** — edited live; every keystroke updates the calibrated readouts using the published Desmos cross-axis formula. Defaults are all zero (`k1=k2=0, o=0`); with non-negative Z this matches the raw atan2 exactly, so nothing is "hidden". The live engine is initialised from these fields on load, so display and math always agree.