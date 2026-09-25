---
name: melexis-scpi
description: Protocol contract between this USB CDC web terminal and the three STM32 firmwares it drives (melexis_io_fw, evb-gen3-fw, mip-firmware) over SCPI. Load when working on serial framing, the command-catalog/help probes, autocomplete, prompt parsing, line endings, or when adding/debugging SCPI commands sent from the terminal.
---

# Melexis SCPI over USB CDC — three firmware targets

The terminal must work against all three. Read this before touching probe or framing code:
they agree on the command syntax but **not** on framing, line endings or catalog discovery.

| | melexis_io_fw | evb-gen3-fw | mip-firmware |
|---|---|---|---|
| path under `~/projects/stm32/` | `melexis_io_fw` | `evb-gen3-fw` | `mip-firmware` |
| USB | `03E9:0041` MELEXISIO | `03E9:0038` EVB-GEN3 | `03E9:A101` PTC-05 CDC RNDIS |
| MCU | STM32F446 | STM32F777 | — |
| terminal core | reference | **byte-identical to io** | own implementation |
| `:SYST:HELP:LIST` | yes | yes | **no** |
| catalog fallback | — | — | `0:/commands.txt` |
| line terminators | LF only | LF only | LF, CR, or `;` |
| empty line | **two** prompts | two prompts | no prompt |
| prompt trailing LF | no | no | **yes** (default) |
| help filtered by login | no | no | **yes** |
| verified on hardware | yes | by identity | **no board yet** |

`evb-gen3-fw/mip-modules/terminal/{terminal,parser}.c` are byte-identical to
`melexis_io_fw/modules/terminal/*` — everything verified on the io board transfers to evb.
mip diverges and is **source-only**: no board has been available to confirm it.

## Shared by all three

Command shape `:ROOT[:SUB...] [<arg>[,<arg>...]]`, case-insensitive. Uppercase letters in a
pattern are the required prefix, lowercase optional: `:SYSTem:INFO` accepts `:SYST:INFO`.
The abbreviation rule is `strip_command` (`parser.c`): **keep uppercase letters, digits,
`:`, `*`, `?`, `_`; drop lowercase**. Each segment independently long or short, so one pattern
expands to several accepted spellings.

`:SYSTem:HELP` exists everywhere and prints `printf("%-32s   %s\n", pattern, help)` — pattern in
its **original mixed case**, padded to 32 columns, then the help text. Group headers print as
`*** NAME ***`, separators as a run of dashes.

Prompt = end-of-response marker: `\n(<status>)>`, `OK` on success, otherwise a HAL/errno string
(`ERROR`, `BUSY`, `TIMEOUT`, `CRC`, `ERR:<n>`). Responses are free-form multi-line text, so the
prompt is the only reliable framing signal.

**No firmware echoes.** The "Local echo" toggle is the only thing making typed commands visible.

**LF is the only terminator safe on all three.** Keep `LF` selected by default in `tools/terminal.html`.

## Per-firmware divergences that bite

**melexis_io_fw / evb-gen3-fw** — `TerminalInput` uses `fgets` and strips only the final `\n`
(`terminal.c:58-70`); the parser never touches `\r`. So `CR+LF` leaves a trailing `\r` glued to
the last argument and the command is rejected; `CR` alone never terminates `fgets` at all.
An empty line emits **two** prompts (`terminal.c:63-68` calls `prompt()` twice).

**mip-firmware** — character-based `fgetc` loop instead. `\n`, `\r` **and `;`** all terminate a
command, so several commands can share a line and CR+LF is harmless (`terminal_rtrim` cleans the
tail). A leading `&` suppresses `;`/`\r` termination. An empty line produces no prompt at all.
Buffer overflow prints `\nToo long!\n`.

Its prompt carries a **trailing `\n`** because `hterm->lf = 1` at init (`terminal.c:50`);
`:SYSTem:LineFeed <bool>` / `:SYSTem:LineFeed?` toggle it. Any prompt matcher must tolerate
trailing whitespace — the app's regex is `/(?:^|\r?\n)\((\w+)\)>\s*$/` for exactly this reason.

mip also gates help output by access level (`ACC_Check` in `PrintCommandsHelp`), so the visible
command set grows after `:USER:HASH?` → `:USER:PASS <16 bytes hex>`. The catalog fetched at
connect reflects the level at that moment; re-probe after logging in.

## Catalog discovery — how the app probes

Implemented in `app.js` as a chain where both catalog sources are **optional** and the help probe
always runs regardless of their outcome:

```
connect()
  └─ :syst:help:list              optional   io / evb
       └─ on failure:
          :FILE:CAT 0:/commands.txt   optional   mip
               └─ always: :syst:help
```

mip has no `:SYST:HELP:LIST`, but `command_index_build()` writes the very same uppercase
permutation list to the RAM volume at boot (`parser.c:139`, `fopen("0:/commands.txt","w")`), and
`:FILE:CAT <[vol:/]filename>` (alias `:FILE:READ`, no credentials required) prints any file.
So all three end up with the same catalog content.

Catalog entries always start with `:` or `*`; anything else is prompt residue or the `outofmem:`
markers mip can write into `commands.txt`, and is filtered out.

Probes are sent with `echo:false, logTx:false` and their output is swallowed rather than
displayed. Each has a 3 s timeout, so a completely silent device now spends 9 s probing before
the terminal settles — only the non-optional help probe reports a timeout to the user.

## Known defect: help panel resolves only ~30% of commands

Left unfixed on purpose — tracked separately. The two sources disagree on spelling and
`findCommandHeader` → `line.startsWith(command)` is case-sensitive. Measured by replaying a real
melexis_io capture through the app's own parsers:

| | |
|---|---|
| datalist entries | 635 |
| resolve to help text | **191 (30%)** |
| show "No saved help found for …" | 444 |

Only all-uppercase patterns (`:I2C:INFO`, `:A0:GPIO`) survive; the 156 help lines carrying
optional lowercase letters — the whole `:SYSTem:*` group, `:EEPROM:STRing`, `:SYSTem:BenchMark` —
all miss. Case-normalising both sides raises it to 330/635; the remaining 305 are abbreviated
spellings with no help line of their own and need mapping onto their canonical long form via the
`strip_command` rule above.

## Observed responses (real melexis_io board)

```
:SYSTem:TIME:MS?\n      -> '347069\n\n(OK)>'
\n                      -> '\n(OK)>\n(OK)>'          (bare LF, two prompts)
:NO:SUCH:COMMAND\n      -> 'Unknown command::NO:SUCH:COMMAND\n\n(ERROR)>'
:SYSTem:TIME:MS?\r\n    -> 'Unknown command::SYSTEM:TIME:MS?\r\n\n(ERROR)>'
```

The last is the CR+LF failure mode on io/evb; on mip the same input would succeed.

## Command reference lives in the firmware repos

Do not restate command sets here — they change there. melexis_io has `doc/SCPI_commands.md` plus
per-module files; evb and mip have no equivalent index, so read the pattern tables directly
(`Application/**/commands_*.c`, the `.pattern` fields). The tables always win over the docs.

## Line settings apply to one target only

Over **USB CDC** the line coding Web Serial asks for — baud rate, data bits, stop bits,
parity, flow control — never reaches the device. The terminal opens at 115200 8N1 and
`pressure/mlx90835.html` at 921600 7O2, and both work identically because neither setting
leaves the host. For the Melexis IO board, which is what this suite is built around, a
serial problem is therefore never a baud problem: look at framing, the LF-only rule, or
the bus instead.

Reached through an **ST-Link** (0483:374e, which exposes a virtual COM port beside the
board's own and is offered in the same picker), the settings are real: that path bridges
to a UART and needs **115200 7O2**, nothing else. The SCPI above it is identical either
way — same commands, same replies, same LF-only framing — so the transport changes what
the port must be opened with and nothing else.

The exception is **mip-firmware, which also exists in a build that talks over a real UART
at 4 Mbit/s**. There the baud rate is the difference between working and silence, so the
terminal keeps the controls — behind an **Advanced** disclosure, since they do nothing for
the CDC boards — and the list of rates has to reach 4000000.

## Bus-level failures

When an exchange is intermittent, hangs, or comes back NACKed, the bus itself is a
suspect before the framing is. `references/robust-i2c.md` distils the Melexis note on
robust I2C for this board: why lowering `:I2C:FREQuency` is a diagnostic step, why a page
reload can leave a slave mid-transaction, and why `:I2C:INIT` cannot free a stuck SDA line
(the firmware has no nine-clock recovery).

## Gotchas when changing terminal code

- Probe responses bypass `displayData`, but their bytes still count toward the RX stat.
- `:SYSTem:DFU 42` (io) reboots into the bootloader — the port disappears mid-session.
  `*RST` prints `\n*RESET*\n(OK)>` then resets.
- Long-running commands (`:SYSTem:BenchMark`, `:SYSTem:TIME:MSSleep 30000`) produce no output
  until they finish; do not treat silence as a dropped connection.
- The firmware repos are read-only from here — they are separate projects.
