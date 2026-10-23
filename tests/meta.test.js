import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeadManager } from "../src/head.js";
import {
	mergeMeta,
	normalizeMeta,
	resolveMeta,
	resolveNormalizedMeta,
} from "../src/meta.js";

describe("mergeMeta", () => {
	it("inherits omitted keys from the parent", () => {
		const result = mergeMeta(
			{ title: "Parent", description: "Parent description" },
			{ title: "Child" },
		);

		expect(result.title).toBe("Child");
		expect(result.description).toBe("Parent description");
	});

	it("clears a field when the child sets null", () => {
		const result = mergeMeta(
			{ title: "Parent", description: "Keep me" },
			{ title: null },
		);

		expect(result.title).toBeNull();
		expect(result.description).toBe("Keep me");
	});

	it("shallow-merges openGraph and twitter sections", () => {
		const result = mergeMeta(
			{
				openGraph: {
					type: "website",
					title: "Parent OG",
					siteName: "Udodi",
				},
				twitter: { card: "summary", site: "@parent" },
			},
			{
				openGraph: { title: "Child OG" },
				twitter: { site: "@child" },
			},
		);

		expect(result.openGraph).toEqual({
			type: "website",
			title: "Child OG",
			siteName: "Udodi",
		});
		expect(result.twitter).toEqual({
			card: "summary",
			site: "@child",
		});
	});

	it("clears a merged section when the child sets null", () => {
		const result = mergeMeta(
			{ openGraph: { title: "Parent" } },
			{ openGraph: null },
		);

		expect(result.openGraph).toBeNull();
	});

	it("concatenates structuredData and scripts arrays", () => {
		const result = mergeMeta(
			{
				structuredData: { "@type": "Organization", name: "A" },
				scripts: [{ src: "/a.js", once: true }],
			},
			{
				structuredData: [{ "@type": "WebPage", name: "B" }],
				scripts: [{ src: "/b.js" }],
			},
		);

		expect(result.structuredData).toEqual([
			{ "@type": "Organization", name: "A" },
			{ "@type": "WebPage", name: "B" },
		]);
		expect(result.scripts).toEqual([
			{ src: "/a.js", once: true },
			{ src: "/b.js" },
		]);
	});

	it("does not mutate the parent or child objects", () => {
		const parent = { title: "Parent", openGraph: { title: "P" } };
		const child = { title: "Child", openGraph: { title: "C" } };
		const parentSnapshot = structuredClone(parent);
		const childSnapshot = structuredClone(child);

		mergeMeta(parent, child);

		expect(parent).toEqual(parentSnapshot);
		expect(child).toEqual(childSnapshot);
	});
});

describe("resolveMeta", () => {
	it("resolves static meta along the parent chain only", async () => {
		const resolved = await resolveMeta({
			defaults: { title: "App", author: "Udodi" },
			matched: [
				{ path: "/", meta: { title: "Layout" } },
				{ path: "/posts", meta: { description: "Posts" } },
			],
		});

		expect(resolved.title).toBe("Layout");
		expect(resolved.description).toBe("Posts");
		expect(resolved.author).toBe("Udodi");
	});

	it("awaits async meta functions with per-route loader data", async () => {
		const resolved = await resolveMeta({
			matched: [
				{
					record: {
						path: "/posts/:id",
						meta: async ({ params, data }) => ({
							title: data.title,
							canonical: `https://udodi.dev/posts/${params.id}`,
						}),
					},
					params: { id: "42" },
					data: { title: "Hello" },
				},
			],
		});

		expect(resolved.title).toBe("Hello");
		expect(resolved.canonical).toBe("https://udodi.dev/posts/42");
	});

	it("does not inherit metadata from a previously committed page", async () => {
		// Simulate only the new matched chain — previous page meta is absent.
		const previousPageMeta = {
			title: "Old page",
			openGraph: { image: { url: "https://example.com/old.png" } },
		};

		void previousPageMeta;

		const resolved = await resolveMeta({
			matched: [
				{
					path: "/about",
					meta: { title: "About" },
				},
			],
		});

		expect(resolved.title).toBe("About");
		expect(resolved.openGraph).toBeUndefined();
	});

	it("supports defaults as an async function", async () => {
		const resolved = await resolveMeta({
			defaults: async () => ({ title: "Default Title" }),
			matched: [],
		});

		expect(resolved.title).toBe("Default Title");
	});
});

describe("normalizeMeta", () => {
	it("normalizes title, description, keywords, and author", () => {
		const normalized = normalizeMeta({
			title: "Udodi",
			description: "A reactive framework",
			keywords: ["javascript", "ui"],
			author: "Udodi",
		});

		expect(normalized.title).toBe("Udodi");
		expect(normalized.description).toBe("A reactive framework");
		expect(normalized.keywords).toBe("javascript, ui");
		expect(normalized.author).toBe("Udodi");
		expect(normalized.metaTags).toEqual(
			expect.arrayContaining([
				{ name: "description", content: "A reactive framework" },
				{ name: "keywords", content: "javascript, ui" },
				{ name: "author", content: "Udodi" },
			]),
		);
	});

	it("accepts image as a string or object", () => {
		const fromString = normalizeMeta({
			openGraph: { image: "https://udodi.dev/og.png" },
		});
		const fromObject = normalizeMeta({
			openGraph: {
				image: {
					url: "https://udodi.dev/og.png",
					width: 400,
					height: 400,
					alt: "Logo",
				},
			},
		});

		expect(
			fromString.metaTags.find((tag) => tag.property === "og:image")
				?.content,
		).toBe("https://udodi.dev/og.png");

		expect(
			fromObject.metaTags.find((tag) => tag.property === "og:image")
				?.content,
		).toBe("https://udodi.dev/og.png");
		expect(
			fromObject.metaTags.find(
				(tag) => tag.property === "og:image:width",
			)?.content,
		).toBe("400");
		expect(
			fromObject.metaTags.find((tag) => tag.property === "og:image:alt")
				?.content,
		).toBe("Logo");
	});

	it("builds openGraph and twitter tags with title/description fallbacks", () => {
		const normalized = normalizeMeta({
			title: "Fallback title",
			description: "Fallback description",
			canonical: "https://udodi.dev/",
			openGraph: { type: "website", siteName: "Udodi" },
			twitter: { card: "summary", site: "@udodi_js" },
		});

		expect(
			normalized.metaTags.find((tag) => tag.property === "og:title")
				?.content,
		).toBe("Fallback title");
		expect(
			normalized.metaTags.find(
				(tag) => tag.property === "og:description",
			)?.content,
		).toBe("Fallback description");
		expect(
			normalized.metaTags.find((tag) => tag.property === "og:url")
				?.content,
		).toBe("https://udodi.dev/");
		expect(
			normalized.metaTags.find((tag) => tag.name === "twitter:title")
				?.content,
		).toBe("Fallback title");
		expect(
			normalized.metaTags.find((tag) => tag.name === "twitter:card")
				?.content,
		).toBe("summary");
	});

	it("emits canonical and icon links", () => {
		const normalized = normalizeMeta({
			canonical: "https://udodi.dev/posts/1",
			icon: { href: "/favicon.svg", type: "image/svg+xml" },
		});

		expect(normalized.links).toEqual(
			expect.arrayContaining([
				{ rel: "canonical", href: "https://udodi.dev/posts/1" },
				{
					rel: "icon",
					href: "/favicon.svg",
					type: "image/svg+xml",
				},
			]),
		);
	});

	it("normalizes structuredData to a deduped array", () => {
		const entity = {
			"@type": "Organization",
			"@id": "https://udodi.dev/#org",
			name: "Udodi",
		};

		const normalized = normalizeMeta({
			structuredData: [entity, entity],
		});

		expect(normalized.jsonLd).toHaveLength(1);
		expect(normalized.jsonLd[0]).toEqual(entity);
	});

	it("normalizes scripts and rejects invalid descriptors", () => {
		const normalized = normalizeMeta({
			scripts: [
				{ src: "https://example.com/a.js", async: true, once: true },
				{ content: "console.log(1)", type: "text/javascript" },
				{ src: "/both.js", content: "nope" },
				{ async: true },
			],
		});

		expect(normalized.scripts).toEqual([
			{
				src: "https://example.com/a.js",
				async: true,
				once: true,
			},
			{
				content: "console.log(1)",
				type: "text/javascript",
			},
		]);
	});

	it("merges custom meta and links into the normalized shape", () => {
		const normalized = normalizeMeta({
			custom: {
				meta: [
					{ name: "theme-color", content: "#ffffff" },
					{ property: "article:author", content: "Udodi" },
				],
				links: [
					{
						rel: "alternate",
						type: "application/rss+xml",
						href: "/feed.xml",
						title: "RSS",
					},
				],
			},
		});

		expect(normalized.metaTags).toEqual(
			expect.arrayContaining([
				{ name: "theme-color", content: "#ffffff" },
				{ property: "article:author", content: "Udodi" },
			]),
		);
		expect(normalized.links).toEqual(
			expect.arrayContaining([
				{
					rel: "alternate",
					type: "application/rss+xml",
					href: "/feed.xml",
					title: "RSS",
				},
			]),
		);
	});

	it("deduplicates managed meta tags by name or property", () => {
		const normalized = normalizeMeta({
			description: "First",
			custom: {
				meta: [{ name: "description", content: "Second" }],
			},
		});

		const descriptions = normalized.metaTags.filter(
			(tag) => tag.name === "description",
		);

		expect(descriptions).toHaveLength(1);
		// Semantic tags are emitted before custom; uniqueBy keeps the first.
		expect(descriptions[0].content).toBe("First");
	});
});

describe("resolveNormalizedMeta", () => {
	it("resolves inheritance and normalizes in one call", async () => {
		const result = await resolveNormalizedMeta({
			defaults: { title: "App" },
			matched: [
				{
					record: {
						path: "/about",
						meta: ({ data }) => ({
							title: data?.title ?? "About",
							description: "About Udodi",
						}),
					},
					data: { title: "About Udodi" },
				},
			],
		});

		expect(result.title).toBe("About Udodi");
		expect(result.description).toBe("About Udodi");
		expect(
			result.metaTags.find((tag) => tag.name === "description")?.content,
		).toBe("About Udodi");
	});
});


/**
 * @returns {Document}
 */
function getDocument() {
	return globalThis.document;
}

/**
 * @param {string} selector
 * @returns {Element[]}
 */
function headQueryAll(selector) {
	return Array.from(getDocument().head.querySelectorAll(selector));
}

describe("createHeadManager", () => {
	/** @type {ReturnType<typeof createHeadManager>} */
	let head;
	/** @type {string} */
	let originalTitle;

	beforeEach(() => {
		const doc = getDocument();

		originalTitle = doc.title;
		doc.title = "";
		doc.head.innerHTML = "";

		// Drop any leftover registry entries by using a fresh manager only;
		// WeakMap keys are document instances, so clear head is enough for DOM.
		head = createHeadManager({ document: doc, window: globalThis.window });
	});

	afterEach(() => {
		head.destroy();
		getDocument().title = originalTitle;
		getDocument().head.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("returns a noop manager when document.head is unavailable", () => {
		const noop = createHeadManager({
			document: /** @type {Document} */ ({}),
		});

		expect(() => noop.apply(normalizeMeta({ title: "X" }))).not.toThrow();
		expect(() => noop.destroy()).not.toThrow();
	});

	it("applies document title", () => {
		head.apply(normalizeMeta({ title: "Udodi Router" }));

		const titleElements = headQueryAll("title");

		expect(titleElements).toHaveLength(1);
		expect(titleElements[0].textContent).toBe("Udodi Router");
		expect(titleElements[0].getAttribute("data-udodi-head")).toBeTruthy();
	});

	it("applies meta tags and updates them without duplicating", () => {
		head.apply(
			normalizeMeta({
				description: "First",
				author: "Udodi",
			}),
		);

		expect(
			headQueryAll('meta[name="description"]')[0].getAttribute("content"),
		).toBe("First");

		head.apply(
			normalizeMeta({
				description: "Second",
				author: "Udodi",
			}),
		);

		expect(headQueryAll('meta[name="description"]')).toHaveLength(1);
		expect(
			headQueryAll('meta[name="description"]')[0].getAttribute("content"),
		).toBe("Second");
	});

	it("applies canonical and icon links as singletons", () => {
		head.apply(
			normalizeMeta({
				canonical: "https://udodi.dev/a",
				icon: "/favicon.svg",
			}),
		);

		expect(headQueryAll('link[rel="canonical"]')).toHaveLength(1);
		expect(
			headQueryAll('link[rel="canonical"]')[0].getAttribute("href"),
		).toBe("https://udodi.dev/a");

		head.apply(
			normalizeMeta({
				canonical: "https://udodi.dev/b",
				icon: "/favicon.svg",
			}),
		);

		expect(headQueryAll('link[rel="canonical"]')).toHaveLength(1);
		expect(
			headQueryAll('link[rel="canonical"]')[0].getAttribute("href"),
		).toBe("https://udodi.dev/b");
	});

	it("removes managed elements that are no longer present", () => {
		head.apply(
			normalizeMeta({
				title: "With description",
				description: "Temporary",
			}),
		);

		expect(headQueryAll('meta[name="description"]')).toHaveLength(1);

		head.apply(normalizeMeta({ title: "Without description" }));

		expect(headQueryAll('meta[name="description"]')).toHaveLength(0);
		expect(headQueryAll("title")[0].textContent).toBe("Without description");
	});

	it("restores adopted pre-existing elements instead of deleting them", () => {
		const doc = getDocument();
		const existing = doc.createElement("meta");

		existing.setAttribute("name", "description");
		existing.setAttribute("content", "Original");
		doc.head.appendChild(existing);

		head.apply(normalizeMeta({ description: "Managed" }));

		expect(existing.getAttribute("content")).toBe("Managed");
		expect(existing.getAttribute("data-udodi-head")).toBeTruthy();

		head.apply(normalizeMeta({ title: "Only title" }));

		expect(existing.getAttribute("content")).toBe("Original");
		expect(existing.hasAttribute("data-udodi-head")).toBe(false);
	});

	it("applies JSON-LD structured data", () => {
		const entity = {
			"@context": "https://schema.org",
			"@type": "Organization",
			name: "Udodi",
		};

		head.apply(normalizeMeta({ structuredData: entity }));

		const scripts = headQueryAll('script[type="application/ld+json"]');

		expect(scripts).toHaveLength(1);
		expect(JSON.parse(scripts[0].textContent || "")).toEqual(entity);
	});

	it("installs once scripts only a single time per identity", () => {
		// Use an inline script so happy-dom does not attempt a network load.
		const meta = normalizeMeta({
			scripts: [
				{
					key: "analytics-bootstrap",
					content: "window.__udodiAnalytics = true;",
					once: true,
				},
			],
		});

		head.apply(meta, { routeKey: "/a" });
		head.apply(meta, { routeKey: "/b" });

		const scripts = headQueryAll("script[data-udodi-script]");

		expect(scripts).toHaveLength(1);
		expect(scripts[0].textContent).toContain("__udodiAnalytics");
	});

	it("re-installs scripts when once is false for the same route identity", () => {
		const meta = normalizeMeta({
			scripts: [
				{
					content: "window.__udodiScriptRuns = (window.__udodiScriptRuns || 0) + 1;",
					once: false,
					key: "route-widget",
				},
			],
		});

		head.apply(meta, { routeKey: "/widget" });
		const first = headQueryAll("script[data-udodi-script]")[0];

		head.apply(meta, { routeKey: "/widget" });
		const scripts = headQueryAll("script[data-udodi-script]");

		expect(scripts).toHaveLength(1);
		expect(scripts[0]).not.toBe(first);
		expect(scripts[0].textContent).toContain("__udodiScriptRuns");
	});

	it("requires routeKey when once is false", () => {
		const meta = normalizeMeta({
			scripts: [{ content: "void 0;", once: false }],
		});

		expect(() => head.apply(meta)).toThrow(/routeKey/i);
	});

	it("reports a gtag page_view when available", () => {
		const gtag = vi.fn();

		// @ts-expect-error test double
		globalThis.window.gtag = gtag;

		head.apply(normalizeMeta({ title: "Posts" }), {
			url: "https://udodi.dev/posts",
			trackPageView: true,
		});

		expect(gtag).toHaveBeenCalledWith(
			"event",
			"page_view",
			expect.objectContaining({
				page_title: "Posts",
				page_path: "/posts",
			}),
		);

		// @ts-expect-error cleanup
		delete globalThis.window.gtag;
	});

	it("skips page_view when analytics.pageView is false", () => {
		const gtag = vi.fn();

		// @ts-expect-error test double
		globalThis.window.gtag = gtag;

		head.apply(
			normalizeMeta({
				title: "Private",
				analytics: { pageView: false },
			}),
			{ url: "https://udodi.dev/private" },
		);

		expect(gtag).not.toHaveBeenCalled();

		// @ts-expect-error cleanup
		delete globalThis.window.gtag;
	});

	it("destroy restores adopted elements and removes created ones", () => {
		const doc = getDocument();
		const existing = doc.createElement("meta");

		existing.setAttribute("name", "author");
		existing.setAttribute("content", "Seed");
		doc.head.appendChild(existing);

		head.apply(
			normalizeMeta({
				title: "Managed title",
				author: "Managed author",
				description: "Created by manager",
			}),
		);

		head.destroy();

		expect(existing.getAttribute("content")).toBe("Seed");
		expect(existing.hasAttribute("data-udodi-head")).toBe(false);
		expect(headQueryAll('meta[name="description"]')).toHaveLength(0);
	});
});
