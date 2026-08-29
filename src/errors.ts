import { Predicate, Schema } from "effect"

import type { Value } from "./core.ts"

export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  pos: Schema.Finite,
  line: Schema.Finite,
  column: Schema.Finite,
  expected: Schema.Array(Schema.String),
  found: Schema.UndefinedOr(Schema.String),
}) {
  override get message(): string {
    const found = this.found === undefined ? "end of input" : JSON.stringify(this.found)
    const expected =
      this.expected.length === 1 ? this.expected[0] : `one of ${this.expected.join(", ")}`
    return `line ${this.line}, column ${this.column}: expected ${expected}, found ${found}`
  }
}

export type PrintIssue =
  | {
      readonly _tag: "TypeMismatch"
      readonly expected: string
      readonly actual: Value
    }
  | {
      readonly _tag: "ConstantMismatch"
      readonly expected: Value
      readonly actual: Value
    }
  | {
      readonly _tag: "MissingField"
      readonly field: string
    }
  | {
      readonly _tag: "MissingBinding"
      readonly binding: string
    }
  | {
      readonly _tag: "InvalidValue"
      readonly expected: string
      readonly actual: Value
      readonly detail?: string | undefined
    }
  | {
      readonly _tag: "NoAlternative"
      readonly actual: Value
      readonly issues: ReadonlyArray<PrintIssue>
    }
  | {
      readonly _tag: "AtPath"
      readonly path: string | number
      readonly issue: PrintIssue
    }

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
      return path.length === 0
        ? `.${issue.field}: missing field`
        : `${pathText(path)}: missing field`
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
  }
}

export class PrintError extends Schema.TaggedError<PrintError>()("PrintError", {
  issue: Schema.Unknown,
}) {
  declare readonly issue: PrintIssue

  override get message(): string {
    return PrintError.format(this)
  }

  static format(error: PrintError | PrintIssue): string {
    return formatAt(error._tag === "PrintError" ? error.issue : error, [])
  }
}

export const preview = <T>(value: T): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export const exceptionMessage = (error: Value): string =>
  Predicate.isError(error) ? error.message : preview(error)
