/**
 * Route metadata resolution and normalization.
 *
 * This module is DOM-independent: it never reads `document`, creates elements,
 * loads scripts, or executes JavaScript.
 *
 * @module meta
 */

/**
 * @typedef {Object} RouteMeta
 * @property {string|null} [title]
 * @property {string|null} [description]
 * @property {string|string[]|null} [keywords]
 * @property {string|null} [author]
 * @property {string|null} [canonical]
 * @property {string|Object|Array<string|Object>|null} [icon]
 * @property {Object|null} [openGraph]
 * @property {Object|null} [twitter]
 * @property {Object|Object[]|null} [structuredData]
 * @property {Object|null} [custom]
 * @property {Object|Object[]} [scripts]
 * @property {Object|null} [analytics]
 */

const MERGED_SECTIONS = ["openGraph", "twitter", "analytics"];

function hasOwn(object, key) {
	return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function copyObject(value) {
	const result = Object.create(null);

	for (const key of Object.keys(value)) {
		result[key] = value[key];
	}

	return result;
}

/**
 * Deep-clone plain objects and arrays used in metadata trees.
 * Non-plain values (functions, class instances) are returned as-is.
 *
 * @param {*} value
 * @returns {*}
 */
function deepCopyMeta(value) {
	if (value === null || typeof value !== "object") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(deepCopyMeta);
	}

	if (!isPlainObject(value)) {
		return value;
	}

	const result = Object.create(null);
	const keys = Object.keys(value);

	for (let i = 0; i < keys.length; i++) {
		result[keys[i]] = deepCopyMeta(value[keys[i]]);
	}

	return result;
}

/**
 * Merge metadata layers without mutating either input.
 * Omitted values inherit; null clears. Known sections merge recursively.
 * Nested plain objects and arrays are deep-copied so later mutation of a
 * route config or resolved meta object cannot leak across layers.
 *
 * @param {Object} parent
 * @param {Object} child
 * @returns {Object}
 */
export function mergeMeta(parent, child) {
	const result = deepCopyMeta(isPlainObject(parent) ? parent : Object.create(null));

	for (const key of Object.keys(child)) {
		const value = child[key];

		if (value === undefined) {
			continue;
		}

		if (MERGED_SECTIONS.includes(key)) {
			if (value === null) {
				result[key] = null;
			} else if (isPlainObject(value)) {
				result[key] = mergeMeta(
					isPlainObject(result[key]) ? result[key] : Object.create(null),
					value,
				);
			} else {
				result[key] = deepCopyMeta(value);
			}

			continue;
		}

		if (key === "custom") {
			if (value === null) {
				result.custom = null;
			} else if (isPlainObject(value)) {
				const custom = deepCopyMeta(
					isPlainObject(result.custom) ? result.custom : Object.create(null),
				);

				for (const customKey of Object.keys(value)) {
					const next = value[customKey];

					if (next === undefined) {
						continue;
					}

					if (Array.isArray(next) && Array.isArray(custom[customKey])) {
						custom[customKey] = [
							...custom[customKey],
							...deepCopyMeta(next),
						];
					} else {
						custom[customKey] = deepCopyMeta(next);
					}
				}

				result.custom = custom;
			} else {
				result.custom = deepCopyMeta(value);
			}

			continue;
		}

		if (key === "scripts" || key === "structuredData") {
			if (value === null) {
				result[key] = null;
			} else {
				const previous =
					result[key] == null
						? []
						: Array.isArray(result[key])
							? result[key]
							: [result[key]];

				const incoming = Array.isArray(value) ? value : [value];

				result[key] = [
					...previous,
					...incoming.map(deepCopyMeta),
				];
			}

			continue;
		}

		result[key] = deepCopyMeta(value);
	}

	return result;
}

/**
 * Evaluate a meta static object or callback.
 * Async callbacks are supported; the result must be a plain object.
 *
 * @param {RouteMeta|((context: Object) => RouteMeta|Promise<RouteMeta>)|null|undefined} value
 * @param {Object} context
 * @returns {Promise<Object>}
 */
async function evaluateMeta(value, context) {
	const result =
		typeof value === "function" ? await value(context) : value;

	return isPlainObject(result) ? result : Object.create(null);
}

/**
 * Resolve router defaults and matched route metadata.
 *
 * `matched` is ordered parent-to-child. Entries can be route records, or
 * `{ record, params, data, context }` wrappers. Each metadata callback gets
 * `{ ...context, ...entry.context, params, data, route }`.
 *
 * Inheritance is parent-chain only. Omitted keys inherit; `null` clears.
 * Metadata from a previously committed page never leaks into a new route.
 *
 * @param {Object} [options]
 * @param {RouteMeta|((context: Object) => RouteMeta|Promise<RouteMeta>)} [options.defaults]
 * @param {Array<Object>} [options.matched]
 * @param {Object} [options.context]
 * @returns {Promise<Object>}
 */
export async function resolveMeta({
	defaults = Object.create(null),
	matched = [],
	context = Object.create(null),
} = {}) {
	let resolved = await evaluateMeta(defaults, context);

	for (const entry of matched) {
		const wrapped = isPlainObject(entry) && hasOwn(entry, "record");
		const record = wrapped ? entry.record : entry;

		if (!isPlainObject(record)) {
			continue;
		}

		const routeContext = {
			...context,
			...(wrapped && isPlainObject(entry.context) ? entry.context : {}),
			params:
				wrapped && entry.params != null
					? entry.params
					: (context.params ?? Object.create(null)),
			data: wrapped && hasOwn(entry, "data") ? entry.data : context.data,
			route: record,
		};

		resolved = mergeMeta(
			resolved,
			await evaluateMeta(record.meta, routeContext),
		);
	}

	return resolved;
}

function normalizeImage(value) {
	if (typeof value === "string") {
		const url = value.trim();
		return url ? { url } : null;
	}

	if (!isPlainObject(value) || typeof value.url !== "string") {
		return null;
	}

	const url = value.url.trim();

	if (!url) return null;

	const image = { url };

	for (const key of ["width", "height"]) {
		if (
			typeof value[key] === "number" &&
			Number.isFinite(value[key]) &&
			value[key] > 0
		) {
			image[key] = value[key];
		}
	}

	if (typeof value.alt === "string") {
		image.alt = value.alt;
	}

	return image;
}

function normalizeIcon(value) {
	if (typeof value === "string") {
		const href = value.trim();
		return href ? { href } : null;
	}

	if (!isPlainObject(value)) return null;

	const href = typeof value.href === "string"
        ? value.href.trim()
        : typeof value.url === "string"
            ? value.url.trim()
            : "";

	if (!href) return null;

	const icon = { href };

	for (const key of ["type", "sizes", "media", "rel"]) {
		if (typeof value[key] === "string" && value[key]) {
			icon[key] = value[key];
		}
	}

	return icon;
}

function normalizeScript(value) {
	if (!isPlainObject(value)) return null;

	const hasSrc = typeof value.src === "string" && value.src.trim() !== "";
	const hasContent = typeof value.content === "string";

	// Exactly one source is required.
	if (hasSrc === hasContent) return null;

	const script = Object.create(null);

	if (hasSrc) {
		script.src = value.src.trim();
	}

	if (hasContent) {
		script.content = value.content;
	}

	for (const key of [
		"type",
		"key",
		"crossOrigin",
		"integrity",
		"referrerPolicy",
	]) {
		if (typeof value[key] === "string" && value[key]) {
			script[key] = value[key];
		}
	}

	for (const key of ["async", "defer", "once"]) {
		if (typeof value[key] === "boolean") {
			script[key] = value[key];
		}
	}

	return script;
}

function stableStringify(value) {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}

	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
		.join(",")}}`;
}

function uniqueBy(values, keyOf = stableStringify) {
	const seen = new Set();
	const result = [];

	for (const value of values) {
		const key = keyOf(value);

		if (seen.has(key)) continue;

		seen.add(key);
		result.push(value);
	}

	return result;
}

function normalizeCustom(custom) {
	const result = {
		meta: [],
		links: [],
	};

	if (!isPlainObject(custom)) return result;

	if (Array.isArray(custom.meta)) {
		for (const item of custom.meta) {
			if (!isPlainObject(item) || typeof item.content !== "string") {
				continue;
			}

			const hasName = typeof item.name === "string" && item.name.trim() !== "";
			const hasProperty = typeof item.property === "string" && item.property.trim() !== "";

			if (hasName === hasProperty) continue;

			result.meta.push(
				hasName
					? {
							name: item.name.trim(),
							content: item.content,
						}
					: {
							property: item.property.trim(),
							content: item.content,
						},
			);
		}
	}

	if (Array.isArray(custom.links)) {
		for (const item of custom.links) {
			if (
				!isPlainObject(item) ||
				typeof item.rel !== "string" ||
				typeof item.href !== "string" ||
				!item.rel.trim() ||
				!item.href.trim()
			) {
				continue;
			}

			const link = {
				rel: item.rel.trim(),
				href: item.href.trim(),
			};

			for (const key of ["type", "hreflang", "media", "sizes", "title"]) {
				if (typeof item[key] === "string" && item[key]) {
					link[key] = item[key];
				}
			}

			result.links.push(link);
		}
	}

	result.meta = uniqueBy(
		result.meta,
		(item) =>
			`${item.name ? "name" : "property"}:${(
				item.name || item.property
			).toLowerCase()}`,
	);

	result.links = uniqueBy(
		result.links,
		(item) => `${item.rel.toLowerCase()}:${item.href}`,
	);

	return result;
}

/**
 * Normalize semantic metadata into a stable, adapter-friendly shape.
 *
 * This function returns descriptors only. Consumers must safely assign DOM
 * properties or escape values when serializing HTML.
 *
 * @param {RouteMeta|null|undefined} meta
 * @returns {Object}
 */
export function normalizeMeta(meta = Object.create(null)) {
	const source = isPlainObject(meta) ? meta : Object.create(null);
	const og = isPlainObject(source.openGraph) ? source.openGraph : null;
	const twitter = isPlainObject(source.twitter) ? source.twitter : null;
	const custom = normalizeCustom(source.custom);

	const normalized = {
		title: typeof source.title === "string" ? source.title : null,
		description: typeof source.description === "string" ? source.description : null,
		keywords: null,
		author: typeof source.author === "string" ? source.author : null,
		canonical: typeof source.canonical === "string" ? source.canonical : null,

		icons: [],
		metaTags: [],
		links: [],
		jsonLd: [],
		scripts: [],

		analytics: isPlainObject(source.analytics)
			? copyObject(source.analytics)
			: null,

		custom,
	};

	if (Array.isArray(source.keywords)) {
		normalized.keywords = source.keywords
			.filter((item) => typeof item === "string" && item.trim())
			.join(", ");
        
	} else if (typeof source.keywords === "string") {
		normalized.keywords = source.keywords;
	}

	const iconValues =
		source.icon == null
			? []
			: Array.isArray(source.icon)
				? source.icon
				: [source.icon];

	normalized.icons = uniqueBy(
		iconValues.map(normalizeIcon).filter(Boolean),
		(icon) => `${(icon.rel || "icon").toLowerCase()}:${icon.href}`,
	);

	const pushTag = (key, content) => {
		if (
			content === null ||
			content === undefined ||
			(typeof content !== "string" && typeof content !== "number")
		) {
			return;
		}

		normalized.metaTags.push({
			...key,
			content: String(content),
		});
	};

	pushTag({ name: "description" }, normalized.description);
	pushTag({ name: "keywords" }, normalized.keywords);
	pushTag({ name: "author" }, normalized.author);

	if (og) {
		const image = normalizeImage(og.image);

		for (const [property, content] of [
			["og:type", og.type],
			["og:site_name", og.siteName],
			["og:locale", og.locale],
			["og:title", og.title ?? normalized.title],
			["og:description", og.description ?? normalized.description],
			["og:url", og.url ?? normalized.canonical],
			["og:image", image?.url],
			["og:image:width", image?.width],
			["og:image:height", image?.height],
			["og:image:alt", image?.alt],
		]) {
			pushTag({ property }, content);
		}
	}

	if (twitter) {
		const image = normalizeImage(twitter.image);

		for (const [name, content] of [
			["twitter:card", twitter.card],
			["twitter:site", twitter.site],
			["twitter:creator", twitter.creator],
			["twitter:title", twitter.title ?? normalized.title],
			["twitter:description", twitter.description ?? normalized.description],
			["twitter:image", image?.url],
			["twitter:image:alt", twitter.imageAlt ?? image?.alt],
		]) {
			pushTag({ name }, content);
		}
	}

	normalized.metaTags.push(...custom.meta);

	if (normalized.canonical) {
		normalized.links.push({
			rel: "canonical",
			href: normalized.canonical,
		});
	}

	for (const icon of normalized.icons) {
		normalized.links.push({
			rel: icon.rel || "icon",
			...icon,
		});
	}

	normalized.links.push(...custom.links);

	const structuredData =
		source.structuredData == null
			? []
			: Array.isArray(source.structuredData)
				? source.structuredData
				: [source.structuredData];

	normalized.jsonLd = uniqueBy(structuredData.filter(isPlainObject), (item) =>
		typeof item["@id"] === "string" && item["@id"]
			? `id:${item["@id"]}`
			: `json:${stableStringify(item)}`,
	);

	const scripts = source.scripts == null
        ? []
        : Array.isArray(source.scripts)
            ? source.scripts
            : [source.scripts];

	normalized.scripts = uniqueBy(
		scripts.map(normalizeScript).filter(Boolean),
		(script) =>
			script.key
				? `key:${script.key}`
				: script.src
					? `src:${script.src}`
					: `inline:${script.type || "text/javascript"}:${script.content}`,
	);

	normalized.metaTags = uniqueBy(normalized.metaTags, (tag) =>
		tag.name
			? `name:${tag.name.toLowerCase()}`
			: `property:${tag.property.toLowerCase()}`,
	);

	normalized.links = uniqueBy(normalized.links, (link) => {
		const rel = (link.rel || "").toLowerCase();
		return rel === "canonical" ? "rel:canonical" : `${rel}:${link.href}`;
	});

	return normalized;
}

/**
 * Resolve and normalize metadata in one call.
 *
 * @param {Object} options Options accepted by {@link resolveMeta}.
 * @returns {Promise<Object>}
 */
export async function resolveNormalizedMeta(options = {}) {
	return normalizeMeta(await resolveMeta(options));
}
