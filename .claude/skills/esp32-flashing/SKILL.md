---
name: esp32-flashing
description: How ESP32 boards with native USB Serial/JTAG are reset and flashed, why the buttons are sometimes unavoidable, and how to recover one that stopped enumerating. Load when working on tools/espupdate.html, when helping someone flash a board, or when a board has gone quiet after a failed write.
---

# Flashing an ESP32 over its own USB

`tools/espupdate.html` drives esptool-js, which carries Espressif's reset
sequences. This is about what those sequences can and cannot do, because the
failure modes look like dead hardware and are not.

## RTS does not reset these boards

On a C3, C6, S3 or S2 whose USB-C goes straight to the SoC — no CP2102, no
CH340 — the reset line esptool pulses is not wired the way it is on a devkit.

From the command line, `esptool --after hard-reset` prints

```
Hard resetting via RTS pin...
```

**and the board does not restart.** It prints on success and on nothing alike.
The way to tell is the USB device number: `lsusb` before and after, and if
`Bus 001 Device 059` is still `059`, nothing happened.

What works from the command line is `--before usb-reset`, which goes through
the USB Serial/JTAG peripheral rather than a modem control line.

Never use `--before no-reset` unless the chip is already known to be sitting in
the ROM downloader. Against a running board it fails with `Write timeout` or
`No more data to read from the serial port` — and see below for what an
interrupted write leaves behind.

The page does not have this problem for writing, because esptool-js resets into
download mode itself. It does have it for *starting the application again*,
which is why `resetBoard()` pulses RTS by hand rather than calling the
library's hard reset: that one only ever releases the line.

## A board that stopped enumerating is not dead

An interrupted write leaves a half-written application. The bootloader then
finds it, refuses it, and resets:

```
E esp_image: Checksum failed. Calculated 0x9f read 0xf5
E boot: Factory app partition is not bootable
E boot: No bootable app partitions in the partition table
```

That loop restarts the USB peripheral faster than the host can finish
enumerating it, so the board stops appearing at all — no port, nothing in
`lsusb`. The kernel log is where the truth is:

```
usb 1-2.2: device descriptor read/64, error -110
usb 1-2.2: device not accepting address 78, error -62
usb 1-2-port2: unable to enumerate USB device
```

The device is there and trying. Recovery, in order:

1. **Hold BOOT, tap RESET, release BOOT.** The ROM downloader holds USB steady
   because no application is running to restart it. On a XIAO with no reset
   button, hold BOOT while plugging the cable in.
2. **Plug into the machine rather than a hub.** A marginal enumeration that
   fails behind a dock succeeds directly.
3. Then write with `--before usb-reset`, or connect from the page.

The ROM bootloader is in silicon. A board cannot be bricked this way, however
dead it looks.

## Things that are not the cause

**A sensor on the I2C connector.** On an S3 the USB pins are GPIO19 and GPIO20
and the strapping pins are GPIO0, GPIO3, GPIO45 and GPIO46. A STEMMA QT device
on GPIO41/GPIO40 shares none of them and cannot affect enumeration.

**The image being for the wrong chip.** That fails differently: it writes
cleanly, the MD5 matches, and the board then will not boot. `imageChip()` in
the page catches it before the write, reading the chip id from the image header
at offset 12 — at `0x0` on a C3, C6 or S3, and at `0x1000` on an ESP32 or S2,
which is why `HEADER_OFFSETS` has both. A reader that only looks at `0x0`
silently accepts any S2 image, which is the one case where two boards in the
same family are easiest to confuse.

## Boards that need a button and boards that do not

A board running an application that keeps the USB Serial/JTAG peripheral up can
usually be reset into download mode by the host. A board running something that
presents its own CDC — Adafruit's CircuitPython, for instance, at `239a:8143`
rather than `303a:1001` — often cannot: the command-line esptool gets
`Could not configure port: (5, 'Input/output error')` and the buttons are the
only way in. esptool-js in the browser is more successful here than esptool
from a shell, so trying the page first is worth it before reaching for BOOT.

`303a:1001` is the USB Serial/JTAG identity of the **ROM** as much as of a
running firmware, so seeing it says a board is attached and nothing about what
is on it. A board at that pair that answers nothing on the terminal is in its
bootloader, not broken.
