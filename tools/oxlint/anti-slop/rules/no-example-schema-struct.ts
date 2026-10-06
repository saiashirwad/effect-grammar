import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

function resolve(source: SourceCode, node: ESTree.IdentifierReference): Variable | undefined {
  for (let scope: Scope | null = source.getScope(node); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) return variable;
  }
  return undefined;
}

function imported(source: SourceCode, node: ESTree.IdentifierReference, module: string, name: string): boolean {
  return resolve(source, node)?.defs.some((definition) => {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration" || definition.parent.source.value !== module) return false;
    const specifier = definition.node;
    if (specifier.type === "ImportNamespaceSpecifier") return name === "*";
    if (specifier.type !== "ImportSpecifier") return false;
    return (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value) === name;
  }) ?? false;
}

export const noExampleSchemaStructRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep example object structure in the grammar, not a parallel Effect Schema.Struct." },
    messages: {
      derive: "Do not restate example grammar structure with Effect Schema.Struct. Use Grammar.gen and GrammarSchema.codec; use Schema.toType on the derived codec when a value schema is needed. Semantic scalar targets, Schema.Record and external API Schema.Union remain supported.",
    },
  },
  create(context) {
    if (!/(?:^|\/)examples\//u.test(context.filename.replaceAll("\\", "/"))) return {};
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier") {
          if (imported(source, callee, "effect/Schema", "Struct")) {
            context.report({ node, messageId: "derive" });
          }
          return;
        }
        if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return;
        const property = callee.property;
        const isStruct = callee.computed
          ? property.type === "Literal" && property.value === "Struct"
          : property.type === "Identifier" && property.name === "Struct";
        if (!isStruct) return;
        if (imported(source, callee.object, "effect", "Schema") || imported(source, callee.object, "effect/Schema", "*")) {
          context.report({ node, messageId: "derive" });
        }
      },
    };
  },
});
