# Change and verify the library

Use Node 24 or later for development. CI runs Node 24, and the verification
script runs directly as TypeScript.

## Run the checks

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Run `pnpm check` before handing back a change.
3. Run `pnpm exec vitest bench --run --dir benchmarks` when changing execution.

`pnpm check` runs formatting, linting, typechecking, tests, and the build.
Typechecking includes examples, benchmarks, and the verification script. Package
tests build and pack the library, exercise every public import, and compile
consumer declarations. `pnpm bench` starts Vitest's benchmark watch mode.

Benchmark fixtures verify parsing, exact printed output, and round trips before
timing. The suite measures real dependent construction, text and byte parsing,
checked printing, and unchecked printing. Timing is a comparison aid, not a
deterministic CI gate.

## Compare a structural rewrite with its baseline

1. Create a detached worktree from the pre-change revision.
2. Make the installed dependencies available in that worktree.
3. Run `node tools/verify-readability.ts /absolute/path/to/baseline`.

The script builds the same grammars through both implementations. It compares
parsed values, checked and unchecked output, structured failures and messages,
generator construction counts, and getter order. Cases include nested
dependencies, optional syntax, dispatch, ambiguous choices, JSON, byte lengths,
every byte value, floats, and variable-width integers.

Four explicit optional-error cases normalize the baseline's synthetic choice
failure to its present-branch issue. All other compared failures must match
exactly. Focused tests separately pin changed diagnostic graph paths and earlier
foreign-ref rejection. Keep tests for callback order and lazy resolution. Use
unchecked printing in binding-order tests so final reparsing does not hide the
operation under test.

## Choose a reading path

Read the examples in this order:

1. `examples/endpoint.ts` combines fields with a Schema codec. Unlike the README
   endpoint, its port is optional and range-validated.
2. `examples/netstring.ts` uses a preceding value as a count.
3. `examples/grammars/json.ts` adds recursion and transformations.
4. `examples/dns.ts` combines byte fields, projected counts, and text encoding.

Examples import source modules for local development. The README uses supported
package imports. For the implementation, start with the
[generator trace](architecture.md#one-generator-in-both-directions), then read
the corresponding cases in `src/parse.ts` and `src/print.ts`.

## Put tests beside their behavior

| Concern                                          | Tests                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Public combinators and terminals                 | `test/grammar.test.ts`, `test/api.test.ts`                       |
| Generator binding, scopes, and return layouts    | `test/generator-bindings.test.ts`, `test/generator-refs.test.ts` |
| Choice policy and tagged dispatch                | `test/choice-dispatch.test.ts`                                   |
| Cursor rollback, failure evidence, and recursion | `test/parse-regressions.test.ts`                                 |
| Print failures and round-trip checks             | `test/print-regressions.test.ts`                                 |
| Structural inspection                            | `test/diagnostics.test.ts`                                       |
| Callback and hostile-value boundaries            | `test/runtime-exceptions.test.ts`                                |
| Byte formats                                     | `test/binary.test.ts`                                            |
| Every AST variant                                | `test/interpreters.test.ts`                                      |
| Value preservation and canonicalization          | `test/round-trip.property.test.ts`, `test/testing.test.ts`       |
| Schema and published package contracts           | `test/schema.test.ts`, `test/package.test.ts`                    |

`test/types.ts` and `test/domain-types.ts` run through typechecking. The
interpreter table covers every `Node` tag at compile time; add a parse and
print-law row when adding a variant. Preserve regression assertions when moving
tests into these suites.
