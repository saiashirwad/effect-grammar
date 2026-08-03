import {
  Effect,
  Equal,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  Scope,
  Stream,
} from "effect"

import { locateParseError, ParseError, UpstreamError } from "./error.ts"
import {
  failHere,
  getPos,
  isEof,
  makeStringState,
  matchRegex,
  ParseState,
  seek,
  startsWith,
} from "./state.ts"
import {
  parseStream as parseStreamEffect,
  streamElements as streamElementsEffect,
} from "./stream.ts"

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

declare const typeId: unique symbol

export interface Literal {
  readonly _tag: "Literal"
  readonly value: string
}

export interface Regex {
  readonly _tag: "Regex"
  readonly re: RegExp
  readonly expected: string
}

export interface MapNode {
  readonly _tag: "Map"
  readonly inner: Grammar<any>
  readonly to: (a: any) => any
  readonly from: ((b: any) => any) | undefined
}

export interface StructNode {
  readonly _tag: "Struct"
  readonly fields: Record<string, Grammar<any>>
}

export interface Choice {
  readonly _tag: "Choice"
  readonly options: ReadonlyArray<Grammar<any>>
}

export interface Many {
  readonly _tag: "Many"
  readonly inner: Grammar<any>
  readonly atLeast: number
}

export interface SepBy {
  readonly _tag: "SepBy"
  readonly inner: Grammar<any>
  readonly sep: Grammar<any>
  readonly atLeast: number
}

export interface Optional {
  readonly _tag: "Optional"
  readonly inner: Grammar<any>
}

export interface Attempt {
  readonly _tag: "Attempt"
  readonly inner: Grammar<any>
}

export interface FromEffect {
  readonly _tag: "FromEffect"
  readonly eff: Effect.Effect<any, ParseError, ParseState>
  readonly expected: string
}

export interface Lazy {
  readonly _tag: "Lazy"
  readonly thunk: () => Grammar<any>
  readonly name: string | undefined
  /** Memoized `thunk()` result, filled in on first use. */
  resolved?: Grammar<any>
}

export interface End {
  readonly _tag: "End"
}

export interface Bind {
  readonly _tag: "Bind"
  readonly inner: Grammar<any>
  readonly to: (a: any) => Grammar<any>
  readonly from: ((b: any) => any) | undefined
}

export interface Count {
  readonly _tag: "Count"
  readonly inner: Grammar<any>
  readonly n: number
}

export interface Guard {
  readonly _tag: "Guard"
  readonly inner: Grammar<any>
  readonly pred: (value: any) => boolean
}

export interface Label {
  readonly _tag: "Label"
  readonly expected: string
  readonly inner: Grammar<any>
}

export type Node =
  | Literal
  | Regex
  | MapNode
  | StructNode
  | Choice
  | Many
  | SepBy
  | Optional
  | Attempt
  | FromEffect
  | Lazy
  | End
  | Bind
  | Count
  | Guard
  | Label

export type Grammar<A> = Node & { readonly [typeId]?: A }

export type GrammarType<G> = G extends Grammar<infer A> ? A : never

export const literal = <L extends string>(value: L): Grammar<L> => ({ _tag: "Literal", value })

/** Clone the pattern and drop `g`/`y` so `lastIndex` and sticky start never affect matching. */
export const regex = (re: RegExp, expected: string): Grammar<string> => ({
  _tag: "Regex",
  re: new RegExp(re.source, re.flags.replace(/[gy]/g, "")),
  expected,
})

export const map = <A, B>(
  inner: Grammar<A>,
  f: { readonly to: (a: A) => B; readonly from?: (b: B) => A },
): Grammar<B> => ({ _tag: "Map", inner, to: f.to, from: f.from })

export const struct = <F extends Record<string, Grammar<any>>>(
  fields: F,
): Grammar<{ [K in keyof F]: GrammarType<F[K]> }> => ({ _tag: "Struct", fields })

export const choice = <Gs extends readonly [Grammar<any>, ...Array<Grammar<any>>]>(
  ...options: Gs
): Grammar<GrammarType<Gs[number]>> => ({ _tag: "Choice", options })

export const many = <A>(
  inner: Grammar<A>,
  opts?: { readonly atLeast?: number },
): Grammar<Array<A>> => ({ _tag: "Many", inner, atLeast: opts?.atLeast ?? 0 })

export const sepBy = <A, S>(inner: Grammar<A>, sep: Grammar<S>): Grammar<Array<A>> => ({
  _tag: "SepBy",
  inner,
  sep,
  atLeast: 0,
})

/** Like `sepBy`, but requires at least one element — the first failure propagates. */
export const sepBy1 = <A, S>(inner: Grammar<A>, sep: Grammar<S>): Grammar<Array<A>> => ({
  _tag: "SepBy",
  inner,
  sep,
  atLeast: 1,
})

export const optional = <A>(inner: Grammar<A>): Grammar<A | undefined> => ({
  _tag: "Optional",
  inner,
})

/**
 * Rewind on failure: if `inner` fails after consuming input, restore the
 * position so an enclosing `choice` tries its next option.
 */
export const attempt = <A>(inner: Grammar<A>): Grammar<A> => ({ _tag: "Attempt", inner })

/**
 * Print-time filter: parse runs `inner` unchanged, but printing fails with
 * `PrintError` when `pred(value)` is false — so an enclosing `choice` moves
 * on to its next option.
 */
export const guard = <A>(inner: Grammar<A>, pred: (value: A) => boolean): Grammar<A> => ({
  _tag: "Guard",
  inner,
  pred,
})

/**
 * Name a grammar for error messages. Replaces `expected` only when `inner`
 * fails without consuming input. Print is transparent; render shows
 * `<expected>` when `inner` is a raw regex.
 */
export const label = <A>(expected: string, inner: Grammar<A>): Grammar<A> => ({
  _tag: "Label",
  expected,
  inner,
})

export const fromEffect = <A>(
  eff: Effect.Effect<A, ParseError, ParseState>,
  expected: string,
): Grammar<A> => ({ _tag: "FromEffect", eff, expected })

/**
 * Defer grammar construction to first use — the building block for recursive
 * grammars. The thunk result is memoized on the node. `name` is what `render`
 * shows at the recursion point.
 */
export const lazy = <A>(
  thunk: () => Grammar<A>,
  opts?: { readonly name?: string },
): Grammar<A> => ({
  _tag: "Lazy",
  thunk,
  name: opts?.name,
})

/** Zero-width assertion: succeeds only at end of input. Prints as "". */
export const end: Grammar<void> = { _tag: "End" }

/**
 * Dependent parsing: the grammar that runs next is computed from the value
 * just parsed (e.g. a length prefix deciding how many chars to read).
 * Printable when `from` recovers the intermediate value from the result.
 */
export const bind = <A, B>(
  inner: Grammar<A>,
  f: { readonly to: (a: A) => Grammar<B>; readonly from?: (b: B) => A },
): Grammar<B> => ({ _tag: "Bind", inner, to: f.to, from: f.from })

/** Run `inner` exactly `n` times, collecting the results. */
export const count = <A>(inner: Grammar<A>, n: number): Grammar<Array<A>> => ({
  _tag: "Count",
  inner,
  n,
})

export const integer: Grammar<number> = map(label("integer", regex(/-?\d+/, "integer")), {
  to: Number,
  from: String,
})

/** Run `inner`, then skip trailing whitespace. Printing emits one canonical space. */
export const lexeme = <A>(inner: Grammar<A>): Grammar<A> =>
  map(struct({ value: inner, ws: label("whitespace", regex(/\s*/, "whitespace")) }), {
    to: ({ value }) => value,
    from: (value) => ({ value, ws: " " }),
  })

/** A literal that skips trailing whitespace. */
export const symbol = <L extends string>(s: L): Grammar<L> => lexeme(literal(s))

/**
 * Run `open`, `inner`, `close` in sequence, keeping only `inner`'s value.
 * Print supplies `undefined` for open/close — they must be value-ignoring
 * printers (`literal`, `symbol`, `end`, or a transparent wrapper around those).
 */
export const between = <O, C, A>(
  open: Grammar<O>,
  close: Grammar<C>,
  inner: Grammar<A>,
): Grammar<A> =>
  map(struct({ open, inner, close }), {
    to: ({ inner }) => inner,
    from: (value) => ({ open: undefined as O, inner: value, close: undefined as C }),
  })

/** Quote a string the way JSON would, for expected-token messages. */
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String))

const interpret = (g: Grammar<any>): Effect.Effect<any, ParseError | UpstreamError, ParseState> =>
  Effect.gen(function* () {
    switch (g._tag) {
      case "Literal": {
        const pos = yield* getPos
        if (!(yield* startsWith(g.value))) return yield* failHere(quote(g.value))
        yield* seek(pos + g.value.length)
        return g.value
      }
      case "Regex": {
        const pos = yield* getPos
        const m = yield* matchRegex(g.re)
        if (Option.isNone(m)) return yield* failHere(g.expected)
        yield* seek(pos + m.value.length)
        return m.value
      }
      case "Map": {
        return g.to(yield* interpret(g.inner))
      }
      case "Struct": {
        const out: Record<string, any> = {}
        for (const [key, field] of Object.entries(g.fields)) {
          out[key] = yield* interpret(field)
        }
        return out
      }
      case "Choice": {
        let furthest: ParseError | undefined
        for (const option of g.options) {
          const mark = yield* getPos
          const r = yield* Effect.result(interpret(option))
          if (r._tag === "Success") return r.success
          if (!Schema.is(ParseError)(r.failure)) return yield* r.failure
          if ((yield* getPos) > mark) return yield* r.failure
          yield* seek(mark)
          if (furthest === undefined || r.failure.pos >= furthest.pos) furthest = r.failure
        }
        return yield* (
          furthest ?? new ParseError({ pos: yield* getPos, expected: "choice", found: undefined })
        )
      }
      case "Many": {
        const out: Array<any> = []
        for (let i = 0; i < g.atLeast; i++) out.push(yield* interpret(g.inner))
        while (true) {
          const mark = yield* getPos
          const r = yield* Effect.result(interpret(g.inner))
          if (r._tag === "Failure") {
            if (!Schema.is(ParseError)(r.failure)) return yield* r.failure
            if ((yield* getPos) > mark) return yield* r.failure
            yield* seek(mark)
            return out
          }
          if ((yield* getPos) === mark) {
            return yield* Effect.die(
              new Error("Grammar.many: inner parser succeeded without consuming input"),
            )
          }
          out.push(r.success)
        }
      }
      case "SepBy": {
        const start = yield* getPos
        const first = yield* Effect.result(interpret(g.inner))
        if (first._tag === "Failure") {
          if (!Schema.is(ParseError)(first.failure)) return yield* first.failure
          if ((yield* getPos) > start || g.atLeast >= 1) return yield* first.failure
          return []
        }
        const out = [first.success]
        while (true) {
          const mark = yield* getPos
          const r = yield* Effect.result(interpret(g.sep).pipe(Effect.andThen(interpret(g.inner))))
          if (r._tag === "Failure") {
            if (!Schema.is(ParseError)(r.failure)) return yield* r.failure
            if ((yield* getPos) > mark) return yield* r.failure
            yield* seek(mark)
            return out
          }
          if ((yield* getPos) === mark) {
            return yield* Effect.die(
              new Error("Grammar.sepBy: separator+element succeeded without consuming input"),
            )
          }
          out.push(r.success)
        }
      }
      case "Optional": {
        const mark = yield* getPos
        const r = yield* Effect.result(interpret(g.inner))
        if (r._tag === "Failure") {
          if (!Schema.is(ParseError)(r.failure)) return yield* r.failure
          if ((yield* getPos) > mark) return yield* r.failure
          yield* seek(mark)
          return undefined
        }
        return r.success
      }
      case "Attempt": {
        const mark = yield* getPos
        const r = yield* Effect.result(interpret(g.inner))
        if (r._tag === "Failure") {
          if (!Schema.is(ParseError)(r.failure)) return yield* r.failure
          yield* seek(mark)
          return yield* r.failure
        }
        return r.success
      }
      case "FromEffect": {
        return yield* g.eff
      }
      case "Lazy": {
        return yield* interpret((g.resolved ??= g.thunk()))
      }
      case "End": {
        if (!(yield* isEof)) return yield* failHere("end of input")
        return undefined
      }
      case "Bind": {
        const a = yield* interpret(g.inner)
        return yield* interpret(g.to(a))
      }
      case "Count": {
        const out: Array<any> = []
        for (let i = 0; i < g.n; i++) out.push(yield* interpret(g.inner))
        return out
      }
      case "Guard": {
        return yield* interpret(g.inner)
      }
      case "Label": {
        const mark = yield* getPos
        const r = yield* Effect.result(interpret(g.inner))
        if (r._tag === "Success") return r.success
        if (!Schema.is(ParseError)(r.failure)) return yield* r.failure
        if ((yield* getPos) === mark) {
          return yield* new ParseError({
            pos: r.failure.pos,
            expected: g.expected,
            found: r.failure.found,
          })
        }
        return yield* r.failure
      }
    }
  })

const printNode = (g: Grammar<any>, value: any): Effect.Effect<string, PrintError> => {
  switch (g._tag) {
    case "Literal":
      return Effect.succeed(g.value)
    case "Regex": {
      const flags = g.re.flags.replace(/[gy]/g, "")
      const anchored = new RegExp(`^(?:${g.re.source})$`, flags)
      return anchored.test(value)
        ? Effect.succeed(value)
        : Effect.fail(
            new PrintError({
              message: `cannot print ${JSON.stringify(value)}: does not match ${g.expected}`,
            }),
          )
    }
    case "Map":
      return g.from === undefined
        ? Effect.fail(
            new PrintError({
              message: `cannot print: this grammar is parse-only (map is missing \`from\`)`,
            }),
          )
        : printNode(g.inner, g.from(value))
    case "Struct":
      return Effect.forEach(Object.entries(g.fields), ([key, field]) =>
        printNode(field, value[key]),
      ).pipe(Effect.map((parts) => parts.join("")))
    case "Choice": {
      const tryOptions = (
        options: ReadonlyArray<Grammar<any>>,
      ): Effect.Effect<string, PrintError> => {
        const [head, ...rest] = options
        return head === undefined
          ? Effect.fail(
              new PrintError({ message: `cannot print: no choice option accepts the value` }),
            )
          : Effect.result(printNode(head, value)).pipe(
              Effect.flatMap((r) =>
                r._tag === "Success" ? Effect.succeed(r.success) : tryOptions(rest),
              ),
            )
      }
      return tryOptions(g.options)
    }
    case "Many": {
      const items = value as Array<any>
      return items.length < g.atLeast
        ? Effect.fail(
            new PrintError({
              message: `cannot print: expected at least ${g.atLeast} items, got ${items.length}`,
            }),
          )
        : Effect.forEach(items, (v) => printNode(g.inner, v)).pipe(
            Effect.map((parts) => parts.join("")),
          )
    }
    case "SepBy": {
      const items = value as Array<any>
      if (items.length < g.atLeast) {
        return Effect.fail(
          new PrintError({
            message: `cannot print: expected at least ${g.atLeast} items, got ${items.length}`,
          }),
        )
      }
      // Separator is printed with `undefined` — same contract as `between` delimiters.
      return Effect.forEach(items, (v) => printNode(g.inner, v)).pipe(
        Effect.flatMap((printed) =>
          printed.length <= 1
            ? Effect.succeed(printed.join(""))
            : Effect.map(
                Effect.forEach(printed.slice(1), (item) =>
                  Effect.map(printNode(g.sep, undefined), (s) => s + item),
                ),
                (rest) => printed[0] + rest.join(""),
              ),
        ),
      )
    }
    case "Optional":
      return value === undefined ? Effect.succeed("") : printNode(g.inner, value)
    case "Attempt":
      return printNode(g.inner, value)
    case "FromEffect":
      return Effect.fail(
        new PrintError({
          message: `cannot print: grammar contains an effect-only fragment (${g.expected})`,
        }),
      )
    case "Lazy":
      return Effect.suspend(() => printNode((g.resolved ??= g.thunk()), value))
    case "End":
      return Effect.succeed("")
    case "Bind": {
      if (g.from === undefined) {
        return Effect.fail(
          new PrintError({
            message: `cannot print: this grammar is parse-only (bind is missing \`from\`)`,
          }),
        )
      }
      const a = g.from(value)
      return Effect.zipWith(printNode(g.inner, a), printNode(g.to(a), value), (l, r) => l + r)
    }
    case "Count":
      return (value as Array<any>).length !== g.n
        ? Effect.fail(
            new PrintError({
              message: `cannot print: expected exactly ${g.n} items, got ${(value as Array<any>).length}`,
            }),
          )
        : Effect.forEach(value as Array<any>, (v) => printNode(g.inner, v)).pipe(
            Effect.map((parts) => parts.join("")),
          )
    case "Guard":
      return g.pred(value)
        ? printNode(g.inner, value)
        : Effect.fail(new PrintError({ message: `cannot print: value rejected by guard` }))
    case "Label":
      return printNode(g.inner, value)
  }
}

export const parse = <A>(input: string, grammar: Grammar<A>): Effect.Effect<A, ParseError> =>
  Effect.gen(function* () {
    const state = yield* makeStringState(input)
    return yield* Effect.gen(function* () {
      const a = yield* interpret(grammar)
      if (!(yield* isEof)) return yield* failHere("end of input")
      return a
    }).pipe(
      Effect.provideService(ParseState, state),
      // String input has no upstream; this can never fire.
      Effect.catchIf(Schema.is(UpstreamError), (e) => Effect.die(e)),
      Effect.mapError((e) => locateParseError(input, e)),
    )
  })

/** Like `parse`, but leaves the cursor wherever the grammar stopped — trailing input is allowed. */
export const parsePrefix = <A>(input: string, grammar: Grammar<A>): Effect.Effect<A, ParseError> =>
  Effect.gen(function* () {
    const state = yield* makeStringState(input)
    return yield* interpret(grammar).pipe(
      Effect.provideService(ParseState, state),
      // String input has no upstream; this can never fire.
      Effect.catchIf(Schema.is(UpstreamError), (e) => Effect.die(e)),
      Effect.mapError((e) => locateParseError(input, e)),
    )
  })

/** Run a grammar once over a stream of chunks. See `parseStream` in `stream.ts`. */
export const parseStream = <A, E2, R2>(
  input: Stream.Stream<string, E2, R2>,
  grammar: Grammar<A>,
): Effect.Effect<A, ParseError | UpstreamError, Exclude<R2, Scope.Scope>> =>
  parseStreamEffect(
    input,
    Effect.gen(function* () {
      const a = yield* interpret(grammar)
      if (!(yield* isEof)) return yield* failHere("end of input")
      return a
    }),
  )

/** Parse a stream of chunks into a stream of values, one per grammar run. */
export const streamElements = <A, E2, R2>(
  input: Stream.Stream<string, E2, R2>,
  grammar: Grammar<A>,
): Stream.Stream<A, ParseError | UpstreamError, Exclude<R2, Scope.Scope>> =>
  streamElementsEffect(input, interpret(grammar))

export const print = <A>(grammar: Grammar<A>, value: A): Effect.Effect<string, PrintError> =>
  printNode(grammar, value)

/**
 * Law: `parse(print(value))` equals `value` (structurally).
 *
 * Prints, re-parses with strict EOF, then compares with `Equal.equals`.
 * Fails with {@link RoundTripError} naming the stage that broke.
 */
export const checkRoundTrip = <A>(
  grammar: Grammar<A>,
  value: A,
): Effect.Effect<void, RoundTripError> =>
  Effect.gen(function* () {
    const printed = yield* print(grammar, value).pipe(
      Effect.mapError(
        (e) =>
          new RoundTripError({
            stage: "print",
            message: `checkRoundTrip: print failed: ${e.message}`,
          }),
      ),
    )

    const reparsed = yield* parse(printed, grammar).pipe(
      Effect.mapError(
        (e) =>
          new RoundTripError({
            stage: "parse",
            message:
              `checkRoundTrip: re-parse failed: ${e.message}` +
              `\n  printed: ${quote(printed)}` +
              `\n  original: ${preview(value)}`,
          }),
      ),
    )

    if (!Equal.equals(reparsed, value)) {
      return yield* new RoundTripError({
        stage: "equal",
        message:
          `checkRoundTrip: value mismatch` +
          `\n  original: ${preview(value)}` +
          `\n  reparsed: ${preview(reparsed)}` +
          `\n  printed:  ${quote(printed)}`,
      })
    }
  })

/** Best-effort value preview for error messages (not a full pretty-printer). */
const preview = (value: unknown): string => {
  try {
    return Schema.encodeSync(Schema.UnknownFromJsonString)(value)
  } catch {
    return String(value)
  }
}

export const render = (g: Grammar<any>): string => renderInner(g, new Set())

const renderRepetition = (atLeast: number): string => {
  const minimum = Math.ceil(atLeast)
  if (minimum <= 0) return "*"
  if (minimum === 1) return "+"
  return `{${minimum},}`
}

const renderInner = (g: Grammar<any>, inProgress: Set<Grammar<any>>): string => {
  switch (g._tag) {
    case "Literal":
      return JSON.stringify(g.value)
    case "Regex":
      return `/${g.re.source}/${g.re.flags}`
    case "Map":
      return renderInner(g.inner, inProgress)
    case "Struct":
      return Object.entries(g.fields)
        .map(([key, field]) => `${key}: ${renderInner(field, inProgress)}`)
        .join(" ")
    case "Choice":
      return g.options.map((option) => renderInner(option, inProgress)).join(" | ")
    case "Many":
      return `(${renderInner(g.inner, inProgress)})${renderRepetition(g.atLeast)}`
    case "SepBy": {
      const inner = renderInner(g.inner, inProgress)
      const sep = renderInner(g.sep, inProgress)
      const sequence = `${inner} (${sep} ${inner})${renderRepetition(Math.max(0, g.atLeast - 1))}`
      return g.atLeast <= 0 ? `(${sequence})?` : sequence
    }
    case "Optional":
      return `(${renderInner(g.inner, inProgress)})?`
    case "Attempt":
      return `attempt(${renderInner(g.inner, inProgress)})`
    case "FromEffect":
      return `<${g.expected}>`
    case "Lazy": {
      if (inProgress.has(g)) return g.name ?? "…"
      inProgress.add(g)
      const out = renderInner((g.resolved ??= g.thunk()), inProgress)
      inProgress.delete(g)
      return out
    }
    case "End":
      return "<end>"
    case "Bind":
      return `${renderInner(g.inner, inProgress)} >>= <bind>`
    case "Count":
      return `(${renderInner(g.inner, inProgress)}){${g.n}}`
    case "Guard":
      return renderInner(g.inner, inProgress)
    case "Label":
      return g.inner._tag === "Regex" ? `<${g.expected}>` : renderInner(g.inner, inProgress)
  }
}

const parseIssue = (input: string) => (e: ParseError) =>
  new SchemaIssue.InvalidValue(Option.some(input), {
    message: locateParseError(input, e).message,
  })

export const toSchema = <S extends Schema.Top>(
  grammar: Grammar<S["Encoded"]>,
  target: S,
  options?: { readonly identifier?: string },
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail({
        decode: (s: string) => parse(s, grammar).pipe(Effect.mapError(parseIssue(s))),
        encode: (a) =>
          print(grammar, a).pipe(
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
