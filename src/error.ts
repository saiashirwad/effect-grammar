import { Schema } from "effect";

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  pos: Schema.Finite,
  expected: Schema.String,
  found: Schema.UndefinedOr(Schema.String),
  /** 1-based; set at the parse / toSchema boundary. Absent for raw streaming failures. */
  line: Schema.optionalKey(Schema.Finite),
  /** 1-based column within `line`. */
  column: Schema.optionalKey(Schema.Finite),
}) {
  override get message(): string {
    const loc =
      this.line !== undefined && this.column !== undefined
        ? `line ${this.line}, column ${this.column}`
        : `position ${this.pos}`;
    const found = this.found === undefined ? "end of input" : JSON.stringify(this.found);
    return `${loc}: expected ${this.expected}, found ${found}`;
  }
}

/** A chunk source feeding a streaming parse failed. `cause` is the original error. */
export class UpstreamError extends Schema.TaggedErrorClass<UpstreamError>()("UpstreamError", {
  cause: Schema.Defect(),
}) {}

/** Absolute offset → 1-based line/column (`"\n"` only). */
export const offsetToLineColumn = (
  input: string,
  pos: number,
): { readonly line: number; readonly column: number } => {
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos; i++) {
    if (input.charCodeAt(i) === 10 /* \n */) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
};

/** Attach line/column from `input` at `e.pos`. */
export const locateParseError = (input: string, e: ParseError): ParseError => {
  if (e.line !== undefined && e.column !== undefined) return e;
  const { line, column } = offsetToLineColumn(input, e.pos);
  return new ParseError({
    pos: e.pos,
    expected: e.expected,
    found: e.found,
    line,
    column,
  });
};
