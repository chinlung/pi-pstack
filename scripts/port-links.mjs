/**
 * Link handling for the skill port: finding every relative link in a Markdown page, pointing
 * links into unshipped parts of upstream at GitHub, and reporting links that point nowhere.
 *
 * These are pure functions of the page text and a `ships(target)` predicate, so the port script
 * and its tests share one implementation.
 */
import { posix } from "node:path";

export const UPSTREAM_BLOB = "https://github.com/cursor/plugins/blob/main/pstack";

/**
 * The parts of upstream pstack this package does not ship, which a ported page may still link
 * to. A link into one of them points at GitHub. A link to any other missing path is a typo or a
 * moved file and fails the port, because rewriting it would hand the reader a dead GitHub URL.
 */
export const UNSHIPPED_UPSTREAM = ["automations/"];

/**
 * Every link destination in a page, with its position. Covers inline links and images,
 * `[text](dest "title")` and `[text](<dest with spaces>)`, and reference definitions,
 * `[label]: dest` and `[label]: <dest>`. Code spans are not excluded: pstack pages put real
 * links in prose, and a false hit in a code span can only fail the check, never pass a bad link.
 */
export function linkDestinations(text) {
	const found = [];
	const inline = /\]\(\s*(?:<([^>\n]*)>|([^)\s]+))/g;
	for (const match of text.matchAll(inline)) {
		const angle = match[1] !== undefined;
		const href = angle ? match[1] : match[2];
		const start = match.index + match[0].length - href.length - (angle ? 1 : 0);
		found.push({ href, start, end: start + href.length, angle });
	}
	const reference = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;
	for (const match of text.matchAll(reference)) {
		const angle = match[1] !== undefined;
		const href = angle ? match[1] : match[2];
		const start = match.index + match[0].length - href.length - (angle ? 1 : 0);
		found.push({ href, start, end: start + href.length, angle });
	}
	return found.sort((a, b) => a.start - b.start);
}

/**
 * The package-relative path a link points at, or undefined when it is not a relative file link:
 * a URL, an in-page anchor, or a template placeholder such as `[source](url)`.
 */
export function linkTarget(key, href) {
	const path = decodeURI(href.replace(/[#?].*$/, ""));
	if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path) || (!path.includes("/") && !path.includes("."))) return undefined;
	return posix.normalize(posix.join(posix.dirname(key), path));
}

/** True when a target lies in a part of upstream this package does not ship. */
export function isUnshippedUpstream(target) {
	return UNSHIPPED_UPSTREAM.some((prefix) => target.startsWith(prefix));
}

/**
 * Points every link into an unshipped part of upstream at GitHub. The tree keeps pstack's
 * layout, so the path carries over unchanged.
 */
export function relinkUnshipped(key, text, ships) {
	let out = text;
	for (const link of linkDestinations(text).reverse()) {
		const target = linkTarget(key, link.href);
		if (target === undefined || ships(target) || !isUnshippedUpstream(target)) continue;
		const suffix = link.href.slice(link.href.search(/[#?]|$/));
		out = out.slice(0, link.start) + `${UPSTREAM_BLOB}/${target}${suffix}` + out.slice(link.end);
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
