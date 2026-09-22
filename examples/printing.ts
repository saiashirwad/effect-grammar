import { Console, Effect, Result, Schema } from "effect"

import * as Grammar from "../src/index.ts"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const show = <A>(label: string, result: Result.Result<A, { readonly message: string }>) =>
  Result.match(result, {
    onSuccess: (value) => `${label}\n  → ${json(value)}`,
    onFailure: (error) => `${label}\n  → ✗ ${error.message}`,
  })

const netstring = Grammar.gen(function*() {
  const length = yield* Grammar.integer
  yield* Grammar.literal(":")
  const payload = yield* Grammar.take(length)
  yield* Grammar.literal(",")
  return { length, payload }
})

const header = Grammar.gen(function*() {
  const kind = yield* Grammar.literals("text", "bits")
  yield* Grammar.literal("/")
  const size = yield* Grammar.integer
  return { kind, size }
})

const frame = Grammar.gen(function*() {
  const parsedHeader = yield* header
  yield* Grammar.literal(":")
  const body = yield* Grammar.match(
    Grammar.get(parsedHeader, "kind"),
    [
      ["text", Grammar.take(Grammar.get(parsedHeader, "size"))],
      ["bits", Grammar.regex(/[01]/, "bit").pipe(Grammar.repeat(Grammar.get(parsedHeader, "size")))],
    ] as const,
  )
  return { header: parsedHeader, body }
})

const endpoint = Grammar.gen(function*() {
  yield* Grammar.literal("https://")
  const host = yield* Grammar.regex(/[^:/?#]+/, "host")
  const port = yield* Grammar.integer.pipe(Grammar.prefix(":"), Grammar.optional)
  return { host, port }
})

const param = Grammar.gen(function*() {
  const key = yield* Grammar.regex(/[a-z]+/, "key")
  yield* Grammar.literal("=")
  const value = yield* Grammar.regex(/[^&]+/, "value")
  return { key, value }
})

const query = Grammar.gen(function*() {
  yield* Grammar.literal("?")
  const params = yield* param.pipe(Grammar.sepBy("&"))
  return params
}).pipe(
  Grammar.transform({
    decode: (entries) => Object.fromEntries(entries.map(({ key, value }) => [key, value])),
    encode: (record) => Object.entries(record).map(([key, value]) => ({ key, value })),
  }),
  Grammar.filter(Schema.is(Schema.Record(Schema.String, Schema.String)), "record"),
)

const program = Effect.gen(function*() {
  yield* Console.log("── netstring ────────────────────────────────────────")
  yield* Console.log(`grammar: ${Grammar.render(netstring)}`)
  yield* Console.log(show("parse \"12:hello world!,\"", Grammar.parse(netstring, "12:hello world!,")))
  yield* Console.log(
    show(
      "print { length: 12, payload: \"hello world!\" }",
      Grammar.print(netstring, { length: 12, payload: "hello world!" }),
    ),
  )

  yield* Console.log("── tagged frames ────────────────────────────────────")
  yield* Console.log(`grammar: ${Grammar.render(frame)}`)
  yield* Console.log(show("parse \"text/3:abc\"", Grammar.parse(frame, "text/3:abc")))
  yield* Console.log(show("parse \"bits/4:1010\"", Grammar.parse(frame, "bits/4:1010")))
  yield* Console.log(
    show(
      "print { header: text/2, body: \"hi\" }",
      Grammar.print(frame, {
        header: { kind: "text", size: 2 },
        body: "hi",
      }),
    ),
  )
  yield* Console.log(
    show(
      "print { header: bits/4, body: bits }",
      Grammar.print(frame, { header: { kind: "bits", size: 4 }, body: ["1", "0", "1", "0"] }),
    ),
  )
  yield* Console.log(
    show(
      "print { header: text/2, body: \"xyz\" }  (body disagrees with header)",
      Grammar.print(frame, { header: { kind: "text", size: 2 }, body: "xyz" }),
    ),
  )

  yield* Console.log("── url ──────────────────────────────────────────────")
  yield* Console.log(`grammar: ${Grammar.render(endpoint)}`)
  yield* Console.log(
    show("print { host, port: 8080 }", Grammar.print(endpoint, { host: "effect.website", port: 8080 })),
  )
  yield* Console.log(
    show(
      "print { host, port: undefined }  (absent → nothing)",
      Grammar.print(endpoint, { host: "effect.website", port: undefined }),
    ),
  )

  yield* Console.log("── query string ─────────────────────────────────────")
  yield* Console.log(`grammar: ${Grammar.render(query)}`)
  yield* Console.log(show("parse \"?sslmode=require&user=alice\"", Grammar.parse(query, "?sslmode=require&user=alice")))
  yield* Console.log(
    show(
      "print { user: \"alice\", sslmode: \"require\" }",
      Grammar.print(query, { user: "alice", sslmode: "require" }),
    ),
  )

  const rounded = Grammar.integer.pipe(Grammar.transform({ decode: (value) => value, encode: Math.floor }))
  yield* Console.log("── checked and unchecked printing ───────────────────")
  yield* Console.log(show("print 1.5  (rejects a lossy round trip)", Grammar.print(rounded, 1.5)))
  yield* Console.log(show("printUnchecked 1.5  (prints 1)", Grammar.printUnchecked(rounded, 1.5)))
})

program.pipe(Effect.runSync)
