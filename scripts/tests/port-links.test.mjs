import assert from "node:assert/strict";
import { test } from "node:test";
import { danglingLinks, linkDestinations, linkTarget, relinkUnshipped, UPSTREAM_BLOB } from "../port-links.mjs";

const KEY = "skills/ketchup/SKILL.md";
const shipped = new Set(["skills/bro/SKILL.md", "skills/my skill/SKILL.md"]);
const ships = (target) => shipped.has(target);

test("finds inline links, images, reference definitions and angle-bracket destinations", () => {
	const text = [
		"[a](../bro/SKILL.md)",
		"![img](../bro/pic.png \"title\")",
		"[b](<../my skill/SKILL.md>)",
		"[c][ref]",
		"",
		"[ref]: ../gone/SKILL.md",
		"  [ref2]: <../also gone.md>",
	].join("\n");
	assert.deepEqual(
		linkDestinations(text).map((link) => link.href),
		["../bro/SKILL.md", "../bro/pic.png", "../my skill/SKILL.md", "../gone/SKILL.md", "../also gone.md"],
	);
});

test("reports missing targets in every link form, and only those", () => {
	const text = [
		"[ok](../bro/SKILL.md#step-1)",
		"[ok angle](<../my skill/SKILL.md>)",
		"![missing image](../bro/pic.png)",
		"[url](https://example.com/x.md) [anchor](#top) [placeholder](url)",
		"[ref]: ../gone/SKILL.md",
		"[ref2]: <../also gone.md>",
	].join("\n");
	assert.deepEqual(danglingLinks(KEY, text, ships), ["../bro/pic.png", "../gone/SKILL.md", "../also gone.md"]);
});

test("points unshipped upstream links at GitHub in inline and reference form, keeping the anchor", () => {
	const text = "[pack](../../automations/benny/README.md#setup)\n\n[pack]: ../../automations/benny/README.md\n[kept](../bro/SKILL.md)";
	const out = relinkUnshipped(KEY, text, ships);
	assert.equal(
		out,
		`[pack](${UPSTREAM_BLOB}/automations/benny/README.md#setup)\n\n[pack]: ${UPSTREAM_BLOB}/automations/benny/README.md\n[kept](../bro/SKILL.md)`,
	);
	assert.deepEqual(danglingLinks(KEY, out, ships), []);
});

test("validates extensionless relative files rather than treating them all as placeholders", () => {
	assert.deepEqual(danglingLinks(KEY, "[missing](missing) [template](url)", ships), ["missing"]);
	assert.deepEqual(danglingLinks(KEY, "[exists](README)", (target) => target === "skills/ketchup/README"), []);
});

test("keeps balanced and escaped parentheses inside inline destinations", () => {
	const text = String.raw`[a](../foo(a).md "title") [b](../foo\(a\).md) [c](../deep(a(b)).md)`;
	assert.deepEqual(linkDestinations(text).map((link) => link.href), [
		"../foo(a).md", String.raw`../foo\(a\).md`, "../deep(a(b)).md",
	]);
	assert.deepEqual(danglingLinks(KEY, text, (target) => ["skills/foo(a).md", "skills/deep(a(b)).md"].includes(target)), []);
});

test("rewrites parenthesized upstream paths without consuming titles or following text", () => {
	const text = '[pack](../../automations/demo(a)/README.md#setup "title") after';
	const out = relinkUnshipped(KEY, text, ships);
	assert.equal(out, `[pack](${UPSTREAM_BLOB}/automations/demo%28a%29/README.md#setup "title") after`);
	assert.deepEqual(danglingLinks(KEY, out, ships), []);
});

test("external links are not decoded as local paths, and encoded local paths resolve", () => {
	const text = "[remote](//example.com/a.md) [percent](https://example.com/100%) [local](../my%20skill/SKILL.md)";
	assert.deepEqual(danglingLinks(KEY, text, ships), []);
});

test("does not classify root-relative destinations as package-relative files", () => {
	for (const href of ["/README.md", "&sol;README.md", "//example.com/README.md", "&sol;&sol;example.com/README.md"]) {
		assert.equal(linkTarget(KEY, href), undefined, href);
	}
	assert.deepEqual(danglingLinks(KEY, "[root](/README.md) [entity](&sol;README.md)", () => false), []);
});

test("validates and rewrites inline destinations wrapped across CRLF lines", () => {
	assert.deepEqual(danglingLinks(KEY, "[missing](\r\n../missing.md)", ships), ["../missing.md"]);
	const text = "[pack](\r\n../../automations/demo/README.md#setup)";
	assert.equal(relinkUnshipped(KEY, text, ships), `[pack](\r\n${UPSTREAM_BLOB}/automations/demo/README.md#setup)`);
});

test("link-like text in inline and reference titles is not another destination", () => {
	for (const text of [
		'[ok](../bro/SKILL.md "example ](copy)")',
		"[ok](../bro/SKILL.md 'example ](copy)')",
		'[ok](<../bro/SKILL.md> "example ](copy)")',
		'[ok](../bro/SKILL.md "example\n[ref]: missing\n")',
		String.raw`[ok](../bro/SKILL.md "escaped \" example ](copy)")`,
		'[ref]: ../bro/SKILL.md "example ](copy)"',
		"[ref]: <../bro/SKILL.md> 'example ](copy)'",
		String.raw`[ok](../bro/SKILL.md (example ]\(copy\)))`,
	]) {
		assert.deepEqual(linkDestinations(text).map((link) => link.href), ["../bro/SKILL.md"], text);
		assert.deepEqual(danglingLinks(KEY, text, ships), [], text);
	}
	assert.deepEqual(danglingLinks(KEY, '[bad](../missing.md "example ](copy)")', ships), ["../missing.md"]);
});

test("invalid reference definitions do not suppress real inline links in the title text", () => {
	const text = '[ref]: ../bro/SKILL.md "example [bad](../missing.md)" trailing text';
	assert.deepEqual(linkDestinations(text).map((link) => link.href), ["../missing.md"]);
	assert.deepEqual(danglingLinks(KEY, text, ships), ["../missing.md"]);
});

test("invalid next-line reference titles preserve valid no-title definitions", () => {
	const text = '[x][ref]\n\n[ref]: missing.md\n"title" trailing';
	assert.deepEqual(linkDestinations(text).map((link) => link.href), ["missing.md"]);
	assert.deepEqual(danglingLinks(KEY, text, ships), ["missing.md"]);
});

test("a title cannot hide real links across a blank paragraph", () => {
	for (const newline of ["\n", "\r\n", "\r"]) {
		const text = `[ok](../bro/SKILL.md "title${newline} \t${newline}[bad](missing)${newline}")`;
		assert.deepEqual(danglingLinks(KEY, text, ships), ["missing"], JSON.stringify(newline));
	}
});

test("reference destinations can start on the next line without crossing a blank paragraph", () => {
	for (const newline of ["\n", "\r\n", "\r"]) {
		assert.deepEqual(danglingLinks(KEY, `[ref]:${newline}  ../missing.md`, ships), ["../missing.md"]);
		assert.deepEqual(danglingLinks(KEY, `[ref]:${newline}  ${newline}../missing.md`, ships), []);
		const text = `[ref]:${newline}  <../../automations/demo/README.md> "title"`;
		assert.equal(relinkUnshipped(KEY, text, ships), `[ref]:${newline}  <${UPSTREAM_BLOB}/automations/demo/README.md> "title"`);
	}
});

test("empty angle destinations still consume their opaque titles", () => {
	for (const text of ['[empty](<> "example ](copy)")', '[ref]: <> "example ](copy)"']) {
		assert.deepEqual(danglingLinks(KEY, text, ships), []);
		assert.equal(relinkUnshipped(KEY, text, ships), text);
	}
});

test("Markdown punctuation is unescaped before URI fragments and queries are split", () => {
	const text = String.raw`[file](READ\!ME) [fragment](README\#intro) [query](README\?raw=yes) [percent](READ\%25ME)`;
	const files = new Set(["skills/ketchup/READ!ME", "skills/ketchup/README", "skills/ketchup/READ%ME"]);
	assert.deepEqual(danglingLinks(KEY, text, (target) => files.has(target)), []);
});

test("encoded separators cannot certify a different sibling path", () => {
	for (const href of ["..%2Fbro%2FSKILL.md", "..%2fbro%2fSKILL.md"]) {
		assert.throws(() => danglingLinks(KEY, `[x](${href})`, ships), /encoded.*separator/i);
	}
	assert.deepEqual(danglingLinks(KEY, "[literal](a%252Fb.md)", (target) => target === "skills/ketchup/a%2Fb.md"), []);
});

test("decodes complete HTML5 references in destinations before path and suffix parsing", () => {
	const files = new Set([
		"skills/ketchup/READ&ME",
		"skills/ketchup/a&b.md",
		"skills/ketchup/READ©ME",
		"skills/ketchup/A≂̸B",
	]);
	const text = "[named](READ&amp;ME) [numeric](a&#38;b.md) [rare](READ&copy;ME) [HTML5](A&NotEqualTilde;B)";
	assert.deepEqual(danglingLinks(KEY, text, (target) => files.has(target)), []);
	assert.deepEqual(danglingLinks(KEY, "[unknown](READ&notARealEntity;ME)", () => false), ["READ&notARealEntity;ME"]);
	for (const name of ["constructor", "toString", "__proto__"]) {
		for (const href of [`READ&${name};ME`, `READ&${name}/ME`]) {
			assert.deepEqual(danglingLinks(KEY, `[unknown](${href})`, (target) => target === `skills/ketchup/${href}`), []);
		}
	}
});

test("decodes source escapes and HTML references once without reprocessing generated punctuation", () => {
	const files = new Set(["skills/ketchup/READ&amp;ME", "skills/ketchup/A\\!B", "skills/ketchup/READ\\&ME"]);
	const text = String.raw`[escaped](READ\&amp;ME) [entity](A&bsol;&excl;B) [doubled](READ\\&amp;ME)`;
	assert.deepEqual(danglingLinks(KEY, text, (target) => files.has(target)), []);
});

test("decodes entity-produced fragment and query separators before rewriting", () => {
	const text = "[fragment](../../automations/demo.md&#35;setup) [query](../../automations/demo.md&#63;raw=1)";
	assert.equal(
		relinkUnshipped(KEY, text, ships),
		`[fragment](${UPSTREAM_BLOB}/automations/demo.md&#35;setup) [query](${UPSTREAM_BLOB}/automations/demo.md&#63;raw=1)`,
	);
});

test("rewrites preserve raw suffix entities without breaking Markdown destination boundaries", () => {
	const text = "[paren](../../automations/demo.md?x=&rpar;) [again](../../automations/demo.md?x=&amp;copy;) [space](../../automations/demo.md?x=&Tab;&lt;)";
	const expected = `[paren](${UPSTREAM_BLOB}/automations/demo.md?x=&rpar;) [again](${UPSTREAM_BLOB}/automations/demo.md?x=&amp;copy;) [space](${UPSTREAM_BLOB}/automations/demo.md?x=&Tab;&lt;)`;
	assert.equal(relinkUnshipped(KEY, text, ships), expected);
	assert.equal(relinkUnshipped(KEY, expected, ships), expected);
});

test("preserves closing parentheses across a path-query boundary when relinking", () => {
	const text = "[pack](../../automations/demo(a?x=b))";
	const out = relinkUnshipped(KEY, text, ships);
	assert.equal(out, `[pack](${UPSTREAM_BLOB}/automations/demo%28a?x=b\\))`);
	assert.deepEqual(linkDestinations(out).map((link) => link.href), [`${UPSTREAM_BLOB}/automations/demo%28a?x=b\\)`]);
});

test("splits query and fragment after references introduce line terminators", () => {
	for (const entity of ["&NewLine;", "&#10;", "&#13;", "&#x2028;", "&#x2029;"]) {
		assert.equal(linkTarget(KEY, `README?x=${entity}y`), "skills/ketchup/README", entity);
		assert.equal(linkTarget(KEY, `README#${entity}y`), "skills/ketchup/README", entity);
	}
});

test("HTML5 numeric references accept full digit sequences and replace out-of-range values", () => {
	assert.equal(linkTarget(KEY, "a&#00000065;b"), "skills/ketchup/aAb");
	assert.equal(linkTarget(KEY, "a&#65b"), "skills/ketchup/aAb");
	assert.equal(linkTarget(KEY, "a&#x0000041;b"), "skills/ketchup/aAb");
	assert.equal(linkTarget(KEY, "a&#x41;b"), "skills/ketchup/aAb");
	assert.equal(linkTarget(KEY, "a&#999999999999999999999999999999;b"), "skills/ketchup/a�b");
});

test("normalizes numeric HTML references that do not name valid Unicode scalar values", () => {
	const files = new Set(["skills/ketchup/a€b", "skills/ketchup/a�b"]);
	const text = "[c1](a&#x80;b) [zero](a&#0;b) [surrogate](a&#xD800;b) [large](a&#1114112;b)";
	assert.deepEqual(danglingLinks(KEY, text, (target) => files.has(target)), []);
});

test("decodes named references once and follows HTML attribute ambiguity rules", () => {
	const files = new Set([
		"skills/ketchup/a&amp;b",
		"skills/ketchup/READ©/ME",
		"skills/ketchup/READ&copyME",
	]);
	const text = "[once](a&amp;amp;b) [legacy](READ&copy/ME) [ambiguous](READ&copyME)";
	assert.deepEqual(danglingLinks(KEY, text, (target) => files.has(target)), []);
});

test("leaves a missing link outside unshipped upstream for the gate to fail", () => {
	const text = "[typo](../brro/SKILL.md)";
	assert.equal(relinkUnshipped(KEY, text, ships), text);
	assert.deepEqual(danglingLinks(KEY, text, ships), ["../brro/SKILL.md"]);
});
