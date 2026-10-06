import { Schema, SchemaAST } from "effect"

export type Emit = (output: ValueNode) => Schema.Top

export type ValueNode =
  | { readonly _tag: "Schema"; readonly schema: Schema.Top }
  | { readonly _tag: "Suspend"; readonly body: () => ValueNode }
  | { readonly _tag: "Union"; readonly members: ReadonlyArray<ValueNode> }
  | { readonly _tag: "Check"; readonly inner: ValueNode; readonly check: (emit: Emit) => SchemaAST.Check<any> }
  | { readonly _tag: "Label"; readonly inner: ValueNode; readonly name: string }
  | { readonly _tag: "Array"; readonly item: ValueNode }
  | { readonly _tag: "Tuple"; readonly items: ReadonlyArray<ValueNode> }
  | { readonly _tag: "Struct"; readonly fields: ReadonlyArray<readonly [PropertyKey, ValueNode]> }

/** Effect does not allow checks directly on Suspend. */
const checkable = (schema: Schema.Top): Schema.Top => SchemaAST.isSuspend(schema.ast) ? Schema.Union([schema]) : schema

export const emitSchema = (root: ValueNode): Schema.Top => {
  const entries = new Map<ValueNode, Schema.Top>()
  const expansions = new Map<ValueNode, Map<bigint, Schema.Top>>()
  const bits = new Map<ValueNode, bigint>()
  const bitOf = (output: ValueNode): bigint => {
    let bit = bits.get(output)
    if (bit === undefined) {
      bit = 1n << BigInt(bits.size)
      bits.set(output, bit)
    }
    return bit
  }

  const entry: Emit = (output) => {
    const known = entries.get(output)
    if (known !== undefined) return known
    let target: Schema.Top
    entries.set(output, Schema.suspend(() => target))
    target = expand(output, 0n)
    entries.set(output, target)
    return target
  }

  const expand = (output: ValueNode, active: bigint): Schema.Top => {
    if (output._tag === "Schema") return output.schema
    let cached = expansions.get(output)
    const known = cached?.get(active)
    if (known !== undefined) return known
    if (cached === undefined) {
      cached = new Map()
      expansions.set(output, cached)
    }
    let schema: Schema.Top
    switch (output._tag) {
      case "Suspend": {
        const bit = bitOf(output)
        if ((active & bit) !== 0n) schema = Schema.Never
        else {
          const target = expand(output.body(), active | bit)
          schema = Schema.suspend(() => target)
        }
        break
      }
      case "Union": {
        const exits = new Set<ValueNode>()
        const seen = new Set<ValueNode>()
        const collect = (member: ValueNode): void => {
          if (seen.has(member)) return
          seen.add(member)
          if (member._tag === "Union") member.members.forEach(collect)
          else if (member._tag === "Suspend") {
            if ((active & bitOf(member)) === 0n) collect(member.body())
          } else exits.add(member)
        }
        output.members.forEach(collect)
        const members = Array.from(exits, (member) => expand(member, active))
        schema = members.length === 1 ? members[0]! : Schema.Union(members)
        break
      }
      case "Check":
        schema = checkable(expand(output.inner, active)).check(output.check(entry))
        break
      case "Label":
        schema = expand(output.inner, active).annotate({ expected: output.name })
        break
      case "Array":
        schema = Schema.Array(entry(output.item))
        break
      case "Tuple":
        schema = Schema.Tuple(output.items.map(entry))
        break
      case "Struct":
        schema = Schema.Struct(Object.fromEntries(output.fields.map(([key, field]) => [key, entry(field)])))
        break
    }
    cached.set(active, schema)
    return schema
  }

  return checkable(entry(root))
}
