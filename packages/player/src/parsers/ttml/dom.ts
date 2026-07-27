import type { ParseDiagnostic } from "../types.js";

export const TTML_NAMESPACE = "http://www.w3.org/ns/ttml";
export const TTML_METADATA_NAMESPACE =
  "http://www.w3.org/ns/ttml#metadata";
export const ITUNES_TTML_NAMESPACE =
  "http://music.apple.com/lyric-ttml-internal";
export const TTML_PARAMETER_NAMESPACE =
  "http://www.w3.org/ns/ttml#parameter";
export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

export interface XmlDocumentReader {
  parse(source: string): XMLDocument;
}

export type XmlDocumentParseResult =
  | { readonly ok: true; readonly document: XMLDocument }
  | {
      readonly ok: false;
      readonly code:
        | "TTML_DOM_PARSER_UNAVAILABLE"
        | "TTML_XML_PARSE_ERROR";
      readonly message: string;
    };

export interface DiagnosticContext {
  readonly lineId?: string;
  readonly sourceIndex?: number;
}

export function createDiagnostic(
  severity: ParseDiagnostic["severity"],
  code: string,
  message: string,
  context: DiagnosticContext = {},
): ParseDiagnostic {
  return {
    severity,
    code,
    message,
    ...(context.lineId === undefined ? {} : { lineId: context.lineId }),
    ...(context.sourceIndex === undefined
      ? {}
      : { sourceIndex: context.sourceIndex }),
  };
}

export function parseXmlDocument(
  text: string,
  reader?: XmlDocumentReader,
): XmlDocumentParseResult {
  if (!reader && typeof globalThis.DOMParser !== "function") {
    return {
      ok: false,
      code: "TTML_DOM_PARSER_UNAVAILABLE",
      message: "This environment does not provide DOMParser.",
    };
  }

  let document: XMLDocument;
  try {
    document = reader
      ? reader.parse(text)
      : new globalThis.DOMParser().parseFromString(text, "application/xml");
  } catch (error) {
    return {
      ok: false,
      code: "TTML_XML_PARSE_ERROR",
      message:
        error instanceof Error && error.message
          ? `Unable to parse TTML XML: ${error.message}`
          : "Unable to parse TTML XML.",
    };
  }

  const parserError = Array.from(
    document.getElementsByTagNameNS("*", "parsererror"),
  )[0];
  if (parserError) {
    const detail = normalizeText(parserError.textContent);
    return {
      ok: false,
      code: "TTML_XML_PARSE_ERROR",
      message: detail ? `Unable to parse TTML XML: ${detail}` : "Unable to parse TTML XML.",
    };
  }

  return { ok: true, document };
}

export function normalizeText(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function getAttribute(
  element: Element,
  namespace: string,
  localName: string,
  qualifiedName: string,
): string | null {
  const namespaced = element.getAttributeNS(namespace, localName);
  if (namespaced !== null) return namespaced;
  const qualified = element.getAttribute(qualifiedName);
  if (qualified !== null) return qualified;
  return element.getAttribute(localName);
}

export function getXmlId(element: Element): string | null {
  return getAttribute(element, XML_NAMESPACE, "id", "xml:id");
}

export function getXmlLanguage(element: Element): string | null {
  return getAttribute(element, XML_NAMESPACE, "lang", "xml:lang");
}

export function getTtmlAgent(element: Element): string | null {
  return getAttribute(
    element,
    TTML_METADATA_NAMESPACE,
    "agent",
    "ttm:agent",
  );
}

export function getTtmlRole(element: Element): string | null {
  return getAttribute(
    element,
    TTML_METADATA_NAMESPACE,
    "role",
    "ttm:role",
  );
}

export function getItunesKey(element: Element): string | null {
  return getAttribute(
    element,
    ITUNES_TTML_NAMESPACE,
    "key",
    "itunes:key",
  );
}

export function getInheritedXmlLanguage(element: Element): string | null {
  let current: Element | null = element;
  while (current) {
    const language = getXmlLanguage(current);
    if (language) return language;
    current = current.parentElement;
  }
  return null;
}

/** Reads xml:lang without escaping a secondary branch into the primary row. */
export function getInheritedXmlLanguageWithin(
  element: Element,
  boundaryExclusive: Element,
): string | null {
  let current: Element | null = element;
  while (current && current !== boundaryExclusive) {
    const language = getXmlLanguage(current);
    if (language) return language;
    current = current.parentElement;
  }
  return null;
}

export function getInheritedTtmlAgent(element: Element): string | null {
  let current: Element | null = element;
  while (current) {
    const agent = getTtmlAgent(current);
    if (agent) return agent;
    current = current.parentElement;
  }
  return null;
}

export function directChildElements(
  parent: Element,
  localName?: string,
): readonly Element[] {
  return Array.from(parent.children).filter(
    (child) => localName === undefined || child.localName === localName,
  );
}

export function descendantElements(
  root: Document | Element,
  localName: string,
  namespaces: readonly string[],
): readonly Element[] {
  const seen = new Set<Element>();
  const result: Element[] = [];

  for (const namespace of namespaces) {
    for (const element of Array.from(
      root.getElementsByTagNameNS(namespace, localName),
    )) {
      if (seen.has(element)) continue;
      seen.add(element);
      result.push(element);
    }
  }

  return result.sort(compareDocumentOrder);
}

function compareDocumentOrder(left: Element, right: Element): number {
  if (left === right) return 0;
  const position = left.compareDocumentPosition(right);
  if (position & 4) return -1;
  if (position & 2) return 1;
  return 0;
}

export function collectTextExcludingRoles(
  node: Node,
  excludedRoles: ReadonlySet<string>,
): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const role = getTtmlRole(element);
  if (role && excludedRoles.has(role)) return "";
  return Array.from(element.childNodes)
    .map((child) => collectTextExcludingRoles(child, excludedRoles))
    .join("");
}

export function collectRoleElements(
  root: Element,
  roles: ReadonlySet<string>,
): readonly Element[] {
  return Array.from(root.getElementsByTagNameNS("*", "span")).filter(
    (element) => {
      const role = getTtmlRole(element);
      return role !== null && roles.has(role);
    },
  );
}

export function hasAncestorWithRole(
  element: Element,
  root: Element,
  roles: ReadonlySet<string>,
): boolean {
  let current = element.parentElement;
  while (current && current !== root) {
    const role = getTtmlRole(current);
    if (role && roles.has(role)) return true;
    current = current.parentElement;
  }
  return false;
}
