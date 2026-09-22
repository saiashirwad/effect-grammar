import { Predicate, Schema } from "effect"

import type { Value } from "./core.ts"
import { hex } from "./internal/bytes.ts"

const describeExpected = (expected: ReadonlyArray<string>): string =>
  expected.length === 1 ? expected[0]! : `one of ${expected.join(", ")}`

export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  pos: Schema.Finite,
  line: Schema.UndefinedOr(Schema.Finite),
  column: Schema.UndefinedOr(Schema.Finite),
  expected: Schema.Array(Schema.String),
  found: Schema.UndefinedOr(Schema.String),
}) {
  override get message(): string {
    const expected = describeExpected(this.expected)
    if (this.line === undefined) {
      const found = this.found === undefined ? "end of input" : `0x${hex(Uint8Array.of(this.found.charCodeAt(0)))}`
      return `byte ${this.pos}: expected ${expected}, found ${found}`
    }
    const found = this.found === undefined ? "end of input" : JSON.stringify(this.found)
    return `line ${this.line}, column ${this.column}: expected ${expected}, found ${found}`
  }
}

export type PrintIssue =
  | { readonly _tag: "TypeMismatch"; readonly expected: string; readonly actual: Value }
  | { readonly _tag: "ConstantMismatch"; readonly expected: Value; readonly actual: Value }
  | { readonly _tag: "MissingField"; readonly field: string }
  | { readonly _tag: "MissingBinding"; readonly binding: string }
  | {
      readonly _tag: "InvalidValue"
      readonly expected: string
      readonly actual: Value
      readonly detail?: string | undefined
    }
  | { readonly _tag: "NoAlternative"; readonly actual: Value; readonly issues: ReadonlyArray<PrintIssue> }
  | {
      readonly _tag: "RoundTrip"
      readonly value: Value
      readonly printed: string
      readonly parsed?: Value
      readonly error?: string | undefined
    }
  | { readonly _tag: "AtPath"; readonly path: string | number; readonly issue: PrintIssue }

const pathText = (path: ReadonlyArray<string | number>) =>
  path.map((part) => (Predicate.isNumber(part) ? `[${part}]` : `.${part}`)).join("")

const formatAt = (issue: PrintIssue, path: ReadonlyArray<string | number>): string => {
  if (issue._tag === "AtPath") return formatAt(issue.issue, [...path, issue.path])

  const prefix = path.length === 0 ? "" : `${pathText(path)}: `
  switch (issue._tag) {
    case "TypeMismatch":
      return `${prefix}expected ${issue.expected}, got ${preview(issue.actual)}`
    case "ConstantMismatch":
      return `${prefix}expected ${preview(issue.expected)}, got ${preview(issue.actual)}`
    case "MissingField":
      return path.length === 0 ? `.${issue.field}: missing field` : `${pathText(path)}: missing field`
    case "MissingBinding":
      return `${prefix}${issue.binding} is not in the value`
    case "InvalidValue":
      return issue.detail === undefined
        ? `${prefix}expected ${issue.expected}, got ${preview(issue.actual)}`
        : `${prefix}${issue.expected}: ${issue.detail}`
    case "NoAlternative":
      return `${prefix}no choice branch accepts ${preview(issue.actual)}:\n  ${issue.issues
        .map((child) => formatAt(child, []))
        .join("\n  ")}`
    case "RoundTrip":
      return `${prefix}${preview(issue.value)} ${describeRoundTrip(issue)}`
  }
}

export const formatIssue = (issue: PrintIssue): string => formatAt(issue, [])

export const describeRoundTrip = (issue: Extract<PrintIssue, { _tag: "RoundTrip" }>): string =>
  issue.error === undefined
    ? `prints as ${JSON.stringify(issue.printed)}, which reads back as ${preview(issue.parsed)}`
    : `prints as ${JSON.stringify(issue.printed)}, which does not parse back: ${issue.error}`

export class PrintError extends Schema.TaggedError<PrintError>()("PrintError", {
  issue: Schema.Unknown,
}) {
  declare readonly issue: PrintIssue

  override get message(): string {
    return formatIssue(this.issue)
  }

  static format(issue: PrintIssue): string {
    return formatIssue(issue)
  }
}

const show = (value: Value, seen: ReadonlyArray<Value>): string | undefined => {
  if (Predicate.isBigInt(value)) return `${value}n`
  if (Predicate.isUint8Array(value)) return `<${hex(value)}>`
  if (seen.includes(value)) throw new TypeError("circular value")
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item: Value) => show(item, [...seen, value]) ?? "null").join(",")}]`
  }
  if (!Predicate.isObject(value) || Predicate.isFunction(value["toJSON"])) {
    return JSON.stringify(value)
  }
  const fields = Object.entries(value).flatMap(([key, field]) => {
    const text = show(field, [...seen, value])
    return text === undefined ? [] : [`${JSON.stringify(key)}:${text}`]
  })
  return `{${fields.join(",")}}`
}

export const preview = <T>(value: T): string => {
  try {
    return show(value, []) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return "<unprintable value>"
    }
  }
}

export const exceptionMessage = (error: Value): string => (Predicate.isError(error) ? error.message : preview(error))
