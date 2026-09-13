/* ============================================================
   AsmCode — NASM x86 Editor & register emulator
   by ExEintel
   ============================================================ */
"use strict";

/* ============================================================
   0. Helpers
   ============================================================ */
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hex32(v, pad = 8) {
  return "0x" + ((v >>> 0).toString(16).toUpperCase().padStart(pad, "0"));
}

/* ============================================================
   1. Theme toggle
   ============================================================ */
const themeBtn = $("themeToggle");
themeBtn.addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  toast(root.dataset.theme === "dark" ? "Dark theme enabled" : "Light theme enabled");
});

/* ============================================================
   2. Editor (overlay: transparent textarea + highlighted <pre>)
   ============================================================ */
const code = $("code");
const hl = $("highlight");
const gutter = $("gutter");
const posInfo = $("posInfo");

const DEFAULT_CODE = `; =========================================================
; Hello World - NASM x86 (Windows, PE32)
; ---------------------------------------------------------
; Build:
;   nasm -f win32 hello.asm -o hello.obj
;   link /subsystem:windows hello.obj kernel32.lib user32.lib
; Run:
;   hello.exe
; =========================================================

section .data
    msg db 'Hello, World!', 0
    title db 'AsmCode', 0

section .text
    global _start
    extern MessageBoxA
    extern ExitProcess

_start:
    push 0              ; uType = MB_OK
    push title          ; lpCaption
    push msg            ; lpText
    push 0              ; hWnd = NULL
    call MessageBoxA    ; MessageBoxA(hWnd, lpText, lpCaption, uType)

    push 0              ; uExitCode = 0
    call ExitProcess    ; ExitProcess(uExitCode)
`;

const REGSET = new Set([
  "eax","ebx","ecx","edx","esi","edi","ebp","esp",
  "ax","bx","cx","dx","si","di","bp","sp",
  "al","ah","bl","bh","cl","ch","dl","dh",
  "eip","eflags","rip","rsp","rbp","rax","rbx","rcx","rdx","rsi","rdi",
  "r8","r9","r10","r11","r12","r13","r14","r15"
]);

const INS_SET = new Set([
  "mov","movzx","movsx","lea","xchg",
  "add","adc","sub","sbb","inc","dec","neg",
  "and","or","xor","not","shl","shr","sar","sal",
  "cmp","test",
  "jmp","je","jne","jz","jnz","jl","jle","jg","jge",
  "jb","jbe","ja","jae","js","jns","jc","jnc","jo","jno",
  "loop","loope","loopne",
  "push","pop","pusha","pushad","popa","popad",
  "call","ret","retn","int","iret","syscall","sysenter",
  "nop","hlt","clc","stc","cmc","cld","std","cdq","cwd","cbw","cwde",
  "mul","imul","div","idiv"
]);

const DIR_SET = new Set([
  "section","global","extern","bits","org","default","cpu",
  "db","dw","dd","dq","dt","equ","resb","resw","resd","resq",
  "times","align","incbin","struc","endstruc","istruc","at","iend"
]);

const NAME_RE = /[A-Za-z_.$@?][\w.$@?]*/;

function tokenizeLine(line, names) {
  const tokens = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === ";") {
      tokens.push({ t: line.slice(i), cls: "tok-cm" });
      break;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && line[j] !== ch) j++;
      if (j >= n) j = n;
      tokens.push({ t: line.slice(i, j + 1), cls: "tok-str" });
      i = j + 1;
      continue;
    }
    const m = NAME_RE.exec(line.slice(i));
    if (m && m.index === 0) {
      const word = m[0];
      let cls = null;
      if (REGSET.has(word.toLowerCase())) cls = "tok-reg";
      else if (INS_SET.has(word.toLowerCase())) cls = "tok-ins";
      else if (DIR_SET.has(word.toLowerCase())) cls = "tok-dir";
      else if (word[0] === ".") cls = "tok-dir";
      else if (names.has(word)) cls = "tok-lbl";
      tokens.push({ t: word, cls });
      i += word.length;
      if (i < n && line[i] === ":") {
        tokens.push({ t: ":", cls: "tok-lbl" });
        i++;
      }
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9A-Fa-fxXbB]/.test(line[j])) j++;
      tokens.push({ t: line.slice(i, j), cls: "tok-num" });
      i = j;
      continue;
    }
    tokens.push({ t: ch, cls: null });
    i++;
  }
  return tokens;
}

function stripComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") inStr = c;
    else if (c === ";") return line.slice(0, i);
  }
  return line;
}

function collectNames(src) {
  const names = new Set();
  const lines = src.split("\n");
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    let m = line.match(/^([A-Za-z_.$@?][\w.$@?]*)\s*:/);
    if (m) names.add(m[1]);
    m = line.match(/^([A-Za-z_.$@?][\w.$@?]*)\s+(?:db|dw|dd|dq|dt|resb|resw|resd|resq|equ)\b/i);
    if (m) names.add(m[1]);
    m = line.match(/^(?:global|extern)\s+([A-Za-z_.$@?][\w.$@?]*)/i);
    if (m) names.add(m[1]);
  }
  return names;
}

function renderHighlight() {
  const src = code.value;
  const names = collectNames(src);
  const lines = src.split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const toks = tokenizeLine(lines[i], names);
    let html = toks.map((t) => t.cls ? `<span class="${t.cls}">${escapeHtml(t.t)}</span>` : escapeHtml(t.t)).join("");
    const cls = [];
    if (i === state.activeLine) cls.push("active");
    if (state.errorLines.has(i)) cls.push("line-err");
    if (!html) html = "\u200b";
    rows.push(`<div class="row${cls.length ? " " + cls.join(" ") : ""}">${html}</div>`);
  }
  hl.innerHTML = rows.join("");
}

function renderGutter() {
  const n = code.value.split("\n").length;
  let h = "";
  for (let i = 0; i < n; i++) {
    const cls = [];
    if (i === state.activeLine) cls.push("active");
    if (state.errorLines.has(i)) cls.push("err");
    h += `<span class="gl${cls.length ? " " + cls.join(" ") : ""}">${i + 1}</span>`;
  }
  gutter.innerHTML = h;
}

function syncScroll() {
  hl.scrollTop = code.scrollTop;
  hl.scrollLeft = code.scrollLeft;
  gutter.scrollTop = code.scrollTop;
}
code.addEventListener("scroll", syncScroll);

function updatePos() {
  const sel = code.selectionStart;
  const before = code.value.slice(0, sel);
  const ln = (before.match(/\n/g) || []).length + 1;
  const col = sel - before.lastIndexOf("\n");
  posInfo.textContent = `Ln ${ln}, Col ${col}`;
}
code.addEventListener("keyup", updatePos);
code.addEventListener("click", updatePos);

code.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = code.selectionStart, en = code.selectionEnd;
    code.value = code.value.slice(0, s) + "    " + code.value.slice(en);
    code.selectionStart = code.selectionEnd = s + 4;
    onEdit();
  }
});

let editTimer = null;
function onEdit() {
  state.dirty = true;
  renderHighlight();
  renderGutter();
  updatePos();
  clearTimeout(editTimer);
  editTimer = setTimeout(runValidation, 320);
}
code.addEventListener("input", onEdit);

/* ============================================================
   3. NASM parser / build
   ============================================================ */
const MEM_SIZE = 0x100000;   // 1 MiB virtual RAM
const MEM_MASK = MEM_SIZE - 1;
const DATA_BASE = 0x10000;
const STACK_BASE = 0x70000;

function parseNumber(s) {
  s = s.trim();
  if (!s) return undefined;
  let sign = 1;
  if (s[0] === "+") s = s.slice(1);
  else if (s[0] === "-") { sign = -1; s = s.slice(1); }
  let v;
  if (/^0x/i.test(s)) v = parseInt(s.slice(2), 16);
  else if (/^0b/i.test(s)) v = parseInt(s.slice(2), 2);
  else if (/^[0-9]+$/.test(s)) v = parseInt(s, 10);
  else v = NaN;
  if (v === undefined || Number.isNaN(v)) return undefined;
  return sign * v;
}

function isRegName(s) { return REGSET.has(s.toLowerCase()); }

function evalExpr(expr, labels, equates, addr) {
  expr = expr.trim();
  if (!expr) return undefined;
  const terms = expr.split(/([+\-])/);
  let total = 0, sign = 1;
  for (const t of terms) {
    if (t === "+" || t === "-") { sign = t === "+" ? 1 : -1; continue; }
    const tt = t.trim();
    if (!tt) continue;
    let v;
    if (tt === "$") v = addr;
    else if (/^[A-Za-z_.$@?]/.test(tt)) {
      const nm = tt.match(NAME_RE)[0];
      if (nm in labels) v = labels[nm];
      else if (nm in equates) v = equates[nm];
      else v = undefined;
    } else v = parseNumber(tt);
    if (v === undefined) return undefined;
    total += sign * v;
  }
  return total;
}

function splitOperands(s) {
  const parts = [];
  let cur = "", depth = 0, inStr = null;
  for (const c of s) {
    if (inStr) { cur += c; if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if (c === "[") depth++;
    if (c === "]") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseOperand(s, labels, equates, addr) {
  s = s.trim();
  let size = 4;
  const szm = s.match(/^(byte|word|dword|qword)\s+/i);
  if (szm) {
    size = { byte: 1, word: 2, dword: 4, qword: 8 }[szm[1].toLowerCase()];
    s = s.slice(szm[0].length).trim();
  }
  if (isRegName(s)) return { type: "reg", name: s.toLowerCase(), size };
  if (s === "$") return { type: "imm", value: addr };
  if (s.startsWith("[")) {
    const lb = s.lastIndexOf("]");
    const inner = s.slice(1, lb === -1 ? s.length : lb);
    const terms = [];
    const segs = inner.split(/([+-])/);
    let sign = 1;
    for (const seg of segs) {
      if (seg === "+" || seg === "-") { sign = seg === "+" ? 1 : -1; continue; }
      const t = seg.trim();
      if (!t) continue;
      if (isRegName(t)) terms.push({ kind: "reg", name: t.toLowerCase(), sign });
      else if (/^[A-Za-z_.$@?]/.test(t)) {
        const nm = t.match(NAME_RE)[0];
        terms.push({ kind: "sym", name: nm, sign });
      } else {
        const v = parseNumber(t);
        if (v === undefined) return { error: `Invalid address expression '[${inner}]'` };
        terms.push({ kind: "imm", value: v, sign });
      }
    }
    return { type: "mem", terms, size };
  }
  const c = s[0];
  if (c === '"' || c === "'") {
    const str = s.slice(1, s.length - 1);
    let v = 0;
    for (let i = 0; i < Math.min(4, str.length); i++) v |= str.charCodeAt(i) << (8 * i);
    return { type: "imm", value: v };
  }
  if (/^[+-]?[0-9]/.test(s)) {
    const v = parseNumber(s);
    if (v !== undefined) return { type: "imm", value: v };
  }
  if (/^[A-Za-z_.$@?]/.test(s)) {
    const nm = s.match(NAME_RE)[0];
    return { type: "imm", ref: nm, value: 0 };
  }
  return { error: `Invalid operand '${s}'` };
}

function parseValues(s, labels, equates, addr) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;
    if (i >= n) break;
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let str = "";
      while (j < n && s[j] !== c) { str += s[j]; j++; }
      if (j >= n) return { error: "Unterminated string literal" };
      for (let k = 0; k < str.length; k++) out.push(str.charCodeAt(k));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !/[\s,]/.test(s[j])) j++;
    const tok = s.slice(i, j);
    const v = evalExpr(tok, labels, equates, addr);
    if (v === undefined) return { error: `Invalid value '${tok}'` };
    out.push(v);
    i = j;
  }
  return out;
}

function parseInstruction(text, lineNo, addr, labels, equates) {
  const parts = splitOperands(text);
  if (!parts.length) return { error: "Empty statement" };
  const p0 = parts[0].trim().split(/\s+/);
  const mnem = p0.shift().toLowerCase();
  if (!INS_SET.has(mnem)) return { error: `Unknown instruction '${mnem}'` };
  const operandTokens = [...p0, ...parts.slice(1)];
  const rawOps = [];
  let pending = null;
  for (const s of operandTokens) {
    const t = s.trim();
    const sz = t.match(/^(byte|word|dword|qword)$/i);
    if (sz && pending === null) { pending = t; continue; }
    rawOps.push(pending ? pending + " " + t : t);
    pending = null;
  }
  if (pending) rawOps.push(pending);
  const ops = [];
  for (const s of rawOps) {
    const op = parseOperand(s, labels, equates, addr);
    if (op.error) return { error: op.error };
    ops.push(op);
  }
  return { lineNo, mnem, ops, addr };
}

function writeMem(mem, addr, size, val) {
  for (let i = 0; i < size; i++) mem[(addr + i) & MEM_MASK] = (val >>> (8 * i)) & 0xff;
}

function buildProgram(src) {
  const mem = new Uint8Array(MEM_SIZE);
  const labels = {};
  const equates = {};
  const externs = new Set();
  const insts = [];
  const issues = [];
  let addr = DATA_BASE;

  const lines = src.split("\n");

  for (let li = 0; li < lines.length; li++) {
    const clean = stripComment(lines[li]).trim();
    if (!clean) continue;

    /* label with colon, e.g. "start:" */
    let label = null;
    let rest = clean;
    const lbm = clean.match(/^([A-Za-z_.$@?][\w.$@?]*)\s*:/);
    if (lbm) {
      label = lbm[1];
      rest = clean.slice(lbm[0].length).trim();
    } else {
      /* data label without colon, e.g. "msg db 'Hello'" (not equ — that's a constant) */
      const dm = clean.match(/^([A-Za-z_.$@?][\w.$@?]*)\s+(db|dw|dd|dq|dt|resb|resw|resd|resq)\b/i);
      if (dm) {
        label = dm[1];
        rest = clean.slice(dm[1].length).trim();
      }
    }

    if (label) {
      if (label in labels && labels[label] !== addr) {
        issues.push({ lineNo: li, msg: `Duplicate label '${label}'` });
      }
      labels[label] = addr;
    }

    if (!rest) continue;

    const toks = rest.split(/\s+/);
    const first = toks[0].toLowerCase();

    if (first === "section" || first === "bits" || first === "org" ||
        first === "default" || first === "cpu" || first === "align") continue;

    if (first === "global" || first === "extern") {
      for (let k = 1; k < toks.length; k++) {
        const t = toks[k].replace(/,+$/, "");
        if (t) {
          if (first === "extern") externs.add(t);
          else labels[t] = labels[t] !== undefined ? labels[t] : addr;
        }
      }
      continue;
    }

    /* equ handling */
    let equName = null, equExpr = null;
    if (first === "equ") {
      equName = label || toks[1];
      equExpr = toks.slice(1).join(" ");
    } else if (toks[1] && toks[1].toLowerCase() === "equ") {
      equName = toks[0];
      equExpr = toks.slice(2).join(" ");
    }
    if (equName !== null) {
      const v = evalExpr(equExpr, labels, equates, addr);
      if (v === undefined) issues.push({ lineNo: li, msg: `Invalid equ expression '${equExpr}'` });
      else equates[equName] = v;
      continue;
    }

    if (["db", "dw", "dd", "dq"].includes(first)) {
      const restText = rest.slice(rest.toLowerCase().indexOf(first) + first.length).trim();
      const size = { db: 1, dw: 2, dd: 4, dq: 8 }[first];
      const vals = parseValues(restText, labels, equates, addr);
      if (vals.error) issues.push({ lineNo: li, msg: vals.error });
      else {
        for (const v of vals) {
          writeMem(mem, addr, size, v);
          addr += size;
        }
      }
      continue;
    }

    if (["resb", "resw", "resd", "resq"].includes(first)) {
      const n = parseNumber(toks[1]) || 0;
      const size = { resb: 1, resw: 2, resd: 4, resq: 8 }[first];
      addr += n * size;
      continue;
    }

    if (first === "times") {
      const cnt = parseNumber(toks[1]) || 0;
      const idx = rest.toLowerCase().indexOf(toks[1] || " ");
      const sub = rest.slice(idx + (toks[1] || "").length).trim();
      const subFirst = sub.split(/\s+/)[0].toLowerCase();
      if (["db", "dw", "dd", "dq"].includes(subFirst)) {
        const size = { db: 1, dw: 2, dd: 4, dq: 8 }[subFirst];
        const restText = sub.slice(sub.indexOf(subFirst) + subFirst.length).trim();
        const vals = parseValues(restText, labels, equates, addr);
        if (vals.error) issues.push({ lineNo: li, msg: vals.error });
        else {
          for (let r = 0; r < cnt; r++) {
            for (const v of vals) {
              writeMem(mem, addr, size, v);
              addr += size;
            }
          }
        }
      } else {
        for (let r = 0; r < cnt; r++) {
          const inst = parseInstruction(sub, li, addr, labels, equates);
          if (inst.error) { issues.push({ lineNo: li, msg: inst.error }); break; }
          inst.addr = addr;
          insts.push(inst);
          addr += 1;
        }
      }
      continue;
    }

    /* plain instruction */
    const inst = parseInstruction(rest, li, addr, labels, equates);
    if (inst.error) {
      issues.push({ lineNo: li, msg: inst.error });
    } else {
      inst.addr = addr;
      insts.push(inst);
      addr += 1;
    }
  }

  /* validate symbol references */
  for (const inst of insts) {
    for (const op of inst.ops) {
      if (op.type === "imm" && op.ref) {
        if (!(op.ref in labels) && !(op.ref in equates) && !externs.has(op.ref)) {
          issues.push({ lineNo: inst.lineNo, msg: `Undefined symbol '${op.ref}'` });
        }
      }
      if (op.type === "mem") {
        for (const t of op.terms) {
          if (t.kind === "sym") {
            if (!(t.name in labels) && !(t.name in equates) && !externs.has(t.name)) {
              issues.push({ lineNo: inst.lineNo, msg: `Undefined symbol '${t.name}'` });
            }
          }
        }
      }
    }
  }

  const addrIndex = {};
  insts.forEach((ins, idx) => { addrIndex[ins.addr] = idx; });

  return { mem, labels, equates, externs, insts, issues, addrIndex };
}

/* ============================================================
   4. VM (x86 register emulation — grammar level only)
   ============================================================ */
const FLAGS = ["zf", "sf", "cf", "of"];

function load(vm, addr, size) {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = (v << 8) | (vm.mem[(addr + i) & MEM_MASK] & 0xff);
  return v | 0;
}
function store(vm, addr, size, val) {
  writeMem(vm.mem, addr, size, val);
}

function getReg(vm, name) {
  name = name.toLowerCase();
  switch (name) {
    case "eax": return vm.eax | 0;
    case "ebx": return vm.ebx | 0;
    case "ecx": return vm.ecx | 0;
    case "edx": return vm.edx | 0;
    case "esi": return vm.esi | 0;
    case "edi": return vm.edi | 0;
    case "ebp": return vm.ebp | 0;
    case "esp": return vm.esp | 0;
    case "eip": return vm.eip | 0;
    case "ax": return vm.eax & 0xffff;
    case "bx": return vm.ebx & 0xffff;
    case "cx": return vm.ecx & 0xffff;
    case "dx": return vm.edx & 0xffff;
    case "si": return vm.esi & 0xffff;
    case "di": return vm.edi & 0xffff;
    case "bp": return vm.ebp & 0xffff;
    case "sp": return vm.esp & 0xffff;
    case "al": return vm.eax & 0xff;
    case "ah": return (vm.eax >>> 8) & 0xff;
    case "bl": return vm.ebx & 0xff;
    case "bh": return (vm.ebx >>> 8) & 0xff;
    case "cl": return vm.ecx & 0xff;
    case "ch": return (vm.ecx >>> 8) & 0xff;
    case "dl": return vm.edx & 0xff;
    case "dh": return (vm.edx >>> 8) & 0xff;
  }
  return 0;
}

function setReg(vm, name, v) {
  v = v | 0;
  name = name.toLowerCase();
  switch (name) {
    case "eax": vm.eax = v; break;
    case "ebx": vm.ebx = v; break;
    case "ecx": vm.ecx = v; break;
    case "edx": vm.edx = v; break;
    case "esi": vm.esi = v; break;
    case "edi": vm.edi = v; break;
    case "ebp": vm.ebp = v; break;
    case "esp": vm.esp = v; break;
    case "ax": vm.eax = (vm.eax & 0xffff0000) | (v & 0xffff); break;
    case "bx": vm.ebx = (vm.ebx & 0xffff0000) | (v & 0xffff); break;
    case "cx": vm.ecx = (vm.ecx & 0xffff0000) | (v & 0xffff); break;
    case "dx": vm.edx = (vm.edx & 0xffff0000) | (v & 0xffff); break;
    case "si": vm.esi = (vm.esi & 0xffff0000) | (v & 0xffff); break;
    case "di": vm.edi = (vm.edi & 0xffff0000) | (v & 0xffff); break;
    case "bp": vm.ebp = (vm.ebp & 0xffff0000) | (v & 0xffff); break;
    case "sp": vm.esp = (vm.esp & 0xffff0000) | (v & 0xffff); break;
    case "al": vm.eax = (vm.eax & 0xffffff00) | (v & 0xff); break;
    case "ah": vm.eax = (vm.eax & 0xffff00ff) | ((v & 0xff) << 8); break;
    case "bl": vm.ebx = (vm.ebx & 0xffffff00) | (v & 0xff); break;
    case "bh": vm.ebx = (vm.ebx & 0xffff00ff) | ((v & 0xff) << 8); break;
    case "cl": vm.ecx = (vm.ecx & 0xffffff00) | (v & 0xff); break;
    case "ch": vm.ecx = (vm.ecx & 0xffff00ff) | ((v & 0xff) << 8); break;
    case "dl": vm.edx = (vm.edx & 0xffffff00) | (v & 0xff); break;
    case "dh": vm.edx = (vm.edx & 0xffff00ff) | ((v & 0xff) << 8); break;
  }
}

function setFlagsAdd(vm, a, b, r) {
  vm.flags.cf = (r >>> 0) < (a >>> 0);
  vm.flags.of = ((a ^ r) & (b ^ r) & 0x80000000) !== 0;
  vm.flags.zf = r === 0;
  vm.flags.sf = (r & 0x80000000) !== 0;
}
function setFlagsSub(vm, a, b, r) {
  vm.flags.cf = (a >>> 0) < (b >>> 0);
  vm.flags.of = ((a ^ b) & (a ^ r) & 0x80000000) !== 0;
  vm.flags.zf = r === 0;
  vm.flags.sf = (r & 0x80000000) !== 0;
}
function clearArithFlags(vm) {
  vm.flags.cf = false; vm.flags.of = false; vm.flags.zf = false; vm.flags.sf = false;
}

function evalOperand(vm, op) {
  if (op.type === "reg") return { kind: "reg", name: op.name, value: getReg(vm, op.name) };
  if (op.type === "mem") {
    let a = 0;
    for (const t of op.terms) {
      let v;
      if (t.kind === "reg") v = getReg(vm, t.name);
      else if (t.kind === "sym") v = (t.name in vm.labels) ? vm.labels[t.name] : (vm.equates[t.name] || 0);
      else v = t.value;
      a += t.sign * v;
    }
    a = a >>> 0;
    return { kind: "mem", addr: a, size: op.size, value: load(vm, a, op.size) };
  }
  if (op.type === "imm") {
    const value = op.ref !== undefined
      ? ((op.ref in vm.labels) ? vm.labels[op.ref] : ((op.ref in vm.equates) ? vm.equates[op.ref] : 0))
      : op.value;
    return { kind: "imm", value };
  }
  throw new Error("invalid operand");
}

function writeOperand(vm, opv, val) {
  if (opv.kind === "reg") setReg(vm, opv.name, val);
  else if (opv.kind === "mem") store(vm, opv.addr, opv.size, val);
  else throw new Error("cannot write to an immediate value");
}

function jumpToAddr(vm, addr) {
  const idx = vm.addrIndex[addr >>> 0];
  if (idx === undefined) throw new Error(`invalid jump target 0x${(addr >>> 0).toString(16)}`);
  vm.pc = idx;
}

function int80(vm) {
  const eax = vm.eax | 0;
  if (eax === 1 || eax === 60 || eax === 93) {
    vm.status = "exited";
    vm.exitCode = vm.ebx | 0;
    return;
  }
  if (eax === 4) {
    const a = vm.ecx >>> 0;
    const len = vm.edx >>> 0;
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(vm.mem[(a + i) & MEM_MASK]);
    vm.output.push(s);
    return;
  }
  if (eax === 3) {
    const a = vm.ecx >>> 0;
    const len = vm.edx >>> 0;
    const inp = vm.stdinValue || "";
    let i = 0;
    for (; i < len && i < inp.length; i++) vm.mem[(a + i) & MEM_MASK] = inp.charCodeAt(i) & 0xff;
    vm.eax = i;
    return;
  }
  if (eax === 162) { vm.eax = 0; return; } // nanosleep
  throw new Error(`unsupported syscall eax=${eax}`);
}

function readCString(vm, addr) {
  let s = "";
  for (let i = 0; ; i++) {
    const c = vm.mem[(addr + i) & MEM_MASK];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function callWinApi(vm, name) {
  name = name.toLowerCase();
  switch (name) {
    case "exitprocess":
      vm.status = "exited";
      vm.exitCode = load(vm, vm.esp, 4) | 0;
      return true;
    case "messageboxa":
    case "messageboxexa": {
      const hWnd = load(vm, vm.esp, 4) >>> 0;
      const lpText = load(vm, vm.esp + 4, 4) >>> 0;
      const lpCaption = load(vm, vm.esp + 8, 4) >>> 0;
      const uType = load(vm, vm.esp + 12, 4) >>> 0;
      const text = readCString(vm, lpText);
      const caption = readCString(vm, lpCaption);
      const type = uType & 0x0f;   // MB_OK=0, MB_OKCANCEL=1, MB_YESNO=4 ...
      let response = 1;            // IDOK
      if (type === 1 || type === 4 || type === 5) response = 1;
      vm.output.push(`[${caption}] ${text}`);
      vm.eax = response;
      return true;
    }
    case "getstdhandle":
      vm.eax = 0xfffffff5;         // fake STD_OUTPUT_HANDLE
      return true;
    case "writefile": {
      const hFile = load(vm, vm.esp, 4) >>> 0;
      const lpBuffer = load(vm, vm.esp + 4, 4) >>> 0;
      const nBytes = load(vm, vm.esp + 8, 4) >>> 0;
      const lpWritten = load(vm, vm.esp + 12, 4) >>> 0;
      const s = readCString(vm, lpBuffer);
      vm.output.push(s.slice(0, nBytes));
      if (lpWritten) store(vm, lpWritten, 4, Math.min(nBytes, s.length));
      vm.eax = 1;
      return true;
    }
    default:
      return false;
  }
}

function execInst(vm, inst) {
  const { mnem, ops } = inst;
  const startPc = vm.pc;
  const a = ops[0] ? evalOperand(vm, ops[0]) : null;   // first operand
  const b = ops[1] ? evalOperand(vm, ops[1]) : null;   // second operand

  switch (mnem) {
    case "mov":
      writeOperand(vm, a, b.value);
      break;
    case "movzx": {
      const v = b.value & 0xff;
      writeOperand(vm, a, v);
      break;
    }
    case "movsx": {
      const v = b.value & 0xff;
      writeOperand(vm, a, (v & 0x80) ? (v | 0xffffff00) : v);
      break;
    }
    case "lea": {
      const v = b.kind === "mem" ? b.addr : b.value;
      writeOperand(vm, a, v);
      break;
    }
    case "xchg": {
      const v = a.value;
      writeOperand(vm, a, b.value);
      if (b.kind === "reg") setReg(vm, b.name, v);
      else if (b.kind === "mem") store(vm, b.addr, b.size, v);
      break;
    }
    case "add": {
      const r = (a.value + b.value) | 0;
      setFlagsAdd(vm, a.value, b.value, r);
      writeOperand(vm, a, r);
      break;
    }
    case "adc": {
      const c = vm.flags.cf ? 1 : 0;
      const r = (a.value + b.value + c) | 0;
      setFlagsAdd(vm, a.value, b.value + c, r);
      writeOperand(vm, a, r);
      break;
    }
    case "sub": {
      const r = (a.value - b.value) | 0;
      setFlagsSub(vm, a.value, b.value, r);
      writeOperand(vm, a, r);
      break;
    }
    case "sbb": {
      const c = vm.flags.cf ? 1 : 0;
      const r = (a.value - b.value - c) | 0;
      setFlagsSub(vm, a.value, b.value + c, r);
      writeOperand(vm, a, r);
      break;
    }
    case "inc": {
      const r = (a.value + 1) | 0;
      vm.flags.zf = r === 0;
      vm.flags.sf = (r & 0x80000000) !== 0;
      vm.flags.of = (a.value === 0x7fffffff);
      writeOperand(vm, a, r);
      break;
    }
    case "dec": {
      const r = (a.value - 1) | 0;
      vm.flags.zf = r === 0;
      vm.flags.sf = (r & 0x80000000) !== 0;
      vm.flags.of = (a.value === 0x80000000);
      writeOperand(vm, a, r);
      break;
    }
    case "neg": {
      const r = (-a.value) | 0;
      setFlagsSub(vm, 0, a.value, r);
      writeOperand(vm, a, r);
      break;
    }
    case "and": {
      const r = (a.value & b.value) | 0;
      clearArithFlags(vm);
      vm.flags.zf = r === 0; vm.flags.sf = (r & 0x80000000) !== 0;
      writeOperand(vm, a, r);
      break;
    }
    case "or": {
      const r = (a.value | b.value) | 0;
      clearArithFlags(vm);
      vm.flags.zf = r === 0; vm.flags.sf = (r & 0x80000000) !== 0;
      writeOperand(vm, a, r);
      break;
    }
    case "xor": {
      const r = (a.value ^ b.value) | 0;
      clearArithFlags(vm);
      vm.flags.zf = r === 0; vm.flags.sf = (r & 0x80000000) !== 0;
      writeOperand(vm, a, r);
      break;
    }
    case "not":
      writeOperand(vm, a, (~a.value) | 0);
      break;
    case "shl": case "sal": {
      const n = b.value & 31;
      const r = (a.value << n) | 0;
      vm.flags.zf = r === 0; vm.flags.sf = (r & 0x80000000) !== 0;
      writeOperand(vm, a, r);
      break;
    }
    case "shr": {
      const n = b.value & 31;
      const r = (a.value >>> n) | 0;
      vm.flags.zf = r === 0; vm.flags.sf = (r & 0x80000000) !== 0;
      writeOperand(vm, a, r);
      break;
    }
    case "sar": {
      const n = b.value & 31;
      const r = (a.value >> n) | 0;
      vm.flags.zf = r === 0; vm.flags.sf = (r & 0x80000000) !== 0;
      writeOperand(vm, a, r);
      break;
    }
    case "cmp": {
      const r = (a.value - b.value) | 0;
      setFlagsSub(vm, a.value, b.value, r);
      break;
    }
    case "test": {
      const r = (a.value & b.value) | 0;
      clearArithFlags(vm);
      vm.flags.zf = r === 0; vm.flags.sf = (r & 0x80000000) !== 0;
      break;
    }
    case "push":
      vm.esp = (vm.esp - 4) >>> 0;
      store(vm, vm.esp, 4, a.value);
      break;
    case "pop": {
      const v = load(vm, vm.esp, 4);
      vm.esp = (vm.esp + 4) >>> 0;
      writeOperand(vm, a, v);
      break;
    }
    case "pusha": case "pushad": {
      const regs = [vm.eax, vm.ecx, vm.edx, vm.ebx, vm.esp, vm.ebp, vm.esi, vm.edi];
      for (let i = 7; i >= 0; i--) {
        vm.esp = (vm.esp - 4) >>> 0;
        store(vm, vm.esp, 4, regs[i]);
      }
      break;
    }
    case "popa": case "popad": {
      const out = [];
      for (let i = 0; i < 8; i++) {
        out.push(load(vm, vm.esp, 4));
        vm.esp = (vm.esp + 4) >>> 0;
      }
      vm.edi = out[7]; vm.esi = out[6]; vm.ebp = out[5];
      vm.esp = out[4];
      vm.ebx = out[3]; vm.edx = out[2]; vm.ecx = out[1]; vm.eax = out[0];
      break;
    }
    case "call": {
      const ref = ops[0] && ops[0].ref;
      if (ref && vm.externs.has(ref)) {
        const res = callWinApi(vm, ref);
        if (res === false) throw new Error(`cannot emulate external function '${ref}' (WINAPI / driver calls are blocked)`);
        break;
      }
      vm.esp = (vm.esp - 4) >>> 0;
      store(vm, vm.esp, 4, vm.pc + 1);
      jumpToAddr(vm, a.value);
      break;
    }
    case "ret": case "retn": {
      const v = load(vm, vm.esp, 4);
      vm.esp = (vm.esp + 4) >>> 0;
      if (v < 0 || v > vm.insts.length) throw new Error("invalid return address");
      vm.pc = v;
      break;
    }
    case "jmp": jumpToAddr(vm, a.value); break;
    case "je": case "jz": if (vm.flags.zf) jumpToAddr(vm, a.value); break;
    case "jne": case "jnz": if (!vm.flags.zf) jumpToAddr(vm, a.value); break;
    case "jl": if (vm.flags.sf !== vm.flags.of) jumpToAddr(vm, a.value); break;
    case "jle": if (vm.flags.zf || vm.flags.sf !== vm.flags.of) jumpToAddr(vm, a.value); break;
    case "jg": if (!vm.flags.zf && vm.flags.sf === vm.flags.of) jumpToAddr(vm, a.value); break;
    case "jge": if (vm.flags.sf === vm.flags.of) jumpToAddr(vm, a.value); break;
    case "jb": case "jc": if (vm.flags.cf) jumpToAddr(vm, a.value); break;
    case "jbe": if (vm.flags.cf || vm.flags.zf) jumpToAddr(vm, a.value); break;
    case "ja": if (!vm.flags.cf && !vm.flags.zf) jumpToAddr(vm, a.value); break;
    case "jae": case "jnc": if (!vm.flags.cf) jumpToAddr(vm, a.value); break;
    case "js": if (vm.flags.sf) jumpToAddr(vm, a.value); break;
    case "jns": if (!vm.flags.sf) jumpToAddr(vm, a.value); break;
    case "jo": if (vm.flags.of) jumpToAddr(vm, a.value); break;
    case "jno": if (!vm.flags.of) jumpToAddr(vm, a.value); break;
    case "loop": {
      vm.ecx = (vm.ecx - 1) | 0;
      if (vm.ecx !== 0) jumpToAddr(vm, a.value);
      break;
    }
    case "loope": {
      vm.ecx = (vm.ecx - 1) | 0;
      if (vm.ecx !== 0 && vm.flags.zf) jumpToAddr(vm, a.value);
      break;
    }
    case "loopne": {
      vm.ecx = (vm.ecx - 1) | 0;
      if (vm.ecx !== 0 && !vm.flags.zf) jumpToAddr(vm, a.value);
      break;
    }
    case "int":
      if (a.value === 0x80) int80(vm);
      else throw new Error(`interrupt 0x${(a.value & 0xff).toString(16)} is not emulated (only int 0x80)`);
      break;
    case "syscall":
      throw new Error("syscall (64-bit) is not emulated — use int 0x80 (32-bit)");
    case "sysenter":
      throw new Error("sysenter is not emulated");
    case "iret":
      throw new Error("iret is not emulated");
    case "nop": break;
    case "hlt":
      vm.status = "halted";
      break;
    case "clc": vm.flags.cf = false; break;
    case "stc": vm.flags.cf = true; break;
    case "cmc": vm.flags.cf = !vm.flags.cf; break;
    case "cld": break;
    case "std": break;
    case "cdq": case "cwd": vm.edx = vm.eax < 0 ? -1 : 0; break;
    case "cbw": vm.eax = (vm.eax & 0xff) | ((vm.eax & 0x80) ? 0xffffff00 : 0); break;
    case "cwde": vm.eax = (vm.eax & 0xffff) | ((vm.eax & 0x8000) ? 0xffff0000 : 0); break;
    case "mul": case "imul": {
      const x = BigInt(vm.eax >>> 0) & 0xffffffffn;
      const y = BigInt(a.value >>> 0) & 0xffffffffn;
      const prod = x * y;
      vm.eax = Number(prod & 0xffffffffn) | 0;
      vm.edx = Number((prod >> 32n) & 0xffffffffn) | 0;
      vm.flags.cf = vm.edx !== 0;
      vm.flags.of = vm.edx !== 0;
      break;
    }
    case "div": case "idiv": {
      if (a.value === 0) throw new Error("division by zero");
      if (mnem === "div") {
        const num = (BigInt(vm.edx >>> 0) << 32n) | BigInt(vm.eax >>> 0);
        const den = BigInt(a.value >>> 0);
        vm.eax = Number(num / den) | 0;
        vm.edx = Number(num % den) | 0;
      } else {
        const num = (BigInt(vm.edx) << 32n) | BigInt(vm.eax >>> 0);
        const den = BigInt(a.value | 0);
        vm.eax = Number(num / den) | 0;
        vm.edx = Number(num % den) | 0;
      }
      vm.flags.zf = vm.eax === 0;
      vm.flags.sf = (vm.eax & 0x80000000) !== 0;
      break;
    }
    default:
      throw new Error(`instruction '${mnem}' is recognised but not implemented in the sandbox`);
  }

  vm.eip = inst.addr;
  if (vm.pc === startPc) vm.pc++;
}

function makeVM(built, stdinValue) {
  return {
    mem: built.mem,
    labels: built.labels,
    equates: built.equates,
    externs: built.externs,
    insts: built.insts,
    addrIndex: built.addrIndex,
    eax: 0, ebx: 0, ecx: 0, edx: 0, esi: 0, edi: 0, ebp: 0, esp: STACK_BASE, eip: 0,
    flags: { zf: false, sf: false, cf: false, of: false },
    pc: 0,
    output: [],
    exitCode: null,
    status: "ready",
    steps: 0,
    stdinValue: stdinValue || ""
  };
}

/* ============================================================
   5. UI: registers, flags, console, errors, stats
   ============================================================ */
const REG_ORDER = ["eax", "ebx", "ecx", "edx", "esi", "edi", "ebp", "esp", "eip"];

const state = {
  activeLine: -1,
  errorLines: new Set(),
  issues: [],
  dirty: true,
  running: false,
  lastBuilt: null
};

let vm = null;
let lastOutLen = 0;
let runTimer = null;

function initRegs() {
  const g = $("regsGrid");
  g.innerHTML = "";
  for (const r of REG_ORDER) {
    const el = document.createElement("div");
    el.className = "reg";
    el.dataset.reg = r;
    el.innerHTML = `<span class="reg-name">${r.toUpperCase()}</span>` +
                   `<span class="reg-hex">0x00000000</span>` +
                   `<span class="reg-dec">0</span>`;
    g.appendChild(el);
  }
  const fw = $("flagsRow");
  fw.innerHTML = "";
  for (const f of FLAGS) {
    const el = document.createElement("div");
    el.className = "flag";
    el.id = "flag_" + f;
    el.innerHTML = `<b>0</b>${f.toUpperCase()}`;
    fw.appendChild(el);
  }
}

function renderRegisters() {
  if (!vm) return;
  for (const r of REG_ORDER) {
    const el = document.querySelector(`.reg[data-reg="${r}"]`);
    if (!el) continue;
    const v = r === "eip" ? vm.eip : getReg(vm, r);
    const hexStr = hex32(v);
    const hexEl = el.querySelector(".reg-hex");
    const decEl = el.querySelector(".reg-dec");
    const decStr = (v >>> 0).toString();
    if (hexEl.textContent !== hexStr) {
      hexEl.textContent = hexStr;
      decEl.textContent = decStr;
      el.classList.remove("changed");
      void el.offsetWidth;
      el.classList.add("changed");
    }
  }
  for (const f of FLAGS) {
    const el = $("flag_" + f);
    if (el) {
      el.classList.toggle("on", !!vm.flags[f]);
      el.querySelector("b").textContent = vm.flags[f] ? "1" : "0";
    }
  }
  $("statEip").textContent = hex32(vm.eip);
  $("statSteps").textContent = vm.steps;
  $("statStatus").textContent = vm.status === "running" ? "Running" : vm.status.toUpperCase();
}

function clearConsole() {
  const c = $("console");
  c.textContent = "";
  const prog = document.createElement("div");
  prog.className = "prog-out";
  prog.id = "progOut";
  c.appendChild(prog);
  lastOutLen = 0;
}

function renderConsole() {
  if (!vm) return;
  const prog = $("progOut");
  if (!prog) return;
  const full = vm.output.join("");
  if (full.length > lastOutLen) {
    prog.appendChild(document.createTextNode(full.slice(lastOutLen)));
    lastOutLen = full.length;
    $("console").scrollTop = $("console").scrollHeight;
  }
}

function addSystemLine(text, cls = "") {
  const c = $("console");
  const el = document.createElement("div");
  el.className = "system" + (cls ? " " + cls : "");
  el.textContent = text;
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function renderErrors() {
  const box = $("errors");
  $("errCount").textContent = state.issues.length;
  if (state.issues.length === 0) {
    box.innerHTML = `<div class="errors-empty">No errors — the code is valid NASM syntax.</div>`;
  } else {
    box.innerHTML = state.issues
      .map(e => `<div class="err-item"><b>${e.lineNo + 1}</b>${escapeHtml(e.msg)}</div>`)
      .join("");
  }
}

function updateButtons() {
  const running = state.running;
  $("stepBtn").disabled = state.issues.length > 0 || running;
  $("runBtn").disabled = state.issues.length > 0;
  $("resetBtn").disabled = running;
}

/* ============================================================
   6. Validation (debounced, live)
   ============================================================ */
function runValidation() {
  const built = buildProgram(code.value);
  state.lastBuilt = built;
  state.issues = built.issues;
  state.errorLines = new Set(built.issues.map(e => e.lineNo));
  renderErrors();
  renderHighlight();
  renderGutter();
  updateButtons();
  if (built.issues.length) {
    setStatus(`Found ${built.issues.length} syntax error${built.issues.length > 1 ? "s" : ""}`);
  } else if (state.dirty && !state.running) {
    setStatus("Ready — write NASM code and press Run");
  }
}

/* ============================================================
   7. Controls: step / run / reset / download
   ============================================================ */
function setStatus(msg) {
  $("statusMsg").textContent = msg;
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function ensureVM() {
  if (vm && !state.dirty) return vm;
  const built = state.lastBuilt || buildProgram(code.value);
  vm = makeVM(built, $("stdin").value);
  state.dirty = false;
  clearConsole();
  return vm;
}

function scrollLineIntoView(lineNo) {
  const lh = parseFloat(getComputedStyle(code).lineHeight) || 22;
  const vh = code.clientHeight;
  const target = lineNo * lh;
  if (target < code.scrollTop + 20) code.scrollTop = Math.max(0, target - lh * 2);
  else if (target + lh > code.scrollTop + vh - 20) code.scrollTop = target - vh + lh * 3;
  syncScroll();
}

function stepOnce() {
  if (state.issues.length) { toast("Fix the syntax errors first"); return; }
  const v = ensureVM();

  if (v.status === "exited" || v.status === "halted" || v.status.startsWith("error")) {
    toast("Program finished — press Reset to run again");
    return;
  }

  const inst = v.insts[v.pc];
  if (!inst) {
    v.status = "halted";
    addSystemLine("; reached end of program", "ok");
    setStatus("End of program reached");
    renderRegisters();
    return;
  }

  try {
    execInst(v, inst);
  } catch (e) {
    v.status = "error: " + e.message;
    addSystemLine("; runtime error: " + e.message, "err");
    setStatus("Runtime error: " + e.message);
    renderRegisters();
    return;
  }

  v.steps++;
  if (v.steps > 100000) {
    v.status = "error: step limit exceeded (possible infinite loop)";
    addSystemLine("; step limit exceeded — possible infinite loop", "err");
  }

  state.activeLine = inst.lineNo;
  scrollLineIntoView(inst.lineNo);
  renderHighlight();
  renderGutter();
  renderRegisters();
  renderConsole();

  if (v.status === "exited") {
    addSystemLine(`; program exited with code ${v.exitCode}`, v.exitCode === 0 ? "ok" : "err");
    setStatus(v.exitCode === 0 ? "Program exited with code 0" : `Program exited with code ${v.exitCode}`);
  } else if (v.status === "halted") {
    addSystemLine("; halted", "ok");
    setStatus("Halted (hlt)");
  } else if (v.status.startsWith("error")) {
    setStatus("Runtime error: " + v.status.slice(6));
  } else {
    setStatus(`Executing ${inst.mnem} · line ${inst.lineNo + 1} · addr ${hex32(inst.addr)}`);
  }
}

function run() {
  if (state.running) { stopRun(false); return; }
  if (state.issues.length) { toast("Fix the syntax errors first"); return; }

  resetVM(false);
  state.running = true;
  $("runBtn").innerHTML = `<span class="btn-ic">■</span><span class="btn-txt">Stop</span>`;
  updateButtons();

  runTimer = setInterval(() => {
    stepOnce();
    if (vm.status === "exited" || vm.status === "halted" || vm.status.startsWith("error")) {
      stopRun(true);
    }
  }, 24);
}

function stopRun(completed) {
  clearInterval(runTimer);
  runTimer = null;
  state.running = false;
  $("runBtn").innerHTML = `<span class="btn-ic">▶</span><span class="btn-txt">Run</span>`;
  updateButtons();
  if (!completed) toast("Program stopped");
}

function resetVM(notify = true) {
  state.dirty = true;
  state.activeLine = -1;
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
  state.running = false;
  clearConsole();
  runValidation();
  const built = state.lastBuilt || buildProgram(code.value);
  vm = makeVM(built, $("stdin").value);
  state.dirty = false;
  renderRegisters();
  $("runBtn").innerHTML = `<span class="btn-ic">▶</span><span class="btn-txt">Run</span>`;
  updateButtons();
  if (notify) {
    toast("Emulation reset");
    setStatus("Ready — write NASM code and press Run");
  }
}

$("runBtn").addEventListener("click", run);
$("stepBtn").addEventListener("click", stepOnce);
$("resetBtn").addEventListener("click", () => resetVM(true));

function downloadAsm() {
  const blob = new Blob([code.value], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "main.asm";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("main.asm downloaded");
}
$("downloadBtn").addEventListener("click", downloadAsm);

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-body").forEach(b => b.classList.remove("active"));
    tab.classList.add("active");
    $("body-" + tab.dataset.tab).classList.add("active");
  });
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
  if (e.key === "F9") { e.preventDefault(); if (!state.running) stepOnce(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); downloadAsm(); }
});

/* ============================================================
   8. Init
   ============================================================ */
code.value = DEFAULT_CODE;
initRegs();
clearConsole();
addSystemLine("; AsmCode virtual console — program output appears here");
addSystemLine("; run with ▸ Run (Ctrl+Enter) or step with F9", "");
onEdit();
