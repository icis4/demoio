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

## Tabs (top of demo area): Thumbstick · Thumbstick with twist

*Only the active tab animates.*

### 1. Thumbstick tab

- **3D stick** — moves with X/Y position (X/20, Y/20), clamped to its max radius, with a 3D tilt effect.

- **28-LED ring** — outer LEDs; the one closest to the vector angle lights bright with dimmer neighbors on either side. Off when the stick is centered.

- **Radar scope** — polar display under the stick: a trail of the last 40 positions, a gradient line from center to the current spot, a glowing dot when off-center, range rings, and compass labels. Readout line: **Azimuth: 0.0° | Range: 0.0%**.

### 2. Thumbstick with twist tab

- **Magnet disk** (half blue **N** / half red **S**) — rides a **fixed ±2.5 mm 1 mm-pitch grid** laid out like the sensor die. It positions with X/Y and spins with the twist angle. A rightward physical rotation shows as clockwise on screen.

    - The grid never rescales, so a pure rotation doesn't jump the disk.

    - Position/angle are lightly smoothed (EMA) to damp tremor + model fuzz.

- **Zero Position button** — captures current raw X/Y as the reference; the disk recentres there.

- **Lock XY (twist only) checkbox** — disk stops translating and only spins — for a clean twist demo. Toggling off never snaps, since the smoother keeps tracking.

- **Signal & Calibration button** — toggles the twist panel below the grid.

**Twist panel (when opened):**

- **Mode selector**: 1px mode (single pixel · mT) — angles from pixel 0 fields; 2px mode (differential · mT/mm) — angles from gradient pairs between pixels.

- **Readouts (6 boxes)**: `Alpha (calibrated)` / `Beta (calibrated)` (post-calibration angles), `Alpha (raw)` / `Beta (raw)` (pure atan2), and `Alpha Strength` / `Beta Strength` (field magnitude, in mT or mT/mm).

**Gain & Calibration Config card** *(always visible below the grid — it is not part of the twist panel)*

- **GAINSEL field** — 0–63 electrical gain register; the hint shows the 6-bit value (1px default 37 = `0b100101` → ~219). Changing it only updates the hint.

- **Calibration constants k1 k2 o11 o12 o21 o22** — edited live; every keystroke updates the calibrated readouts using the published Desmos cross-axis formula. Defaults `k1=k2=1, o=0` are an exact no-op: calibrated = raw, so nothing is "hidden".