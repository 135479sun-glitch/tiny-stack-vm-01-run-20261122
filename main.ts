// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA (program/v1).
// One program, main.ts at the repo root, run as `node /bot/main.ts` on Node 22.
// Reads /input/<id>/program.bin + input.bin, writes /output/<id>/stdout.bin + exit.txt.
// Faithful to the kit's reference VM (program/generator/subject/vm.mjs): same traps,
// same step/output limits, same wrapping 32-bit arithmetic, same exit codes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode table: byte -> (imm | pops<<3 | pushes<<5) + 1; 0 = not an opcode.
const T = new Uint8Array(256);
for (const [o, i, p, u] of [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0],
  [0x04, 0, 1, 2], [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3],
  [0x10, 0, 2, 1], [0x11, 0, 2, 1], [0x12, 0, 2, 1], [0x13, 0, 2, 1],
  [0x14, 0, 2, 1], [0x15, 0, 2, 1], [0x16, 0, 2, 1], [0x17, 0, 1, 1],
  [0x18, 0, 2, 1], [0x19, 0, 2, 1], [0x1a, 0, 2, 1], [0x1b, 0, 1, 1],
  [0x1c, 0, 2, 1], [0x1d, 0, 2, 1], [0x1e, 0, 2, 1], [0x20, 0, 2, 1],
  [0x21, 0, 2, 1], [0x22, 0, 2, 1], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1],
  [0x53, 0, 1, 0],
]) T[o] = (i | (p << 3) | (u << 5)) + 1;

const TB = new Uint8Array(12); // scratch for PRINT's decimal digits

function run(p, inp) {
  const n = p.length;
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  for (;;) {
    if (steps === 1000000) return [out.subarray(0, ol), 10];
    if (pc < 0 || pc >= n) return [out.subarray(0, ol), 9];
    const op = p[pc];
    const e = T[op];
    if (!e) return [out.subarray(0, ol), 5];
    const v = e - 1, imm = v & 7;
    if (pc + imm >= n) return [out.subarray(0, ol), 9];
    steps++;
    const next = pc + 1 + imm;
    const pops = (v >> 3) & 3, pushes = (v >> 5) & 3;
    if (sp < pops) return [out.subarray(0, ol), 2];
    if (sp - pops + pushes > 256) return [out.subarray(0, ol), 3];
    pc = next;
    if (op >= 0x10 && op <= 0x22 && op !== 0x17 && op !== 0x1b) {
      const b = D[sp - 1], a = D[sp - 2];
      let r;
      switch (op) {
        case 0x10: r = (a + b) | 0; break;
        case 0x11: r = (a - b) | 0; break;
        case 0x12: r = Math.imul(a, b); break;
        case 0x13:
          if (b === 0) return [out.subarray(0, ol), 4];
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0; break;
        case 0x14:
          if (b === 0) return [out.subarray(0, ol), 4];
          r = b === -1 ? 0 : (a % b) | 0; break;
        case 0x15:
          if (b === 0) return [out.subarray(0, ol), 4];
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0; break;
        case 0x16:
          if (b === 0) return [out.subarray(0, ol), 4];
          r = ((a >>> 0) % (b >>> 0)) | 0; break;
        case 0x18: r = a & b; break;
        case 0x19: r = a | b; break;
        case 0x1a: r = a ^ b; break;
        case 0x1c: r = a << (b & 31); break;
        case 0x1d: r = a >> (b & 31); break;
        case 0x1e: r = (a >>> (b & 31)) | 0; break;
        case 0x20: r = a === b ? 1 : 0; break;
        case 0x21: r = a < b ? 1 : 0; break;
        default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
      }
      sp -= 2;
      D[sp++] = r;
      continue;
    }
    switch (op) {
      case 0x00: return [out.subarray(0, ol), 0]; // HALT
      case 0x01: D[sp++] = (p[next - 1] << 24) >> 24; break; // PUSH8
      case 0x02: D[sp++] = p[next - 4] | (p[next - 3] << 8) | (p[next - 2] << 16) | (p[next - 1] << 24); break; // PUSH32
      case 0x03: sp--; break; // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = (-D[sp - 1]) | 0; break; // NEG
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((p[next - 2] | (p[next - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (!take) { const x = D[--sp]; take = op === 0x31 ? x === 0 : x !== 0; }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === 64) return [out.subarray(0, ol), 7];
        C[cp++] = next;
        pc = p[next - 2] | (p[next - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return [out.subarray(0, ol), 8];
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a >= 256) return [out.subarray(0, ol), 6];
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE
        const a = D[sp - 1], w = D[sp - 2];
        if (a < 0 || a >= 256) return [out.subarray(0, ol), 6];
        sp -= 2;
        M[a] = w;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline
        let val = D[sp - 1], neg = false, u = val;
        if (val < 0) { neg = true; u = -val; }
        let d = 0;
        do { TB[d++] = 48 + (u % 10); u = (u / 10) | 0; } while (u > 0);
        const len = d + (neg ? 1 : 0);
        if (ol + len > 65536) return [out.subarray(0, ol), 11];
        sp--;
        if (neg) out[ol++] = 45;
        while (d > 0) out[ol++] = TB[--d];
        break;
      }
      case 0x51: // PUTC
        if (ol + 1 > 65536) return [out.subarray(0, ol), 11];
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = ip < inp.length ? inp[ip++] : -1; break; // IN
      case 0x53: return [out.subarray(0, ol), D[--sp] & 255]; // EXIT
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const [o, code] = run(readFileSync(join(I, id, 'program.bin')), readFileSync(join(I, id, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), o);
  writeFileSync(join(O, id, 'exit.txt'), `${code}\n`);
}
