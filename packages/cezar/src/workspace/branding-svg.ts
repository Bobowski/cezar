import { DOMParser, XMLSerializer, onErrorStopParsing, type Element, type Node } from '@xmldom/xmldom';

/**
 * The favicon's SVG sanitiser (spec 2026-10-24-cockpit-branding §5): a favicon is loaded on every
 * page, so what is served is a re-serialised tree of allowlisted SVG elements whose attributes
 * reference nothing outside the document. Scripts, event handlers, `foreignObject`, `<image>`,
 * stylesheets, animation and every external `href`/`url()` are dropped; an input that does not
 * parse as one `<svg>` root is refused rather than repaired.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Shapes, paint servers and filters — nothing that runs, loads, links or animates. */
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'textPath', 'linearGradient', 'radialGradient', 'stop', 'clipPath',
  'mask', 'pattern', 'marker', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge',
  'feMergeNode', 'feMorphology', 'feOffset',
]);

/** Element types whose text content is part of the picture. */
const TEXT_PARENTS = new Set(['text', 'tspan', 'textPath', 'title', 'desc']);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** A `url(...)` that is not a same-document `#id`, or anything a CSS value could load or run. */
function referencesOutside(value: string): boolean {
  const lowered = value.toLowerCase();
  // A backslash is a CSS escape, which could spell any of these past the patterns.
  if (/javascript:|vbscript:|data:|expression\s*\(|@import|\\/.test(lowered)) return true;
  return /url\s*\((?!\s*['"]?#)/.test(lowered);
}

function keepAttribute(attr: { name: string; namespaceURI: string | null; value: string; localName: string | null }): boolean {
  const name = attr.name.toLowerCase();
  const local = (attr.localName ?? attr.name).toLowerCase();
  if (local.startsWith('on')) return false;
  if (name === 'xmlns' || name === 'xmlns:xlink') return true;
  if (name.startsWith('xmlns:')) return false;
  // Only the SVG attributes themselves (no namespace), `xlink:href` and `xml:space`.
  if (attr.namespaceURI !== null && attr.namespaceURI !== XLINK_NS && name !== 'xml:space') return false;
  if (local === 'href') return /^#[\w.:-]+$/.test(attr.value.trim());
  if (referencesOutside(attr.value)) return false;
  return true;
}

function clean(element: Element): void {
  for (const attr of [...Array.from(element.attributes)]) {
    if (!keepAttribute(attr)) element.removeAttributeNode(attr);
  }
  for (const child of [...Array.from(element.childNodes)] as Node[]) {
    if (child.nodeType === ELEMENT_NODE) {
      const el = child as Element;
      if (el.namespaceURI === SVG_NS && ELEMENTS.has(el.localName ?? '') && el.localName !== 'svg') clean(el);
      else element.removeChild(child);
    } else if (child.nodeType !== TEXT_NODE || !TEXT_PARENTS.has(element.localName ?? '')) {
      // Comments, processing instructions, CDATA, and stray text between shapes.
      element.removeChild(child);
    }
  }
}

export type SanitizeResult = { ok: true; svg: string } | { ok: false; error: string };

export function sanitizeSvg(source: string): SanitizeResult {
  const text = source.replace(/^﻿/, '');
  // No DTD at all: entity expansion is the one parser feature an SVG favicon never needs.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { ok: false, error: 'an SVG with a DOCTYPE or entities is not accepted' };
  let doc;
  try {
    doc = new DOMParser({ onError: onErrorStopParsing, locator: false }).parseFromString(text, 'image/svg+xml');
  } catch {
    return { ok: false, error: 'not a well-formed SVG' };
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    return { ok: false, error: 'not an SVG image — the root element must be <svg xmlns="http://www.w3.org/2000/svg">' };
  }
  clean(root);
  // Parsed as image/svg+xml, a bare `<svg>` is already in the SVG namespace; served, it must say so.
  if (!root.hasAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS);
  for (const child of [...Array.from(doc.childNodes)] as Node[]) if (child !== root) doc.removeChild(child);
  const svg = new XMLSerializer().serializeToString(root);
  return svg.length > 0 ? { ok: true, svg } : { ok: false, error: 'the SVG is empty once sanitised' };
}
