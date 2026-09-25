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
      reason(error) { return Promise.resolve(describe(error)); },
    };
  }

  function describe(error) {
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

      /* A refused open says nothing about why. When another tab holds the board,
         that is the why, and it is the one the reader can act on. */
      async reason(error) {
        const message = describe(error);
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

  window.melexisSerial = {
    claim: typeof BroadcastChannel === "function" ? sharedClaim() : inertClaim(),
    lowerSignals,
  };
})();
