/**
 * mlx_api.js
 * Complete MLX90396 API - SCPI Tunneling Version with BAA Gain Controls
 */
export class MLX90396_API {
    
  static Mlx90396Command = {
      RT: 0xF0,       // Reset
      HS: 0xE0,       // Memory Store
      HR: 0xD0,       // Memory Recall
      EX: 0x80,       // Exit Mode
      RR: 0x50,       // Read Register
      WR: 0x60,       // Write Register
      SB: 0x10,       // Start Burst
      SWOC: 0x20,     // Start WOC
      SM: 0x30,       // Start Single Measurement
      RM_NO_TEMP: 0x40, // Read Measurement (No Temp)
      // Datasheet table 27 encodes the temperature request at bit 3
      // (0b0100 T000 = 0x48), but the hardware-verified reference implementation
      // drives bit 0 (0x41) and that is what works on the bench. Only 0x41 is
      // confirmed here - verify on the part before relying on temperature.
      RM_TEMP: 0x41   // Read Measurement (With Temp)
  };

  constructor(scpiQueryFn, getSpiPrefixFn = () => ":SPI") {
      this.query = scpiQueryFn;
      this.getSpiPrefix = typeof getSpiPrefixFn === 'function' ? getSpiPrefixFn : () => getSpiPrefixFn;
  }

  async _send_spi(mosi_data, miso_len) {
      const prefix = this.getSpiPrefix();
      const txArray = [...mosi_data];
      for (let i = 0; i < miso_len; i++) {
          txArray.push(0x00);
      }
      const decStr = txArray.join(',');
      
      await this.query(`${prefix}:CS0 0`);

      const scpiCmd = `${prefix}:WriteReaD ${decStr}`;
      let response = await this.query(scpiCmd);

      await this.query(`${prefix}:CS0 1`);

      if (!response) return Array(miso_len).fill(0);

      const stripped = response.replace(scpiCmd, '').trim();
      const tokens = stripped.match(/0x[0-9a-fA-F]+|[0-9a-fA-F]+/g) || [];
      const rx = tokens.map(tok => parseInt(tok, 16));

      if (rx.length >= mosi_data.length + miso_len) {
          return rx.slice(mosi_data.length, mosi_data.length + miso_len);
      }
      if (rx.length >= miso_len) {
          return rx.slice(-miso_len);
      }
      return Array(miso_len).fill(0);
  }

  _crc_2f(message) {
      let crc = 0xFF; 
      for (let i = 0; i < message.length; i++) {
          crc = crc ^ message[i];
          for (let j = 0; j < 8; j++) {
              if ((crc & 0x80) === 0) crc = (crc << 1) & 0xFF;
              else crc = ((crc << 1) ^ 0x2F) & 0xFF;
          }
      }
      return (crc ^ 0xFF) & 0xFF; 
  }

  _verify_crc(message, expected_crc) {
      let crcFF = 0xFF; 
      for (let i = 0; i < message.length; i++) {
          crcFF ^= message[i];
          for (let j = 0; j < 8; j++) {
              crcFF = (crcFF & 0x80) ? ((crcFF << 1) ^ 0x2F) & 0xFF : (crcFF << 1) & 0xFF;
          }
      }
      if (((crcFF ^ 0xFF) & 0xFF) === expected_crc) return true;

      let crc00 = 0x00; 
      for (let i = 0; i < message.length; i++) {
          crc00 ^= message[i];
          for (let j = 0; j < 8; j++) {
              crc00 = (crc00 & 0x80) ? ((crc00 << 1) ^ 0x2F) & 0xFF : (crc00 << 1) & 0xFF;
          }
      }
      if (((crc00 ^ 0x00) & 0xFF) === expected_crc) return true;

      return false; 
  }

  _s16(u) {
      let val = (u << 4) & 0xFFFF;
      if (val & 0x8000) val = val - 0x10000;
      return val >> 4;
  }

  _checkMaskLimit(data_mask) {
      // The part measures at most 6 channels per SM/SB/SWOC/RM, and MI6 is the
      // warning flag for over-asking. The mask is 20 bits (0..19); only bits
      // 2..19 select measurement channels, so reserved bit 0 and the supply bit
      // (bit 1) are excluded from the budget check instead of refusing.
      let count = 0;
      let temp_mask = data_mask & 0xFFFFFC;
      while (temp_mask) {
          temp_mask &= (temp_mask - 1);
          if (++count > 6) return true;
      }
      return false;
  }

  async rt() {
      const mosi = [MLX90396_API.Mlx90396Command.RT, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async hs() {
      const mosi = [MLX90396_API.Mlx90396Command.HS, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async hr() {
      const mosi = [MLX90396_API.Mlx90396Command.HR, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async ex(mode) {
      const mosi = [MLX90396_API.Mlx90396Command.EX | (0x0F & mode), 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async rr(reg) {
      const mosi = [MLX90396_API.Mlx90396Command.RR, reg, 0];
      mosi[2] = this._crc_2f(mosi.slice(0, 2));
      const miso = await this._send_spi(mosi, 4);
      
      const error = !this._verify_crc(miso.slice(0, 3), miso[3]);
      const data = (miso[1] << 8) | miso[2];
      
      return { error, status: miso[0], data }; 
  }

  async wr(reg, data) {
      const mosi = [
          MLX90396_API.Mlx90396Command.WR,
          reg,
          (data >> 8) & 0xFF,
          data & 0xFF,
          0
      ];
      mosi[4] = this._crc_2f(mosi.slice(0, 4));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
  }

  async sb(data_mask) {
      if (this._checkMaskLimit(data_mask)) return true;
      const mosi = [
          MLX90396_API.Mlx90396Command.SB | ((data_mask >> 16) & 0x0F),
          (data_mask >> 8) & 0xFF,
          data_mask & 0xFF,
          0 
      ];
      mosi[3] = this._crc_2f(mosi.slice(0, 3));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
  }

  async swoc(data_mask) {
      if (this._checkMaskLimit(data_mask)) return true;
      const mosi = [
          MLX90396_API.Mlx90396Command.SWOC | ((data_mask >> 16) & 0x0F),
          (data_mask >> 8) & 0xFF,
          data_mask & 0xFF,
          0 
      ];
      mosi[3] = this._crc_2f(mosi.slice(0, 3));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
  }

  async sm(data_mask) {
      if (this._checkMaskLimit(data_mask)) return true;
      const mosi = [
          MLX90396_API.Mlx90396Command.SM | ((data_mask >> 16) & 0x0F),
          (data_mask >> 8) & 0xFF,
          data_mask & 0xFF,
          0 
      ];
      mosi[3] = this._crc_2f(mosi.slice(0, 3));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
  }

  async rm(temp, data_mask) {
      if (this._checkMaskLimit(data_mask)) return { error: true, msg: "Limit Exceeded (Max 6 axes)" };
      
      const mosi = [temp ? MLX90396_API.Mlx90396Command.RM_TEMP : MLX90396_API.Mlx90396Command.RM_NO_TEMP, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      
      const keys = [
          'x0', 'y0', 'z0', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'x3', 'y3', 'z3',
          'x02', 'y02', 'z02', 'x13', 'y13', 'z13', 'vdd'
      ];
      
      let activeKeys = [];
      for (let i = 0; i < 19; i++) {
          const bitPos = 19 - i;
          if ((data_mask & (1 << bitPos)) !== 0) {
              activeKeys.push(keys[i]);
          }
      }
      
      const miso_len = 1 + (temp ? 2 : 0) + (activeKeys.length * 2) + 1;
      const miso = await this._send_spi(mosi, miso_len);
      
      let result = { raw: miso };
      let offset = 1; 

      if (temp) {
          const w = (miso[offset] << 8) | miso[offset + 1];
          result.t = this._s16(w);
          offset += 2;
      }
      
      for (let key of activeKeys) {
          const w = (miso[offset] << 8) | miso[offset + 1];
          result[key] = this._s16(w);
          offset += 2;
      }
      
      result.error = !this._verify_crc(miso.slice(0, offset), miso[offset]);
      result.status = miso[0];

      return result;
  }

  async rm_joystick_xyz(temp, data_mask) {
      return this.rm(temp, data_mask);
  }

  // Status-only RM: returns { ok, status } without consuming the pending
  // measurement, mirroring the thumbstick API and the reference page's DRDY
  // poll. The byte after the status is DATA (the reply CRC is only at the end
  // of the full frame), so no CRC is verified on a lone status byte.
  async rmStatus() {
      const mosi = [MLX90396_API.Mlx90396Command.RM_NO_TEMP, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 1);
      if (!miso || miso.length < 1) return { ok: false, status: 0 };
      return { ok: true, status: miso[0] };
  }

  // Wait for conversion-complete after SM: polls the status byte about every
  // 2 ms up to deadlineMs, then proceeds regardless so a slow or silent part can
  // never stall the loop. Returns true when DRDY (status bit 0) was seen.
  async awaitReady(deadlineMs = 10) {
      const t0 = Date.now();
      for (;;) {
          try {
              const st = await this.rmStatus();
              if (st.ok && (st.status & 0x01)) return true;
          } catch (_) { /* transport hiccup: retry until the deadline */ }
          if (Date.now() - t0 >= deadlineMs) return false;
          await new Promise(r => setTimeout(r, 2));
      }
  }

  /**
   * Updates NV_GAINSEL_1PX (reg 0x00 bits [5:0]) using the required unlock sequence
   * @param {number} gainValue - 9 (gain ~72) or 37 (gain ~219)
   * @param {boolean} persist - If true, issues HS to store permanently into NVRAM
   */
  async setGain1Px(gainValue = 37, persist = false) {
      // 1. Send unlock sequence (Datasheet 15.4.3); abort if either write fails.
      if (await this.wr(0x43, 0x9952)) return false;
      if (await this.wr(0x44, 0x84DE)) return false;

      // 2. Read register 0x00 to preserve NV_GAINSEL_2PX (bits [11:6])
      const readRes = await this.rr(0x00);
      // Abort on a failed read: substituting 0 would wipe the 2px gain field
      // instead of failing safe.
      if (readRes.error) return false;
      const currentVal = readRes.data;

      // 3. Clear bits [5:0] and apply new 6-bit gain
      const updatedVal = (currentVal & ~0x003F) | (gainValue & 0x003F);
      const writeErr = await this.wr(0x00, updatedVal);
      if (writeErr) return false;

      // Confirm the volatile register contains the requested 1PX gain bits.
      const verifyRes = await this.rr(0x00);
      const verified = !verifyRes.error && ((verifyRes.data & 0x003F) === (gainValue & 0x003F));
      if (!verified) return false;

      // 4. Optionally commit to non-volatile memory
      if (persist) {
          await this.hs();
      }
      return true;
  }

  /**
   * Reads back NV_GAINSEL_1PX (reg 0x00 bits [5:0]) for UI confirmation.
   * @returns {{error: boolean, value: (number|null), raw: (number|null)}}
   */
  async readGain1Px() {
      const readRes = await this.rr(0x00);
      if (readRes.error) return { error: true, value: null, raw: null };
      return { error: false, value: readRes.data & 0x003F, raw: readRes.data };
  }

  /**
   * GAINSEL fields share register 0x00: bits[5:0] = 1px, bits[11:6] = 2px.
   * Writes require the unlock sequence (datasheet 15.4.3) and must preserve the
   * other field; a readback then confirms what the part actually holds.
   * @param {'1px'|'2px'} mode
   * @param {number} gainValue 6-bit gain
   * @param {boolean} persist - If true, issues HS to store permanently into NVRAM
   */
  async setGain(mode, gainValue, persist = false) {
      if (await this.wr(0x43, 0x9952)) return { ok: false };
      if (await this.wr(0x44, 0x84DE)) return { ok: false };

      const is2px = mode === '2px';
      const readRes = await this.rr(0x00);
      // Abort on a failed read: substituting 0 would wipe the other mode's
      // gain field instead of failing safe.
      if (readRes.error) return { ok: false };
      const currentVal = readRes.data;

      const gainField = gainValue & 0x003F;
      // Preserve everything outside the written field, including bits 15:12 -
      // the old positive masks zeroed the upper nibble on every gain write.
      const updatedVal = is2px
          ? (currentVal & ~0x0FC0) | (gainField << 6)
          : (currentVal & ~0x003F) | gainField;

      if (await this.wr(0x00, updatedVal)) return { ok: false };

      const verifyRes = await this.rr(0x00);
      const verifiedField = is2px
          ? (verifyRes.data >> 6) & 0x003F
          : verifyRes.data & 0x003F;
      const ok = !verifyRes.error && verifiedField === gainField;

      if (ok && persist) await this.hs();

      return { ok, value: ok ? verifiedField : null, raw: verifyRes.data };
  }

  async readGain(mode) {
      const readRes = await this.rr(0x00);
      if (readRes.error) return { error: true, value: null, raw: null };
      const value = mode === '2px'
          ? (readRes.data >> 6) & 0x003F
          : readRes.data & 0x003F;
      return { error: false, value, raw: readRes.data };
  }
}

export default MLX90396_API;
