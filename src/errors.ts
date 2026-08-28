import { Schema } from "effect"

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
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

export class PrintError extends Schema.TaggedErrorClass<PrintError>()("PrintError", {
  message: Schema.String,
}) {}

/** A short, never-throwing rendering of a value for error messages. */
export const preview = <T>(value: T): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
