/**
 * Repository-wide i18n contracts. Read a single disk snapshot: never import the
 * app, initialize i18next, install packages, or rewrite another owner's files.
 *
 * Globally invariant protocol/product tokens are documented in invariant-copy.ts.
 * Other UI exceptions must name the exact rendered text and explain why it
 * is invariant, on the same line or immediately before the affected UI node:
 *   // i18n-exempt "OpenAI" -- Provider trademark; identical in every locale.
 *   // i18n-exempt "GET" -- HTTP method token, displayed verbatim.
 * A wildcard, missing reason, unused comment, or distant comment is an error.
 * These comments only exempt visible text, never resource/key contract failures.
 *
 * Protocol/data props (value, id, model, method, name, href, className, etc.),
 * code/pre/kbd/samp content, comments, declaration files, and *.test/spec files
 * are not UI-copy sinks. No production directory or historical baseline is
 * excluded. Dynamic keys whose values cannot be statically resolved are outside
 * the literal-key check; UI strings reaching sinks through local/imported
 * constants and presenter return values are inspected.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { INVARIANT_COPY } from './invariant-copy'

const LANGUAGES = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP'] as const
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = path.join(SRC, 'i18n/locales')
const CATEGORIES = 'zero|one|two|few|many|other'
const PLURAL = new RegExp('^(.*?)(_ordinal)?_(' + CATEGORIES + ')$')

type Issue = { file: string; line?: number; rule: string; detail: string }
type Leaves = Map<string, string>
type Bundle = Map<string, Map<string, Leaves>>
type ResourceFile = {
  file: string
  language: string
  namespace: string
  text: string
}
type Source = { file: string; text: string }
type Message = {
  logical: string
  base: string
  ordinal: boolean
  category?: string
}
type Translator = { namespaces: string[]; prefix: string }
type Literal = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral

function issue(
  file: string,
  rule: string,
  detail: string,
  line?: number
): Issue {
  return { file, rule, detail, ...(line ? { line } : {}) }
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory()
        ? walkFiles(file)
        : entry.isFile()
          ? [file]
          : []
    })
    .sort()
}

function relative(file: string): string {
  return path.relative(SRC, file).split(path.sep).join('/')
}

function parseLeaves(file: ResourceFile, issues: Issue[]): Leaves {
  const result: Leaves = new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(file.text)
  } catch (error) {
    issues.push(issue(file.file, 'resource-json', String(error)))
    return result
  }
  function visit(value: unknown, key: string) {
    if (typeof value === 'string') {
      if (!value.trim()) issues.push(issue(file.file, 'empty-value', key))
      if (result.has(key)) issues.push(issue(file.file, 'ambiguous-key', key))
      result.set(key, value)
    } else if (value && typeof value === 'object') {
      const entries = Object.entries(value)
      if (!entries.length)
        issues.push(issue(file.file, 'empty-value', key || '<root>'))
      for (const [part, child] of entries) {
        if (!part.trim())
          issues.push(issue(file.file, 'empty-key', key || '<root>'))
        visit(child, key ? key + '.' + part : part)
      }
    } else {
      issues.push(issue(file.file, 'non-string-value', key || '<root>'))
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push(
      issue(file.file, 'resource-root', 'Namespace must be a JSON object')
    )
    return result
  }
  visit(parsed, '')
  return result
}

function message(key: string): Message {
  const match = PLURAL.exec(key)
  if (!match) return { logical: key, base: key, ordinal: false }
  return {
    logical: match[1] + (match[2] ? '#ordinal' : ''),
    base: match[1],
    ordinal: Boolean(match[2]),
    category: match[3],
  }
}

function variables(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(/{{\s*-?\s*([^},\s]+)(?:\s*,[^}]*)?\s*}}/g)].map(
        (m) => m[1]
      )
    ),
  ].sort()
}

function markup(value: string): { tags: string[]; errors: string[] } {
  const tags: string[] = [],
    stack: string[] = [],
    errors: string[] = []
  for (const match of value.matchAll(
    /<(\/?)([A-Za-z][\w.-]*|\d+)(?:\s+[^<>]*?)?\s*(\/?)>/g
  )) {
    const [, closing, name, selfClosing] = match
    if (closing) {
      if (stack.pop() !== name)
        errors.push('Unmatched closing tag </' + name + '>')
    } else {
      tags.push(name)
      if (!selfClosing && !['br', 'hr', 'img', 'input', 'wbr'].includes(name))
        stack.push(name)
    }
  }
  for (const name of stack) errors.push('Unclosed tag <' + name + '>')
  return { tags: tags.sort(), errors }
}

function same(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function auditResources(files: ResourceFile[]): {
  bundle: Bundle
  issues: Issue[]
} {
  const issues: Issue[] = [],
    bundle: Bundle = new Map()
  for (const file of files) {
    if (!(LANGUAGES as readonly string[]).includes(file.language)) {
      issues.push(issue(file.file, 'unexpected-locale', file.language))
    }
    const namespaces = bundle.get(file.language) || new Map<string, Leaves>()
    if (namespaces.has(file.namespace))
      issues.push(issue(file.file, 'duplicate-namespace', file.namespace))
    namespaces.set(file.namespace, parseLeaves(file, issues))
    bundle.set(file.language, namespaces)
  }
  const namespaces = [...new Set(files.map((f) => f.namespace))].sort()
  if (!namespaces.length)
    issues.push(
      issue('i18n/locales', 'no-namespaces', 'No locale resources discovered')
    )
  for (const namespace of namespaces) {
    const logicalKeys = new Set<string>()
    const entries = new Map<string, Map<string, Array<[string, string]>>>()
    for (const language of LANGUAGES) {
      const leaves = bundle.get(language)?.get(namespace)
      const file = 'i18n/locales/' + language + '/' + namespace + '.json'
      if (!leaves) {
        issues.push(issue(file, 'missing-namespace', namespace))
        continue
      }
      const families = new Map<string, Array<[string, string]>>()
      for (const [key, value] of leaves) {
        const id = message(key).logical
        logicalKeys.add(id)
        families.set(id, [...(families.get(id) || []), [key, value]])
      }
      entries.set(language, families)
    }
    for (const logical of [...logicalKeys].sort()) {
      let reference:
        { variables: string[]; tags: string[]; from: string } | undefined
      const plural = [...entries.values()].some((e) =>
        e.get(logical)?.some(([k]) => message(k).category)
      )
      for (const language of LANGUAGES) {
        const family = entries.get(language)?.get(logical)
        const file = 'i18n/locales/' + language + '/' + namespace + '.json'
        if (!family) {
          if (entries.has(language))
            issues.push(issue(file, 'missing-leaf', logical))
          continue
        }
        if (plural) {
          const ordinal = logical.endsWith('#ordinal')
          const required = new Intl.PluralRules(language, {
            type: ordinal ? 'ordinal' : 'cardinal',
          }).resolvedOptions().pluralCategories
          const categories = family.map(([k]) => message(k).category)
          // A plain key is a valid fallback in languages with only "other".
          const scalarFallback =
            required.length === 1 &&
            required[0] === 'other' &&
            categories.includes(undefined)
          for (const category of required) {
            if (!scalarFallback && !categories.includes(category))
              issues.push(
                issue(file, 'missing-plural', logical + ': ' + category)
              )
          }
        }
        for (const [key, value] of family) {
          const contract = {
            variables: variables(value),
            tags: markup(value).tags,
            from: language + ':' + key,
          }
          if (!reference) reference = contract
          else {
            if (!same(reference.variables, contract.variables))
              issues.push(
                issue(
                  file,
                  'interpolation-mismatch',
                  key +
                    ' [' +
                    contract.variables.join(', ') +
                    '] differs from ' +
                    reference.from +
                    ' [' +
                    reference.variables.join(', ') +
                    ']'
                )
              )
            if (!same(reference.tags, contract.tags))
              issues.push(
                issue(
                  file,
                  'trans-tags-mismatch',
                  key +
                    ' [' +
                    contract.tags.join(', ') +
                    '] differs from ' +
                    reference.from +
                    ' [' +
                    reference.tags.join(', ') +
                    ']'
                )
              )
          }
        }
      }
    }
  }
  return { bundle, issues }
}

const invariants = new Set<string>(
  INVARIANT_COPY.flatMap((group) => [...group.values])
)
function isInvariantCopy(text: string): boolean {
  const value = text.trim().replace(/^[ ·]+|[ ·]+$/g, '')
  if (invariants.has(value)) return true
  // Pure physical units, compact number suffixes and version markers.
  const units = value.replace(/\{\{expression\}\}/g, '0')
  if (
    /^(?:[<>]?\d*(?:\.\d+)?\s*(?:USD|[KMGT]?i?B|vCPU|RPM|IPv6|ms|tok|token|Tokens|[kKMBdhmvsF])\s*[ ·/:]*)+$/i.test(
      units
    )
  )
    return true
  // URI/Unix paths, example keys and email addresses must be copied verbatim.
  if (
    /^(?:https?:\/\/|socks5:\/\/|\/v1\/|[a-z-]+\/|Asia\/|sk-)[^\s]+$/.test(
      value
    )
  )
    return true
  if (value === 'https://') return true
  if (/^[0-9]+:[A-Z]+…$/.test(value)) return true
  if (/^host:port:user:pass\nsocks5:\/\/[^\s]+$/.test(value)) return true
  if (/^vm-\d+\n[^\s@]+@[^\s@]+$/.test(value)) return true
  if (/^\{\{expression\}\}:xx:xx:xx$/.test(value)) return true
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object') return true
  } catch {
    /* UI prose is not JSON. */
  }
  return false
}

const UI_PROPS = new Set([
  'title',
  'label',
  'description',
  'desc',
  'reason',
  'hint',
  'message',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-valuetext',
  'aria-roledescription',
  'emptyText',
  'searchPlaceholder',
  'confirmText',
  'cancelText',
  'cancelBtnText',
  'loadingText',
  'errorMessage',
  'successMessage',
  'tooltip',
  'caption',
  'header',
  'footer',
  'unit',
])
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style'])

function isLiteral(node: ts.Node): node is Literal {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

function propertyName(node: ts.PropertyName | ts.JsxAttributeName): string {
  return ts.isIdentifier(node) || ts.isStringLiteral(node)
    ? node.text
    : node.getText()
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  )
    expr = expr.expression
  return expr
}

function importInfo(
  node: ts.Node
): { module: string; imported: string } | undefined {
  let cursor: ts.Node | undefined = node
  while (cursor && !ts.isImportDeclaration(cursor)) cursor = cursor.parent
  if (!cursor || !ts.isStringLiteral(cursor.moduleSpecifier)) return
  const imported = ts.isImportSpecifier(node)
    ? (node.propertyName || node.name).text
    : ts.isNamespaceImport(node)
      ? '*'
      : 'default'
  return { module: cursor.moduleSpecifier.text, imported }
}

function isTestFile(file: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /\.d\.[cm]?ts$/.test(file)
  )
}

// AST implementation follows below; self-tests exercise both false positives
// (protocol data) and true positives without adding a production allowlist.
function auditSources(sources: Source[], bundle: Bundle): Issue[] {
  const issues: Issue[] = []
  const root = '/i18n-coverage/src'
  const files = new Map(
    sources
      .filter((s) => !isTestFile(s.file))
      .map((s) => {
        const absolute = path.posix.resolve(root, s.file)
        return [
          absolute,
          ts.createSourceFile(absolute, s.text, ts.ScriptTarget.Latest, true),
        ] as const
      })
  )
  const options: ts.CompilerOptions = {
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
  }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (file) => files.get(file)
  host.fileExists = (file) => files.has(file)
  host.readFile = (file) => files.get(file)?.text
  host.getCurrentDirectory = () => root
  const program = ts.createProgram([...files.keys()], options, host)
  const checker = program.getTypeChecker()
  type Exemption = { text: string; line: number; used: Set<number> }
  const exemptionsByFile = new Map<ts.SourceFile, Exemption[]>()
  const visibleCandidates = new Map<ts.Node, string>()
  const emitted = new Set<string>()

  function report(node: ts.Node, rule: string, detail: string) {
    const sf = node.getSourceFile()
    const file = path.posix.relative(root, sf.fileName)
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    const id = [sf.fileName, node.getStart(sf), rule, detail].join('|')
    if (emitted.has(id)) return
    emitted.add(id)
    issues.push(issue(file, rule, detail, line))
  }

  function importedFile(
    node: ts.Node,
    module: string
  ): ts.SourceFile | undefined {
    if (!module.startsWith('.') && !module.startsWith('@/')) return
    const base = module.startsWith('@/')
      ? path.posix.join(root, module.slice(2))
      : path.posix.resolve(
          path.posix.dirname(node.getSourceFile().fileName),
          module
        )
    return [
      base,
      ...[
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mts',
        '.mjs',
        '/index.ts',
        '/index.tsx',
        '/index.js',
      ].map((ext) => base + ext),
    ]
      .map((file) => files.get(file))
      .find(Boolean)
  }

  function exported(
    sf: ts.SourceFile,
    name: string,
    seen = new Set<string>()
  ): ts.Node[] {
    const identity = sf.fileName + ':' + name
    if (seen.has(identity)) return []
    seen.add(identity)
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
        return [statement]
      if (ts.isVariableStatement(statement)) {
        const found = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === name
        )
        if (found) return [found]
      }
      if (ts.isExportDeclaration(statement)) {
        const target =
          statement.moduleSpecifier && isLiteral(statement.moduleSpecifier)
            ? importedFile(statement, statement.moduleSpecifier.text)
            : sf
        if (!target) continue
        if (!statement.exportClause) {
          const found = exported(target, name, seen)
          if (found.length) return found
        } else if (ts.isNamedExports(statement.exportClause)) {
          const item = statement.exportClause.elements.find(
            (e) => e.name.text === name
          )
          if (item)
            return exported(target, (item.propertyName || item.name).text, seen)
        }
      }
    }
    return []
  }

  function declarations(expr: ts.Expression): ts.Node[] {
    expr = unwrap(expr)
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression)
    ) {
      const declaration = checker.getSymbolAtLocation(expr.expression)
        ?.declarations?.[0]
      const imported = declaration && importInfo(declaration)
      const sf = imported && importedFile(expr, imported.module)
      if (imported?.imported === '*' && sf) return exported(sf, expr.name.text)
    }
    if (!ts.isIdentifier(expr)) return []
    return (checker.getSymbolAtLocation(expr)?.declarations || []).flatMap(
      (declaration) => {
        const imported = importInfo(declaration)
        const target = imported && importedFile(declaration, imported.module)
        // Preserve the import node for recognizing translation APIs.
        return target && imported?.module !== '@/i18n'
          ? exported(target, imported!.imported)
          : [declaration]
      }
    )
  }

  function select(values: ts.Expression[], member?: string): ts.Expression[] {
    return values.flatMap((value) => {
      value = unwrap(value)
      if (ts.isObjectLiteralExpression(value))
        return value.properties.flatMap((prop) => {
          if (
            ts.isPropertyAssignment(prop) &&
            (!member || propertyName(prop.name) === member)
          )
            return [prop.initializer]
          if (
            ts.isShorthandPropertyAssignment(prop) &&
            (!member || prop.name.text === member)
          )
            return [prop.name]
          return []
        })
      if (ts.isArrayLiteralExpression(value))
        return [...value.elements]
          .filter((_, index) => member == null || String(index) === member)
          .filter(ts.isExpression)
      return []
    })
  }

  function roots(
    expr: ts.Expression,
    seen = new Set<ts.Node>()
  ): ts.Expression[] {
    expr = unwrap(expr)
    if (seen.has(expr) || seen.size > 80) return []
    const nextSeen = new Set(seen).add(expr)
    if (ts.isConditionalExpression(expr))
      return [
        ...roots(expr.whenTrue, nextSeen),
        ...roots(expr.whenFalse, nextSeen),
      ]
    if (
      ts.isBinaryExpression(expr) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(expr.operatorToken.kind)
    )
      return [...roots(expr.left, nextSeen), ...roots(expr.right, nextSeen)]
    if (ts.isIdentifier(expr))
      return declarations(expr).flatMap((declaration) => {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return roots(declaration.initializer, nextSeen)
        if (ts.isParameter(declaration) && declaration.initializer)
          return roots(declaration.initializer, nextSeen)
        if (ts.isBindingElement(declaration)) {
          const pattern = declaration.parent
          const member = ts.isArrayBindingPattern(pattern)
            ? String(pattern.elements.indexOf(declaration))
            : propertyName(
                declaration.propertyName || (declaration.name as ts.Identifier)
              )
          const owner = pattern.parent
          if (ts.isVariableDeclaration(owner) && owner.initializer)
            return select(roots(owner.initializer, nextSeen), member).flatMap(
              (v) => roots(v, nextSeen)
            )
          if (ts.isParameter(owner)) {
            const fn = owner.parent
            const call = fn.parent
            if (
              ts.isArrowFunction(fn) &&
              ts.isCallExpression(call) &&
              ts.isPropertyAccessExpression(call.expression) &&
              call.expression.name.text === 'map'
            ) {
              const rows = select(roots(call.expression.expression, nextSeen))
              return rows
                .flatMap((row) => select(roots(row, nextSeen), member))
                .flatMap((v) => roots(v, nextSeen))
            }
          }
        }
        return []
      })
    if (
      ts.isPropertyAccessExpression(expr) ||
      ts.isElementAccessExpression(expr)
    ) {
      const member = ts.isPropertyAccessExpression(expr)
        ? expr.name.text
        : expr.argumentExpression &&
            (isLiteral(expr.argumentExpression) ||
              ts.isNumericLiteral(expr.argumentExpression))
          ? expr.argumentExpression.text
          : undefined
      const imported = declarations(expr)
      if (imported.length)
        return imported.flatMap((d) =>
          ts.isVariableDeclaration(d) && d.initializer
            ? roots(d.initializer, nextSeen)
            : []
        )
      return select(roots(expr.expression, nextSeen), member).flatMap((v) =>
        roots(v, nextSeen)
      )
    }
    return [expr]
  }

  function literals(expr: ts.Expression | undefined): Literal[] {
    if (!expr) return []
    return roots(expr).flatMap((value) =>
      isLiteral(value)
        ? [value]
        : ts.isArrayLiteralExpression(value)
          ? value.elements.flatMap((e) =>
              ts.isExpression(e) ? literals(e) : []
            )
          : []
    )
  }

  function option(
    expr: ts.Expression | undefined,
    key: string
  ): ts.Expression | undefined {
    if (!expr) return
    return select(roots(expr), key)[0]
  }

  function callName(
    expr: ts.Expression
  ): { module: string; imported: string } | undefined {
    if (!ts.isIdentifier(expr)) return
    const declaration = checker.getSymbolAtLocation(expr)?.declarations?.[0]
    return declaration && importInfo(declaration)
  }

  function hook(expr: ts.Expression): Translator | undefined {
    if (!ts.isCallExpression(expr)) return
    const imported = callName(expr.expression)
    if (
      imported?.module !== 'react-i18next' ||
      imported.imported !== 'useTranslation'
    )
      return
    let ns = literals(expr.arguments[0]).map((v) => v.text)
    if (!expr.arguments[0]) ns = ['common']
    if (literals(option(expr.arguments[1], 'nsMode'))[0]?.text !== 'fallback')
      ns = ns.slice(0, 1)
    return {
      namespaces: ns,
      prefix: literals(option(expr.arguments[1], 'keyPrefix'))[0]?.text || '',
    }
  }

  function translator(expr: ts.Expression): Translator | undefined {
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 't') {
      const imported = callName(expr.expression)
      if (
        imported &&
        (imported.module === '@/i18n' || imported.module === 'i18next')
      )
        return { namespaces: ['common'], prefix: '' }
    }
    for (const declaration of declarations(expr)) {
      const imported = importInfo(declaration)
      if (imported?.module === '@/i18n' && imported.imported === 't')
        return { namespaces: ['common'], prefix: '' }
      if (
        ts.isBindingElement(declaration) &&
        (declaration.propertyName || declaration.name).getText() === 't'
      ) {
        const variable = declaration.parent.parent
        if (ts.isVariableDeclaration(variable) && variable.initializer) {
          const bound = hook(variable.initializer)
          if (bound) return bound
        }
      }
      if (
        ts.isParameter(declaration) &&
        declaration.type &&
        ts.isTypeReferenceNode(declaration.type) &&
        declaration.type.typeName.getText().endsWith('TFunction')
      ) {
        const ns = declaration.type.typeArguments?.[0]
        const prefix = declaration.type.typeArguments?.[1]
        return {
          namespaces:
            ns && ts.isLiteralTypeNode(ns) && isLiteral(ns.literal)
              ? [ns.literal.text]
              : [],
          prefix:
            prefix && ts.isLiteralTypeNode(prefix) && isLiteral(prefix.literal)
              ? prefix.literal.text
              : '',
        }
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const init = unwrap(declaration.initializer)
        if (
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          init.expression.name.text === 'getFixedT'
        )
          return {
            namespaces: literals(init.arguments[1]).map((v) => v.text),
            prefix: literals(init.arguments[2])[0]?.text || '',
          }
      }
    }
    return
  }

  function transElement(node: ts.JsxOpeningLikeElement): boolean {
    return (
      callName(node.tagName as ts.Expression)?.imported === 'Trans' &&
      callName(node.tagName as ts.Expression)?.module === 'react-i18next'
    )
  }

  function attribute(
    node: ts.JsxOpeningLikeElement,
    name: string
  ): ts.Expression | undefined {
    const attr = node.attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && propertyName(p.name) === name
    )
    if (!attr || !ts.isJsxAttribute(attr) || !attr.initializer) return
    return ts.isJsxExpression(attr.initializer)
      ? attr.initializer.expression
      : attr.initializer
  }

  function insideDataOrTrans(node: ts.Node): boolean {
    let parent: ts.Node | undefined = node.parent
    while (parent && !ts.isStatement(parent)) {
      if (ts.isJsxElement(parent)) {
        if (
          CODE_TAGS.has(parent.openingElement.tagName.getText()) ||
          transElement(parent.openingElement)
        )
          return true
      }
      parent = parent.parent
    }
    return false
  }

  // Index plural families once per namespace instead of rescanning every
  // resource for every source reference (four locales, thousands of keys).
  const familyIndexes = new WeakMap<
    Leaves,
    Map<string, Array<[string, string]>>
  >()
  function keyVariants(
    leaves: Leaves,
    key: string,
    plural: boolean,
    objects: boolean
  ) {
    const matches = new Map<string, string>()
    if (leaves.has(key)) matches.set(key, leaves.get(key)!)
    if (plural) {
      let families = familyIndexes.get(leaves)
      if (!families) {
        families = new Map()
        for (const entry of leaves) {
          const base = message(entry[0]).base
          const family = families.get(base)
          if (family) family.push(entry)
          else families.set(base, [entry])
        }
        familyIndexes.set(leaves, families)
      }
      for (const [leaf, value] of families.get(key) ?? [])
        matches.set(leaf, value)
    }
    if (objects) {
      for (const [leaf, value] of leaves) {
        if (leaf.startsWith(key + '.')) matches.set(leaf, value)
      }
    }
    return [...matches]
  }

  function checkKey(
    node: ts.Node,
    key: string,
    bound: Translator,
    opts?: ts.Expression,
    trans = false
  ) {
    const explicit = /^([^:]+):(.*)$/.exec(key)
    const nsOverride = literals(option(opts, 'ns')).map((v) => v.text)
    const ns = explicit
      ? [explicit[1]]
      : nsOverride.length
        ? nsOverride
        : bound.namespaces
    const prefix = literals(option(opts, 'keyPrefix'))[0]?.text ?? bound.prefix
    const bare = explicit ? explicit[2] : (prefix ? prefix + '.' : '') + key
    const context = literals(option(opts, 'context'))[0]?.text
    const candidates = context ? [bare + '_' + context, bare] : [bare]
    if (!ns.length) {
      report(
        node,
        'unresolved-key-namespace',
        key + ': qualify the literal with namespace:key'
      )
      return
    }
    const count = Boolean(option(opts, 'count')) || trans
    const objects =
      option(opts, 'returnObjects')?.kind === ts.SyntaxKind.TrueKeyword
    for (const language of LANGUAGES) {
      let found = false
      for (const namespace of ns) {
        const leaves = bundle.get(language)?.get(namespace)
        if (!leaves) continue
        for (const candidate of candidates) {
          const variants = keyVariants(
            leaves,
            candidate,
            count || !opts,
            objects
          )
          if (variants.length) {
            found = true
            if (trans)
              for (const [leaf, value] of variants)
                for (const error of markup(value).errors)
                  report(
                    node,
                    'invalid-trans-markup',
                    language + ':' + namespace + ':' + leaf + ' ' + error
                  )
            break
          }
        }
        if (found) break
      }
      if (!found)
        report(
          node,
          'missing-literal-key',
          language + ':' + ns.join('|') + ':' + bare
        )
    }
  }

  for (const sf of files.values()) {
    const comments = new Map<number, ts.CommentRange>()
    function collectComments(node: ts.Node) {
      // AST trivia ranges cannot contain string literals. Scan them directly so
      // an inline block comment after a comma or JSX attribute is not lost.
      const trivia: Array<[number, number]> = [[node.pos, node.getStart(sf)]]
      if (ts.isJsxExpression(node) && !node.expression)
        trivia.push([node.getStart(sf) + 1, node.end - 1])
      for (const [start, end] of trivia) {
        const text = sf.text.slice(start, end)
        for (const match of text.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)) {
          const pos = start + match.index!
          comments.set(pos, {
            pos,
            end: pos + match[0].length,
            kind: match[0].startsWith('//')
              ? ts.SyntaxKind.SingleLineCommentTrivia
              : ts.SyntaxKind.MultiLineCommentTrivia,
          })
        }
      }
      for (const range of [
        ...(ts.getLeadingCommentRanges(sf.text, node.pos) || []),
        ...(ts.getTrailingCommentRanges(sf.text, node.end) || []),
      ])
        comments.set(range.pos, range)
      if (ts.isJsxExpression(node) && !node.expression)
        for (const range of ts.getLeadingCommentRanges(
          sf.text,
          node.getStart(sf) + 1
        ) || [])
          comments.set(range.pos, range)
      ts.forEachChild(node, collectComments)
    }
    collectComments(sf)
    const exemptions: Exemption[] = []
    exemptionsByFile.set(sf, exemptions)
    for (const range of comments.values()) {
      const body = sf.text
        .slice(range.pos, range.end)
        .replace(/^\/\*+|^\/\//, '')
        .replace(/\*\/$/, '')
        .trim()
      if (!body.startsWith('i18n-exempt')) continue
      const match = /^i18n-exempt\s+("(?:[^"\\]|\\.)*")\s+--\s+(.+)$/.exec(body)
      const line = sf.getLineAndCharacterOfPosition(range.end).line + 1
      if (!match || !/[\p{L}\p{N}]/u.test(match[2])) {
        issues.push(
          issue(
            path.posix.relative(root, sf.fileName),
            'invalid-exemption',
            'Expected i18n-exempt "exact text" -- specific reason',
            line
          )
        )
        continue
      }
      try {
        const text = JSON.parse(match[1]) as string
        if (!text || text === '*')
          throw new Error('Empty or wildcard exemption')
        exemptions.push({ text, line, used: new Set() })
      } catch {
        issues.push(
          issue(
            path.posix.relative(root, sf.fileName),
            'invalid-exemption',
            body,
            line
          )
        )
      }
    }

    function visible(node: ts.Node, text: string) {
      if (/[\p{L}]/u.test(text) && !isInvariantCopy(text))
        visibleCandidates.set(node, text)
    }

    function visibleExpression(expr: ts.Expression, seen = new Set<ts.Node>()) {
      if (seen.has(expr) || seen.size > 80) return
      const nextSeen = new Set(seen).add(expr)
      for (const value of roots(expr)) {
        if (isLiteral(value)) visible(value, value.text)
        else if (ts.isTemplateExpression(value)) {
          const text =
            value.head.text +
            value.templateSpans
              .map((span) => '{{expression}}' + span.literal.text)
              .join('')
          // Interpolated identifiers/numbers alone are data, not UI prose.
          const prose =
            value.head.text +
            value.templateSpans.map((span) => span.literal.text).join('')
          if (/\p{L}/u.test(prose)) visible(value, text)
        } else if (
          ts.isBinaryExpression(value) &&
          value.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
          visibleExpression(value.left, nextSeen)
          visibleExpression(value.right, nextSeen)
        } else if (
          ts.isCallExpression(value) &&
          !translator(value.expression)
        ) {
          for (const declaration of declarations(value.expression)) {
            const fn = ts.isFunctionDeclaration(declaration)
              ? declaration
              : ts.isVariableDeclaration(declaration) &&
                  declaration.initializer &&
                  (ts.isArrowFunction(declaration.initializer) ||
                    ts.isFunctionExpression(declaration.initializer))
                ? declaration.initializer
                : undefined
            if (!fn?.body) continue
            if (!ts.isBlock(fn.body)) visibleExpression(fn.body, nextSeen)
            else {
              function returns(n: ts.Node) {
                if (ts.isReturnStatement(n) && n.expression)
                  visibleExpression(n.expression, nextSeen)
                else if (!ts.isFunctionLike(n)) ts.forEachChild(n, returns)
              }
              ts.forEachChild(fn.body, returns)
            }
          }
        }
      }
    }

    function visit(node: ts.Node) {
      if (ts.isJsxText(node) && !insideDataOrTrans(node))
        visible(node, node.text.replace(/\s+/g, ' ').trim())
      if (
        ts.isJsxExpression(node) &&
        node.expression &&
        !ts.isJsxAttribute(node.parent) &&
        !insideDataOrTrans(node)
      )
        visibleExpression(node.expression)
      if (
        ts.isJsxAttribute(node) &&
        UI_PROPS.has(propertyName(node.name)) &&
        node.initializer
      ) {
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression)
          visibleExpression(node.initializer.expression)
        else if (ts.isStringLiteral(node.initializer))
          visible(node.initializer, node.initializer.text)
      }
      if (ts.isCallExpression(node)) {
        const bound = translator(node.expression)
        if (bound)
          for (const literal of literals(node.arguments[0])) {
            if (literal.text || isLiteral(node.arguments[0]))
              checkKey(literal, literal.text, bound, node.arguments[1])
          }
        const target = node.expression.getText(sf)
        if (
          /^(?:(?:window|globalThis)\.)?(?:alert|confirm|prompt)$/.test(
            target
          ) ||
          /^(?:toast|notifications?)\.(?:success|error|warning|warn|info|message|loading)$/.test(
            target
          )
        ) {
          if (node.arguments[0]) visibleExpression(node.arguments[0])
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          [
            'min',
            'max',
            'length',
            'nonempty',
            'email',
            'url',
            'regex',
          ].includes(node.expression.name.text)
        ) {
          for (const arg of node.arguments.slice(
            node.expression.name.text === 'nonempty' ||
              node.expression.name.text === 'email' ||
              node.expression.name.text === 'url'
              ? 0
              : 1
          ))
            if (isLiteral(arg)) visibleExpression(arg)
        }
      }
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        transElement(node)
      ) {
        const key = attribute(node, 'i18nKey')
        if (!key)
          report(
            node,
            'trans-key-required',
            'Trans must use an explicit semantic i18nKey'
          )
        else {
          const supplied = attribute(node, 't')
          const bound = (supplied && translator(supplied)) || {
            namespaces: ['common'],
            prefix: '',
          }
          const ns = literals(attribute(node, 'ns')).map((v) => v.text)
          for (const literal of literals(key))
            checkKey(
              literal,
              literal.text,
              { ...bound, namespaces: ns.length ? ns : bound.namespaces },
              undefined,
              true
            )
        }
      }
      if (
        ts.isImportDeclaration(node) &&
        isLiteral(node.moduleSpecifier) &&
        /(?:^|\/)i18n\/messages$/.test(node.moduleSpecifier.text)
      )
        report(node, 'legacy-translation-import', node.moduleSpecifier.text)
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  for (const [node, text] of visibleCandidates) {
    const sf = node.getSourceFile()
    const anchors = [
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    ]
    let parent: ts.Node | undefined = node.parent
    while (parent && !ts.isFunctionLike(parent)) {
      if (
        ts.isJsxElement(parent) ||
        ts.isJsxAttribute(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isReturnStatement(parent) ||
        ts.isExpressionStatement(parent)
      ) {
        anchors.push(
          sf.getLineAndCharacterOfPosition(parent.getStart(sf)).line + 1
        )
        break
      }
      parent = parent.parent
    }
    const exception = exemptionsByFile
      .get(sf)
      ?.find(
        (e) =>
          e.text === text &&
          anchors.some((line) => e.line === line || e.line === line - 1)
      )
    if (exception) exception.used.add(node.getStart(sf))
    else report(node, 'hardcoded-visible-text', JSON.stringify(text))
  }
  for (const [sf, exemptions] of exemptionsByFile) {
    for (const e of exemptions)
      if (e.used.size !== 1)
        issues.push(
          issue(
            path.posix.relative(root, sf.fileName),
            e.used.size ? 'ambiguous-exemption' : 'unused-exemption',
            JSON.stringify(e.text) +
              ': annotate exactly one adjacent UI literal',
            e.line
          )
        )
  }
  return issues
}

function resourceSnapshot(): ResourceFile[] {
  return walkFiles(LOCALES)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      file: relative(file),
      language: path.basename(path.dirname(file)),
      namespace: path.basename(file, '.json'),
      text: readFileSync(file, 'utf8'),
    }))
}

function sourceSnapshot(): Source[] {
  return walkFiles(SRC)
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !isTestFile(file))
    .map((file) => ({ file: relative(file), text: readFileSync(file, 'utf8') }))
}

const snapshot = auditResources(resourceSnapshot())

describe('all console locale resources', () => {
  it('provides matching nonempty messages, plural forms, interpolation and rich-text slots', () => {
    expect(snapshot.issues).toEqual([])
  })

  it('resolves literal translation keys and rejects untranslated visible copy', () => {
    expect(auditSources(sourceSnapshot(), snapshot.bundle)).toEqual([])
  }, 30_000)
})

describe('i18n coverage guardrails', () => {
  const fixtures = LANGUAGES.map((language) => ({
    file: language + '/sample.json',
    language,
    namespace: 'sample',
    text: JSON.stringify({
      hello: 'Hello {{name}}',
      rich: 'Read <link>the guide</link>',
    }),
  }))
  const bundle = auditResources(fixtures).bundle

  it('detects missing translations and mismatched interpolation', () => {
    const broken = fixtures.map((f) =>
      f.language === 'ja-JP'
        ? { ...f, text: JSON.stringify({ hello: 'Hello {{other}}' }) }
        : f
    )
    const rules = auditResources(broken).issues.map((e) => e.rule)
    expect(rules).toContain('missing-leaf')
    expect(rules).toContain('interpolation-mismatch')
  })

  it('detects a missing key and newly hardcoded rendered text', () => {
    const issues = auditSources(
      [
        {
          file: 'example.tsx',
          text: "import { t } from '@/i18n'; export function Example() { return <div title={t('sample:missing')}>未翻译提示</div> }",
        },
      ],
      bundle
    )
    expect(issues.some((i) => i.rule === 'missing-literal-key')).toBe(true)
    expect(issues.some((i) => i.rule === 'hardcoded-visible-text')).toBe(true)
  })

  it('keeps API payloads, comments, identifiers and code samples as data', () => {
    const issues = auditSources(
      [
        {
          file: 'example.tsx',
          text: "import { t } from '@/i18n'; const requestBody = {model:'用户模型',message:'原文'}; export function Example() { return <div aria-label={t('sample:hello',{name:'用户内容'})}><code>POST /api 请求</code></div> }",
        },
      ],
      bundle
    )
    expect(issues).toEqual([])
  })
})
