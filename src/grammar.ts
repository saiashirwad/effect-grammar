/**
 * Bidirectional grammars: one definition parses a string to a value, prints a
 * value to its canonical string, renders itself as text, and derives a
 * `Schema.Codec<A, string>`.
 *
 * The parser is a synchronous backtracking interpreter over a whole string.
 * Errors report the furthest position reached and everything expected there.
 *
 * Sequencing rule that makes generators printable: a *silent* grammar
 * (`literal`, `symbol`, `skip`, ...) carries no value and can be `yield*`-ed
 * bare inside {@link gen} or listed bare inside {@link seq}; a value grammar
 * must be wrapped in {@link field} so the printer knows which part of the
 * value belongs to it. Printing a `gen` grammar replays the generator, feeding
 * each field its value back in, so control flow takes the same path both ways.
 */
import {
  Effect,
  Equal,
  Function as F,
  Option,
  Pipeable,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect"

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** A parse failure at the furthest position the parser reached. */
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  /** 0-based offset into the input. */
  pos: Schema.Finite,
  /** 1-based. */
  line: Schema.Finite,
  /** 1-based column within `line`. */
  column: Schema.Finite,
  /** Everything that could have matched at `pos`. */
  expected: Schema.Array(Schema.String),
  /** The character at `pos`, or `undefined` at end of input. */
  found: Schema.UndefinedOr(Schema.String),
}) {
  override get message(): string {
    const found = this.found === undefined ? "end of input" : JSON.stringify(this.found)
    const expected =
      this.expected.length === 1 ? this.expected[0] : `one of ${this.expected.join(", ")}`
    return `line ${this.line}, column ${this.column}: expected ${expected}, found ${found}`
  }
}

/** A value the grammar cannot print. */
export class PrintError extends Schema.TaggedErrorClass<PrintError>()("PrintError", {
  message: Schema.String,
}) {}

/**
 * Failure of {@link checkRoundTrip}. `stage` names which step broke:
 * - `"print"` — the value could not be printed
 * - `"parse"` — the printed string failed to re-parse
 * - `"equal"` — re-parse succeeded but the value differed
 */
export class RoundTripError extends Schema.TaggedErrorClass<RoundTripError>()("RoundTripError", {
  stage: Schema.Literals(["print", "parse", "equal"]),
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

/** One element of a sequence: a named value, or a silent grammar. */
export type Part = Field<string, any> | Grammar<any>

interface Bounds {
  readonly min: number
  readonly max: number
}

export type Node =
  | { readonly _tag: "Literal"; readonly value: string }
  | { readonly _tag: "Regex"; readonly re: RegExp; readonly name: string }
  | { readonly _tag: "Seq"; readonly parts: ReadonlyArray<Part> }
  | { readonly _tag: "Gen"; readonly run: () => Generator<Part, any, any> }
  | {
      readonly _tag: "Wrap"
      readonly open: Grammar<void>
      readonly inner: Grammar<any>
      readonly close: Grammar<void>
    }
  | { readonly _tag: "Choice"; readonly options: ReadonlyArray<Grammar<any>> }
  | ({ readonly _tag: "Many"; readonly inner: Grammar<any> } & Bounds)
  | ({ readonly _tag: "SepBy"; readonly inner: Grammar<any>; readonly sep: Grammar<void> } & Bounds)
  | { readonly _tag: "Optional"; readonly inner: Grammar<any> }
  | {
      readonly _tag: "Transform"
      readonly inner: Grammar<any>
      readonly decode: (a: any) => any
      readonly encode: (b: any) => any
      readonly is: ((u: unknown) => boolean) | undefined
      readonly name: string | undefined
    }
  | { readonly _tag: "Const"; readonly inner: Grammar<void>; readonly value: unknown }
  | {
      readonly _tag: "Skip"
      readonly inner: Grammar<any>
      readonly printAs: unknown
      /** `false` hides it from `render` (whitespace). */
      readonly show: boolean
    }
  | { readonly _tag: "Label"; readonly inner: Grammar<any>; readonly name: string }
  | {
      readonly _tag: "Suspend"
      readonly thunk: () => Grammar<any>
      readonly name: string | undefined
      /** Memoized `thunk()` result, filled in on first use. */
      resolved?: Grammar<any>
    }

// ---------------------------------------------------------------------------
// grammar values
// ---------------------------------------------------------------------------

/** The `yield*` protocol: yield yourself once, resume with the value sent back. */
export interface GenIterator<Y, A> {
  next(...args: ReadonlyArray<any>): IteratorResult<Y, A>
  [Symbol.iterator](): GenIterator<Y, A>
}

class SingleShot<Y, A> implements GenIterator<Y, A> {
  private called = false
  readonly self: Y
  constructor(self: Y) {
    this.self = self
  }
  next(a: A): IteratorResult<Y, A> {
    if (this.called) return { done: true, value: a }
    this.called = true
    return { done: false, value: this.self }
  }
  [Symbol.iterator](): GenIterator<Y, A> {
    return new SingleShot(this.self)
  }
}

declare const TypeId: unique symbol

/** A grammar that parses a string to `A` and prints an `A` back to a string. */
export interface Grammar<out A> extends Pipeable.Pipeable {
  readonly [TypeId]: { readonly _A: () => A }
  readonly node: Node
}

/**
 * A grammar with no value: `literal`, `symbol`, `whitespace`, anything under
 * `skip`. Only these can be `yield*`-ed bare in {@link gen} or listed bare in
 * {@link seq}, because the printer needs no value to emit them.
 */
export interface Silent extends Grammar<void> {
  [Symbol.iterator](): GenIterator<Silent, void>
}

/** A named part of a sequence. Printing reads `value[name]` for it. */
export interface Field<K extends string, A> {
  readonly _tag: "Field"
  readonly name: K
  readonly grammar: Grammar<A>
  [Symbol.iterator](): GenIterator<Field<K, A>, A>
}

class GrammarImpl<A> implements Grammar<A> {
  declare readonly [TypeId]: { readonly _A: () => A }
  readonly node: Node
  constructor(node: Node) {
    this.node = node
  }
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
}

class SilentImpl extends GrammarImpl<void> implements Silent {
  [Symbol.iterator](): GenIterator<Silent, void> {
    return new SingleShot<Silent, void>(this)
  }
}

class FieldImpl<K extends string, A> implements Field<K, A> {
  readonly _tag = "Field" as const
  readonly name: K
  readonly grammar: Grammar<A>
  constructor(name: K, grammar: Grammar<A>) {
    this.name = name
    this.grammar = grammar
  }
  [Symbol.iterator](): GenIterator<Field<K, A>, A> {
    return new SingleShot<Field<K, A>, A>(this)
  }
}

const make = <A>(node: Node): Grammar<A> => new GrammarImpl<A>(node)
const silent = (node: Node): Silent => new SilentImpl(node)
const isGrammar = (u: unknown): u is Grammar<any> => u instanceof GrammarImpl
const isSilent = (g: Grammar<any>): g is Silent => g instanceof SilentImpl
const isField = (p: Part): p is Field<string, any> => p instanceof FieldImpl

/** The value type of a grammar. */
export type Type<G> = G extends Grammar<infer A> ? A : never

type Names<Y> = Y extends Field<infer K, any> ? K : never

/** The object a sequence produces: one key per `field`, silent parts dropped. */
export type Fields<Y> = { [K in Names<Y>]: Y extends Field<K, infer A> ? A : never }

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** Match `value` exactly. Silent: carries no value, prints itself. */
export const literal = (value: string): Silent => silent({ _tag: "Literal", value })

/** Matches nothing, prints nothing. Useful as a `choice` fallback with {@link as}. */
export const empty: Silent = literal("")

/**
 * Match `re` at the cursor; the value is the matched text. `name` is what
 * errors and `render` call it. `g`/`y` flags are dropped so `lastIndex`
 * never leaks between matches.
 */
export const regex = (re: RegExp, name: string): Grammar<string> =>
  make({ _tag: "Regex", re: new RegExp(re.source, re.flags.replace(/[gy]/g, "")), name })

// ---------------------------------------------------------------------------
// sequencing
// ---------------------------------------------------------------------------

/**
 * Name a value inside a sequence. Infers through the grammar's type, so a
 * conditional like `cond ? g1 : g2` yields the union of both value types.
 */
export const field = <const K extends string, G extends Grammar<any>>(
  name: K,
  grammar: G,
): Field<K, Type<G>> => new FieldImpl(name, grammar)

/**
 * Static sequence. Parts are silent grammars and named fields, in order; the
 * value is the object of fields. A sequence of only silent parts is silent.
 */
export const seq: {
  (...parts: ReadonlyArray<Silent>): Silent
  <const Parts extends ReadonlyArray<Silent | Field<string, any>>>(
    ...parts: Parts
  ): Grammar<Fields<Parts[number]>>
} = (...parts: ReadonlyArray<Part>): any =>
  parts.every((p) => !isField(p)) ? silent({ _tag: "Seq", parts }) : make({ _tag: "Seq", parts })

/**
 * Dynamic sequence. Inside the generator, `yield*` a silent grammar to consume
 * it, or `yield* field("name", g)` to parse `g` and bind its value. Return an
 * object holding every field under its name — or return nothing to get the
 * object of fields. Printing replays the generator with the value's fields,
 * so `if`/`switch` on a parsed value is safe. A field name may be yielded at
 * most once per run; repeat with `many`.
 */
export const gen = <Y extends Silent | Field<string, any>, R extends Fields<Y> | void = void>(
  run: () => Generator<Y, R, any>,
): Grammar<[R] extends [void] ? Fields<Y> : R> => make({ _tag: "Gen", run })

const toSilent = (s: Silent | string): Silent => (typeof s === "string" ? literal(s) : s)

/** `open inner close`, keeping only `inner`'s value. Strings are shorthand for `literal`. */
export const wrap: {
  (open: Silent | string, inner: Silent, close: Silent | string): Silent
  <A>(open: Silent | string, inner: Grammar<A>, close: Silent | string): Grammar<A>
} = (open: Silent | string, inner: Grammar<any>, close: Silent | string): any => {
  const node: Node = { _tag: "Wrap", open: toSilent(open), inner, close: toSilent(close) }
  return isSilent(inner) ? silent(node) : make(node)
}

/** `open inner`, keeping `inner`'s value. */
export const prefix: {
  (open: Silent | string, inner: Silent): Silent
  <A>(open: Silent | string, inner: Grammar<A>): Grammar<A>
} = (open: Silent | string, inner: Grammar<any>): any => wrap(open, inner, empty)

/** `inner close`, keeping `inner`'s value. */
export const suffix: {
  (inner: Silent, close: Silent | string): Silent
  <A>(inner: Grammar<A>, close: Silent | string): Grammar<A>
} = (inner: Grammar<any>, close: Silent | string): any => wrap(empty, inner, close)

// ---------------------------------------------------------------------------
// alternation and repetition
// ---------------------------------------------------------------------------

/**
 * Ordered choice with full backtracking: each option starts from the same
 * position. Printing tries options in order and uses the first that accepts
 * the value — see {@link as}, {@link decodeTo}, and `transform`'s `is`.
 */
export const choice = <const Gs extends readonly [Grammar<any>, ...Array<Grammar<any>>]>(
  ...options: Gs
): Grammar<Type<Gs[number]>> => make({ _tag: "Choice", options })

/** Zero or one. An optional silent grammar is silent and prints nothing. */
export const optional: {
  (inner: Silent): Silent
  <A>(inner: Grammar<A>): Grammar<A | undefined>
} = (inner: Grammar<any>): any => {
  const node: Node = { _tag: "Optional", inner }
  return isSilent(inner) ? silent(node) : make(node)
}

export interface RepeatOptions {
  /** Default 0. */
  readonly min?: number
  /** Default unbounded. */
  readonly max?: number
}

const bounds = (name: string, opts: RepeatOptions | undefined): Bounds => {
  const min = opts?.min ?? 0
  const max = opts?.max ?? Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(min) || min < 0) {
    throw new RangeError(`${name}: min must be a non-negative safe integer`)
  }
  if (!(max === Number.POSITIVE_INFINITY || (Number.isSafeInteger(max) && max >= min))) {
    throw new RangeError(`${name}: max must be a safe integer >= min`)
  }
  return { min, max }
}

/** Repeat `inner`, collecting values. Stops at the first failure or at `max`. */
export const many: {
  <A>(inner: Grammar<A>, opts?: RepeatOptions): Grammar<Array<A>>
  (opts?: RepeatOptions): <A>(inner: Grammar<A>) => Grammar<Array<A>>
} = F.dual(
  (args) => isGrammar(args[0]),
  <A>(inner: Grammar<A>, opts?: RepeatOptions): Grammar<Array<A>> =>
    make({ _tag: "Many", inner, ...bounds("many", opts) }),
)

/** `inner` separated by `sep`. Prints `sep` between elements. */
export const sepBy = <A>(
  inner: Grammar<A>,
  sep: Silent | string,
  opts?: RepeatOptions,
): Grammar<Array<A>> => make({ _tag: "SepBy", inner, sep: toSilent(sep), ...bounds("sepBy", opts) })

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

export interface TransformOptions<A, B> {
  readonly decode: (a: A) => B
  readonly encode: (b: B) => A
  /**
   * Guard on both sides: parsing fails (so a `choice` moves on) when the
   * decoded value is rejected, and printing fails when the value to print is
   * rejected. Prefer {@link decodeTo}, which derives this from a Schema.
   */
  readonly is?: (u: unknown) => boolean
  /** What errors call this when `is` rejects. Defaults to the inner grammar's rendering. */
  readonly name?: string
}

/** Map the value both ways. */
export const transform: {
  <A, B>(f: TransformOptions<A, B>): (inner: Grammar<A>) => Grammar<B>
  <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>): Grammar<B>
} = F.dual(
  2,
  <A, B>(inner: Grammar<A>, f: TransformOptions<A, B>): Grammar<B> =>
    make({
      _tag: "Transform",
      inner,
      decode: f.decode,
      encode: f.encode,
      is: f.is,
      name: f.name,
    }),
)

export interface DecodeToOptions<A, T> {
  readonly decode: (a: A) => T
  readonly encode: (b: T) => A
  /** What errors call this when the schema rejects. Defaults to the inner grammar's rendering. */
  readonly name?: string
}

/**
 * {@link transform} with a Schema as the value contract, named after
 * `Schema.decodeTo`. The schema types `decode`/`encode` and guards both
 * directions, so a `choice` of schema-typed branches picks the right one when
 * printing. The guard compiles lazily, so recursive schemas are safe.
 *
 * Curried on purpose: fixing the schema's type before the options are checked
 * is what lets `decode` return `{ kind: "number", ... }` without annotating it.
 *
 * ```ts
 * const num = Grammar.integer.pipe(
 *   Grammar.decodeTo(Num)({ decode: (value) => ({ kind: "num", value }), encode: (n) => n.value }),
 * )
 * ```
 */
export const decodeTo =
  <T>(schema: Schema.Codec<T, unknown, unknown, unknown>) =>
  <A>(f: DecodeToOptions<A, T>) =>
  (inner: Grammar<A>): Grammar<T> => {
    let is: ((u: unknown) => boolean) | undefined
    return transform(inner, { ...f, is: (u) => (is ??= Schema.is(schema))(u) })
  }

/**
 * Give a silent grammar a constant value: `literal("null").pipe(as(null))`.
 * Prints only when the value is `Equal` to the constant, so a `choice` of
 * constants prints the right branch.
 */
export const as: {
  <const V>(value: V): (inner: Silent) => Grammar<V>
  <const V>(inner: Silent, value: V): Grammar<V>
} = F.dual(
  2,
  <const V>(inner: Silent, value: V): Grammar<V> => make({ _tag: "Const", inner, value }),
)

/** A boolean from presence: `flag("-")` is `true` when `-` is present. */
export const flag = (s: Silent | string): Grammar<boolean> =>
  choice(as(toSilent(s), true), as(empty, false))

/** Discard a value grammar's result; printing emits `printAs`. The result is silent. */
export const skip: {
  <A>(printAs: A): (inner: Grammar<A>) => Silent
  <A>(inner: Grammar<A>, printAs: A): Silent
} = F.dual(
  2,
  <A>(inner: Grammar<A>, printAs: A): Silent =>
    silent({ _tag: "Skip", inner, printAs, show: true }),
)

/** Name a grammar for errors: replaces the expected set when it fails at its own start. */
export const label: {
  (name: string): <A>(inner: Grammar<A>) => Grammar<A>
  <A>(inner: Grammar<A>, name: string): Grammar<A>
} = F.dual(
  2,
  <A>(inner: Grammar<A>, name: string): Grammar<A> => make({ _tag: "Label", inner, name }),
)

/** Defer construction — for recursive grammars. `name` is what `render` shows at the recursion point. */
export const suspend = <A>(thunk: () => Grammar<A>, name?: string): Grammar<A> =>
  make({ _tag: "Suspend", thunk, name })

// ---------------------------------------------------------------------------
// small standard library
// ---------------------------------------------------------------------------

const hiddenWhitespace = (printAs: string): Silent =>
  silent({ _tag: "Skip", inner: regex(/\s*/, "whitespace"), printAs, show: false })

/** Optional whitespace; prints nothing. Hidden from `render`. */
export const whitespace: Silent = hiddenWhitespace("")

/** `inner` followed by optional whitespace; prints one trailing space. */
export const lexeme: {
  (inner: Silent): Silent
  <A>(inner: Grammar<A>): Grammar<A>
} = (inner: Grammar<any>): any => suffix(inner, hiddenWhitespace(" "))

/** A literal followed by optional whitespace. */
export const symbol = (s: string): Silent => lexeme(literal(s))

/** A signed decimal integer within `Number.isSafeInteger`. */
export const integer: Grammar<number> = regex(/-?\d+/, "integer").pipe(
  transform({ decode: Number, encode: String, is: Number.isSafeInteger, name: "integer" }),
)

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

interface State {
  readonly input: string
  pos: number
  furthest: number
  expected: Set<string>
}

const FAIL: unique symbol = Symbol.for("effect-grammar/fail")
type Res<A> = A | typeof FAIL

const failAt = (s: State, expected: string): typeof FAIL => {
  if (s.pos > s.furthest) {
    s.furthest = s.pos
    s.expected = new Set([expected])
  } else if (s.pos === s.furthest) {
    s.expected.add(expected)
  }
  return FAIL
}

const resolve = (n: Extract<Node, { _tag: "Suspend" }>): Grammar<any> => (n.resolved ??= n.thunk())

const runPart = (p: Part, s: State): Res<any> => go(isField(p) ? p.grammar : p, s)

const go = (g: Grammar<any>, s: State): Res<any> => {
  const n = g.node
  switch (n._tag) {
    case "Literal": {
      if (!s.input.startsWith(n.value, s.pos)) return failAt(s, JSON.stringify(n.value))
      s.pos += n.value.length
      return undefined
    }
    case "Regex": {
      const m = n.re.exec(s.input.slice(s.pos))
      if (m === null || m.index !== 0) return failAt(s, n.name)
      s.pos += m[0].length
      return m[0]
    }
    case "Seq": {
      const out: Record<string, unknown> = {}
      let hasField = false
      for (const p of n.parts) {
        const v = runPart(p, s)
        if (v === FAIL) return FAIL
        if (isField(p)) {
          out[p.name] = v
          hasField = true
        }
      }
      return hasField ? out : undefined
    }
    case "Gen": {
      const it = n.run()
      const out: Record<string, unknown> = {}
      let r = it.next()
      while (!r.done) {
        const p = r.value
        const v = runPart(p, s)
        if (v === FAIL) {
          it.return?.(undefined)
          return FAIL
        }
        if (isField(p)) {
          if (p.name in out) {
            throw new Error(`gen: field "${p.name}" yielded twice — use many() to repeat`)
          }
          out[p.name] = v
        }
        r = it.next(v)
      }
      return r.value === undefined ? out : r.value
    }
    case "Wrap": {
      if (go(n.open, s) === FAIL) return FAIL
      const v = go(n.inner, s)
      if (v === FAIL) return FAIL
      if (go(n.close, s) === FAIL) return FAIL
      return v
    }
    case "Choice": {
      const start = s.pos
      for (const o of n.options) {
        const v = go(o, s)
        if (v !== FAIL) return v
        s.pos = start
      }
      return FAIL
    }
    case "Many": {
      const out: Array<unknown> = []
      while (out.length < n.max) {
        const mark = s.pos
        const v = go(n.inner, s)
        if (v === FAIL) {
          s.pos = mark
          break
        }
        if (s.pos === mark) throw new Error("many: inner grammar matched without consuming input")
        out.push(v)
      }
      return out.length < n.min ? FAIL : out
    }
    case "SepBy": {
      const out: Array<unknown> = []
      let mark = s.pos
      let v = go(n.inner, s)
      while (v !== FAIL && out.length < n.max) {
        out.push(v)
        mark = s.pos
        if (go(n.sep, s) === FAIL) break
        if (s.pos === mark) throw new Error("sepBy: separator matched without consuming input")
        v = go(n.inner, s)
      }
      s.pos = mark
      return out.length < n.min ? FAIL : out
    }
    case "Optional": {
      const mark = s.pos
      const v = go(n.inner, s)
      if (v !== FAIL) return v
      s.pos = mark
      return undefined
    }
    case "Transform": {
      const start = s.pos
      const v = go(n.inner, s)
      if (v === FAIL) return FAIL
      const b = n.decode(v)
      if (n.is !== undefined && !n.is(b)) {
        s.pos = start
        return failAt(s, n.name ?? describe(n.inner))
      }
      return b
    }
    case "Const":
      return go(n.inner, s) === FAIL ? FAIL : n.value
    case "Skip":
      return go(n.inner, s) === FAIL ? FAIL : undefined
    case "Label": {
      const start = s.pos
      const v = go(n.inner, s)
      if (v !== FAIL) return v
      if (s.furthest === start) s.expected = new Set([n.name])
      return FAIL
    }
    case "Suspend":
      return go(resolve(n), s)
  }
}

const lineColumn = (input: string, pos: number): { line: number; column: number } => {
  let line = 1
  let column = 1
  for (let i = 0; i < pos; i++) {
    if (input.charCodeAt(i) === 10) {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}

const toError = (s: State): ParseError =>
  new ParseError({
    pos: s.furthest,
    ...lineColumn(s.input, s.furthest),
    expected: [...s.expected],
    found: s.input[s.furthest],
  })

/** Parse the whole input. Trailing input is a failure. */
export const parse = <A>(grammar: Grammar<A>, input: string): Result.Result<A, ParseError> => {
  const s: State = { input, pos: 0, furthest: 0, expected: new Set() }
  const v = go(grammar, s)
  if (v === FAIL) return Result.fail(toError(s))
  if (s.pos < input.length) {
    failAt(s, "end of input")
    return Result.fail(toError(s))
  }
  return Result.succeed(v as A)
}

// ---------------------------------------------------------------------------
// print
// ---------------------------------------------------------------------------

class PrintFail {
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

const printFail = (message: string): never => {
  throw new PrintFail(message)
}

const preview = (u: unknown): string => {
  try {
    return JSON.stringify(u) ?? String(u)
  } catch {
    return String(u)
  }
}

const printPart = (p: Part, value: Record<string, unknown>): string =>
  isField(p) ? out(p.grammar, value[p.name]) : out(p, undefined)

const out = (g: Grammar<any>, value: any): string => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value
    case "Regex": {
      if (typeof value !== "string") {
        return printFail(`${n.name}: expected a string, got ${preview(value)}`)
      }
      const anchored = new RegExp(`^(?:${n.re.source})$`, n.re.flags)
      return anchored.test(value)
        ? value
        : printFail(`${n.name}: ${JSON.stringify(value)} does not match /${n.re.source}/`)
    }
    case "Seq":
      return n.parts.map((p) => printPart(p, value)).join("")
    case "Gen": {
      const it = n.run()
      let acc = ""
      let r = it.next()
      while (!r.done) {
        const p = r.value
        acc += printPart(p, value)
        r = it.next(isField(p) ? value[p.name] : undefined)
      }
      return acc
    }
    case "Wrap":
      return out(n.open, undefined) + out(n.inner, value) + out(n.close, undefined)
    case "Choice": {
      const reasons: Array<string> = []
      for (const o of n.options) {
        try {
          return out(o, value)
        } catch (e) {
          if (!(e instanceof PrintFail)) throw e
          reasons.push(e.message)
        }
      }
      return printFail(`no choice branch accepts ${preview(value)}:\n  ${reasons.join("\n  ")}`)
    }
    case "Many":
    case "SepBy": {
      if (!Array.isArray(value)) return printFail(`expected an array, got ${preview(value)}`)
      if (value.length < n.min || value.length > n.max) {
        const range =
          n.max === Number.POSITIVE_INFINITY ? `at least ${n.min}` : `${n.min}..${n.max}`
        return printFail(`expected ${range} items, got ${value.length}`)
      }
      const sep = n._tag === "SepBy" ? out(n.sep, undefined) : ""
      return value.map((v) => out(n.inner, v)).join(sep)
    }
    case "Optional":
      return value === undefined ? "" : out(n.inner, value)
    case "Transform":
      if (n.is !== undefined && !n.is(value)) {
        return printFail(`${n.name ?? describe(n.inner)}: rejected ${preview(value)}`)
      }
      return out(n.inner, n.encode(value))
    case "Const":
      return Equal.equals(value, n.value)
        ? out(n.inner, undefined)
        : printFail(`expected ${preview(n.value)}, got ${preview(value)}`)
    case "Skip":
      return out(n.inner, n.printAs)
    case "Label":
      return out(n.inner, value)
    case "Suspend":
      return out(resolve(n), value)
  }
}

/** Print a value in the grammar's canonical form. */
export const print = <A>(grammar: Grammar<A>, value: A): Result.Result<string, PrintError> => {
  try {
    return Result.succeed(out(grammar, value))
  } catch (e) {
    if (e instanceof PrintFail) return Result.fail(new PrintError({ message: e.message }))
    throw e
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/**
 * The grammar as text. Exact for everything but {@link gen}, which is
 * dry-run with `undefined` in place of every value: straight-line sequences
 * render fully, and a branch that inspects a value renders as `…` from there.
 */
export const render = (g: Grammar<any>): string => show(g, new Set())

/** Short name for error messages. */
const describe = (g: Grammar<any>): string => {
  const n = g.node
  if (n._tag === "Regex") return n.name
  if (n._tag === "Label") return n.name
  return render(g)
}

const repetition = (b: Bounds): string => {
  if (b.max === Number.POSITIVE_INFINITY) {
    return b.min === 0 ? "*" : b.min === 1 ? "+" : `{${b.min},}`
  }
  return b.min === b.max ? `{${b.min}}` : `{${b.min},${b.max}}`
}

const joinShown = (parts: ReadonlyArray<string>): string => parts.filter((p) => p !== "").join(" ")

const showPart = (p: Part, seen: Set<Node>): string =>
  isField(p) ? `${p.name}:${show(p.grammar, seen)}` : show(p, seen)

const show = (g: Grammar<any>, seen: Set<Node>): string => {
  const n = g.node
  switch (n._tag) {
    case "Literal":
      return n.value === "" ? "" : JSON.stringify(n.value)
    case "Regex":
      return `<${n.name}>`
    case "Seq":
      return joinShown(n.parts.map((p) => showPart(p, seen)))
    case "Gen": {
      const parts: Array<string> = []
      try {
        const it = n.run()
        let r = it.next()
        while (!r.done) {
          parts.push(showPart(r.value, seen))
          r = it.next(undefined)
        }
      } catch {
        parts.push("…")
      }
      return joinShown(parts)
    }
    case "Wrap":
      return joinShown([show(n.open, seen), show(n.inner, seen), show(n.close, seen)])
    case "Choice":
      return `(${n.options.map((o) => show(o, seen)).join(" | ")})`
    case "Many":
      return `(${show(n.inner, seen)})${repetition(n)}`
    case "SepBy": {
      const inner = show(n.inner, seen)
      const sep = show(n.sep, seen)
      const rest = repetition({
        min: Math.max(0, n.min - 1),
        max: n.max === Number.POSITIVE_INFINITY ? n.max : n.max - 1,
      })
      const body = `${inner} (${joinShown([sep, inner])})${rest}`
      return n.min === 0 ? `(${body})?` : body
    }
    case "Optional":
      return `(${show(n.inner, seen)})?`
    case "Transform":
    case "Const":
    case "Label":
      return show(n.inner, seen)
    case "Skip":
      return n.show ? show(n.inner, seen) : ""
    case "Suspend": {
      if (seen.has(n)) return n.name ?? "…"
      seen.add(n)
      const s = show(resolve(n), seen)
      seen.delete(n)
      return s
    }
  }
}

// ---------------------------------------------------------------------------
// laws and the Schema boundary
// ---------------------------------------------------------------------------

/**
 * The round-trip law: `parse(print(value))` equals `value` (by `Equal`).
 * Fails with {@link RoundTripError} naming the stage that broke. This is the
 * property to test every grammar against.
 */
export const checkRoundTrip = <A>(
  grammar: Grammar<A>,
  value: A,
): Result.Result<void, RoundTripError> => {
  const printed = print(grammar, value)
  if (Result.isFailure(printed)) {
    return Result.fail(new RoundTripError({ stage: "print", message: printed.failure.message }))
  }
  const reparsed = parse(grammar, printed.success)
  if (Result.isFailure(reparsed)) {
    return Result.fail(
      new RoundTripError({
        stage: "parse",
        message: `${reparsed.failure.message}\n  printed: ${JSON.stringify(printed.success)}`,
      }),
    )
  }
  if (!Equal.equals(reparsed.success, value)) {
    return Result.fail(
      new RoundTripError({
        stage: "equal",
        message:
          `original: ${preview(value)}` +
          `\n  reparsed: ${preview(reparsed.success)}` +
          `\n  printed:  ${JSON.stringify(printed.success)}`,
      }),
    )
  }
  return Result.void
}

/**
 * A `Schema.Codec<Target, string>`: decoding parses with the grammar and then
 * validates against `target`; encoding prints with the grammar. The rendered
 * grammar becomes the schema's `description`.
 */
export const toSchema = <S extends Schema.Top>(
  grammar: Grammar<S["Type"]>,
  target: S,
  options?: { readonly identifier?: string },
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail({
        decode: (s: string) =>
          Effect.fromResult(parse(grammar, s)).pipe(
            Effect.mapError(
              (e) => new SchemaIssue.InvalidValue(Option.some(s), { message: e.message }),
            ),
          ),
        encode: (a: S["Type"]) =>
          Effect.fromResult(print(grammar, a)).pipe(
            Effect.mapError(
              (e) => new SchemaIssue.InvalidValue(Option.some(a), { message: e.message }),
            ),
          ),
      }),
    ),
    Schema.annotate({
      ...(options?.identifier === undefined ? {} : { identifier: options.identifier }),
      description: render(grammar),
    }),
  )
