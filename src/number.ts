import { Predicate } from "effect"

import type { Node, Value } from "./core.ts"
import { isCount } from "./env.ts"

type NumberNode = Extract<Node, { _tag: "Number" }>

const viewNames = {
  uint: { 1: "Uint8", 2: "Uint16", 4: "Uint32", 8: "BigUint64" },
  int: { 1: "Int8", 2: "Int16", 4: "Int32", 8: "BigInt64" },
  float: { 4: "Float32", 8: "Float64" },
} as const

const viewName = (node: NumberNode) =>
  node.kind === "float" ? viewNames.float[node.width] : viewNames[node.kind][node.width]

export const readNumber = (node: NumberNode, input: Uint8Array, pos: number): number | bigint => {
  const view = new DataView(input.buffer, input.byteOffset + pos, node.width)
  return view[`get${viewName(node)}`](0, node.littleEndian)
}

export const writeNumber = (node: NumberNode, value: number | bigint): Uint8Array => {
  const bytes = new Uint8Array(node.width)
  const view = new DataView(bytes.buffer)
  const name = viewName(node)
  if (name === "BigUint64" || name === "BigInt64") {
    view[`set${name}`](0, BigInt(value), node.littleEndian)
  } else {
    view[`set${name}`](0, Number(value), node.littleEndian)
  }
  return bytes
}

export const numberIssue = (node: NumberNode, value: Value): string | undefined => {
  if (node.kind === "float") return Predicate.isNumber(value) ? undefined : "a number"
  const bits = BigInt(node.width * 8)
  const min = node.kind === "uint" ? 0n : -(2n ** (bits - 1n))
  const max = node.kind === "uint" ? 2n ** bits - 1n : 2n ** (bits - 1n) - 1n
  const ok =
    node.width === 8
      ? Predicate.isBigInt(value) && value >= min && value <= max
      : Predicate.isNumber(value) &&
        Number.isSafeInteger(value) &&
        value >= Number(min) &&
        value <= Number(max)
  return ok ? undefined : `${node.width === 8 ? "a bigint" : "an integer"} in ${min}..${max}`
}

const zigzagDecode = (value: number): number => (value % 2 === 0 ? value / 2 : -(value + 1) / 2)
const zigzagEncode = (value: number): number => (value >= 0 ? value * 2 : -value * 2 - 1)

export const readVarInt = (
  signed: boolean,
  input: Uint8Array,
  pos: number,
): { readonly value: number; readonly width: number } | undefined => {
  let value = 0
  let scale = 1
  for (let offset = pos; offset < input.length && scale <= Number.MAX_SAFE_INTEGER; offset++) {
    const byte = input[offset]!
    value += (byte & 0x7f) * scale
    if (byte < 0x80) {
      if (!Number.isSafeInteger(value)) return undefined
      return { value: signed ? zigzagDecode(value) : value, width: offset - pos + 1 }
    }
    scale *= 128
  }
  return undefined
}

export const writeVarInt = (signed: boolean, value: number): Uint8Array => {
  const bytes: Array<number> = []
  let rest = signed ? zigzagEncode(value) : value
  while (rest >= 128) {
    bytes.push((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return new Uint8Array(bytes)
}

export const varIntIssue = (signed: boolean, value: Value): string | undefined => {
  if (signed) {
    return Predicate.isNumber(value) &&
      Number.isSafeInteger(value) &&
      Number.isSafeInteger(zigzagEncode(value))
      ? undefined
      : "a signed varint within the safe integer range"
  }
  return isCount(value) ? undefined : "an unsigned varint within the safe integer range"
}
