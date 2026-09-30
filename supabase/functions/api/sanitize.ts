// Cleaning instructors' HTML (descriptions, pages) before it's shown in the page.

import sanitizeHtml from "sanitize-html";
import { decodeHTML } from "entities";

/** Turn HTML entities (&amp; &#39; …) back into plain characters. */
export const unescapeHtml = (text: string) => decodeHTML(text);

/** Remove all tags, leaving the text. */
export const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");

// The tags the nh3/ammonia HTML cleaner allows by default.
const TAGS = [
  "a",
  "abbr",
  "acronym",
  "area",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "map",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
];

// (sanitize-html ships without type information, so the options are typed loosely.)
const OPTIONS = {
  allowedTags: TAGS,
  allowedAttributes: {
    "*": ["lang", "title"],
    a: ["href", "hreflang", "target", "rel"],
    img: ["alt", "height", "src", "width"],
    area: ["alt", "coords", "href", "shape"],
    col: ["align", "char", "charoff", "span"],
    colgroup: ["align", "char", "charoff", "span"],
    ol: ["start"],
    td: ["align", "char", "charoff", "colspan", "headers", "rowspan"],
    th: ["align", "char", "charoff", "colspan", "headers", "rowspan", "scope"],
    table: ["align", "char", "charoff", "summary"],
    time: ["datetime"],
    q: ["cite"],
    blockquote: ["cite"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  allowProtocolRelative: false,
  // Links open in a new tab, without giving that tab access to this page.
  transformTags: {
    a: (tagName: string, attribs: Record<string, string>) => ({
      tagName,
      attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
    }),
  },
};

/**
 * Remove anything unsafe (scripts, styles, code that runs on click…) from an
 * instructor's description, and make its links open in a new tab.
 */
export function sanitize(html: string | null | undefined): string {
  return sanitizeHtml(html ?? "", OPTIONS).trim();
}
