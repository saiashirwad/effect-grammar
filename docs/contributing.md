# Change and verify the library

Use Node 24+. Install dependencies with `pnpm install --frozen-lockfile`.

## Run the checks

Before submitting, run formatting, linting, typechecking, tests, and the build:

```sh
pnpm check
```

For execution or codec-derivation changes, compare benchmarks. Timings are aids,
not CI gates:

```sh
pnpm exec vitest bench --run --dir benchmarks
```

## Compare structural rewrites

1. Create a detached worktree from the pre-change revision.
2. Install dependencies there.
3. Run `node tools/verify-readability.ts /absolute/path/to/baseline`.

This compares parsed values, output, failures, and execution order. Preserve
callback/getter order and lazy resolution. Use unchecked printing in
binding-order tests.

## Find your way around

Start with `examples/endpoint.ts` and `examples/netstring.ts`. For recursion and
binary formats, see `examples/grammars/json.ts` and `examples/dns.ts`.

For implementation details, start at `src/internal/generator.ts`, then
`src/parse.ts` and `src/print.ts`.

## Add tests

- Keep regressions in the relevant behavior suite.
- Type tests live in `test/types.ts` and `test/domain-types.ts`.
- New AST `Node` variants need parse and print-law coverage in
  `test/interpreters.test.ts`.
