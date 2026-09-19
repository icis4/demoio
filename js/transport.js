/* ============================================================
   Transports — Web Serial and Web Bluetooth behind one interface
   ============================================================

   The board is reached over USB CDC or, on an ESP32, over a Nordic UART
   Service. Everything above this file works in terms of bytes in and bytes
   out, so it does not care which.

   A transport exposes:
     kind          'serial' | 'ble'
     label         what to show once open
     open(opts)    pick a device and connect; rejects if the user cancels
     close()       tear down
     write(bytes)  Uint8Array out
     read(onChunk) start delivering Uint8Array in; resolves when reading stops
     stopReading() make read() resolve
     isOpen()
*/

window.MelexisTransport = (() => {
  'use strict';

  /* The de-facto standard Nordic UART Service. Lower case: Web Bluetooth
     rejects upper-case UUIDs. */
  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_RX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // browser -> board
  const NUS_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // board -> browser

  /* Web Bluetooth does not expose the negotiated ATT MTU, and a write longer
     than it fails rather than splitting. 20 bytes is what the 23-byte default
     MTU leaves after the ATT header, so it always fits. */
  const BLE_CHUNK = 20;

  const serialAvailable = () => 'serial' in navigator;
  const bleAvailable = () => 'bluetooth' in navigator;

  // ============================================================
  //  Web Serial
  // ============================================================

  const PORT_KEY = 'melexisio.port';

  function rememberPort(port) {
    const info = port && port.getInfo ? port.getInfo() : {};
    if (!Number.isInteger(info.usbVendorId) || !Number.isInteger(info.usbProductId)) return;
    try {
      window.localStorage.setItem(PORT_KEY, `${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}`);
    } catch { /* storage unavailable */ }
  }

  /* The picker exists to grant permission, not to use it: a board already
     authorised for this origin comes back from getPorts() silently. */
  async function authorisedPort() {
    if (!serialAvailable()) return null;
    let ports;
    try {
      ports = await navigator.serial.getPorts();
    } catch {
      return null;
    }
    if (ports.length === 0) return null;
    if (ports.length === 1) return ports[0];

    let vid = NaN, pid = NaN;
    try {
      const saved = (window.localStorage.getItem(PORT_KEY) || '').split(':');
      vid = parseInt(saved[0], 16);
      pid = parseInt(saved[1], 16);
    } catch { /* storage unavailable */ }
    if (!Number.isInteger(vid)) return null;   // several boards, no hint: let the user choose

    const matches = ports.filter((port) => {
      const info = port.getInfo();
      return info.usbVendorId === vid && info.usbProductId === pid;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function createSerialTransport() {
    let port = null;
    let reader = null;
    let reading = false;
    let label = '';

    return {
      kind: 'serial',
      get label() { return label; },
      isOpen: () => Boolean(port && port.readable),

      async open(options) {
        if (!serialAvailable()) {
          throw new Error('Web Serial API is not available. Make sure you are using Chrome/Edge/Opera and accessing the page via localhost or HTTPS.');
        }
        port = await authorisedPort() || await navigator.serial.requestPort();
        await port.open(options);
        rememberPort(port);
        label = `${options.baudRate} baud (${options.dataBits}${options.parity[0].toUpperCase()}${options.stopBits})`;
      },

      async read(onChunk, onError) {
        if (!port || !port.readable) return;
        reading = true;

        while (reading && port && port.readable) {
          const active = port.readable.getReader();
          reader = active;
          try {
            for (;;) {
              const { value, done } = await active.read();
              if (done) break;
              if (value && value.length > 0) onChunk(value);
            }
          } catch (err) {
            if (reading && onError) onError(err);
          } finally {
            active.releaseLock();
            if (reader === active) reader = null;
          }
        }
      },

      async stopReading() {
        reading = false;
        /* Cancelling wakes the pending read(); the loop owns the lock and
           releases it, so the caller waits for the loop before closing. */
        if (reader) {
          try { await reader.cancel(); } catch { /* already errored */ }
        }
      },

      async write(bytes) {
        if (!port || !port.writable) throw new Error('Serial port is not writable.');
        const writer = port.writable.getWriter();
        try {
          await writer.write(bytes);
        } finally {
          writer.releaseLock();
        }
      },

      async close() {
        const open = port;
        port = null;
        reader = null;
        if (open) await open.close();
      },
    };
  }

  // ============================================================
  //  Web Bluetooth — Nordic UART Service
  // ============================================================

  function createBleTransport() {
    let device = null;
    let rxChar = null;   // written by the browser
    let txChar = null;   // notified by the board
    let label = '';
    let stop = null;     // resolves the read() promise

    return {
      kind: 'ble',
      get label() { return label; },
      isOpen: () => Boolean(device && device.gatt && device.gatt.connected),

      async open() {
        if (!bleAvailable()) {
          throw new Error('Web Bluetooth is not available. Use Chrome/Edge over HTTPS or localhost, with Bluetooth switched on.');
        }

        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [NUS_SERVICE] }],
          optionalServices: [NUS_SERVICE],
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(NUS_SERVICE);
        rxChar = await service.getCharacteristic(NUS_RX);
        txChar = await service.getCharacteristic(NUS_TX);
        label = device.name || 'BLE device';
      },

      async read(onChunk, onError) {
        if (!txChar) return;

        const handler = (event) => {
          const v = event.target.value;
          if (v && v.byteLength > 0) {
            onChunk(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
          }
        };

        txChar.addEventListener('characteristicvaluechanged', handler);
        await txChar.startNotifications();

        /* Nothing to poll: notifications arrive as events, so this promise
           just holds the caller until the link is torn down. */
        await new Promise((resolve) => {
          stop = resolve;
          const gone = () => {
            if (onError) onError(new Error('Bluetooth device disconnected.'));
            resolve();
          };
          device.addEventListener('gattserverdisconnected', gone, { once: true });
        });

        txChar.removeEventListener('characteristicvaluechanged', handler);
      },

      async stopReading() {
        if (stop) {
          stop();
          stop = null;
        }
      },

      async write(bytes) {
        if (!rxChar) throw new Error('Bluetooth device is not connected.');
        for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
          const chunk = bytes.subarray(i, i + BLE_CHUNK);
          /* Without a response the board cannot apply back-pressure, but the
             console is line-based and the writes are short. */
          await rxChar.writeValueWithoutResponse(chunk);
        }
      },

      async close() {
        const open = device;
        device = null;
        rxChar = null;
        txChar = null;
        if (open && open.gatt && open.gatt.connected) open.gatt.disconnect();
      },
    };
  }

  return {
    NUS_SERVICE,
    serialAvailable,
    bleAvailable,
    authorisedPort,
    createSerialTransport,
    createBleTransport,
  };
})();
