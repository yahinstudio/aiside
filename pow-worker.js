// pow-worker.js —— DeepSeek PoW 求解器（DeepSeekHashV1）
// 算法：找 nonce ∈ [0, difficulty) 使 DeepSeekHashV1("<salt>_<expire_at>_<nonce>") 的
// 32 字节摘要 == challenge（64 位 hex）。DeepSeekHashV1 = SHA3-256 变体：
// **keccak-f[1600] 跳过 round 0，只执行 rounds 1..23**（对齐官方 WASM，ds2api 逆向确认）。
// 求解在 Web Worker 中运行，不阻塞侧边栏 UI。

const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

// ρ+π 链式表（与 tiny_sha3 公有领域实现一致）：
// 从 lane1 出发，沿 PILN 序列轮转，每步旋转 ROTC_CHAIN[i]
const ROTC_CHAIN = new Uint8Array([
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
]);
const PILN = new Uint8Array([
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
]);

// keccak-f[1600]（DeepSeekHashV1 变体）：跳过 round 0，只执行 rounds 1..23
function keccakF(s) {
  const b = new Uint32Array(50);
  const c = new Uint32Array(10);
  for (let round = 1; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      let lo = s[x * 2] ^ s[(x + 5) * 2] ^ s[(x + 10) * 2] ^ s[(x + 15) * 2] ^ s[(x + 20) * 2];
      let hi = s[x * 2 + 1] ^ s[(x + 5) * 2 + 1] ^ s[(x + 10) * 2 + 1] ^ s[(x + 15) * 2 + 1] ^ s[(x + 20) * 2 + 1];
      c[x * 2] = lo;
      c[x * 2 + 1] = hi;
    }
    for (let x = 0; x < 5; x++) {
      const p = ((x + 4) % 5) * 2;
      const q = ((x + 1) % 5) * 2;
      // D[x] = C[x-1] ^ rotl(C[x+1], 1)
      const dLo = c[p] ^ ((c[q] << 1) | (c[q + 1] >>> 31));
      const dHi = c[p + 1] ^ ((c[q + 1] << 1) | (c[q] >>> 31));
      const dLoU = dLo >>> 0;
      const dHiU = dHi >>> 0;
      for (let y = 0; y < 5; y++) {
        const i = (x + 5 * y) * 2;
        s[i] = (s[i] ^ dLoU) >>> 0;
        s[i + 1] = (s[i + 1] ^ dHiU) >>> 0;
      }
    }
    // ρ + π：链式轮转（lane1 出发，值沿 PILN 链传递并逐步旋转）
    let tLo = s[2], tHi = s[3];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i] * 2;
      const jLo = s[j], jHi = s[j + 1];
      const n = ROTC_CHAIN[i];
      if (n < 32) {
        s[j] = ((tLo << n) | (tHi >>> (32 - n))) >>> 0;
        s[j + 1] = ((tHi << n) | (tLo >>> (32 - n))) >>> 0;
      } else {
        // n ≥ 32：低/高 32 位角色互换
        const m = n - 32;
        s[j] = ((tHi << m) | (tLo >>> (32 - m))) >>> 0;
        s[j + 1] = ((tLo << m) | (tHi >>> (32 - m))) >>> 0;
      }
      tLo = jLo;
      tHi = jHi;
    }
    // χ（逐行：先拷贝该行到 b，再就地异或）
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = (x + 5 * y) * 2;
        b[i] = s[i];
        b[i + 1] = s[i + 1];
      }
      for (let x = 0; x < 5; x++) {
        const i = (x + 5 * y) * 2;
        const i1 = (((x + 1) % 5) + 5 * y) * 2;
        const i2 = (((x + 2) % 5) + 5 * y) * 2;
        s[i] = (b[i] ^ ((~b[i1] & b[i2]) >>> 0)) >>> 0;
        s[i + 1] = (b[i + 1] ^ ((~b[i1 + 1] & b[i2 + 1]) >>> 0)) >>> 0;
      }
    }
    // ι
    s[0] = (s[0] ^ RC_LO[round]) >>> 0;
    s[1] = (s[1] ^ RC_HI[round]) >>> 0;
  }
}

function le32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

// SHA3-256：输入任意字节，返回 32 字节摘要
function dsHashV1(msg) {
  const RATE = 136;
  const s = new Uint32Array(50);
  const block = new Uint8Array(RATE);
  let off = 0;
  while (off + RATE <= msg.length) {
    for (let i = 0; i < 17; i++) {
      s[i * 2] ^= le32(msg, off + i * 8);
      s[i * 2 + 1] ^= le32(msg, off + i * 8 + 4);
    }
    keccakF(s);
    off += RATE;
  }
  // 收尾块（含 0x06 起始填充与 0x80 结束位）
  block.fill(0);
  block.set(msg.subarray(off));
  block[msg.length - off] = 0x06;
  block[RATE - 1] |= 0x80;
  for (let i = 0; i < 17; i++) {
    s[i * 2] ^= le32(block, i * 8);
    s[i * 2 + 1] ^= le32(block, i * 8 + 4);
  }
  keccakF(s);
  const out = new Uint8Array(32);
  for (let k = 0; k < 4; k++) {
    let lo = s[k * 2];
    let hi = s[k * 2 + 1];
    out[k * 8] = lo & 0xff;
    out[k * 8 + 1] = (lo >>> 8) & 0xff;
    out[k * 8 + 2] = (lo >>> 16) & 0xff;
    out[k * 8 + 3] = (lo >>> 24) & 0xff;
    out[k * 8 + 4] = hi & 0xff;
    out[k * 8 + 5] = (hi >>> 8) & 0xff;
    out[k * 8 + 6] = (hi >>> 16) & 0xff;
    out[k * 8 + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}

function dsHashV1Hex(msgBytes) {
  return Array.from(dsHashV1(msgBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// 求解：在 [start, end) 范围内返回命中的 nonce；范围内无解返回 -1
// start/end 缺省时扫描 [0, difficulty)——供多 Worker 分片并行调用
function solveChallenge(challengeHex, salt, expireAt, difficulty, start, end) {
  const lo = typeof start === "number" && start >= 0 ? start : 0;
  const hi = typeof end === "number" && end <= difficulty ? end : difficulty;
  const prefix = salt + "_" + expireAt + "_";
  const enc = new TextEncoder();
  const prefixBytes = enc.encode(prefix);
  const target = hexToBytes(challengeHex);
  const RATE = 136;
  const block = new Uint8Array(RATE);
  block.set(prefixBytes);
  const state = new Uint32Array(50);
  const baseState = new Uint32Array(50);
  const baseLen = prefixBytes.length;
  const digits = new Uint8Array(20);
  for (let n = lo; n < hi; n++) {
    // 十进制 nonce 写入缓冲
    let v = n;
    let pos = digits.length;
    if (v === 0) {
      pos--;
      digits[pos] = 0x30;
    } else {
      while (v > 0) {
        pos--;
        digits[pos] = 0x30 + (v % 10);
        v = (v / 10) | 0;
      }
    }
    const numLen = digits.length - pos;
    const total = baseLen + numLen;
    block.fill(0, baseLen);
    block.set(digits.subarray(pos), baseLen);
    block[total] = 0x06;
    block[RATE - 1] |= 0x80;
    state.set(baseState); // keccakF 原地变换，每轮从基准状态恢复
    for (let i = 0; i < 17; i++) {
      state[i * 2] ^= le32(block, i * 8);
      state[i * 2 + 1] ^= le32(block, i * 8 + 4);
    }
    keccakF(state);
    let ok = true;
    for (let k = 0; k < 32; k++) {
      const lane = k >> 3;
      const shift = (k & 7) * 8;
      const byte = (k & 4)
        ? (state[lane * 2 + 1] >>> shift) & 0xff
        : (state[lane * 2] >>> shift) & 0xff;
      if (byte !== target[k]) { ok = false; break; }
    }
    if (ok) return n;
  }
  return -1;
}

self.onmessage = (e) => {
  const { challengeHex, salt, expireAt, difficulty, start, end } = e.data || {};
  try {
    const answer = solveChallenge(challengeHex, salt, expireAt, difficulty || 144000, start, end);
    self.postMessage({ answer, start: start || 0 });
  } catch (err) {
    self.postMessage({ answer: -1, error: err && err.message ? err.message : String(err) });
  }
};
