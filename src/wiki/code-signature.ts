/**
 * Code signature generator (P0c-T1)
 *
 * Generates stable structured signatures for code entities (functions, classes,
 * interfaces, modules). The core design principle:
 *
 *   signatureHash = sha256 of canonical signature string (name + param types + return type)
 *   astHash       = sha256 of full AST serialization
 *
 * **Signature stability invariant**: If only the function body changes but the
 * signature (name, param types, return type) stays the same, signatureHash MUST
 * remain unchanged while astHash MUST change. This is the foundation for Wiki
 * staleness detection: a Wiki Entity's description remains accurate as long as
 * the signature is unchanged, even if the implementation evolves.
 *
 * Uses the TypeScript compiler API (`typescript` package, already a devDep) to
 * parse source code into AST, then extracts signature components.
 *
 * Supported entity types:
 * - Function declarations (`function foo() {}`)
 * - Arrow/variable functions (`const foo = () => {}`)
 * - Class declarations (`class Foo {}`)
 * - Interface declarations (`interface IFoo {}`)
 *
 * Multi-entity source: If the source contains multiple declarations, the first
 * one found is used by default. Pass `entityName` to target a specific entity.
 */

import * as ts from 'typescript';
import { createHash } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export type CodeEntityType = 'function' | 'class' | 'module' | 'interface';

export interface CodeSignature {
  /** Entity name, e.g. 'greet', 'Foo', 'IRepository' */
  entityName: string;
  /** Entity type classification */
  entityType: CodeEntityType;
  /** Parameter type strings in declaration order (e.g. ['string', 'number']) */
  paramTypes: string[];
  /** Return type string (e.g. 'Promise<void>', 'unknown' if not annotated) */
  returnType: string;
  /** sha256 of canonical signature string — stable across body-only changes */
  signatureHash: string;
  /** sha256 of full AST serialization — changes on any modification */
  astHash: string;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Compute sha256 hex digest of a string.
 */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Serialize a TS AST node to a canonical string for astHash.
 * This produces a normalized representation that captures structural
 * differences (body changes, comment changes, etc.) but is insensitive
 * to source formatting variations that don't change semantics.
 *
 * We use `ts.forEachChild` traversal to serialize the full tree.
 */
function serializeAst(node: ts.Node): string {
  let result = ts.SyntaxKind[node.kind];
  // Include text content for identifiers and literals (these affect semantics)
  if (ts.isIdentifier(node)) {
    result += `:"${node.text}"`;
  } else if (ts.isStringLiteral(node)) {
    result += `:"${node.text}"`;
  } else if (ts.isNumericLiteral(node)) {
    result += `:${node.text}`;
  }
  // Recursively serialize children
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    children.push(serializeAst(child));
  });
  if (children.length > 0) {
    result += `({${children.join(',')}})`;
  }
  return result;
}

/**
 * Extract all comments from source text for astHash computation.
 * Comments are part of the "trivia" that TS parser strips from the AST
 * structure, so we extract them separately to ensure comment-only changes
 * are detected by astHash (while signatureHash remains stable).
 *
 * Returns a sorted array of comment strings for deterministic hashing.
 */
function extractAllComments(sourceText: string): string[] {
  const comments: string[] = [];
  // Remove string literals to avoid false positives from // or /* inside strings
  const cleaned = sourceText
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  // Block comments: /* ... */
  const blockRe = /\/\*[\s\S]*?\*\//g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(cleaned)) !== null) {
    comments.push(m[0]);
  }
  // Line comments: // ...
  const lineRe = /\/\/[^\n]*/g;
  while ((m = lineRe.exec(cleaned)) !== null) {
    comments.push(m[0]);
  }
  return comments;
}

/**
 * Extract the type string from a type node, normalized.
 * Handles common TS type syntax: simple names, generics, arrays, unions,
 * function types, parenthesized types.
 */
function typeNodeToString(typeNode: ts.TypeNode | undefined): string {
  if (!typeNode) return 'unknown';
  return printTypeNode(typeNode);
}

/**
 * Recursively print a type node to its canonical string representation.
 */
function printTypeNode(node: ts.TypeNode): string {
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'string';
    case ts.SyntaxKind.NumberKeyword:
      return 'number';
    case ts.SyntaxKind.BooleanKeyword:
      return 'boolean';
    case ts.SyntaxKind.VoidKeyword:
      return 'void';
    case ts.SyntaxKind.AnyKeyword:
      return 'any';
    case ts.SyntaxKind.UnknownKeyword:
      return 'unknown';
    case ts.SyntaxKind.NullKeyword:
      return 'null';
    case ts.SyntaxKind.UndefinedKeyword:
      return 'undefined';
    case ts.SyntaxKind.NeverKeyword:
      return 'never';
    case ts.SyntaxKind.ObjectKeyword:
      return 'object';
    case ts.SyntaxKind.BigIntKeyword:
      return 'bigint';
    case ts.SyntaxKind.SymbolKeyword:
      return 'symbol';
    case ts.SyntaxKind.ArrayType: {
      const arr = node as ts.ArrayTypeNode;
      return `${printTypeNode(arr.elementType)}[]`;
    }
    case ts.SyntaxKind.TypeReference: {
      const ref = node as ts.TypeReferenceNode;
      let name = ref.typeName.getText();
      if (ref.typeArguments && ref.typeArguments.length > 0) {
        const args = ref.typeArguments.map(printTypeNode).join(', ');
        name += `<${args}>`;
      }
      return name;
    }
    case ts.SyntaxKind.UnionType: {
      const union = node as ts.UnionTypeNode;
      return union.types.map(printTypeNode).join(' | ');
    }
    case ts.SyntaxKind.IntersectionType: {
      const inter = node as ts.IntersectionTypeNode;
      return inter.types.map(printTypeNode).join(' & ');
    }
    case ts.SyntaxKind.FunctionType: {
      // Use getText() to preserve full function type including param names
      // e.g. "(x: number) => string" rather than "(number) => string"
      return node.getText().trim();
    }
    case ts.SyntaxKind.ParenthesizedType: {
      const paren = node as ts.ParenthesizedTypeNode;
      return printTypeNode(paren.type);
    }
    case ts.SyntaxKind.TupleType: {
      const tuple = node as ts.TupleTypeNode;
      return `[${tuple.elements.map(printTypeNode).join(', ')}]`;
    }
    case ts.SyntaxKind.LiteralType: {
      const lit = node as ts.LiteralTypeNode;
      return lit.literal.getText();
    }
    default:
      // Fallback: use getText() for any type we don't explicitly handle
      return node.getText().trim();
  }
}

/**
 * Print a parameter declaration's type as canonical string.
 */
function printParam(param: ts.ParameterDeclaration): string {
  return typeNodeToString(param.type);
}

/**
 * Build canonical signature string from components.
 * Format: "name(paramType1,paramType2)=>returnType"
 * This is the string that signatureHash is computed from.
 */
function buildCanonicalSignature(
  name: string,
  paramTypes: string[],
  returnType: string,
): string {
  return `${name}(${paramTypes.join(',')})=>${returnType}`;
}

// ─── Entity extraction ──────────────────────────────────────────

interface ExtractedEntity {
  name: string;
  type: CodeEntityType;
  paramTypes: string[];
  returnType: string;
}

/**
 * Walk the AST to find all top-level declarations and extract their signatures.
 */
function extractEntities(sourceFile: ts.SourceFile): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];

  function visit(node: ts.Node) {
    // Function declaration: function foo(a: string): void { ... }
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? 'anonymous';
      const paramTypes = node.parameters.map(printParam);
      const returnType = typeNodeToString(node.type);
      entities.push({ name, type: 'function', paramTypes, returnType });
    }

    // Variable declaration with arrow/function initializer:
    // const foo = (x: number): string => ...
    // const foo = function(x: number): string { ... }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name && ts.isIdentifier(decl.name)) {
          const init = decl.initializer;
          if (init) {
            if (ts.isArrowFunction(init)) {
              const paramTypes = init.parameters.map(printParam);
              const returnType = typeNodeToString(init.type);
              entities.push({ name: decl.name.text, type: 'function', paramTypes, returnType });
            } else if (ts.isFunctionExpression(init)) {
              const paramTypes = init.parameters.map(printParam);
              const returnType = typeNodeToString(init.type);
              entities.push({ name: decl.name.text, type: 'function', paramTypes, returnType });
            }
          }
        }
      }
    }

    // Class declaration
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? 'anonymous';
      entities.push({ name, type: 'class', paramTypes: [], returnType: 'void' });
    }

    // Interface declaration
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name?.text ?? 'anonymous';
      entities.push({ name, type: 'interface', paramTypes: [], returnType: 'void' });
    }

    // Module/namespace declaration
    if (ts.isModuleDeclaration(node)) {
      const name = node.name?.text ?? 'anonymous';
      entities.push({ name, type: 'module', paramTypes: [], returnType: 'void' });
    }

    // Only visit top-level children (don't recurse into function/class bodies
    // for signature extraction — we want top-level entities only)
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isVariableStatement(node) ||
      ts.isSourceFile(node)
    ) {
      node.forEachChild(visit);
    }
  }

  visit(sourceFile);
  return entities;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Generate a code signature for a TypeScript/JavaScript source snippet.
 *
 * @param code - Source code string (TS or JS syntax)
 * @param entityName - Optional: target a specific entity by name when source
 *                     contains multiple declarations. If omitted, the first
 *                     entity found is used.
 * @returns CodeSignature with entityName, entityType, paramTypes, returnType,
 *          signatureHash (stable across body changes), and astHash (changes
 *          on any modification).
 *
 * @throws Error if no entities are found in the source, or if entityName is
 *         specified but not found.
 */
export function generateSignature(code: string, entityName?: string): CodeSignature {
  // Parse source into AST
  const sourceFile = ts.createSourceFile(
    'signature.ts',
    code,
    ts.ScriptTarget.Latest,
    true, // setParentNodes
    ts.ScriptKind.TS,
  );

  // Extract entities
  const entities = extractEntities(sourceFile);
  if (entities.length === 0) {
    throw new Error('No code entities (function/class/interface/module) found in source');
  }

  // Select target entity
  let entity: ExtractedEntity;
  if (entityName) {
    const found = entities.find((e) => e.name === entityName);
    if (!found) {
      throw new Error(`Entity "${entityName}" not found. Available: ${entities.map((e) => e.name).join(', ')}`);
    }
    entity = found;
  } else {
    entity = entities[0];
  }

  // Build canonical signature and compute hashes
  const canonicalSig = buildCanonicalSignature(
    entity.name,
    entity.paramTypes,
    entity.returnType,
  );
  const signatureHash = sha256(canonicalSig);

  // For astHash, serialize the AST structure AND include all comments.
  // The AST serialization captures structural changes (body, params, etc.)
  // The comment extraction captures comment-only changes that the TS parser
  // strips from the AST structure (comments are "trivia"). Together they
  // ensure astHash changes on ANY source modification.
  const astString = serializeAst(sourceFile);
  const comments = extractAllComments(code);
  const fullAstString = comments.length > 0
    ? `${astString}::COMMENTS[${comments.join('|')}]`
    : astString;
  const astHash = sha256(fullAstString);

  return {
    entityName: entity.name,
    entityType: entity.type,
    paramTypes: entity.paramTypes,
    returnType: entity.returnType,
    signatureHash,
    astHash,
  };
}
