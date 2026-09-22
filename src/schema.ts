import { Schema } from "effect"

import { codecWith } from "./internal/schema.ts"
import { parse } from "./parse.ts"
import { print } from "./print.ts"

export type { CodecOptions } from "./internal/schema.ts"

export const codec = codecWith(Schema.String, parse, print)
