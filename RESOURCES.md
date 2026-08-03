# Resources

Ideas and prior art behind the design of `src/grammar.ts`.

## The core idea: invertible syntax descriptions

`grammar.ts` defines grammars as **data** (a tree of `Node`s) rather than
programs, so one definition can be walked in both directions: `interpret`
parses, `printNode` prints. The `map` combinator carries both directions of a
transformation (`to` / `from`) — a _partial isomorphism_.

This pattern is known as **invertible syntax descriptions**, from:

- Tillmann Rendel & Klaus Ostermann, _Invertible Syntax Descriptions: Unifying
  Parsing and Pretty Printing_ (2010). PureScript README with a good summary:
  <https://github.com/kaxap/arl/blob/master/README-PureScript.md>

## Prior art

- **Haskell** — several libraries implement the pattern, e.g. `roundtrip-aeson`
  (JSON un-/parsing from one invertible definition) and Happstack's
  `boomerang` (bidirectional URL routing). See
  <https://hackage.haskell.org/packages/>
- **fp-ts** — `fp-ts-routing`: the same trick for bidirectional route
  parsing/printing in TypeScript.
- **Effect** — no official parser-combinator package. `@effect/printer`
  (<https://github.com/Effect-TS/effect/blob/main/packages/printer/README.md>)
  is only the print half (Wadler-style pretty-printing, no parsing).
  Effect **Schema** is the closest relative philosophically — one definition,
  both decode and encode — but it transforms data structures, not text;
  `grammar.ts`'s `toSchema` bridges the two by embedding the grammar as a
  `SchemaTransformation`.

## Design rule of thumb

- The **grammar** handles _shape_ (what the text looks like).
- The **Schema** (via `toSchema`) handles _refinement_ (whether the values are
  valid — e.g. port ranges, non-empty strings).
- Parsing alone, with no need to print? The plain Effect combinator style in
  `src/parser.ts` (see `examples/ip.ts`) is simpler — no `from` functions to
  write.

## Examples

- `examples/connection-string.ts` — the showcase for `grammar.ts`: parses
  PostgreSQL DSNs, prints them back, derives a Schema, renders the grammar.
- `examples/schema-derivation.ts` — smaller IP-address version of the same
  idea, plus the `fromEffect` escape hatch.
