/**
 * @fileoverview Server entry for Udodi Router.
 *
 * Pure pathname matching and document-metadata helpers for SEO pipelines.
 * This module must not import browser-only code (history, navigation, head DOM).
 *
 * @module server
 */

import { createMatcher, matchRoutes } from "./matcher.js";
import { normalizeMeta, resolveMeta } from "./meta.js";

export { createMatcher, matchRoutes };

/**
 * @typedef {import("./matcher.js").RouteRecord} RouteRecord
 * @typedef {import("./matcher.js").MatchResult} MatchResult
 */

/**
 * Escape text for HTML body / text nodes.
 *
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 *
 * `&quot;` is the correct encoding: the HTML parser treats it as data inside
 * the attribute, not as a delimiter. A raw `"` would end the attribute.
 *
 * @param {*} value
 * @returns {string}
 */
function escapeAttr(value) {
	return escapeHtml(value);
}

/**
 * Encode JSON text embedded in `<script type="application/ld+json">`.
 * Prevents `</script>` breakout; extra escapes are defensive only.
 *
 * @param {string} jsonString
 * @returns {string}
 */
function escapeJsonLd(jsonString) {
	return String(jsonString)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/**
 * Shallow-copy a params object onto a null prototype.
 *
 * @param {Object<string, string>|null|undefined} params
 * @returns {Object<string, string>}
 */
function copyParams(params) {
	const result = Object.create(null);

	if (params && typeof params === "object") {
		for (const key of Object.keys(params)) {
			result[key] = params[key];
		}
	}

	return result;
}

/**
 * Normalize matched input into `{ record, params, data, context? }` wrappers.
 *
 * @param {Array<Object>} matched
 * @param {Object<string, string>} [params]
 * @param {Map<RouteRecord, *>|Object<string, *>|null} [loaderData]
 * @returns {Array<Object>}
 */
function wrapMatched(matched, params = Object.create(null), loaderData = null) {
	if (!Array.isArray(matched)) {
		return [];
	}

	const safeParams = copyParams(params);

	return matched.map((entry) => {
		if (entry && typeof entry === "object" && "record" in entry) {
			return {
				record: entry.record,
				params: entry.params != null ? copyParams(entry.params) : safeParams,
				data: "data" in entry ? entry.data : null,
				context: entry.context,
			};
		}

		let data = null;

		if (loaderData instanceof Map) {
			data = loaderData.has(entry) ? loaderData.get(entry) : null;
		} else if (loaderData && typeof loaderData === "object") {
			data = loaderData[entry.path] ?? null;
		}

		return {
			record: entry,
			params: safeParams,
			data,
		};
	});
}

/**
 * Resolve semantic route metadata for a matched chain (server public API).
 *
 * Same inheritance rules as the client: parent → child, omit inherits, null clears.
 * Does not touch the DOM.
 *
 * @param {Object} [options]
 * @param {Array<Object>} [options.matched] Route records or `{ record, params, data }` wrappers
 * @param {Object<string, string>} [options.params]
 * @param {Map<RouteRecord, *>|Object|null} [options.loaderData]
 * @param {Object|Function} [options.defaults] Router-level meta defaults
 * @param {Object} [options.context] Extra context passed to meta functions
 * @returns {Promise<Object>} Semantic metadata object (not yet normalized for HTML)
 */
export async function resolveMetadata({
	matched = [],
	params = Object.create(null),
	loaderData = null,
	defaults = Object.create(null),
	context = Object.create(null),
} = {}) {
	const wrapped = wrapMatched(matched, params, loaderData);

	return resolveMeta({
		defaults,
		matched: wrapped,
		context: {
			...context,
			params,
		},
	});
}

/**
 * Render resolved semantic metadata to an HTML string for a document shell.
 *
 * Values are escaped. Scripts from meta are emitted as tags when present;
 * the server does not execute them.
 *
 * @param {Object|null|undefined} metadata Result of {@link resolveMetadata} (semantic)
 *   or already-normalized meta from normalizeMeta
 * @param {Object} [options]
 * @param {boolean} [options.normalize=true] Run normalizeMeta when true
 * @param {boolean} [options.includeScripts=false] Emit script tags from meta.scripts
 * @returns {string}
 */
export function renderMetadata(metadata, options = {}) {
	if (metadata == null) {
		return "";
	}

	const normalize = options.normalize !== false;
	const includeScripts = options.includeScripts === true;

	const normalized = normalize ? normalizeMeta(metadata) : metadata;
	/** @type {string[]} */
	const parts = [];

	if (typeof normalized.title === "string" && normalized.title) {
		parts.push(`<title>${escapeHtml(normalized.title)}</title>`);
	}

	for (const tag of normalized.metaTags || []) {
		if (!tag || tag.content == null) {
			continue;
		}

		/** @type {string[]} */
		const attrs = [];

		if (tag.name != null) {
			attrs.push(`name="${escapeAttr(tag.name)}"`);
		}

		if (tag.property != null) {
			attrs.push(`property="${escapeAttr(tag.property)}"`);
		}

		if (tag.httpEquiv != null) {
			attrs.push(`http-equiv="${escapeAttr(tag.httpEquiv)}"`);
		}

		attrs.push(`content="${escapeAttr(tag.content)}"`);
		parts.push(`<meta ${attrs.join(" ")}>`);
	}

	for (const link of normalized.links || []) {
		if (!link?.rel || !link.href) {
			continue;
		}

		/** @type {string[]} */
		const attrs = [
			`rel="${escapeAttr(link.rel)}"`,
			`href="${escapeAttr(link.href)}"`,
		];

		for (const key of [
			"type",
			"sizes",
			"media",
			"hreflang",
			"title",
			"crossOrigin",
			"integrity",
			"referrerPolicy",
		]) {
			const attrName = key === "crossOrigin"
				? "crossorigin"
				: key === "referrerPolicy"
					? "referrerpolicy"
					: key;

			if (link[key] != null && link[key] !== "") {
				attrs.push(`${attrName}="${escapeAttr(link[key])}"`);
			}
		}

		parts.push(`<link ${attrs.join(" ")}>`);
	}

	for (const entry of normalized.jsonLd || []) {
		if (entry == null) {
			continue;
		}

		const json = typeof entry === "string" ? entry : JSON.stringify(entry);

		parts.push(
			`<script type="application/ld+json">${escapeJsonLd(json)}</script>`,
		);
	}

	if (includeScripts) {
		for (const script of normalized.scripts || []) {
			if (!script) {
				continue;
			}

			/** @type {string[]} */
			const attrs = [];

			if (script.type) {
				attrs.push(`type="${escapeAttr(script.type)}"`);
			}

			if (script.src) {
				attrs.push(`src="${escapeAttr(script.src)}"`);

				if (script.async) {
					attrs.push("async");
				}

				if (script.defer) {
					attrs.push("defer");
				}

				if (script.crossOrigin) {
					attrs.push(
						`crossorigin="${escapeAttr(script.crossOrigin)}"`,
					);
				}

				if (script.integrity) {
					attrs.push(
						`integrity="${escapeAttr(script.integrity)}"`,
					);
				}

				parts.push(`<script ${attrs.join(" ")}></script>`);

			} else if (typeof script.content === "string") {
				// Escape "<" to prevent `</script>` breakout. 
                // (Escaping all "<" is simpler and sufficient inside a script element.)
                const safe = script.content
                    .replace(/</g, "\\u003c")
                    .replace(/\u2028/g, "\\u2028")
                    .replace(/\u2029/g, "\\u2029");

				parts.push(
					attrs.length
						? `<script ${attrs.join(" ")}>${safe}</script>`
						: `<script>${safe}</script>`,
				);
			}
		}
	}

	return parts.join("\n");
}

/**
 * Run loaders for each matched route record (parent → child).
 *
 * @param {RouteRecord[]} matched
 * @param {Object<string, string>} params
 * @param {Object} [options]
 * @param {Object<string, string>} [options.query]
 * @param {Object} [options.context]
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<Map<RouteRecord, *>>}
 */
async function runServerLoaders(matched, params, options = {}) {
	/** @type {Map<RouteRecord, *>} */
	const results = new Map();
	const query = options.query || Object.create(null);
	const context = options.context || Object.create(null);
	const signal = options.signal || null;

	for (const record of matched) {
		if (signal?.aborted) {
			const error = signal.reason instanceof Error
				? signal.reason
				: new DOMException("Loaders aborted.", "AbortError");
			throw error;
		}

		if (typeof record.loader !== "function") {
			results.set(record, null);
			continue;
		}

		const data = await record.loader({
			params,
			query,
			signal,
			context,
		});

		results.set(record, data);
	}

	return results;
}

/**
 * One-shot server helper: match → loaders → resolve metadata → render HTML.
 *
 * Lower-level exports remain available for custom pipelines.
 *
 * @param {Object} options
 * @param {RouteRecord[]} options.routes
 * @param {string} options.pathname Pathname only (no query/hash)
 * @param {string} [options.base] Deployment base path
 * @param {Object|Function} [options.defaults] Meta defaults
 * @param {Object} [options.context]
 * @param {Object<string, string>} [options.query]
 * @param {AbortSignal|null} [options.signal]
 * @param {boolean} [options.runLoaders=true]
 * @param {Map<RouteRecord, *>|null} [options.loaderData] Used when runLoaders is false
 * @param {boolean} [options.includeScripts=false] Pass through to renderMetadata
 * @returns {Promise<{
 *   match: MatchResult|null,
 *   metadata: Object|null,
 *   head: string,
 *   loaderData: Map<RouteRecord, *>
 * }>}
 */
export async function resolveHead({
	routes,
	pathname,
	base = "",
	defaults = Object.create(null),
	context = Object.create(null),
	query = Object.create(null),
	signal = null,
	runLoaders = true,
	loaderData = null,
	includeScripts = false,
} = {}) {
	if (!Array.isArray(routes)) {
		throw new TypeError("[udodi-router/server] routes must be an array.");
	}

	if (typeof pathname !== "string") {
		throw new TypeError(
			"[udodi-router/server] pathname must be a string.",
		);
	}

	const match = matchRoutes(routes, pathname, { base });

	/** @type {Map<RouteRecord, *>} */
	let dataMap = loaderData instanceof Map ? loaderData : new Map();

	if (!match) {
		return {
			match: null,
			metadata: null,
			head: "",
			loaderData: dataMap,
		};
	}

	if (runLoaders) {
		dataMap = await runServerLoaders(match.matched, match.params, {
			query,
			context,
			signal,
		});
	}

	const metadata = await resolveMetadata({
		matched: match.matched,
		params: match.params,
		loaderData: dataMap,
		defaults,
		context,
	});

	const head = renderMetadata(metadata, { includeScripts });

	return {
		match,
		metadata,
		head,
		loaderData: dataMap,
	};
}
