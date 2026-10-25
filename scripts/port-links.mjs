/**
 * Link handling for the skill port: finding every relative link in a Markdown page, pointing
 * links into unshipped parts of upstream at GitHub, and reporting links that point nowhere.
 *
 * These are pure functions of the page text and a `ships(target)` predicate, so the port script
 * and its tests share one implementation.
 */
import { posix } from "node:path";
import { HTML5_ENTITIES } from "./html5-entities.mjs";

export const UPSTREAM_BLOB = "https://github.com/cursor/plugins/blob/main/pstack";

/**
 * The parts of upstream pstack this package does not ship, which a ported page may still link
 * to. A link into one of them points at GitHub. A link to any other missing path is a typo or a
 * moved file and fails the port, because rewriting it would hand the reader a dead GitHub URL.
 */
export const UNSHIPPED_UPSTREAM = ["automations/"];

// HTML's legacy C1 control-reference replacements.
const C1_REPLACEMENTS = new Map([
	[0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020],
	[0x87, 0x2021], [0x88, 0x2c6], [0x89, 0x2030], [0x8a, 0x160], [0x8b, 0x2039], [0x8c, 0x152],
	[0x8e, 0x17d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022],
	[0x96, 0x2013], [0x97, 0x2014], [0x98, 0x2dc], [0x99, 0x2122], [0x9a, 0x161], [0x9b, 0x203a],
	[0x9c, 0x153], [0x9e, 0x17e], [0x9f, 0x178],
]);

function readDestination(text, offset) {
	const angle = text[offset] === "<";
	const start = offset + (angle ? 1 : 0);
	let end = start;
	let depth = 0;
	while (end < text.length) {
		const char = text[end];
		if (char === "\\" && /[\\()<>]/.test(text[end + 1] ?? "")) {
			end += 2;
			continue;
		}
		if (angle) {
			if (char === ">" || char === "\n" || char === "\r") break;
		} else {
			if (/\s/.test(char) || (char === ")" && depth === 0)) break;
			if (char === "(") depth++;
			if (char === ")") depth--;
		}
		end++;
	}
	if ((!angle && end === start) || depth !== 0 || (angle && text[end] !== ">")) return undefined;
	return { href: text.slice(start, end), start, end, after: end + (angle ? 1 : 0) };
}

function skipLinkSpace(text, start) {
	return start + /^[ \t]*(?:(?:\r\n?|\n)[ \t]*)?/.exec(text.slice(start))[0].length;
}

function afterTitle(text, start) {
	let cursor = skipLinkSpace(text, start);
	if (cursor === start || !/["'(]/.test(text[cursor] ?? "")) return start;
	const closing = text[cursor] === "(" ? ")" : text[cursor];
	for (cursor++; cursor < text.length; cursor++) {
		if (text[cursor] === "\\") cursor++;
		else if (text[cursor] === closing) {
			return /(?:\r\n|\n|\r(?!\n))[ \t]*(?:\r\n?|\n)/.test(text.slice(start, cursor)) ? start : cursor + 1;
		}
	}
	return start;
}

/**
 * Link destinations and their replacement spans. Covers images, inline links and reference
 * definitions, including angle-bracket destinations. Titles are opaque, not nested links.
 * Code examples are scanned too: pstack puts runnable links in them.
 */
export function linkDestinations(text) {
	const found = [];
	let consumed = 0;
	const prefix = /\]\(\s*|^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(?:(?:\r\n?|\n)[ \t]*)?/gm;
	for (const match of text.matchAll(prefix)) {
		if (match.index < consumed) continue;
		const link = readDestination(text, match.index + match[0].length);
		if (!link) continue;
		const titleStart = skipLinkSpace(text, link.after);
		const titleOnNextLine = titleStart !== link.after
			&& /[\r\n]/.test(text.slice(link.after, titleStart))
			&& /["'(]/.test(text[titleStart] ?? "");
		const after = afterTitle(text, link.after);
		if (match[0].startsWith("](")) {
			const closing = skipLinkSpace(text, after);
			if (text[closing] !== ")") continue;
			consumed = closing + 1;
		} else {
			const lineEnd = text.slice(after).search(/[\r\n]/);
			const trailing = lineEnd < 0 ? text.slice(after) : text.slice(after, after + lineEnd);
			let definitionEnd = after;
			if (!/^[ \t]*$/.test(trailing)) {
				const originalLineEnd = text.slice(link.after).search(/[\r\n]/);
				const originalTrailing = originalLineEnd < 0 ? text.slice(link.after) : text.slice(link.after, link.after + originalLineEnd);
				if (!titleOnNextLine || !/^[ \t]*$/.test(originalTrailing)) continue;
				definitionEnd = link.after;
			}
			consumed = definitionEnd;
		}
		const { href, start, end } = link;
		found.push({ href, start, end });
	}
	return found;
}

function decodedNumericReference(value) {
	const hexadecimal = value[1].toLowerCase() === "x";
	const codePoint = Number.parseInt(value.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
	if (!Number.isInteger(codePoint) || codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "\uFFFD";
	return String.fromCodePoint(C1_REPLACEMENTS.get(codePoint) ?? codePoint);
}

const DESTINATION_TOKEN = /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])|&#(?:[xX][0-9A-Fa-f]+|[0-9]+);?|&[A-Za-z][A-Za-z0-9]*;?/g;

/** Decode source escapes and complete HTML5 references once, without rescanning output. */
function normalizeDestination(href) {
	let value = "";
	const sourceOffsets = [];
	let offset = 0;
	const append = (text, sourceOffset, copyOffsets = false) => {
		value += text;
		for (let index = 0; index < text.length; index++) sourceOffsets.push(copyOffsets ? sourceOffset + index : sourceOffset);
	};
	for (const match of href.matchAll(DESTINATION_TOKEN)) {
		append(href.slice(offset, match.index), offset, true);
		let replacement = match[1];
		if (replacement === undefined) {
			const token = match[0];
			if (token.startsWith("&#")) {
				const value = token.slice(1).replace(/;$/, "");
				replacement = decodedNumericReference(value);
			} else {
				const terminated = token.endsWith(";");
				const name = token.slice(1, terminated ? -1 : undefined);
				const next = href[match.index + token.length] ?? "";
				const allowed = terminated || !/[=A-Za-z0-9]/.test(next);
				const key = terminated ? `${name};` : name;
				replacement = allowed && Object.hasOwn(HTML5_ENTITIES, key) ? HTML5_ENTITIES[key] : token;
			}
		}
		append(replacement, match.index);
		offset = match.index + match[0].length;
	}
	append(href.slice(offset), offset, true);
	return { value, sourceOffsets };
}

function linkTargetFromDecoded(key, href) {
	const suffixStart = href.search(/[?#]/);
	const path = suffixStart < 0 ? href : href.slice(0, suffixStart);
	if (path === "" || path === "url" || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
	if (/%2f/i.test(path)) throw new Error(key + " links to an encoded path separator: " + href);
	return posix.normalize(posix.join(posix.dirname(key), decodeURIComponent(path)));
}

/**
 * The package-relative path a link points at, or undefined when it is not a relative file link:
 * a URL, an in-page anchor, or a template placeholder such as `[source](url)`.
 */
export function linkTarget(key, href) {
	return linkTargetFromDecoded(key, normalizeDestination(href).value);
}

/** True when a target lies in a part of upstream this package does not ship. */
export function isUnshippedUpstream(target) {
	return UNSHIPPED_UPSTREAM.some((prefix) => target.startsWith(prefix));
}

// A raw suffix may contain a `)` that balanced a `(` in the source pathname. After the pathname
// is percent-encoded, escape suffix parentheses that Markdown would otherwise treat as structure.
function escapeMarkdownParentheses(suffix) {
	let escaped = "";
	let backslashes = 0;
	for (const char of suffix) {
		if ((char === "(" || char === ")") && backslashes % 2 === 0) escaped += "\\";
		escaped += char;
		backslashes = char === "\\" ? backslashes + 1 : 0;
	}
	return escaped;
}

/**
 * Points every link into an unshipped part of upstream at GitHub. The tree keeps pstack's
 * layout, so the path carries over unchanged.
 */
export function relinkUnshipped(key, text, ships) {
	let out = text;
	for (const link of linkDestinations(text).toReversed()) {
		const normalized = normalizeDestination(link.href);
		const href = normalized.value;
		const target = linkTargetFromDecoded(key, href);
		if (target === undefined || ships(target) || !isUnshippedUpstream(target)) continue;
		const suffixStart = href.search(/[?#]/);
		const suffix = suffixStart < 0 ? "" : escapeMarkdownParentheses(link.href.slice(normalized.sourceOffsets[suffixStart]));
		const encoded = target.split("/").map((part) => encodeURIComponent(part).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
		out = out.slice(0, link.start) + `${UPSTREAM_BLOB}/${encoded}${suffix}` + out.slice(link.end);
	}
	return out;
}

/** Every relative link in a page whose target the package does not ship. */
export function danglingLinks(key, text, ships) {
	return linkDestinations(text)
		.filter((link) => {
			const target = linkTarget(key, link.href);
			return target !== undefined && !ships(target);
		})
		.map((link) => link.href);
}
