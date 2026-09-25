/* Shared serial plumbing for the suite: who owns the board, and how to let go of
 * it without resetting it.
 *
 * ---- One board, many tabs ----
 *
 * Every page here reconnects to an already authorised board on load. Open two of
 * them and the second open takes the port from the first, which is then told
 * "The device has been lost" on its next read — an error that reads like a
 * hardware fault and is not one. What follows is worse: the page blames the
 * wiring, and the search goes to the sensor.
 *
 * So tabs tell each other. A page holding the port answers when another asks,
 * and a page reconnecting by itself stands down instead of taking it. Standing
 * down is the only option either way: measured in Chrome, a second open fails
 * with "Failed to open serial port" rather than taking the board, so the other
 * tab has to let go first. reason() turns that bare failure into what to do
 * about it.
 *
 * The terminal and the sensor pages share the channel, so it does not matter
 * which of them holds the board.
 */
(function () {
  "use strict";

  const CHANNEL = "melexisio.port-claim";
  // Long enough for a holder to answer, short enough not to delay a real connect.
  const REPLY_WAIT_MS = 150;

  function inertClaim() {
    return {
      announce() {},
      release() {},
      heldElsewhere() { return Promise.resolve(false); },
      reason(error) { return Promise.resolve(messageOf(error)); },
    };
  }

  function messageOf(error) {
    return error && error.message ? error.message : String(error);
  }

  function sharedClaim() {
    const channel = new BroadcastChannel(CHANNEL);
    let holding = false;

    channel.addEventListener("message", (event) => {
      // Somebody asking whether the port is taken; only a holder answers.
      if (event.data === "who-holds" && holding) channel.postMessage("holding");
    });

    // A tab that goes away without disconnecting still frees the board.
    window.addEventListener("pagehide", () => {
      if (!holding) return;
      holding = false;
      channel.postMessage("released");
    });

    const claim = {
      announce() {
        holding = true;
        channel.postMessage("holding");
      },

      release() {
        holding = false;
        channel.postMessage("released");
      },

      /* A refused open says nothing about why, and a lost device says something
         that is not true. Both have an answer the reader can act on. */
      async reason(error) {
        const message = messageOf(error);
        /* Chrome's handle to a board can go bad on its own — after a tab fight,
           or a run of quick open/close cycles. The OS still lists the device and
           it still answers from a shell; only the browser cannot reach it, and
           only a replug clears that. */
        if (/device has been lost|network ?error/i.test(message)) {
          return "the browser has lost its handle to this board — unplug the USB cable "
            + "and plug it back in; the board itself is fine";
        }
        if (!/failed to open|access denied|busy|in use/i.test(message)) return message;
        return (await claim.heldElsewhere())
          ? "another tab has this board open — disconnect there first"
          : message;
      },

      heldElsewhere() {
        return new Promise((resolve) => {
          let answered = false;
          const onReply = (event) => {
            if (event.data !== "holding") return;
            answered = true;
            channel.removeEventListener("message", onReply);
            resolve(true);
          };
          channel.addEventListener("message", onReply);
          channel.postMessage("who-holds");
          setTimeout(() => {
            channel.removeEventListener("message", onReply);
            if (!answered) resolve(false);
          }, REPLY_WAIT_MS);
        });
      },
    };

    return claim;
  }

  /* ---- Letting go of the board ----
   *
   * The Melexis IO board reads DTR as "something is attached": asserted turns
   * its LED green, released turns it red, and nothing else about its behaviour
   * changes. RTS it ignores, and its USB CDC accepts any line coding. So here
   * this is what makes the LED go red when a page disconnects, instead of
   * leaving it green until the browser gets round to dropping the line.
   *
   * The order matters elsewhere. On a devkit where DTR and RTS drive EN and
   * GPIO0 through the auto-reset transistors, RTS asserted while DTR is
   * released holds EN low, so dropping DTR on its own resets the part.
   * MIPTerminal learned that the expensive way (mip/mip.py) and drops RTS
   * first; a browser drops both at close in an order of its own, so the pages
   * settle it themselves beforehand.
   */
  async function lowerSignals(port) {
    if (!port || typeof port.setSignals !== "function") return;
    try {
      await port.setSignals({ requestToSend: false });
      await port.setSignals({ dataTerminalReady: false });
    } catch {
      /* Not every platform allows it, and a port already gone refuses; the
         close that follows is what actually matters. */
    }
  }

  /* Which device is this, in words. Chrome's picker lists every USB CDC port on
     the machine, and an ST-Link exposes one that looks just like the board; a
     page that names what it opened turns a silent session into an obvious
     mis-pick. */
  const KNOWN = {
    "03e9:0041": "Melexis IO",
    "0483:374e": "ST-Link virtual port",
  };

  function describe(port) {
    const info = port && typeof port.getInfo === "function" ? port.getInfo() : {};
    if (!Number.isInteger(info.usbVendorId)) return "serial device";
    const id = `${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
    return KNOWN[id] ? `${KNOWN[id]} (${id})` : id;
  }

  /* ---- How to open the port ----
   *
   * Detect is where a session starts and where the line is chosen, so it hands
   * the choice on: the chip pages take it from the link, fall back to whatever
   * was last used, and only then to the CDC default. It matters solely on the
   * ST-Link path, where the settings reach a real UART — but that is exactly
   * the path where a page opening 115200 8N1 of its own accord hears nothing.
   */
  const LINE_KEY = "melexisio.line";
  /* 115200 8N1 suits everything this suite meets — an ESP32 wants exactly that,
     and the board's CDC ignores line coding altogether — with one exception:
     an ST-Link bridges to a UART running 7O2. So the device decides, and the
     table only has to carry what differs. */
  const DEFAULT_LINE = "115200,8,none,1";
  const LINE_BY_DEVICE = {
    "0483:374e": { line: "115200,7,odd,2", why: "an ST-Link's UART needs 7O2" },
  };

  function parseLine(value) {
    const [baud, bits, parity, stop] = String(value ?? "").split(",");
    const options = {
      baudRate: parseInt(baud, 10),
      dataBits: parseInt(bits, 10),
      parity,
      stopBits: parseInt(stop, 10),
    };
    const sane = Number.isInteger(options.baudRate)
      && [7, 8].includes(options.dataBits)
      && ["none", "odd", "even"].includes(options.parity)
      && [1, 2].includes(options.stopBits);
    return sane ? options : null;
  }

  function rememberLine(value) {
    try { localStorage.setItem(LINE_KEY, value); } catch { /* storage unavailable */ }
  }

  function deviceId(port) {
    const info = port && typeof port.getInfo === "function" ? port.getInfo() : {};
    if (!Number.isInteger(info.usbVendorId)) return null;
    return `${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  }

  // What this device needs, when it needs anything in particular.
  const lineFor = (port) => LINE_BY_DEVICE[deviceId(port)] ?? null;

  /* A page asks for a link's settings first, then what the device itself needs,
     then what was last used, and only then the default. */
  function lineOptions(port) {
    const handedOver = new URLSearchParams(location.hash.replace(/^#/, "")).get("line");
    let remembered = null;
    try { remembered = localStorage.getItem(LINE_KEY); } catch { /* storage unavailable */ }
    return parseLine(handedOver)
      ?? parseLine(lineFor(port)?.line)
      ?? parseLine(remembered)
      ?? parseLine(DEFAULT_LINE);
  }

  const describeLine = (options) =>
    `${options.baudRate} ${options.dataBits}${options.parity[0].toUpperCase()}${options.stopBits}`;

  window.melexisSerial = {
    describe,
    lineFor,
    lineOptions,
    rememberLine,
    describeLine,
    claim: typeof BroadcastChannel === "function" ? sharedClaim() : inertClaim(),
    lowerSignals,
  };
})();
