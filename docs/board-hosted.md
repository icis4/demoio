# Serving the tool pages from the board

Status: the browser half is in place, the firmware half is not. This is the contract between
them, written down before either side guesses at the other.

## Why the pages have to come from the board

The obvious arrangement — pages on the tool site, board on the local network — does not work and
cannot be made to work. A page served over `https://` may not open `http://` or `ws://` to a
private address: that is mixed content, and the browser refuses it outright. There is no warning
to dismiss and no flag to set. Chrome additionally asks for permission before a public page may
touch the local network at all.

Served **by the board**, every one of those rules falls away, because the page and the socket are
then one origin. So the board serves the pages, and the pages talk back to the board they came
from. `melexisSerial.webSocketUrl()` builds the address from `location` for exactly this reason:
there is nothing for anyone to type, and nothing that could point somewhere else.

The board already registers an mDNS name — `mdns_hostname_set(pinmap_model())` in
`tcp_console.c` — so the address is `http://<model>.local/`.

## The socket

| | |
|---|---|
| Path | `/ws` |
| Frames | text; a binary frame is accepted too |
| Payload | the console's own bytes, nothing added |
| Commands | one per frame, terminated with `\n` |
| Replies | free-running, ending in the `(OK)>` / `(ERROR)>` prompt |

This is the console that already listens on TCP 2001, with a WebSocket in front of it rather than
a new protocol. The pages parse the prompt themselves and need no framing of their own; anything
that wraps replies in JSON would have to be unwrapped again by every page.

Text frames are the default because the console is line-based ASCII and a firmware handler can
then read the payload as a string. A server that answers in binary is answering correctly too,
and the browser side accepts both.

## What the browser side provides

`js/serial-port.js` hands back the same shape for all three transports — a `write` and a `close` —
so a page gains the network without learning a third set of rules:

```js
state.link = await window.melexisSerial.connectWebSocket({
  onData: (bytes) => { /* same handler as serial and BLE */ },
  onDisconnect: () => { /* the board went away */ },
});
```

* `connectWebSocket({ url, onData, onDisconnect, binary })` — `url` defaults to the page's own host.
* `webSocketUrl(path = "/ws")` — `wss:` when the page is `https:`, `ws:` otherwise.
* `servedByBoard()` — true when the page came from a board rather than from the tool site or a
  development server. A page that is on the board should connect to it, not offer a port picker.

## Serving the page for the chip that is fitted

The useful behaviour is for `/` to land on the page for whatever is on the connector, so a board
with an MLX90614 opens the MLX90614 page and nobody has to know which it is.

The probe is the one in `fir/detect.html`: scan the bus, then test every answering address
against all four signatures, since both the 90632 and the 90642 can be re-addressed. The page
names and the signatures live at the top of that file and are the reference — copying the table
here would only let the two drift apart. The result is a redirect:

```
/            → /fir/mlx90614.html#addr=0x5A
/fir/...     → the pages themselves
/ws          → the console
```

The address belongs in the fragment: the sensor pages read `#addr=0x…`, so a re-addressed part
opens correctly instead of falling back to the compiled-in default.

If nothing answers, `/` should land on `fir/detect.html`, which says so properly and lets someone
scan again after fixing the wiring.

## Two things to plan for

**The pages pull Bootstrap and Lato from a CDN.** A board on a network with no route to the
internet will serve them unstyled. Serving them from the board means vendoring both, the way
`js/vendor/esptool-js-0.7.0.js` is vendored.

**Flash.** The images are already about 1.3 MB.

## What stays on the cable

`tools/espupdate.html` writes the flash the pages are served from, so it has no business running
over the board's own network. It stays on USB.
