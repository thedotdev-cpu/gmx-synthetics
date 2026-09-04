import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

type FnSpan = {
  file: string;
  name: string;
  header: string;
  visibility: string;
  mutability: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  body: string;
};

type Hit = {
  rule: string;
  confidence: "high" | "medium" | "triage";
  file: string;
  line: number;
  fn: string;
  message: string;
  code: string;
};

const ROOT = process.cwd();
const CONTRACTS = path.join(ROOT, "contracts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && entry.name.endsWith(".sol")) out.push(p);
  }
  return out.sort();
}

// Replaces comments and quoted strings with spaces while preserving byte offsets/newlines.
function sanitize(source: string): string {
  const chars = source.split("");
  let state: "code" | "line" | "block" | "single" | "double" = "code";
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const n = chars[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        chars[i] = chars[i + 1] = " ";
        state = "line";
        i++;
      } else if (c === "/" && n === "*") {
        chars[i] = chars[i + 1] = " ";
        state = "block";
        i++;
      } else if (c === "'") {
        chars[i] = " ";
        state = "single";
      } else if (c === '"') {
        chars[i] = " ";
        state = "double";
      }
    } else if (state === "line") {
      if (c === "\n") state = "code";
      else chars[i] = " ";
    } else if (state === "block") {
      if (c === "*" && n === "/") {
        chars[i] = chars[i + 1] = " ";
        state = "code";
        i++;
      } else if (c !== "\n") chars[i] = " ";
    } else {
      if (escaped) {
        if (c !== "\n") chars[i] = " ";
        escaped = false;
      } else if (c === "\\") {
        chars[i] = " ";
        escaped = true;
      } else if ((state === "single" && c === "'") || (state === "double" && c === '"')) {
        chars[i] = " ";
        state = "code";
      } else if (c !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function matchingBrace(clean: string, open: number): number {
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return clean.length - 1;
}

function parseFunctions(file: string, source: string): FnSpan[] {
  const clean = sanitize(source);
  const starts = lineStarts(source);
  const relative = path.relative(ROOT, file).replace(/\\/g, "/");
  const spans: FnSpan[] = [];
  const rx = /\b(function\s+([A-Za-z_]\w*)\s*\([^;{}]*\)|constructor\s*\([^;{}]*\)|fallback\s*\([^;{}]*\)|receive\s*\(\s*\))([^;{}]*)([;{])/gms;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(clean))) {
    const delimiter = m[4];
    if (delimiter === ";") continue;
    const open = m.index + m[0].lastIndexOf("{");
    const close = matchingBrace(clean, open);
    const header = source.slice(m.index, open).replace(/\s+/g, " ").trim();
    const name = m[2] || (header.startsWith("constructor") ? "constructor" : header.startsWith("fallback") ? "fallback" : "receive");
    const visibility = /\bexternal\b/.test(header) ? "external" : /\bpublic\b/.test(header) ? "public" : /\bprivate\b/.test(header) ? "private" : "internal";
    const mutability = /\bview\b/.test(header) ? "view" : /\bpure\b/.test(header) ? "pure" : /\bpayable\b/.test(header) ? "payable" : "nonpayable";
    spans.push({
      file: relative,
      name,
      header,
      visibility,
      mutability,
      start: m.index,
      end: close + 1,
      startLine: lineAt(starts, m.index),
      endLine: lineAt(starts, close),
      body: source.slice(open + 1, close),
    });
    rx.lastIndex = close + 1;
  }
  return spans;
}

function compact(s: string, max = 360): string {
  const v = s.replace(/\s+/g, " ").trim();
  return v.length > max ? v.slice(0, max) + "…" : v;
}

function contextLine(source: string, line: number): string {
  return (source.split(/\r?\n/)[line - 1] || "").trim();
}

function invocationAt(source: string, start: number): string {
  const open = source.indexOf("(", start);
  if (open < 0) return source.slice(start, start + 300);
  const clean = sanitize(source);
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "(") depth++;
    else if (clean[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start, Math.min(start + 1000, source.length));
}

function containingFn(spans: FnSpan[], offset: number): FnSpan | undefined {
  return spans.find((f) => offset >= f.start && offset < f.end);
}

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

describe("audit source sweep", function () {
  this.timeout(120_000);

  it("emits a deterministic high-signal contracts report", async () => {
    const files = walk(CONTRACTS);
    const sources = new Map<string, string>();
    const functions = new Map<string, FnSpan[]>();
    const allFunctions: FnSpan[] = [];
    let totalLines = 0;

    for (const absolute of files) {
      const rel = path.relative(ROOT, absolute).replace(/\\/g, "/");
      const source = fs.readFileSync(absolute, "utf8");
      sources.set(rel, source);
      totalLines += source.split(/\r?\n/).length;
      const spans = parseFunctions(absolute, source);
      functions.set(rel, spans);
      allFunctions.push(...spans);
    }

    const hits: Hit[] = [];
    const addHit = (rule: string, confidence: Hit["confidence"], file: string, line: number, fn: string, message: string, code: string) => {
      hits.push({ rule, confidence, file, line, fn, message, code: compact(code) });
    };

    const guardRx = /\bonly[A-Z]\w*\b|\bnonReentrant\b|\bglobalNonReentrant\b|\bvalidateSender\b|\bwithOraclePrices\b|\bonlyGov\b|\bonlyController\b/;
    for (const fn of allFunctions) {
      if ((fn.visibility === "external" || fn.visibility === "public") && fn.mutability !== "view" && fn.mutability !== "pure" && fn.name !== "constructor") {
        if (!guardRx.test(fn.header)) {
          addHit("EXTERNAL_MUTATOR_NO_EXPLICIT_GUARD", "triage", fn.file, fn.startLine, fn.name, "Public/external state-changing function has no explicit role/reentrancy/oracle modifier in its own header; inherited/internal gates must be verified.", fn.header);
        }
      }

      const body = fn.body;
      const callPatterns = [
        /\.delegatecall\s*\(/,
        /\.call\s*(?:\{|\()/,
        /\.staticcall\s*\(/,
        /\bassembly\s*\{/,
        /\bselfdestruct\s*\(/,
        /\btx\.origin\b/,
      ];
      for (const rx of callPatterns) {
        const m = rx.exec(body);
        if (m) addHit("LOW_LEVEL_OR_ASSEMBLY", "medium", fn.file, fn.startLine + body.slice(0, m.index).split("\n").length - 1, fn.name, `Sensitive primitive matched ${rx.source}.`, body.slice(Math.max(0, m.index - 120), m.index + 260));
      }

      const catchRx = /catch(?:\s*\([^)]*\))?\s*\{([\s\S]*?)\}/g;
      let cm: RegExpExecArray | null;
      while ((cm = catchRx.exec(body))) {
        const cb = cm[1];
        if (!/\brevert\b|\breturn\b|\bemit\b|EventUtils|ErrorUtils|cancel|freeze|handle/i.test(cb)) {
          addHit("SWALLOWED_CATCH", "medium", fn.file, fn.startLine + body.slice(0, cm.index).split("\n").length - 1, fn.name, "Catch body appears to suppress failure without an explicit lifecycle/error action.", cm[0]);
        }
      }

      const extTokens = [".call(", ".call{", ".delegatecall(", "transferOut(", "safeTransfer(", "safeTransferFrom(", "CallbackUtils.", ".sendValue("];
      const stateTokens = ["dataStore.set", "dataStore.add", "dataStore.remove", "dataStore.increment", "dataStore.decrement", "StoreUtils.set", "StoreUtils.remove", ".setUint(", ".setInt(", ".setAddress(", ".setBool("];
      let firstExternal = Number.MAX_SAFE_INTEGER;
      for (const t of extTokens) {
        const p = body.indexOf(t);
        if (p >= 0) firstExternal = Math.min(firstExternal, p);
      }
      let stateAfter = -1;
      for (const t of stateTokens) {
        const p = body.indexOf(t, firstExternal === Number.MAX_SAFE_INTEGER ? 0 : firstExternal + 1);
        if (p >= 0) stateAfter = stateAfter < 0 ? p : Math.min(stateAfter, p);
      }
      if (firstExternal !== Number.MAX_SAFE_INTEGER && stateAfter > firstExternal) {
        addHit("EXTERNAL_EFFECT_BEFORE_LATER_STATE_WRITE", "triage", fn.file, fn.startLine + body.slice(0, firstExternal).split("\n").length - 1, fn.name, "An external/token/callback effect appears before a later persistent write; verify CEI and global reentrancy coverage.", body.slice(Math.max(0, firstExternal - 160), Math.min(body.length, stateAfter + 240)));
      }

      const loopRx = /for\s*\([^;]*;[^;]*(?:\.length|get\w*Count\(|count|Count)[^;]*;[^)]*\)/g;
      let lm: RegExpExecArray | null;
      while ((lm = loopRx.exec(body))) {
        addHit("DYNAMIC_LOOP", "triage", fn.file, fn.startLine + body.slice(0, lm.index).split("\n").length - 1, fn.name, "Loop bound depends on a dynamic collection/count; verify an enforced cap and failure isolation.", lm[0]);
      }

      const decodeRx = /abi\.decode\s*\(/g;
      let dm: RegExpExecArray | null;
      while ((dm = decodeRx.exec(body))) {
        const before = body.slice(Math.max(0, dm.index - 300), dm.index);
        if (!/\.length\s*[<>=!]|validate\w*Data|try/i.test(before)) {
          addHit("ABI_DECODE_WITHOUT_NEARBY_LENGTH_GUARD", "triage", fn.file, fn.startLine + body.slice(0, dm.index).split("\n").length - 1, fn.name, "abi.decode has no nearby obvious payload-length validation; confirm caller/authentication makes malformed input harmless.", body.slice(Math.max(0, dm.index - 120), dm.index + 300));
        }
      }
    }

    const criticalNames = [
      "recordTransferIn",
      "transferOut",
      "payExecutionFee",
      "transferExcessiveExecutionFee",
      "afterOrderExecution",
      "afterOrderCancellation",
      "afterOrderFrozen",
      "afterDepositExecution",
      "afterDepositCancellation",
      "afterWithdrawalExecution",
      "afterWithdrawalCancellation",
      "afterShiftExecution",
      "afterShiftCancellation",
      "updateFundingAndBorrowingState",
      "bridgeOutFromController",
      "GMX_DATA_ACTION",
      "dataList",
      "multicall",
      "delegatecall",
    ];

    const slices: Array<{ name: string; file: string; line: number; fn: string; call: string }> = [];
    for (const [file, source] of sources) {
      const starts = lineStarts(source);
      const spans = functions.get(file) || [];
      for (const name of criticalNames) {
        let cursor = 0;
        while (true) {
          const at = source.indexOf(name, cursor);
          if (at < 0) break;
          const fn = containingFn(spans, at);
          slices.push({ name, file, line: lineAt(starts, at), fn: fn?.name || "<file-scope>", call: compact(invocationAt(source, at), 700) });
          cursor = at + name.length;
        }
      }
    }

    // Match exact Keys.X constants used through typed DataStore collection/value APIs.
    const keyUse = new Map<string, Array<{ type: string; op: string; file: string; line: number; code: string }>>();
    const typedRx = /(?:[A-Za-z_]\w*\.)*dataStore\.(get|set|add|remove|increment|decrement)(Address|Uint|Int|Bool|Bytes32|Bytes|String)(Count|ValuesAt)?\s*\(\s*(Keys\.[A-Z0-9_]+)/g;
    for (const [file, source] of sources) {
      const starts = lineStarts(source);
      let m: RegExpExecArray | null;
      while ((m = typedRx.exec(source))) {
        const [, op, type, suffix, key] = m;
        const list = keyUse.get(key) || [];
        list.push({ type: type + (suffix || ""), op, file, line: lineAt(starts, m.index), code: contextLine(source, lineAt(starts, m.index)) });
        keyUse.set(key, list);
      }
    }

    const typedMismatches: Array<{ key: string; uses: any[] }> = [];
    for (const [key, uses] of keyUse) {
      const bases = new Set(uses.map((u) => u.type.replace(/Count|ValuesAt/g, "")));
      if (bases.size > 1) typedMismatches.push({ key, uses });
    }

    // Source-level division sites with non-literal denominators.
    const divisions: Array<{ file: string; line: number; fn: string; code: string }> = [];
    for (const [file, source] of sources) {
      const spans = functions.get(file) || [];
      const lines = source.split(/\r?\n/);
      lines.forEach((line, i) => {
        const cleaned = line.replace(/\/\/.*$/, "");
        if (/\/(?![/*=])\s*[A-Za-z_(]/.test(cleaned) && !/https?:\/\//.test(cleaned)) {
          const offset = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
          divisions.push({ file, line: i + 1, fn: containingFn(spans, offset)?.name || "<file-scope>", code: compact(cleaned) });
        }
      });
    }

    const directoryCounts: Record<string, { files: number; lines: number }> = {};
    for (const [file, source] of sources) {
      const dir = file.split("/")[1] || "root";
      directoryCounts[dir] ||= { files: 0, lines: 0 };
      directoryCounts[dir].files++;
      directoryCounts[dir].lines += source.split(/\r?\n/).length;
    }

    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        gitHead: git("rev-parse", "HEAD"),
        gitParents: git("show", "-s", "--format=%P", "HEAD"),
        contractsTree: git("rev-parse", "HEAD:contracts"),
        files: files.length,
        lines: totalLines,
        functions: allFunctions.length,
        externalMutators: allFunctions.filter((f) => (f.visibility === "external" || f.visibility === "public") && f.mutability !== "view" && f.mutability !== "pure").length,
        combinedSourceSha256: sha256([...sources].map(([f, s]) => `${f}\0${sha256(s)}`).join("\n")),
      },
      directoryCounts,
      hitCounts: hits.reduce((acc: Record<string, number>, h) => ((acc[h.rule] = (acc[h.rule] || 0) + 1), acc), {}),
      criticalSliceCounts: slices.reduce((acc: Record<string, number>, h) => ((acc[h.name] = (acc[h.name] || 0) + 1), acc), {}),
      typedMismatchCount: typedMismatches.length,
      divisionCount: divisions.length,
    };

    console.log("AUDIT_REPORT_BEGIN");
    console.log("AUDIT_SUMMARY|" + JSON.stringify(report));

    console.log("AUDIT_SECTION|TYPED_DATASTORE_MISMATCHES");
    for (const item of typedMismatches) console.log("TYPE_MISMATCH|" + JSON.stringify(item));

    console.log("AUDIT_SECTION|HEURISTIC_HITS");
    for (const h of hits.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log("HIT|" + JSON.stringify(h));
    }

    console.log("AUDIT_SECTION|CRITICAL_CALL_SLICES");
    for (const s of slices.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log("SLICE|" + JSON.stringify(s));
    }

    console.log("AUDIT_SECTION|DIVISION_SITES");
    for (const d of divisions) console.log("DIVISION|" + JSON.stringify(d));

    console.log("AUDIT_SECTION|FILE_MANIFEST");
    for (const [file, source] of sources) console.log("FILE|" + JSON.stringify({ file, lines: source.split(/\r?\n/).length, sha256: sha256(source) }));
    console.log("AUDIT_REPORT_END");
  });
});
