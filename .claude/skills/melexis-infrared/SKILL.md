---
name: melexis-infrared
description: Building the Infrared section of the suite — an index page plus one subpage per sensor chip (MLX90632 thermometer, MLX90640/90641/90642 thermal arrays), all talking I2C through the Melexis IO board. Load when creating or changing any infrared page, porting sensor calibration maths to JavaScript, or choosing I2C transaction shapes for a new chip.
---

# Infrared sensor pages

Everything infrared lives under `fir/` (far infrared): `fir/index.html` serves the section
at `/fir/`, plus one subpage per chip, following the pattern the suite already uses — a tile on the frontpage,
a Home link back, the shared theme, no build step.

Because the pages sit one level down, shared assets are reached as `../favicon.svg`,
`../theme.css`, `../manifest.webmanifest` and `../index.html`, and the service worker is
registered as `../service-worker.js`. Its scope stays the site root, which is allowed
because the script itself lives there — a worker can never claim a scope broader than its
own directory.

Every chip speaks **I2C through the Melexis IO board**, which is driven over SCPI on USB
CDC. Read `.claude/skills/melexis-scpi/SKILL.md` first — framing, prompt parsing and the
LF-only rule all apply here unchanged. This skill covers only what sits on top.

## Sources

Under `~/projects/infrared/`, all Apache-2.0:

| | `mlx90632-` | `mlx90640-` | `mlx90641-` | `mlx90642-` |
|---|---|---|---|---|
| what it is | single-zone | 32×24 (768 px) | 16×12 (192 px) | 32×24 (768 px) |
| source language | C | C | **C++** | C |
| calibration maths | in the host | in the host | in the host | **on the chip** |
| EEPROM | `0x2480…` | 832 w @ `0x2400` | 832 w @ `0x2400` **+ Hamming** | none to read |
| frame read | a few registers | 834 w @ `0x0400` | 6 × 32 w @ `0x0400` | 768 w @ `0x342C` |
| page shape | readout + chart | false-colour image | false-colour image | false-colour image |

Melexis application notes for these chips are distilled under `references/`:
`mlx90632-application-notes.md` (measurement modes, refresh rate) and
`ir-design-application-notes.md` (the shared thermal/mechanical note, plus which notes exist
per chip — the 90640 and 90642 have none).

`mlx90632-example` is a reference STM32 port of the 90632 library (Nucleo-F070RB /
F4Discovery, CubeMX). Its `Src/main.c` is the most useful file in the whole set: it
implements the `mlx90632_depends.h` layer and calls the library in the correct order. Read
it before porting anything. `Library/` there is an uninitialised git submodule pointing at
`mlx90632-library` — ignore it, read the library directly.

Ported maths must keep the Apache-2.0 copyright notice and name the upstream library; the
repo is public.

## The I2C transport

The board's I2C commands are in `melexis_io_fw/Application/commands_i2c/commands_i2c.c`.
The two that matter:

```
:I2C:MemReaD  <dev>,<mem>,<memAddSize>,<count>            -> aa,bb,cc,…
:I2C:MemWRite <dev>,<mem>,<memAddSize>,<data>[,<data>…]
```

- `<dev>` is the **7-bit** address; the firmware shifts it (`DevAddress <<= 1`). Pass
  `0x3A` / `0x33` directly, exactly as `pressure/mlx90835.html` passes `0x33` for its own sensor.
  The reference port does the same shift by hand: `#define CHIP_ADDRESS 0x3a << 1`.
- `<memAddSize>` is `2` for all four chips — 16-bit register addresses.
- The reply is **comma-separated lowercase hex bytes**, no `0x`, then the usual `\n(OK)>`
  prompt. A failed transfer returns a non-OK status instead of data.

**Transaction size: up to 2048 bytes.** The `.help` strings and `doc/SCPI_commands_i2c.md`
still say `1-256`; that is stale — the limit was raised and the docs were not updated. The
code bounds `Read_Size` by `sizeof(buffer)`, and `buffer` is `uint8_t buffer[2048]`
(`commands_i2c.c:137`). Trust the code, and do not "fix" a page back down to 256.

This matters: a whole 90640 EEPROM (1664 bytes) or a whole frame (1668 bytes) fits in
**one** transaction instead of seven.

`:I2C:WaitMask <dev>,<addr>,<mask>,<timeout_ms>,<step_us>` polls a 16-bit register on the
board until the mask is non-zero. Use it for data-ready instead of polling from
JavaScript — one command replaces a round trip per poll, with a microsecond step.
`:I2C:WaitNotMask`, `:I2C:WaitValue` and `:I2C:WaitNotValue` are the variants.

`:I2C:INIT` before anything, `:I2C:FREQuency` to raise the bus clock (`400k`, `1000k`).
The array sensors need the faster bus to be usable at all.

## Byte and word order — the easiest thing to get wrong

Within a 16-bit register the bytes are **MSB first**:

```c
*value = data[1] | (data[0] << 8);
```

But a 32-bit constant spanning two consecutive registers is assembled with the **words
swapped** — the first register holds the *low* half:

```c
*value = data[2]<<24 | data[3]<<16 | data[0]<<8 | data[1];
```

So bytes are big-endian inside a register, words are little-endian across registers. Both
lines are from `mlx90632-example/Src/main.c`. Read such a constant as one 4-byte
`:I2C:MemReaD`, then reassemble in that order — reading it as a plain big-endian 32-bit
value gives a plausible-looking but wrong calibration constant, and the temperature is then
quietly off rather than obviously broken.

## MLX90632 — single-zone thermometer

The port layer is two functions (`mlx90632_depends.h`): read and write **one 16-bit
register**, mapping to `:I2C:MemReaD 0x3A,<reg>,2,2` and
`:I2C:MemWRite 0x3A,<reg>,2,<hi>,<lo>`. The example adds a third, `mlx90632_i2c_read32`,
for the calibration constants.

Order, straight from `main.c`:

1. `mlx90632_init()` — reads `MLX90632_EE_VERSION` (`0x240b`), checks the low byte is DSPv5,
   then clears `NEW_DATA` in `MLX90632_REG_STATUS` (`0x3fff`).
2. Read the calibration constants **once** and keep them. The example's `mlx90632_read_eeprom`
   pulls thirteen: `P_R P_G P_O P_T Ea Eb Fa Fb Ga` as 32-bit, `Gb Ha Hb Ka` as 16-bit.
3. Per measurement: `mlx90632_read_temp_raw()` → ambient and object raw pairs.
4. Then pure maths, no further I2C: `mlx90632_preprocess_temp_ambient()`,
   `mlx90632_preprocess_temp_object()`, `mlx90632_calc_temp_ambient()`,
   `mlx90632_calc_temp_object()`. Emissivity is set separately via
   `mlx90632_set_emissivity()`.

Medical (`MTYP 0x00`) and extended (`0x11`) measurement types have different EEPROM
settings and a different raw-read path — `mlx90632_extended_meas.c` is a separate
translation unit for that reason. Start with medical; add extended only when asked.

`MLX90632_MEAS_MAX_TIME` is 2000 ms at the slowest refresh rate, so a page must not treat a
slow reply as a dead device.

For anything beyond the default continuous-medical loop — picking a measurement mode,
burst/sleeping-step timing, polling `new_data` vs `device_busy`, or changing the refresh rate
in EEPROM — read `references/mlx90632-application-notes.md`. It distils the two Melexis
application notes (measurement modes, changing the refresh rate) and maps their `RAM_n`
naming onto the library's macros.

## MLX90640 — 32×24 array

Its port layer is a **bulk** read, `MLX90640_I2CRead(slaveAddr, startAddress, nWords, data)`,
which maps one-to-one onto `:I2C:MemReaD`.

1. `MLX90640_DumpEE()` — 832 words from `0x2400`, once per session.
2. `MLX90640_ExtractParameters()` → `paramsMLX90640`, holding `alpha[768]`, `offset[768]`,
   `kta[768]`, `kv[768]` plus scalars. Compute once and keep it; recomputing per frame is
   the obvious performance mistake.
3. Per frame: `MLX90640_GetFrameData()` → 834 words. Word 832 is the control register,
   833 the subpage number.
4. `MLX90640_GetTa()` / `MLX90640_GetVdd()`, then `MLX90640_CalculateTo()` with emissivity
   and reflected temperature → 768 floats.
5. `MLX90640_BadPixelsCorrection()` before display.

Status register `0x8000`: bit 3 data-ready, bit 0 subpage. Control register `0x800D`:
refresh rate at bit 7 (3 bits), resolution at bit 10, measurement mode at bit 12.

## MLX90641 — 16×12 array

Same API shape as the 90640 with `MLX90641_` prefixes, but do not assume it is a smaller
copy. Three real differences:

**EEPROM is Hamming-encoded.** `MLX90641_DumpEE()` reads 832 words from `0x2400` and then
runs `HammingDecode()` over them. A port that skips the decode gets silently wrong
calibration. The 90640 has no equivalent step.

**Frames are read in six 32-word chunks** from `0x0400`, `0x0440`, `0x0480`, `0x04C0`,
`0x0500`, `0x0540` — that is the library's own structure, not a transport limit. One
`:I2C:MemReaD` per chunk mirrors it safely; merging them into a single read is possible
given the 2048-byte budget, but verify against the device before assuming the address space
is contiguous.

**The parameter struct differs in shape:** `ksTo[8]` and `ct[8]` against the 90640's `[5]`,
and `offset[2][192]` — two offset sets rather than one. `MLX90641_BadPixelsCorrection()`
also takes a single pixel rather than an array.

The source is C++, so it is a translation rather than a transcription when porting to JS.

The first frames after power-on carry a thermal transient and miss the temporal filter's
previous frame; Melexis says to skip the first and use the 4th and 5th. See
`references/mlx90641-start-up.md`, which also covers duty-cycling the part by switching VDD.

## Throughput is the design constraint for the arrays

A 90640 frame is 1668 bytes and a 90642 image 1536, which the board returns as
comma-separated hex — roughly **5 KB of text per frame** over USB CDC, plus the I2C
transfer itself. That, not the maths,
sets the achievable frame rate. Before building the UI:

- Raise the bus clock (`:I2C:FREQuency 1000k`); at 100 kHz a single frame read alone takes
  well over 100 ms.
- Do not chase the sensor's top refresh rates. Pick a rate the link sustains and have the
  page state what it is.
- Parse the hex reply without allocating per byte; the terminal's own per-byte rendering
  bug (`app.js`, since fixed) is the cautionary tale.
- Retry a failed bulk read once before giving up. A frame is over a kilobyte of hex, and a
  single transfer that glitches otherwise ends the stream with an error when repeating it
  would have worked. Nothing is written, so a second attempt cannot disturb the sensor — but
  do not extend the retry to the data-ready wait, which is meant to time out.
- Measure before optimising the maths. `CalculateTo` over 768 pixels is cheap next to the
  transfer.

**Subpages are not optional** on the 90640 and 90641 (the 90642 has no subpages). Each frame carries only half the pixels —
chess pattern by default, interleaved via `SetInterleavedMode()`. A page that renders every
frame straight to the canvas shows a visibly flickering checkerboard. Accumulate two
consecutive subpages into one image buffer, and use `GetSubPageNumber()` rather than
assuming they alternate.

## MLX90642 — 32×24 array that does its own maths

Architecturally the odd one out, and the simplest to build a page for: **it computes
temperatures on the chip**. There is no `ExtractParameters`, no `CalculateTo`, no EEPROM
calibration dump — `MLX90642_GetImage()` is a single bulk read of 768 already-computed
values from `MLX90642_TO_DATA_ADDRESS` (`0x342C`), 1536 bytes, one transaction. Nothing to
port to JavaScript beyond scaling for display.

`MLX90642_GetFrameData()` additionally pulls 20 aux words from `0x2E02` and the 768 raw IR
values from `0x2E2A`, for when the raw data is wanted alongside the result.

Flags register `0x3C14`: `BUSY` is `0x0001`, `READY` is `0x0100`. Both are a natural fit
for `:I2C:WaitMask` / `:I2C:WaitNotMask` on the board rather than polling from the page.

Configuration is read-modify-write on single words: refresh rate at `0x11F0` (values 2–6 →
2, 4, 8, 16, 32 Hz), emissivity at `0x11F2`, output format and measurement mode in
`0x11F4` (masks `0x0100` and `0x0800`; continuous vs step), I2C settings at `0x11FC`, slave
address at `0x11FE`.

**Configuration is a block write, not a register poke.** Its port layer has four transaction
types, not two (`MLX90642_depends.h`): `MLX90642_I2CRead` for all reads, plus
`MLX90642_Config`, `MLX90642_I2CCmd` and `MLX90642_WakeUp`, and the library never shows what
those three look like on the wire. They are ordinary **writes with a 16-bit memory address**
— the same shape as `:I2C:MemWRite <dev>,<reg>,2,<hi>,<lo>` — addressed to a command
register, and the payload is a **block of six 16-bit words sent in one transaction**,
carrying the frame rate, a flag field and a clock period. The words go out MSB first, so a
little-endian host has to swap each one before sending.

That much is established from a working EVB firmware; the field layout inside the six words
is not, and it is exactly the kind of detail where a wrong bit is silently accepted. Confirm
against the datasheet's communication chapter before writing configuration from a page.
Reads map onto `:I2C:MemReaD` as usual. The part also supports sleep (`GotoSleep` / `WakeUp`
/ `IsDeviceBusy`), which the other chips do not.

## Page conventions

Follow what `pressure/mlx90835.html` already does, since it is the working precedent for driving a
sensor over this board: connect via Web Serial, `:I2C:INIT`, probe for the chip, show a
clear "not present" state when the slave does not ACK, and keep a debug log of the SCPI
exchange.

Each new page goes in `fir/` and needs: a link from `fir/index.html`, a Home link back to
`./`, `../theme.css`, a `./fir/…` entry in the `SHELL` list in `service-worker.js`, and a
row in the README's Layout table. The
`deploy-check` agent covers exactly these.

Prefer one subpage per chip over a single page with a chip selector — the chips share
almost no UI beyond the connection controls, and the arrays need a canvas the thermometer
has no use for.
