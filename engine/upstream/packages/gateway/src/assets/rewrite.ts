/**
 * Asset URL rewriter and central rewrite choke point.
 *
 * This module rewrites URLs; it is not a sanitizer. Any future DOM/content sanitizer or
 * attribute allowlist must be a separate audited layer. Do not alter payload content here except
 * for resource URLs.
 *
 * Rewrites, in FullSnapshot AND mutation events (attribute mutations + added-node subtrees):
 * - attributes: src, srcset (REAL srcset parsing — commas inside URLs), poster, xlink:href,
 *   inline style
 * - stylesheet text: url() in all three quote forms, @import
 * - data: URLs pass through untouched
 * Rewritten form: /s/<sid>/a/<token>, token = AES-256-GCM of {url, sessionId, tabId}.
 * `postcss-value-parser` is allowed for url() extraction (it's parsing, not sanitizing).
 *
 * Implements the RewriteStage hook from ../hub/tabhub.ts — integration wires it in main.ts;
 * this domain never edits hub files.
 */
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import type { RewriteStage } from "../hub/tabhub";
import { sealAssetToken } from "./token";

type UnknownRecord = Record<string, unknown>;

const NODE_ELEMENT = 2;
const NODE_TEXT = 3;
const DIRECT_URL_ATTRIBUTES = new Set(["src", "poster", "xlink:href"]);
const CSS_WHITESPACE = /[\t\n\f\r ]/;
const IDENT_CHAR = /[A-Za-z0-9_-]/;

interface RewriteContext {
  sessionId: string;
  tabId: string;
  baseUrl?: string;
  assetUrl?: (url: string) => string;
  tags?: Map<number, string>;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

export function createRewriteStage(serverKey: Buffer): RewriteStage {
  if (!Buffer.isBuffer(serverKey) || serverKey.length !== 32) {
    throw new TypeError("Asset token key must be a 32-byte Buffer");
  }
  // Do not let later mutation of the caller's key silently rotate an already-wired stage.
  const key = Buffer.from(serverKey);
  const documentUrls = new Map<string, string>();
  const tags = new Map<number, string>();
  // One live tab owns this stage. Bound memoization while making repeated DOM references
  // (preload + visible image, mutations, resnapshots) share the browser's HTTP cache key.
  const assetUrls = new Map<string, string>();
  const assetUrl = (url: string, ctx: { sessionId: string; tabId: string }): string => {
    const id = JSON.stringify([ctx.sessionId, ctx.tabId, url]);
    const existing = assetUrls.get(id);
    if (existing !== undefined) return existing;
    const result = proxyUrl(url, key, ctx);
    if (assetUrls.size >= 4096) assetUrls.delete(assetUrls.keys().next().value!);
    assetUrls.set(id, result);
    return result;
  };

  return (event, ctx) => {
    if (event.type === EventType.FullSnapshot) tags.clear();
    const documentKey = JSON.stringify([ctx.sessionId, ctx.tabId]);
    if (event.type === EventType.Meta) {
      const href = record(event.data).href;
      if (typeof href === "string" && absoluteUrl(href) !== null) {
        documentUrls.set(documentKey, href);
      }
      return event;
    }

    return rewriteEvent(event, key, {
      sessionId: ctx.sessionId,
      tabId: ctx.tabId,
      baseUrl: documentUrls.get(documentKey),
      assetUrl: (url) => assetUrl(url, ctx),
      tags,
    });
  };
}

function rewriteEvent(event: eventWithTime, key: Buffer, ctx: RewriteContext): eventWithTime {
  if (event.type === EventType.FullSnapshot) {
    const data = record(event.data);
    const rewritten = rewriteSerializedNode(data.node, key, ctx, false);
    if (rewritten === data.node) return event;
    return { ...event, data: { ...event.data, node: rewritten } } as eventWithTime;
  }

  if (event.type !== EventType.IncrementalSnapshot) return event;
  const data = record(event.data);

  if (data.source === IncrementalSource.Mutation) {
    return rewriteMutationEvent(event, key, ctx);
  }
  if (data.source === IncrementalSource.StyleSheetRule) {
    return rewriteStyleSheetRuleEvent(event, key, ctx);
  }
  if (data.source === IncrementalSource.AdoptedStyleSheet) {
    return rewriteAdoptedStyleSheetEvent(event, key, ctx);
  }
  if (data.source === IncrementalSource.StyleDeclaration) {
    return rewriteStyleDeclarationEvent(event, key, ctx);
  }
  // GOTCHA (P2-FONTS): CSS @font-face reaches the stylesheet paths above, but rrweb
  // collectFonts records a string-backed JS FontFace constructor through this separate event.
  // Binary FontFace sources contain the bytes themselves and deliberately have no URL to rewrite.
  if (data.source === IncrementalSource.Font && typeof data.fontSource === "string") {
    const fontSource = rewriteCssText(
      data.fontSource,
      (url) => proxyUrl(url, key, ctx),
      ctx.baseUrl,
    );
    if (fontSource === data.fontSource) return event;
    return { ...event, data: { ...event.data, fontSource } } as eventWithTime;
  }
  return event;
}

function rewriteMutationEvent(
  event: eventWithTime,
  key: Buffer,
  ctx: RewriteContext,
): eventWithTime {
  const data = record(event.data);
  let changed = false;

  const attributes = Array.isArray(data.attributes)
    ? data.attributes.map((mutation) => {
        const item = record(mutation);
        const rewritten = rewriteAttributes(
          item.attributes,
          key,
          ctx,
          ctx.tags?.get(item.id as number),
        );
        if (rewritten === item.attributes) return mutation;
        changed = true;
        return { ...item, attributes: rewritten };
      })
    : data.attributes;

  const adds = Array.isArray(data.adds)
    ? data.adds.map((addition) => {
        const item = record(addition);
        const node = rewriteSerializedNode(item.node, key, ctx, false);
        if (node === item.node) return addition;
        changed = true;
        return { ...item, node };
      })
    : data.adds;

  if (!changed) return event;
  return { ...event, data: { ...data, attributes, adds } } as eventWithTime;
}

function rewriteStyleSheetRuleEvent(
  event: eventWithTime,
  key: Buffer,
  ctx: RewriteContext,
): eventWithTime {
  const data = record(event.data);
  let changed = false;
  const rewrite = (css: string) =>
    rewriteCssText(css, (url) => proxyUrl(url, key, ctx), ctx.baseUrl);
  const adds = Array.isArray(data.adds)
    ? data.adds.map((addition) => {
        const item = record(addition);
        if (typeof item.rule !== "string") return addition;
        const rule = rewrite(item.rule);
        if (rule === item.rule) return addition;
        changed = true;
        return { ...item, rule };
      })
    : data.adds;
  const replace = typeof data.replace === "string" ? rewrite(data.replace) : data.replace;
  const replaceSync =
    typeof data.replaceSync === "string" ? rewrite(data.replaceSync) : data.replaceSync;
  changed ||= replace !== data.replace || replaceSync !== data.replaceSync;
  if (!changed) return event;
  return { ...event, data: { ...data, adds, replace, replaceSync } } as eventWithTime;
}

function rewriteAdoptedStyleSheetEvent(
  event: eventWithTime,
  key: Buffer,
  ctx: RewriteContext,
): eventWithTime {
  const data = record(event.data);
  if (!Array.isArray(data.styles)) return event;
  let changed = false;
  const styles = data.styles.map((style) => {
    const item = record(style);
    if (!Array.isArray(item.rules)) return style;
    let styleChanged = false;
    const rules = item.rules.map((ruleValue) => {
      const rule = record(ruleValue);
      if (typeof rule.rule !== "string") return ruleValue;
      const rewritten = rewriteCssText(rule.rule, (url) => proxyUrl(url, key, ctx), ctx.baseUrl);
      if (rewritten === rule.rule) return ruleValue;
      styleChanged = true;
      changed = true;
      return { ...rule, rule: rewritten };
    });
    return styleChanged ? { ...item, rules } : style;
  });
  if (!changed) return event;
  return { ...event, data: { ...data, styles } } as eventWithTime;
}

function rewriteStyleDeclarationEvent(
  event: eventWithTime,
  key: Buffer,
  ctx: RewriteContext,
): eventWithTime {
  const data = record(event.data);
  const set = record(data.set);
  if (typeof set.value !== "string") return event;
  const value = rewriteCssText(set.value, (url) => proxyUrl(url, key, ctx), ctx.baseUrl);
  if (value === set.value) return event;
  return { ...event, data: { ...data, set: { ...set, value } } } as eventWithTime;
}

function rewriteSerializedNode(
  value: unknown,
  key: Buffer,
  ctx: RewriteContext,
  insideStyle: boolean,
): unknown {
  const node = record(value);
  const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : undefined;
  if (node.type === NODE_ELEMENT && typeof node.id === "number" && tag) ctx.tags?.set(node.id, tag);
  if (node.type === NODE_TEXT && insideStyle && typeof node.textContent === "string") {
    const textContent = rewriteCssText(
      node.textContent,
      (url) => proxyUrl(url, key, ctx),
      ctx.baseUrl,
    );
    return textContent === node.textContent ? value : { ...node, textContent };
  }

  let changed = false;
  const attributes = rewriteAttributes(node.attributes, key, ctx, tag);
  changed ||= attributes !== node.attributes;

  const childIsStyle =
    node.type === NODE_ELEMENT &&
    typeof node.tagName === "string" &&
    node.tagName.toLowerCase() === "style";
  const childNodes = Array.isArray(node.childNodes)
    ? node.childNodes.map((child) => {
        const rewritten = rewriteSerializedNode(child, key, ctx, childIsStyle);
        changed ||= rewritten !== child;
        return rewritten;
      })
    : node.childNodes;

  if (!changed) return value;
  return {
    ...node,
    ...(attributes !== node.attributes ? { attributes } : {}),
    ...(childNodes !== node.childNodes ? { childNodes } : {}),
  };
}

function rewriteAttributes(
  value: unknown,
  key: Buffer,
  ctx: RewriteContext,
  tag?: string,
): unknown {
  if (!isRecord(value)) return value;
  let changed = false;
  const output: UnknownRecord = { ...value };

  for (const [name, original] of Object.entries(value)) {
    const lowerName = name.toLowerCase();
    // MediaSource object URLs are not image Blobs. Preserve their source kind so
    // the viewer's existing media compositor selects RTC rather than HTTP playback.
    if (
      lowerName === "src" &&
      typeof original === "string" &&
      /^blob:/i.test(original) &&
      (tag === "video" || tag === "audio" || tag === "source")
    )
      continue;
    let rewritten: unknown = original;
    if ((DIRECT_URL_ATTRIBUTES.has(lowerName) || lowerName === "href" && (tag === "link" || tag === "use" || tag === "image")) && typeof original === "string") {
      rewritten = rewriteUrlPreservingSpace(
        original,
        (url) => proxyUrl(url, key, ctx),
        ctx.baseUrl,
      );
    } else if (lowerName === "srcset" && typeof original === "string") {
      rewritten = rewriteSrcset(original, (url) => proxyUrl(url, key, ctx), ctx.baseUrl);
    } else if (lowerName === "style") {
      rewritten = rewriteStyleAttribute(original, key, ctx);
    } else if (lowerName === "_csstext" && typeof original === "string") {
      rewritten = rewriteCssText(original, (url) => proxyUrl(url, key, ctx), ctx.baseUrl);
    }
    if (rewritten !== original) {
      output[name] = rewritten;
      changed = true;
    }
  }
  return changed ? output : value;
}

function rewriteStyleAttribute(value: unknown, key: Buffer, ctx: RewriteContext): unknown {
  const rewrite = (css: string) =>
    rewriteCssText(css, (url) => proxyUrl(url, key, ctx), ctx.baseUrl);
  if (typeof value === "string") return rewrite(value);
  if (!isRecord(value)) return value;

  let changed = false;
  const output: UnknownRecord = { ...value };
  for (const [property, styleValue] of Object.entries(value)) {
    if (typeof styleValue === "string") {
      const rewritten = rewrite(styleValue);
      if (rewritten !== styleValue) {
        output[property] = rewritten;
        changed = true;
      }
    } else if (Array.isArray(styleValue) && typeof styleValue[0] === "string") {
      const rewritten = rewrite(styleValue[0]);
      if (rewritten !== styleValue[0]) {
        output[property] = [rewritten, ...styleValue.slice(1)];
        changed = true;
      }
    }
  }
  return changed ? output : value;
}

/** Rewrite the URL spans in a srcset while retaining every descriptor and separator byte. */
export function rewriteSrcset(
  input: string,
  rewrite: (absoluteUrl: string) => string,
  baseUrl?: string,
): string {
  const replacements: Replacement[] = [];
  let position = 0;

  while (position < input.length) {
    while (
      position < input.length &&
      (isCssWhitespace(input[position]!) || input[position] === ",")
    ) {
      position += 1;
    }
    if (position >= input.length) break;

    const urlStart = position;
    while (position < input.length && !isCssWhitespace(input[position]!)) position += 1;
    let urlEnd = position;

    if (input[urlEnd - 1] === ",") {
      while (urlEnd > urlStart && input[urlEnd - 1] === ",") urlEnd -= 1;
    } else {
      let parentheses = 0;
      while (position < input.length) {
        const char = input[position]!;
        if (char === "(") parentheses += 1;
        else if (char === ")" && parentheses > 0) parentheses -= 1;
        else if (char === "," && parentheses === 0) {
          position += 1;
          break;
        }
        position += 1;
      }
    }

    addUrlReplacement(input, urlStart, urlEnd, replacements, rewrite, baseUrl);
  }
  return applyReplacements(input, replacements);
}

/** Parse CSS strings/comments/functions so only url() and quoted @import URL contents move. */
export function rewriteCssText(
  css: string,
  rewrite: (absoluteUrl: string) => string,
  baseUrl?: string,
): string {
  const replacements: Replacement[] = [];
  let position = 0;

  while (position < css.length) {
    if (css.startsWith("/*", position)) {
      position = skipComment(css, position);
      continue;
    }
    const char = css[position]!;
    if (char === "'" || char === '"') {
      position = skipQuoted(css, position, char);
      continue;
    }

    if (char === "@" && identifierBoundary(css, position - 1)) {
      const nameEnd = readIdentifier(css, position + 1);
      if (css.slice(position + 1, nameEnd).toLowerCase() === "import") {
        let target = skipCssSpaceAndComments(css, nameEnd);
        const quote = css[target];
        if (quote === "'" || quote === '"') {
          const end = skipQuoted(css, target, quote);
          if (end <= css.length && css[end - 1] === quote) {
            addCssUrlReplacement(css, target + 1, end - 1, replacements, rewrite, baseUrl);
          }
          position = end;
          continue;
        }
      }
    }

    if (isIdentifierStart(char) && identifierBoundary(css, position - 1)) {
      const nameEnd = readIdentifier(css, position);
      if (css.slice(position, nameEnd).toLowerCase() === "url" && css[nameEnd] === "(") {
        const end = parseUrlFunction(css, nameEnd, replacements, rewrite, baseUrl);
        if (end !== null) {
          position = end;
          continue;
        }
      }
      position = nameEnd;
      continue;
    }
    position += 1;
  }
  return applyReplacements(css, replacements);
}

function parseUrlFunction(
  css: string,
  openParen: number,
  replacements: Replacement[],
  rewrite: (absoluteUrl: string) => string,
  baseUrl?: string,
): number | null {
  let contentStart = openParen + 1;
  while (contentStart < css.length && isCssWhitespace(css[contentStart]!)) contentStart += 1;
  const quote = css[contentStart];

  if (quote === "'" || quote === '"') {
    const quotedEnd = skipQuoted(css, contentStart, quote);
    if (quotedEnd > css.length || css[quotedEnd - 1] !== quote) return null;
    const closeParen = skipCssSpaceAndComments(css, quotedEnd);
    if (css[closeParen] !== ")") return null;
    addCssUrlReplacement(css, contentStart + 1, quotedEnd - 1, replacements, rewrite, baseUrl);
    return closeParen + 1;
  }

  let position = contentStart;
  let depth = 0;
  while (position < css.length) {
    if (css.startsWith("/*", position)) {
      position = skipComment(css, position);
      continue;
    }
    if (css[position] === "\\") {
      position = skipCssEscape(css, position);
      continue;
    }
    if (css[position] === "(") depth += 1;
    else if (css[position] === ")") {
      if (depth === 0) {
        let contentEnd = position;
        while (contentEnd > contentStart && isCssWhitespace(css[contentEnd - 1]!)) contentEnd -= 1;
        addCssUrlReplacement(css, contentStart, contentEnd, replacements, rewrite, baseUrl);
        return position + 1;
      }
      depth -= 1;
    }
    position += 1;
  }
  return null;
}

function addCssUrlReplacement(
  source: string,
  start: number,
  end: number,
  replacements: Replacement[],
  rewrite: (absoluteUrl: string) => string,
  baseUrl?: string,
): void {
  const decoded = decodeCssEscapes(source.slice(start, end));
  addResolvedReplacement(decoded, start, end, replacements, rewrite, baseUrl);
}

function addUrlReplacement(
  source: string,
  start: number,
  end: number,
  replacements: Replacement[],
  rewrite: (absoluteUrl: string) => string,
  baseUrl?: string,
): void {
  addResolvedReplacement(source.slice(start, end), start, end, replacements, rewrite, baseUrl);
}

function addResolvedReplacement(
  candidate: string,
  start: number,
  end: number,
  replacements: Replacement[],
  rewrite: (absoluteUrl: string) => string,
  baseUrl?: string,
): void {
  if (candidate === "" || candidate.startsWith("#") || /^data:/i.test(candidate)) return;
  const url = absoluteUrl(candidate, baseUrl);
  if (url === null) return;
  if (!/^(https?:|blob:)/i.test(url)) return;
  replacements.push({ start, end, value: rewrite(url) });
}

function rewriteUrlPreservingSpace(
  input: string,
  rewrite: (absoluteUrl: string) => string,
  baseUrl?: string,
): string {
  const start = input.search(/\S/);
  if (start < 0) return input;
  let end = input.length;
  while (end > start && /\s/.test(input[end - 1]!)) end -= 1;
  const replacements: Replacement[] = [];
  addUrlReplacement(input, start, end, replacements, rewrite, baseUrl);
  return applyReplacements(input, replacements);
}

function proxyUrl(url: string, key: Buffer, ctx: RewriteContext): string {
  if (ctx.assetUrl !== undefined) return ctx.assetUrl(url);
  const token = sealAssetToken({ url, sessionId: ctx.sessionId, tabId: ctx.tabId }, key);
  return `/s/${encodeURIComponent(ctx.sessionId)}/a/${token}`;
}

function absoluteUrl(value: string, baseUrl?: string): string | null {
  try {
    return baseUrl === undefined ? new URL(value).href : new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function applyReplacements(source: string, replacements: Replacement[]): string {
  if (replacements.length === 0) return source;
  let output = "";
  let position = 0;
  for (const replacement of replacements) {
    output += source.slice(position, replacement.start) + replacement.value;
    position = replacement.end;
  }
  return output + source.slice(position);
}

function skipQuoted(source: string, start: number, quote: string): number {
  let position = start + 1;
  while (position < source.length) {
    if (source[position] === "\\") {
      position = skipCssEscape(source, position);
    } else if (source[position] === quote) {
      return position + 1;
    } else {
      position += 1;
    }
  }
  return source.length + 1;
}

function skipCssEscape(source: string, slash: number): number {
  let position = slash + 1;
  if (position >= source.length) return position;
  if (source[position] === "\r" && source[position + 1] === "\n") return position + 2;
  if (source[position] === "\n" || source[position] === "\r" || source[position] === "\f") {
    return position + 1;
  }
  if (/[0-9A-Fa-f]/.test(source[position]!)) {
    let digits = 0;
    while (position < source.length && digits < 6 && /[0-9A-Fa-f]/.test(source[position]!)) {
      position += 1;
      digits += 1;
    }
    if (position < source.length && isCssWhitespace(source[position]!)) position += 1;
    return position;
  }
  return position + 1;
}

function decodeCssEscapes(value: string): string {
  let output = "";
  for (let position = 0; position < value.length; position += 1) {
    if (value[position] !== "\\") {
      output += value[position];
      continue;
    }
    const next = position + 1;
    if (next >= value.length) continue;
    if (value[next] === "\r" && value[next + 1] === "\n") {
      position += 2;
      continue;
    }
    if (value[next] === "\n" || value[next] === "\r" || value[next] === "\f") {
      position += 1;
      continue;
    }
    if (/[0-9A-Fa-f]/.test(value[next]!)) {
      let end = next;
      while (end < value.length && end - next < 6 && /[0-9A-Fa-f]/.test(value[end]!)) end += 1;
      const codePoint = Number.parseInt(value.slice(next, end), 16);
      output += String.fromCodePoint(codePoint === 0 || codePoint > 0x10ffff ? 0xfffd : codePoint);
      if (end < value.length && isCssWhitespace(value[end]!)) end += 1;
      position = end - 1;
      continue;
    }
    output += value[next];
    position = next;
  }
  return output;
}

function skipComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  return end < 0 ? source.length : end + 2;
}

function skipCssSpaceAndComments(source: string, start: number): number {
  let position = start;
  while (position < source.length) {
    if (isCssWhitespace(source[position]!)) position += 1;
    else if (source.startsWith("/*", position)) position = skipComment(source, position);
    else break;
  }
  return position;
}

function readIdentifier(source: string, start: number): number {
  let end = start;
  while (end < source.length && IDENT_CHAR.test(source[end]!)) end += 1;
  return end;
}

function identifierBoundary(source: string, position: number): boolean {
  return position < 0 || !IDENT_CHAR.test(source[position]!);
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_-]/.test(char);
}

function isCssWhitespace(char: string): boolean {
  return CSS_WHITESPACE.test(char);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}
