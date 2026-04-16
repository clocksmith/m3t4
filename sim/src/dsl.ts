// ============ Attribute expression DSL ============
//
// A tiny AST-compiled expression language used to express attribute
// trajectories. Safe enough to run untrusted user input server-side:
//
//   • Whitelisted operators and functions only
//   • Read-only access to: tick, self.*, opp.*, game.*
//   • No loops, no assignment, no property access beyond the whitelist
//   • AST depth ≤ 8, total nodes ≤ 40, rejected otherwise
//   • No eval, no Function — pure tree-walking interpreter
//
// Examples of valid expressions:
//   "0.3 + 0.6 * clamp(tick/1200, 0, 1)"
//   "self.hp < 40 ? 0.9 : 0.2"
//   "90 + 30 * sin(tick * 0.013)"
//   "opp.hasToken && opp.y < 300 ? 0.8 : 0.0"

import type { AttributeSpec, Observation, Params, ParamKey } from "./types.js";
import { DEFAULT_PARAMS, PARAM_KEYS } from "./types.js";

// ---------- AST types ----------

type Expr =
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "var"; path: string[] }
  | { t: "bin"; op: BinOp; a: Expr; b: Expr }
  | { t: "un"; op: UnOp; a: Expr }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "call"; fn: keyof typeof FN_TABLE; args: Expr[] };

type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||";
type UnOp = "-" | "!";

// ---------- Whitelisted functions ----------

const FN_TABLE = {
  sin: (x: number) => Math.sin(x),
  cos: (x: number) => Math.cos(x),
  abs: (x: number) => Math.abs(x),
  sqrt: (x: number) => Math.sqrt(Math.max(0, x)),
  floor: (x: number) => Math.floor(x),
  ceil: (x: number) => Math.ceil(x),
  min: (a: number, b: number) => Math.min(a, b),
  max: (a: number, b: number) => Math.max(a, b),
  clamp: (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi),
  sign: (x: number) => Math.sign(x),
  step: (edge: number, x: number) => (x < edge ? 0 : 1),
  smoothstep: (edge0: number, edge1: number, x: number) => {
    const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
    return t * t * (3 - 2 * t);
  },
} as const;

type FnName = keyof typeof FN_TABLE;
const FN_ARITY: Record<FnName, number> = {
  sin: 1,
  cos: 1,
  abs: 1,
  sqrt: 1,
  floor: 1,
  ceil: 1,
  sign: 1,
  min: 2,
  max: 2,
  step: 2,
  clamp: 3,
  smoothstep: 3,
};

// ---------- Tokenizer ----------

type Token =
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" }
  | { t: "dot" }
  | { t: "q" }
  | { t: "colon" };

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i;
      while (j < n && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i;
      while (
        j < n &&
        ((src[j] >= "a" && src[j] <= "z") ||
          (src[j] >= "A" && src[j] <= "Z") ||
          (src[j] >= "0" && src[j] <= "9") ||
          src[j] === "_")
      )
        j++;
      const word = src.slice(i, j);
      if (word === "true") toks.push({ t: "num", v: 1 });
      else if (word === "false") toks.push({ t: "num", v: 0 });
      else toks.push({ t: "ident", v: word });
      i = j;
      continue;
    }
    if (c === "(") { toks.push({ t: "lp" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp" }); i++; continue; }
    if (c === ",") { toks.push({ t: "comma" }); i++; continue; }
    if (c === ".") { toks.push({ t: "dot" }); i++; continue; }
    if (c === "?") { toks.push({ t: "q" }); i++; continue; }
    if (c === ":") { toks.push({ t: "colon" }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "<=" || two === ">=" || two === "==" || two === "!=") {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>!".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`DSL: unexpected character '${c}' at ${i}`);
  }
  return toks;
}

// ---------- Recursive-descent parser ----------

class Parser {
  private p = 0;
  constructor(private toks: Token[]) {}
  private peek(): Token | undefined {
    return this.toks[this.p];
  }
  private eat(): Token {
    const t = this.toks[this.p];
    if (!t) throw new Error("DSL: unexpected end");
    this.p++;
    return t;
  }
  private match(pred: (t: Token) => boolean): Token | null {
    const t = this.toks[this.p];
    if (t && pred(t)) {
      this.p++;
      return t;
    }
    return null;
  }

  parse(): Expr {
    const e = this.parseTernary();
    if (this.p !== this.toks.length) throw new Error("DSL: trailing tokens");
    return e;
  }

  private parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.match((t) => t.t === "q")) {
      const a = this.parseTernary();
      if (!this.match((t) => t.t === "colon")) throw new Error("DSL: expected ':'");
      const b = this.parseTernary();
      return { t: "cond", c: cond, a, b };
    }
    return cond;
  }
  private parseOr(): Expr {
    let e = this.parseAnd();
    while (this.match((t) => t.t === "op" && t.v === "||")) {
      const r = this.parseAnd();
      e = { t: "bin", op: "||", a: e, b: r };
    }
    return e;
  }
  private parseAnd(): Expr {
    let e = this.parseEq();
    while (this.match((t) => t.t === "op" && t.v === "&&")) {
      const r = this.parseEq();
      e = { t: "bin", op: "&&", a: e, b: r };
    }
    return e;
  }
  private parseEq(): Expr {
    let e = this.parseCmp();
    while (true) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "==" || t.v === "!=")) {
        this.p++;
        const r = this.parseCmp();
        e = { t: "bin", op: t.v as BinOp, a: e, b: r };
      } else break;
    }
    return e;
  }
  private parseCmp(): Expr {
    let e = this.parseAdd();
    while (true) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "<" || t.v === "<=" || t.v === ">" || t.v === ">=")) {
        this.p++;
        const r = this.parseAdd();
        e = { t: "bin", op: t.v as BinOp, a: e, b: r };
      } else break;
    }
    return e;
  }
  private parseAdd(): Expr {
    let e = this.parseMul();
    while (true) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        this.p++;
        const r = this.parseMul();
        e = { t: "bin", op: t.v as BinOp, a: e, b: r };
      } else break;
    }
    return e;
  }
  private parseMul(): Expr {
    let e = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.p++;
        const r = this.parseUnary();
        e = { t: "bin", op: t.v as BinOp, a: e, b: r };
      } else break;
    }
    return e;
  }
  private parseUnary(): Expr {
    const t = this.peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "!")) {
      this.p++;
      const a = this.parseUnary();
      return { t: "un", op: t.v as UnOp, a };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Expr {
    const t = this.eat();
    if (t.t === "num") return { t: "num", v: t.v };
    if (t.t === "lp") {
      const e = this.parseTernary();
      if (!this.match((x) => x.t === "rp")) throw new Error("DSL: expected ')'");
      return e;
    }
    if (t.t === "ident") {
      // function call?
      if (this.match((x) => x.t === "lp")) {
        const args: Expr[] = [];
        if (!this.match((x) => x.t === "rp")) {
          args.push(this.parseTernary());
          while (this.match((x) => x.t === "comma")) args.push(this.parseTernary());
          if (!this.match((x) => x.t === "rp")) throw new Error("DSL: expected ')' after call args");
        }
        if (!(t.v in FN_TABLE)) throw new Error(`DSL: unknown function '${t.v}'`);
        const fn = t.v as FnName;
        if (args.length !== FN_ARITY[fn])
          throw new Error(`DSL: ${fn} expects ${FN_ARITY[fn]} args, got ${args.length}`);
        return { t: "call", fn, args };
      }
      // variable path: ident (.ident)*
      const path = [t.v];
      while (this.match((x) => x.t === "dot")) {
        const n = this.eat();
        if (n.t !== "ident") throw new Error("DSL: expected identifier after '.'");
        path.push(n.v);
      }
      return { t: "var", path };
    }
    throw new Error(`DSL: unexpected token ${JSON.stringify(t)}`);
  }
}

// ---------- AST validation ----------

const ALLOWED_VARS: Set<string> = new Set([
  "tick",
  "self.x",
  "self.y",
  "self.vx",
  "self.vy",
  "self.hp",
  "self.facing",
  "self.onGround",
  "self.hasToken",
  "self.stun",
  "self.swipeT",
  "self.swipeCD",
  "self.diveT",
  "self.diveCD",
  "self.dead",
  "opp.x",
  "opp.y",
  "opp.vx",
  "opp.vy",
  "opp.hp",
  "opp.facing",
  "opp.onGround",
  "opp.hasToken",
  "opp.stun",
  "opp.swipeT",
  "opp.diveT",
  "opp.dead",
  "game.dx",
  "game.absDx",
  "game.dy",
  "game.goalExists",
  "game.goalX",
  "game.goalY",
  "game.goalTimer",
]);

const MAX_DEPTH = 8;
const MAX_NODES = 40;

function validate(e: Expr, depth = 0): number {
  if (depth > MAX_DEPTH) throw new Error(`DSL: expression too deep (> ${MAX_DEPTH})`);
  let count = 1;
  switch (e.t) {
    case "num":
    case "bool":
      return 1;
    case "var": {
      const path = e.path.join(".");
      if (!ALLOWED_VARS.has(path))
        throw new Error(`DSL: variable '${path}' is not allowed (see whitelist in dsl.ts)`);
      return 1;
    }
    case "bin":
      count += validate(e.a, depth + 1);
      count += validate(e.b, depth + 1);
      return count;
    case "un":
      count += validate(e.a, depth + 1);
      return count;
    case "cond":
      count += validate(e.c, depth + 1);
      count += validate(e.a, depth + 1);
      count += validate(e.b, depth + 1);
      return count;
    case "call":
      for (const a of e.args) count += validate(a, depth + 1);
      return count;
  }
}

// ---------- Evaluator ----------

export interface EvalCtx {
  tick: number;
  obs: Observation;
}

function readVar(path: string[], ctx: EvalCtx): number {
  if (path.length === 1 && path[0] === "tick") return ctx.tick;
  const root = path[0];
  const key = path[1];
  if (!key) throw new Error(`DSL: expected '${root}.<field>'`);
  const o = ctx.obs;
  if (root === "self") {
    const s = o.self as Record<string, unknown>;
    const v = s[key];
    return coerceNum(v);
  }
  if (root === "opp") {
    const s = o.opp as Record<string, unknown>;
    const v = s[key];
    return coerceNum(v);
  }
  if (root === "game") {
    switch (key) {
      case "dx": return o.dx;
      case "absDx": return o.absDx;
      case "dy": return o.dy;
      case "goalExists": return o.goal.exists ? 1 : 0;
      case "goalX": return o.goal.x;
      case "goalY": return o.goal.y;
      case "goalTimer": return o.goal.timer;
    }
  }
  throw new Error(`DSL: unknown variable '${path.join(".")}'`);
}

function coerceNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

function evalExpr(e: Expr, ctx: EvalCtx): number {
  switch (e.t) {
    case "num": return e.v;
    case "bool": return e.v ? 1 : 0;
    case "var": return readVar(e.path, ctx);
    case "un": {
      const a = evalExpr(e.a, ctx);
      return e.op === "-" ? -a : a === 0 ? 1 : 0;
    }
    case "bin": {
      const a = evalExpr(e.a, ctx);
      const b = evalExpr(e.b, ctx);
      switch (e.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? 0 : a / b;
        case "%": return b === 0 ? 0 : a % b;
        case "<": return a < b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
        case "&&": return a !== 0 && b !== 0 ? 1 : 0;
        case "||": return a !== 0 || b !== 0 ? 1 : 0;
      }
    }
    case "cond": {
      const c = evalExpr(e.c, ctx);
      return c !== 0 ? evalExpr(e.a, ctx) : evalExpr(e.b, ctx);
    }
    case "call": {
      const fn = FN_TABLE[e.fn] as (...xs: number[]) => number;
      const vs = e.args.map((a) => evalExpr(a, ctx));
      return fn(...vs);
    }
  }
}

// ---------- Public: compile + evaluate an AttributeSpec ----------

export type AttributeEvaluator = (ctx: EvalCtx) => number;

export function compileAttribute(spec: AttributeSpec | undefined, fallback: number): AttributeEvaluator {
  if (spec === undefined || spec === null) return () => fallback;
  if (typeof spec === "number") return () => spec;
  if (typeof spec === "string") {
    const tokens = tokenize(spec);
    const ast = new Parser(tokens).parse();
    const size = validate(ast);
    if (size > MAX_NODES)
      throw new Error(`DSL: expression too complex (${size} > ${MAX_NODES} nodes)`);
    return (ctx) => evalExpr(ast, ctx);
  }
  // Structured object: base + ramp + oscillate + triggers
  const base = spec.base ?? fallback;
  const ramp = spec.ramp;
  const osc = spec.oscillate;
  const triggers = (spec.triggers ?? []).map((tr) => {
    const toks = tokenize(tr.when);
    const ast = new Parser(toks).parse();
    const size = validate(ast);
    if (size > MAX_NODES)
      throw new Error(`DSL: trigger condition too complex (${size} > ${MAX_NODES})`);
    return { ast, value: tr.value };
  });
  return (ctx) => {
    // triggers win over base when any is active (first match)
    for (const tr of triggers) if (evalExpr(tr.ast, ctx) !== 0) return tr.value;
    let v = base;
    if (ramp) v += (ramp.to - base) * Math.min(1, ctx.tick / Math.max(1, ramp.overTicks));
    if (osc) v += osc.amp * Math.sin(((2 * Math.PI) / osc.period) * ctx.tick + (osc.phase ?? 0));
    return v;
  };
}

// ---------- Compile a whole brain config ----------

export interface CompiledBrain {
  id: string;
  author?: string;
  evaluators: Record<ParamKey, AttributeEvaluator>;
}

export function compileBrain(cfg: { id: string; author?: string; attributes: Partial<Record<ParamKey, AttributeSpec>> }): CompiledBrain {
  const evaluators = {} as Record<ParamKey, AttributeEvaluator>;
  for (const k of PARAM_KEYS) {
    evaluators[k] = compileAttribute(cfg.attributes[k], DEFAULT_PARAMS[k]);
  }
  return { id: cfg.id, author: cfg.author, evaluators };
}

export function evaluateParams(brain: CompiledBrain, obs: Observation): Params {
  const ctx: EvalCtx = { tick: obs.tick, obs };
  const out = {} as Params;
  for (const k of PARAM_KEYS) out[k] = brain.evaluators[k](ctx);
  return out;
}
