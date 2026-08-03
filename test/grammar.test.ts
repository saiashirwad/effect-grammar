import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Schema } from "effect";
import * as Grammar from "../src/grammar.ts";
import {
  assertRoundTrip,
  parseFail,
  parseOk,
  parsePrefixOk,
  printFail,
  printOk,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// literal
// ---------------------------------------------------------------------------

describe("literal", () => {
  const g = Grammar.literal("hello");

  it("parses a matching prefix (strict EOF)", () => {
    assert.equal(parseOk("hello", g), "hello");
  });

  it("fails with position and expected", () => {
    const e = parseFail("help", g);
    assert.equal(e.pos, 0);
    assert.equal(e.expected, '"hello"');
    assert.equal(e.found, "h");
  });

  it("fails on empty input", () => {
    const e = parseFail("", g);
    assert.equal(e.pos, 0);
    assert.equal(e.expected, '"hello"');
    assert.equal(e.found, undefined);
  });

  it("prints the literal value", () => {
    assert.equal(printOk(g, "hello"), "hello");
  });

  it("round-trips", () => {
    assertRoundTrip(g, "hello");
  });
});

// ---------------------------------------------------------------------------
// regex
// ---------------------------------------------------------------------------

describe("regex", () => {
  const g = Grammar.regex(/[a-z]+/, "word");

  it("parses a match", () => {
    assert.equal(parseOk("abc", g), "abc");
  });

  it("fails with expected and found", () => {
    const e = parseFail("123", g);
    assert.equal(e.pos, 0);
    assert.equal(e.expected, "word");
    assert.equal(e.found, "1");
  });

  it("prints a matching string", () => {
    assert.equal(printOk(g, "xyz"), "xyz");
  });

  it("print rejects a non-matching string", () => {
    const e = printFail(g, "123");
    assert.match(e.message, /does not match word/);
  });

  it("preserves flags on print", () => {
    const gi = Grammar.regex(/foo/i, "foo");
    assert.equal(parseOk("FOO", gi), "FOO");
    assert.equal(printOk(gi, "FOO"), "FOO");
  });

  it("reuses a /g RegExp across matches", () => {
    const re = /\d/g;
    const pair = Grammar.struct({
      a: Grammar.regex(re, "digit"),
      b: Grammar.regex(re, "digit"),
    });
    assert.deepEqual(parseOk("12", pair), { a: "1", b: "2" });
    assert.equal(parseOk("7", Grammar.regex(re, "digit")), "7");
    assert.equal(parseOk("8", Grammar.regex(re, "digit")), "8");
  });

  it("round-trips", () => {
    assertRoundTrip(g, "word");
  });
});

// ---------------------------------------------------------------------------
// struct
// ---------------------------------------------------------------------------

describe("struct", () => {
  const g = Grammar.struct({
    a: Grammar.literal("a"),
    b: Grammar.literal("b"),
  });

  it("parses fields in order", () => {
    assert.deepEqual(parseOk("ab", g), { a: "a", b: "b" });
  });

  it("fails at the broken field", () => {
    const e = parseFail("ax", g);
    assert.equal(e.pos, 1);
    assert.equal(e.expected, '"b"');
    assert.equal(e.found, "x");
  });

  it("prints by concatenating fields", () => {
    assert.equal(printOk(g, { a: "a", b: "b" }), "ab");
  });

  it("round-trips", () => {
    assertRoundTrip(g, { a: "a" as const, b: "b" as const });
  });
});

// ---------------------------------------------------------------------------
// choice
// ---------------------------------------------------------------------------

describe("choice", () => {
  const g = Grammar.choice(Grammar.literal("foo"), Grammar.literal("bar"));

  it("parses the first matching option", () => {
    assert.equal(parseOk("foo", g), "foo");
    assert.equal(parseOk("bar", g), "bar");
  });

  it("fails when no option matches", () => {
    const e = parseFail("baz", g);
    assert.equal(e.pos, 0);
    // furthest among equal positions is last-wins (`pos >=`)
    assert.equal(e.expected, '"bar"');
  });

  // Bare literals always print successfully, so choice always picks the first.
  // Discriminating print needs regex (or guard) — see also the guard suite.
  it("print picks the first option that can print the value", () => {
    const nums = Grammar.choice(
      Grammar.regex(/[0-9]+/, "digits"),
      Grammar.regex(/[a-z]+/, "letters"),
    );
    assert.equal(printOk(nums, "12"), "12");
    assert.equal(printOk(nums, "ab"), "ab");
  });

  it("round-trips when options discriminate on print", () => {
    const nums = Grammar.choice(
      Grammar.regex(/[0-9]+/, "digits"),
      Grammar.regex(/[a-z]+/, "letters"),
    );
    assertRoundTrip(nums, "12");
    assertRoundTrip(nums, "ab");
  });
});

// ---------------------------------------------------------------------------
// many
// ---------------------------------------------------------------------------

describe("many", () => {
  const g = Grammar.many(Grammar.literal("a"));

  it("parses zero or more", () => {
    assert.deepEqual(parseOk("", g), []);
    assert.deepEqual(parseOk("aaa", g), ["a", "a", "a"]);
  });

  it("atLeast requires a minimum", () => {
    const g1 = Grammar.many(Grammar.literal("a"), { atLeast: 2 });
    assert.deepEqual(parseOk("aa", g1), ["a", "a"]);
    const e = parseFail("a", g1);
    assert.equal(e.pos, 1);
    assert.equal(e.expected, '"a"');
  });

  it("prints by concatenating elements", () => {
    assert.equal(printOk(g, ["a", "a"]), "aa");
    assert.equal(printOk(g, []), "");
  });

  it("print rejects below atLeast", () => {
    const g1 = Grammar.many(Grammar.literal("a"), { atLeast: 2 });
    const e = printFail(g1, []);
    assert.match(e.message, /at least 2 items/);
  });

  it("round-trips", () => {
    assertRoundTrip(g, ["a", "a", "a"]);
    assertRoundTrip(g, []);
  });

  it("dies on zero-width success", () => {
    // optional always succeeds without consuming when missing — many would loop forever
    const zeroWidth = Grammar.many(Grammar.optional(Grammar.literal("x")));
    assert.throws(
      () => Effect.runSync(Grammar.parse("", zeroWidth)),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("succeeded without consuming input"),
    );
  });

  it("fails when the inner commits after partial consume", () => {
    const pair = Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") });
    const e = parseFail("abac", Grammar.many(pair));
    assert.equal(e.pos, 3);
    assert.equal(e.expected, '"b"');
  });
});

// ---------------------------------------------------------------------------
// sepBy / sepBy1
// ---------------------------------------------------------------------------

describe("sepBy / sepBy1", () => {
  const item = Grammar.regex(/[a-z]+/, "word");
  const g = Grammar.sepBy(item, Grammar.literal(","));
  const g1 = Grammar.sepBy1(item, Grammar.literal(","));

  it("sepBy accepts empty", () => {
    assert.deepEqual(parseOk("", g), []);
  });

  it("sepBy parses lists", () => {
    assert.deepEqual(parseOk("a,b,c", g), ["a", "b", "c"]);
  });

  it("sepBy1 requires at least one", () => {
    assert.deepEqual(parseOk("a", g1), ["a"]);
    const e = parseFail("", g1);
    assert.equal(e.pos, 0);
    assert.equal(e.expected, "word");
  });

  it("fails after a separator with no following item (committed)", () => {
    const e = parseFail("a,", g);
    assert.equal(e.pos, 2);
    assert.equal(e.expected, "word");
  });

  it("prints with separators", () => {
    assert.equal(printOk(g, ["a", "b"]), "a,b");
    assert.equal(printOk(g, []), "");
  });

  it("print rejects sepBy1 below atLeast", () => {
    const e = printFail(g1, []);
    assert.match(e.message, /at least 1 items/);
  });

  it("dies on zero-width separator+element", () => {
    assert.throws(
      () => Effect.runSync(Grammar.parse("", Grammar.sepBy(Grammar.end, Grammar.end))),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("succeeded without consuming input"),
    );
  });

  it("round-trips", () => {
    assertRoundTrip(g, ["one", "two"]);
    assertRoundTrip(g, []);
    assertRoundTrip(g1, ["only"]);
  });
});

// ---------------------------------------------------------------------------
// optional
// ---------------------------------------------------------------------------

describe("optional", () => {
  const g = Grammar.struct({
    a: Grammar.optional(Grammar.literal("a")),
    b: Grammar.literal("b"),
  });

  it("parses present and missing", () => {
    assert.deepEqual(parseOk("ab", g), { a: "a", b: "b" });
    assert.deepEqual(parseOk("b", g), { a: undefined, b: "b" });
  });

  it("propagates committed failures from the inner parser", () => {
    // optional does not swallow a failure after the inner has consumed input
    const committed = Grammar.struct({
      head: Grammar.optional(
        Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") }),
      ),
      tail: Grammar.literal("x"),
    });
    const e = parseFail("ax", committed);
    assert.equal(e.pos, 1);
    assert.equal(e.expected, '"b"');
  });

  it("prints undefined as empty", () => {
    assert.equal(printOk(g, { a: undefined, b: "b" }), "b");
    assert.equal(printOk(g, { a: "a", b: "b" }), "ab");
  });

  it("round-trips", () => {
    assertRoundTrip(g, { a: "a" as const, b: "b" as const });
    assertRoundTrip(g, { a: undefined, b: "b" as const });
  });
});

// ---------------------------------------------------------------------------
// attempt
// ---------------------------------------------------------------------------

describe("attempt", () => {
  // Without attempt: "tr" + "ue" commits on "tr", so "truce" fails at "e"
  const trueKw = Grammar.struct({
    t: Grammar.literal("tr"),
    rest: Grammar.literal("ue"),
  });
  const ident = Grammar.regex(/[a-z]+/, "ident");

  it("without attempt, choice commits after consume", () => {
    const g = Grammar.choice(trueKw, ident);
    const e = parseFail("truce", g);
    assert.equal(e.pos, 2);
    assert.equal(e.expected, '"ue"');
  });

  it("with attempt, rewinds so choice tries next option", () => {
    const g = Grammar.choice(Grammar.attempt(trueKw), ident);
    assert.equal(parseOk("truce", g), "truce");
    assert.deepEqual(parseOk("true", g), { t: "tr", rest: "ue" });
  });

  it("prints through to the inner grammar", () => {
    const g = Grammar.attempt(Grammar.literal("x"));
    assert.equal(printOk(g, "x"), "x");
  });

  it("round-trips", () => {
    assertRoundTrip(Grammar.attempt(Grammar.literal("ok")), "ok");
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe("count", () => {
  const g = Grammar.count(Grammar.literal("x"), 3);

  it("parses exactly n times", () => {
    assert.deepEqual(parseOk("xxx", g), ["x", "x", "x"]);
  });

  it("fails if fewer than n", () => {
    const e = parseFail("xx", g);
    assert.equal(e.pos, 2);
    assert.equal(e.expected, '"x"');
  });

  it("print rejects wrong length", () => {
    const e = printFail(g, ["x", "x"]);
    assert.match(e.message, /exactly 3 items/);
  });

  it("prints and round-trips", () => {
    assert.equal(printOk(g, ["x", "x", "x"]), "xxx");
    assertRoundTrip(g, ["x", "x", "x"]);
  });
});

// ---------------------------------------------------------------------------
// between
// ---------------------------------------------------------------------------

describe("between", () => {
  const g = Grammar.between(
    Grammar.label("'('", Grammar.literal("(")),
    Grammar.label("')'", Grammar.literal(")")),
    Grammar.integer,
  );

  it("parses open, inner, close", () => {
    assert.equal(parseOk("(42)", g), 42);
  });

  it("fails on missing close with the delimiter label", () => {
    const e = parseFail("(42", g);
    assert.equal(e.pos, 3);
    assert.equal(e.expected, "')'");
  });

  it("prints delimiters around the value", () => {
    assert.equal(printOk(g, 7), "(7)");
  });

  it("round-trips", () => {
    assertRoundTrip(g, 99);
  });
});

// ---------------------------------------------------------------------------
// integer
// ---------------------------------------------------------------------------

describe("integer", () => {
  it("parses signed integers", () => {
    assert.equal(parseOk("42", Grammar.integer), 42);
    assert.equal(parseOk("-7", Grammar.integer), -7);
  });

  it("fails on non-digits", () => {
    const e = parseFail("x", Grammar.integer);
    assert.equal(e.pos, 0);
    assert.equal(e.expected, "integer");
  });

  it("prints and round-trips", () => {
    assert.equal(printOk(Grammar.integer, 42), "42");
    assertRoundTrip(Grammar.integer, -3);
  });
});

// ---------------------------------------------------------------------------
// lexeme / symbol
// ---------------------------------------------------------------------------

describe("lexeme / symbol", () => {
  const g = Grammar.struct({
    a: Grammar.symbol("let"),
    name: Grammar.lexeme(Grammar.regex(/[a-z]+/, "name")),
  });

  it("skips trailing whitespace after tokens", () => {
    assert.deepEqual(parseOk("let  foo", g), { a: "let", name: "foo" });
    assert.deepEqual(parseOk("let foo", g), { a: "let", name: "foo" });
  });

  it("fails with the inner expected", () => {
    const e = parseFail("var x", g);
    assert.equal(e.pos, 0);
    assert.equal(e.expected, '"let"');
  });

  it("print emits a canonical trailing space from lexeme", () => {
    // lexeme from maps ws → " "
    const printed = printOk(g, { a: "let", name: "foo" });
    assert.equal(printed, "let foo ");
  });

  it("round-trips (print normalizes whitespace)", () => {
    const value = { a: "let" as const, name: "foo" };
    const printed = printOk(g, value);
    assert.deepEqual(parseOk(printed, g), value);
  });
});

// ---------------------------------------------------------------------------
// lazy
// ---------------------------------------------------------------------------

describe("lazy", () => {
  type Nest = { readonly n: number; readonly inner?: Nest };

  const nest: Grammar.Grammar<Nest> = Grammar.lazy(
    () =>
      Grammar.map(
        Grammar.struct({
          open: Grammar.literal("("),
          n: Grammar.integer,
          rest: Grammar.optional(
            Grammar.struct({
              comma: Grammar.literal(","),
              inner: nest,
            }),
          ),
          close: Grammar.literal(")"),
        }),
        {
          to: ({ n, rest }) => (rest === undefined ? { n } : { n, inner: rest.inner }),
          from: ({ n, inner }) => ({
            open: "(" as const,
            n,
            rest: inner === undefined ? undefined : { comma: "," as const, inner },
            close: ")" as const,
          }),
        },
      ),
    { name: "nest" },
  );

  it("parses recursive nesting", () => {
    assert.deepEqual(parseOk("(1,(2,(3)))", nest), {
      n: 1,
      inner: { n: 2, inner: { n: 3 } },
    });
  });

  it("render terminates on cycles", () => {
    const s = Grammar.render(nest);
    assert.ok(s.includes("nest"), `render should mention the cycle name, got: ${s}`);
    // must finish (no infinite loop) and stay finite
    assert.ok(s.length < 500);
  });

  it("round-trips", () => {
    assertRoundTrip(nest, { n: 1, inner: { n: 2 } });
  });
});

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

describe("bind", () => {
  const exactly = (n: number): Grammar.Grammar<string> =>
    Grammar.map(Grammar.count(Grammar.regex(/[\s\S]/, "char"), n), {
      to: (chars) => chars.join(""),
      from: (s: string) => s.split(""),
    });

  const lengthPrefix = Grammar.map(
    Grammar.struct({ n: Grammar.integer, colon: Grammar.literal(":") }),
    {
      to: ({ n }) => n,
      from: (n: number) => ({ n, colon: ":" as const }),
    },
  );

  const netish = Grammar.bind(lengthPrefix, {
    to: exactly,
    from: (s: string) => s.length,
  });

  it("dependent parse uses the bound value", () => {
    assert.equal(parseOk("3:abc", netish), "abc");
  });

  it("fails when the payload is too short", () => {
    const e = parseFail("3:ab", netish);
    assert.equal(e.pos, 4);
    assert.equal(e.expected, "char");
  });

  it("prints with from", () => {
    assert.equal(printOk(netish, "hi"), "2:hi");
  });

  it("print fails honestly without from", () => {
    const parseOnly = Grammar.bind(lengthPrefix, { to: exactly });
    const e = printFail(parseOnly, "abc");
    assert.match(e.message, /missing `from`/);
  });

  it("round-trips", () => {
    assertRoundTrip(netish, "hello");
  });
});

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

describe("guard", () => {
  const num = Grammar.guard(
    Grammar.map(Grammar.regex(/\d+/, "digits"), { to: Number, from: String }),
    (v) => typeof v === "number",
  );
  const word = Grammar.guard(Grammar.regex(/[a-z]+/, "word"), (v) => typeof v === "string");
  const g = Grammar.choice(num, word);

  it("parse is unaffected by the predicate", () => {
    assert.equal(parseOk("42", g), 42);
    assert.equal(parseOk("hi", g), "hi");
  });

  it("print rejects values that fail the guard", () => {
    const e = printFail(num, "not-a-number" as unknown as number);
    assert.match(e.message, /rejected by guard/);
  });

  it("choice skips guarded options when printing", () => {
    assert.equal(printOk(g, 9), "9");
    assert.equal(printOk(g, "ok"), "ok");
  });

  it("round-trips", () => {
    assertRoundTrip(g, 12);
    assertRoundTrip(g, "ab");
  });
});

// ---------------------------------------------------------------------------
// fromEffect
// ---------------------------------------------------------------------------

describe("fromEffect", () => {
  it("parses via the opaque effect", () => {
    const g = Grammar.fromEffect(Effect.succeed("hardcoded"), "fx");
    assert.equal(parsePrefixOk("anything", g), "hardcoded");
  });

  it("print fails with PrintError so choice can try the next option", () => {
    const g = Grammar.choice(
      Grammar.fromEffect(Effect.succeed("x"), "fx"),
      Grammar.literal("y"),
    );
    assert.equal(printOk(g, "y"), "y");
    const e = printFail(Grammar.fromEffect(Effect.succeed("x"), "fx"), "x");
    assert.match(e.message, /effect-only fragment/);
  });
});

// ---------------------------------------------------------------------------
// backtracking semantics
// ---------------------------------------------------------------------------

describe("backtracking semantics", () => {
  it("choice commits after consuming input", () => {
    const ab = Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") });
    const ac = Grammar.struct({ a: Grammar.literal("a"), c: Grammar.literal("c") });
    const g = Grammar.choice(ab, ac);
    // first option consumes "a", fails on "c" vs "b" — second option is not tried
    const e = parseFail("ac", g);
    assert.equal(e.pos, 1);
    assert.equal(e.expected, '"b"');
  });

  it("attempt rewinds so choice can try the next option", () => {
    const ab = Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") });
    const ac = Grammar.struct({ a: Grammar.literal("a"), c: Grammar.literal("c") });
    const g = Grammar.choice(Grammar.attempt(ab), ac);
    assert.deepEqual(parseOk("ac", g), { a: "a", c: "c" });
  });

  it("many dies on zero-width success", () => {
    assert.throws(() => Effect.runSync(Grammar.parse("x", Grammar.many(Grammar.end))));
  });
});

// ---------------------------------------------------------------------------
// strict EOF
// ---------------------------------------------------------------------------

describe("strict EOF", () => {
  const g = Grammar.literal("hi");

  it("parse rejects trailing garbage", () => {
    const e = parseFail("hi!", g);
    assert.equal(e.pos, 2);
    assert.equal(e.expected, "end of input");
    assert.equal(e.found, "!");
  });

  it("parsePrefix allows trailing input", () => {
    assert.equal(parsePrefixOk("hi!", g), "hi");
  });
});

// ---------------------------------------------------------------------------
// toSchema
// ---------------------------------------------------------------------------

describe("toSchema", () => {
  const g = Grammar.integer;
  const S = Grammar.toSchema(g, Schema.Finite, { identifier: "Int" });

  it("derived schema decodes and encodes", () => {
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(S)("42"));
    assert.equal(decoded, 42);
    const encoded = Effect.runSync(Schema.encodeEffect(S)(42));
    assert.equal(encoded, "42");
  });

  it("strict EOF applies through the schema", () => {
    const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(S)("42x")));
    assert.equal(r._tag, "Failure");
    if (r._tag === "Failure") {
      assert.match(String(r.failure), /end of input/);
    }
  });

  it("refinement errors surface when the target rejects", () => {
    const Positive = Grammar.toSchema(g, Schema.Finite.check(Schema.isGreaterThan(0)));
    const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Positive)("0")));
    assert.equal(r._tag, "Failure");
  });

  it("encode fails when print fails", () => {
    const word = Grammar.toSchema(Grammar.regex(/[a-z]+/, "word"), Schema.String);
    const r = Effect.runSync(Effect.result(Schema.encodeEffect(word)("123")));
    assert.equal(r._tag, "Failure");
  });
});

// ---------------------------------------------------------------------------
// label
// ---------------------------------------------------------------------------

describe("label", () => {
  it("replaces expected when the inner fails without consuming", () => {
    const g = Grammar.label("port", Grammar.regex(/\d+/, "digits"));
    const e = parseFail("#", g);
    assert.equal(e.pos, 0);
    assert.equal(e.expected, "port");
    assert.equal(e.found, "#");
  });

  it("propagates the inner expected after consuming input", () => {
    const g = Grammar.label(
      "ab",
      Grammar.struct({ a: Grammar.literal("a"), b: Grammar.literal("b") }),
    );
    const e = parseFail("ax", g);
    assert.equal(e.pos, 1);
    assert.equal(e.expected, '"b"');
    assert.equal(e.found, "x");
  });

  it("print is transparent", () => {
    const g = Grammar.label("word", Grammar.regex(/[a-z]+/, "word"));
    assert.equal(printOk(g, "hi"), "hi");
  });

  it("round-trips", () => {
    assertRoundTrip(Grammar.label("n", Grammar.integer), 7);
  });

  it("render shows <label> for a raw regex, otherwise the inner", () => {
    assert.equal(Grammar.render(Grammar.label("port", Grammar.regex(/\d+/, "digits"))), "<port>");
    assert.equal(Grammar.render(Grammar.label("hi", Grammar.literal("hi"))), '"hi"');
  });
});

// ---------------------------------------------------------------------------
// line / column messages
// ---------------------------------------------------------------------------

describe("line / column messages", () => {
  it("attaches 1-based line and column at the parse boundary", () => {
    const g = Grammar.struct({
      a: Grammar.literal("aa"),
      nl: Grammar.literal("\n"),
      b: Grammar.literal("bb"),
    });
    const e = parseFail("aa\nx", g);
    assert.equal(e.pos, 3);
    assert.equal(e.line, 2);
    assert.equal(e.column, 1);
    assert.equal(e.expected, '"bb"');
    assert.equal(e.message, 'line 2, column 1: expected "bb", found "x"');
  });

  it("uses column = pos + 1 on a single line", () => {
    const e = parseFail("hello!", Grammar.literal("hello"));
    assert.equal(e.pos, 5);
    assert.equal(e.line, 1);
    assert.equal(e.column, 6);
    assert.match(e.message, /^line 1, column 6: expected end of input, found "!"$/);
  });

  it("surfaces in toSchema decode errors", () => {
    const S = Grammar.toSchema(
      Grammar.label("port", Grammar.regex(/\d+/, "digits")),
      Schema.String,
    );
    const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(S)("#")));
    assert.equal(r._tag, "Failure");
    if (r._tag === "Failure") {
      assert.match(String(r.failure), /line 1, column 1: expected port, found "#"/);
    }
  });
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

describe("render", () => {
  it("renders literals, regexes, and combinators", () => {
    assert.equal(Grammar.render(Grammar.literal("hi")), '"hi"');
    assert.equal(Grammar.render(Grammar.regex(/\d+/, "digits")), "/\\d+/");
    assert.equal(Grammar.render(Grammar.regex(/abc/is, "abc")), "/abc/is");
    assert.equal(
      Grammar.render(Grammar.choice(Grammar.literal("a"), Grammar.literal("b"))),
      '"a" | "b"',
    );
    assert.equal(Grammar.render(Grammar.many(Grammar.literal("x"))), '("x")*');
    assert.equal(Grammar.render(Grammar.many(Grammar.literal("x"), { atLeast: 1 })), '("x")+');
    assert.equal(Grammar.render(Grammar.many(Grammar.literal("x"), { atLeast: 0.5 })), '("x")+');
    assert.equal(
      Grammar.render(Grammar.many(Grammar.literal("x"), { atLeast: 2 })),
      '("x"){2,}',
    );
    assert.equal(Grammar.render(Grammar.optional(Grammar.literal("x"))), '("x")?');
    assert.equal(Grammar.render(Grammar.count(Grammar.literal("x"), 2)), '("x"){2}');
    assert.equal(Grammar.render(Grammar.end), "<end>");
    assert.equal(
      Grammar.render(Grammar.attempt(Grammar.literal("x"))),
      'attempt("x")',
    );
  });

  it("renders struct fields", () => {
    const s = Grammar.render(
      Grammar.struct({ a: Grammar.literal("a"), b: Grammar.integer }),
    );
    assert.equal(s, 'a: "a" b: <integer>');
  });

  it("renders sepBy", () => {
    const s = Grammar.render(Grammar.sepBy(Grammar.literal("a"), Grammar.literal(",")));
    assert.equal(s, '("a" ("," "a")*)?');
    assert.equal(
      Grammar.render(Grammar.sepBy1(Grammar.literal("a"), Grammar.literal(","))),
      '"a" ("," "a")*',
    );
  });

  it("renders bind", () => {
    const s = Grammar.render(
      Grammar.bind(Grammar.integer, { to: () => Grammar.literal("x") }),
    );
    assert.equal(s, "<integer> >>= <bind>");
  });
});

// ---------------------------------------------------------------------------
// checkRoundTrip
// ---------------------------------------------------------------------------

describe("checkRoundTrip", () => {
  it("succeeds when print ∘ parse recovers the value", () => {
    Effect.runSync(Grammar.checkRoundTrip(Grammar.integer, 42));
    Effect.runSync(
      Grammar.checkRoundTrip(
        Grammar.struct({ a: Grammar.literal("a"), n: Grammar.integer }),
        { a: "a", n: 7 },
      ),
    );
  });

  it("fails at stage print when the value cannot be printed", () => {
    // bind without `from` — print is honest and refuses
    const g = Grammar.bind(Grammar.integer, { to: () => Grammar.literal("x") });
    const r = Effect.runSync(Effect.result(Grammar.checkRoundTrip(g, "x")));
    assert.equal(r._tag, "Failure");
    if (r._tag === "Failure") {
      assert.ok(Schema.is(Grammar.RoundTripError)(r.failure));
      assert.equal(r.failure.stage, "print");
      assert.match(r.failure.message, /print failed/);
    }
  });

  it("fails at stage print when many atLeast is not met", () => {
    const g = Grammar.many(Grammar.literal("a"), { atLeast: 2 });
    const r = Effect.runSync(Effect.result(Grammar.checkRoundTrip(g, [])));
    assert.equal(r._tag, "Failure");
    if (r._tag === "Failure") {
      assert.ok(Schema.is(Grammar.RoundTripError)(r.failure));
      assert.equal(r.failure.stage, "print");
      assert.match(r.failure.message, /print failed/);
    }
  });

  it("fails at stage parse when the printed string does not re-parse", () => {
    // `end` between tokens prints as "" so the string is "ab", but re-parse hits
    // end while input remains.
    const g = Grammar.struct({
      a: Grammar.literal("a"),
      e: Grammar.end,
      b: Grammar.literal("b"),
    });
    const r = Effect.runSync(
      Effect.result(Grammar.checkRoundTrip(g, { a: "a", e: undefined, b: "b" })),
    );
    assert.equal(r._tag, "Failure");
    if (r._tag === "Failure") {
      assert.ok(Schema.is(Grammar.RoundTripError)(r.failure));
      assert.equal(r.failure.stage, "parse");
      assert.match(r.failure.message, /re-parse failed/);
    }
  });

  it("fails at stage equal when re-parse yields a different value", () => {
    // print always emits "0"; parse turns that into 0 — original was 1
    const g = Grammar.map(Grammar.regex(/\d+/, "digits"), {
      to: Number,
      from: () => "0",
    });
    const r = Effect.runSync(Effect.result(Grammar.checkRoundTrip(g, 1)));
    assert.equal(r._tag, "Failure");
    if (r._tag === "Failure") {
      assert.ok(Schema.is(Grammar.RoundTripError)(r.failure));
      assert.equal(r.failure.stage, "equal");
      assert.match(r.failure.message, /value mismatch/);
      assert.match(r.failure.message, /original/);
      assert.match(r.failure.message, /reparsed/);
    }
  });
});
