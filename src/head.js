
/**
 * @file head.js
 * @description Internal DOM head manager for Udodi Router.
 *
 * Applies normalized route metadata to document.head while preserving
 * pre-existing application-owned elements and managing script lifecycles.
 *
 * Metadata resolution and normalization belong in meta.js.
 *
 * @module head
 */

const OWNER_ATTR = "data-udodi-head";
const KEY_ATTR = "data-udodi-key";
const SCRIPT_ATTR = "data-udodi-script";

/**
 * Persistent script identities shared by all head managers using the same
 * document. Scripts installed with once: true remain registered even if
 * their DOM elements are subsequently removed.
 *
 * @type {WeakMap<Document, Map<string, HTMLScriptElement>>}
 */
const SCRIPT_REGISTRY = new WeakMap();

const SINGLETON_LINK_RELS = new Set([
	"canonical",
	"alternate",
	"manifest",
	"mask-icon",
	"apple-touch-icon",
	"apple-touch-icon-precomposed",
	"icon",
	"shortcut icon",
]);

/**
 * Creates a head manager for a router instance.
 *
 * @param {Object} [options]
 * @param {Document} [options.document]
 * @param {Window} [options.window]
 * @returns {{
 *   apply: (meta: Object, context?: Object) => void,
 *   reportPageView: (meta: Object, context?: Object) => void,
 *   destroy: () => void
 * }}
 */
export function createHeadManager({
	document: doc = globalThis.document,
	window: win = globalThis.window,
} = {}) {
	if (!doc?.head) {
		return createNoopHeadManager();
	}

	const ownerId = createOwnerId();
	const ownedElements = new Map();

	/**
	 * Records original element state before the manager adopts it.
	 *
	 * Created elements are removed on cleanup. Adopted elements are restored.
	 *
	 * @type {Map<HTMLElement, Object|null>}
	 */
	const originalStates = new Map();

	/**
	 * Route-scoped scripts keyed by route identity and script identity.
	 *
	 * These scripts are replaced when their route is entered again.
	 *
	 * @type {Map<string, HTMLScriptElement>}
	 */
	const routeScripts = new Map();

	let destroyed = false;

	/**
	 * Creates an internal element identity.
	 *
	 * @param {string} type
	 * @param {string} key
	 * @returns {string}
	 */
	function elementKey(type, key) {
		return `${type}:${key}`;
	}

	/**
	 * Captures an element's original attributes and text content.
	 *
	 * @param {HTMLElement} element
	 * @returns {Object}
	 */
	function captureElement(element) {
		return {
			attributes: Array.from(element.attributes, attribute => [
				attribute.name,
				attribute.value,
			]),
			textContent: element.textContent,
		};
	}

	/**
	 * Restores an element to its original state.
	 *
	 * @param {HTMLElement} element
	 * @param {Object} state
	 */
	function restoreElement(element, state) {
		for (const attribute of Array.from(element.attributes)) {
			element.removeAttribute(attribute.name);
		}

		for (const [name, value] of state.attributes) {
			element.setAttribute(name, value);
		}

		element.textContent = state.textContent;
	}

	/**
	 * Finds the first existing element matching a semantic identity.
	 *
	 * This inspects elements instead of constructing selectors from metadata
	 * values, avoiding selector-escaping problems.
	 *
	 * @param {string} tagName
	 * @param {(element: HTMLElement) => boolean} matches
	 * @returns {HTMLElement|null}
	 */
	function findExistingElement(tagName, matches) {
		for (const element of doc.head.children) {
			if (element.tagName.toLowerCase() !== tagName) continue;
			if (element.hasAttribute(OWNER_ATTR)) continue;

			if (matches(element)) {
				return element;
			}
		}

		return null;
	}

	/**
	 * Adopts an existing element or creates a new managed element.
	 *
	 * Adopted elements are restored when they become stale. Elements created
	 * by this manager are removed when they become stale.
	 *
	 * @param {string} type
	 * @param {string} key
	 * @param {string} tagName
	 * @param {(element: HTMLElement) => boolean} matches
	 * @returns {HTMLElement}
	 */
	function getOrCreateElement(type, key, tagName, matches) {
		const id = elementKey(type, key);
		let element = ownedElements.get(id);

		if (element && element.isConnected && element.parentNode === doc.head) {
			return element;
		}

		if (element) {
			ownedElements.delete(id);
			originalStates.delete(element);
		}

		element = findExistingElement(tagName, matches);

		if (element) {
			originalStates.set(element, captureElement(element));
		} else {
			element = doc.createElement(tagName);
			originalStates.set(element, null);
		}

		element.setAttribute(OWNER_ATTR, ownerId);
		element.setAttribute(KEY_ATTR, id);

		ownedElements.set(id, element);

		return element;
	}

	/**
	 * Inserts an element into document.head if necessary.
	 *
	 * @param {HTMLElement} element
	 */
	function ensureInHead(element) {
		if (element.parentNode !== doc.head) {
			doc.head.appendChild(element);
		}
	}

	/**
	 * Updates an attribute only when its value changes.
	 *
	 * @param {HTMLElement} element
	 * @param {string} name
	 * @param {unknown} value
	 */
	function setAttribute(element, name, value) {
		if (value == null || value === false) {
			element.removeAttribute(name);
			return;
		}

		if (value === true) {
			element.setAttribute(name, "");
			return;
		}

		const normalized = String(value);

		if (element.getAttribute(name) !== normalized) {
			element.setAttribute(name, normalized);
		}
	}

	/**
	 * Restores or removes elements no longer present in the resolved metadata.
	 *
	 * @param {Set<string>} wanted
	 */
	function removeStaleElements(wanted) {
		for (const [id, element] of ownedElements) {
			if (wanted.has(id)) continue;

			const original = originalStates.get(element);

			if (original) {
				restoreElement(element, original);
			} else {
				element.remove();
			}

			ownedElements.delete(id);
			originalStates.delete(element);
		}
	}

	/**
	 * Applies the resolved document title.
	 *
	 * If no title is resolved, a previously adopted title is restored during
	 * stale-element cleanup.
	 *
	 * @param {string|null|undefined} title
	 * @param {Set<string>} wanted
	 */
	function applyTitle(title, wanted) {
		if (typeof title !== "string") return;

		const id = elementKey("title", "document");
		wanted.add(id);

		const element = getOrCreateElement(
			"title",
			"document",
			"title",
			() => true,
		);

		element.textContent = title;
		ensureInHead(element);
	}

	/**
	 * Applies normalized meta tag descriptors.
	 *
	 * @param {Array<Object>} tags
	 * @param {Set<string>} wanted
	 */
	function applyMetaTags(tags, wanted) {
		for (const tag of tags || []) {
			if (!tag || tag.content == null) continue;

			const identity = tag.name
				? `name:${String(tag.name).toLowerCase()}`
				: tag.property
					? `property:${String(tag.property).toLowerCase()}`
					: tag.httpEquiv
						? `http-equiv:${String(tag.httpEquiv).toLowerCase()}`
						: null;

			if (!identity) continue;

			const element = getOrCreateElement(
				"meta",
				identity,
				"meta",
				candidate => tag.name
                    ? candidate.getAttribute("name")?.toLowerCase() ===
                        String(tag.name).toLowerCase()
                    : tag.property
                        ? candidate.getAttribute("property")?.toLowerCase() ===
                            String(tag.property).toLowerCase()
                        : candidate.getAttribute("http-equiv")?.toLowerCase() ===
                            String(tag.httpEquiv).toLowerCase(),
			);

			wanted.add(elementKey("meta", identity));

			setAttribute(element, "name", tag.name);
			setAttribute(element, "property", tag.property);
			setAttribute(element, "http-equiv", tag.httpEquiv);
			setAttribute(element, "content", tag.content);

			ensureInHead(element);
		}
	}

	/**
	 * Applies normalized link descriptors.
	 *
	 * Singleton link relations use their relation as identity so that
	 * changing the URL updates the existing link. Other relations use
	 * relation + href to support multiple links.
	 *
	 * @param {Array<Object>} links
	 * @param {Set<string>} wanted
	 */
	function applyLinks(links, wanted) {
		for (const link of links || []) {
			if (!link?.rel || !link.href) continue;

			const rel = String(link.rel).toLowerCase();
			const href = String(link.href);
			const singleton = SINGLETON_LINK_RELS.has(rel);
			const identity = singleton ? rel : `${rel}:${href}`;

			const element = getOrCreateElement(
				"link",
				identity,
				"link",
				candidate => {
					const candidateRel = (
						candidate.getAttribute("rel") || ""
					).toLowerCase();

					if (candidateRel !== rel) return false;

					return singleton ||
						candidate.getAttribute("href") === href;
				},
			);

			wanted.add(elementKey("link", identity));

			setAttribute(element, "rel", rel);
			setAttribute(element, "href", href);
			setAttribute(element, "type", link.type);
			setAttribute(element, "sizes", link.sizes);
			setAttribute(element, "media", link.media);
			setAttribute(element, "hreflang", link.hreflang);
			setAttribute(element, "title", link.title);
			setAttribute(element, "crossorigin", link.crossOrigin);
			setAttribute(element, "integrity", link.integrity);
			setAttribute(element, "referrerpolicy", link.referrerPolicy);

			ensureInHead(element);
		}
	}

	/**
	 * Creates a stable script identity.
	 *
	 * Explicit keys are global identities. Otherwise, script type and source
	 * URL or inline content identify the script.
	 *
	 * Use unique explicit keys when the same source must intentionally be
	 * installed more than once with different configuration.
	 *
	 * @param {Object} script
	 * @returns {string|null}
	 */
	function getScriptKey(script) {
		if (script.key != null) {
			return `key:${String(script.key)}`;
		}

		if (script.src) {
			return `src:${String(script.type || "text/javascript")}:${String(script.src)}`;
		}

		if (typeof script.content === "string") {
			return `content:${String(script.type || "text/javascript")}:${script.content}`;
		}

		return null;
	}

	/**
	 * Gets the persistent script registry shared by managers for this document.
	 *
	 * @returns {Map<string, HTMLScriptElement>}
	 */
	function getScriptRegistry() {
		let registry = SCRIPT_REGISTRY.get(doc);

		if (!registry) {
			registry = new Map();
			SCRIPT_REGISTRY.set(doc, registry);
		}

		return registry;
	}

	/**
	 * Creates a script element without inserting it into the document.
	 *
	 * Inline content is assigned before insertion so it executes when the
	 * element is appended.
	 *
	 * @param {Object} script
	 * @param {string} key
	 * @returns {HTMLScriptElement}
	 */
	function createScriptElement(script, key) {
		const element = doc.createElement("script");

		element.setAttribute(SCRIPT_ATTR, key);

		if (script.type != null) {
			element.type = String(script.type);
		}

		if (script.src) {
			element.src = String(script.src);
		}

		if (script.async != null) {
			element.async = Boolean(script.async);
		}

		if (script.defer != null) {
			element.defer = Boolean(script.defer);
		}

		if (script.crossOrigin != null) {
			element.crossOrigin = String(script.crossOrigin);
		}

		if (script.integrity != null) {
			element.integrity = String(script.integrity);
		}

		if (script.referrerPolicy != null) {
			element.referrerPolicy = String(script.referrerPolicy);
		}

		if (script.content != null) {
			element.textContent = String(script.content);
		}

		return element;
	}

	/**
	 * Installs a script according to its execution policy.
	 *
	 * once: true (the default) installs a script once per document and
	 * identity. once: false replaces the previous node for the same route
	 * and script identity every time that route is entered.
	 *
	 * Script descriptors must come from trusted application configuration.
	 * Removing a script node does not undo JavaScript that has already run.
	 *
	 * @param {Object} script
	 * @param {string|number} [routeKey]
	 */
	/**
	 * Escape a value for use inside a CSS attribute selector.
	 *
	 * @param {string} value
	 * @returns {string}
	 */
	function escapeSelectorAttr(value) {
		if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
			return CSS.escape(value);
		}

		return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}

	function applyScript(script, routeKey) {
		if (!script || destroyed) return;

		const key = getScriptKey(script);

		if (!key) return;

		if (script.once !== false) {
			const registry = getScriptRegistry();

			if (registry.has(key)) return;

			const element = createScriptElement(script, key);

			// Register before insertion to prevent duplicate insertion.
			registry.set(key, element);

			try {
				doc.head.appendChild(element);
			} catch (error) {
				registry.delete(key);
				element.remove();
				throw error;
			}

			return;
		}

		if (routeKey == null || routeKey === "") {
			throw new TypeError(
				"Scripts with once: false require a routeKey in headManager.apply().",
			);
		}

		const routeScriptKey = `${String(routeKey)}:${key}`;
		const previous = routeScripts.get(routeScriptKey);

		// Drop the tracked node and any matching DOM node if the map and head
		// diverged (external mutation or a prior partial failure).
		let existingDom = null;

		try {
			existingDom = doc.head.querySelector(
				`script[${SCRIPT_ATTR}="${escapeSelectorAttr(key)}"]`,
			);
		} catch {
			existingDom = null;
		}

		if (previous) {
			previous.remove();
		}

		if (existingDom && existingDom !== previous) {
			existingDom.remove();
		}

		routeScripts.delete(routeScriptKey);

		const element = createScriptElement(script, key);

		try {
			doc.head.appendChild(element);
			routeScripts.set(routeScriptKey, element);
		} catch (error) {
			element.remove();
			throw error;
		}
	}

	/**
	 * Applies normalized JSON-LD structured data.
	 *
	 * Entries are keyed by content so updates reuse existing elements.
	 *
	 * @param {Array<Object|string>} entries
	 * @param {Set<string>} wanted
	 */
	function applyJsonLd(entries, wanted) {
		for (const entry of entries || []) {
			if (entry == null) continue;

			const content = typeof entry === "string"
				? entry
				: JSON.stringify(entry);

			if (content == null) continue;

			const identity = `jsonld:${content}`;
			const id = elementKey("jsonld", identity);

			const element = getOrCreateElement(
				"jsonld",
				identity,
				"script",
				candidate =>
					candidate.type === "application/ld+json" &&
					candidate.textContent === content,
			);

			wanted.add(id);

			element.type = "application/ld+json";
			element.textContent = content;

			ensureInHead(element);
		}
	}

	/**
	 * Applies normalized metadata to document.head.
	 *
	 * Call only after the router has successfully committed navigation.
	 *
	 * @param {Object} meta Result of normalizeMeta() from meta.js.
	 * @param {Object} [context]
	 * @param {string} [context.url] Committed URL for analytics.
	 * @param {string|number} [context.routeKey] Stable identity for the
	 *   committed route. Required by scripts with once: false.
	 * @param {boolean} [context.trackPageView=true]
	 */
	function apply(meta, context = {}) {
		if (destroyed || !meta) return;

		const wanted = new Set();

		applyTitle(meta.title, wanted);
		applyMetaTags(meta.metaTags, wanted);
		applyLinks(meta.links, wanted);
		applyJsonLd(meta.jsonLd, wanted);

		for (const script of meta.scripts || []) {
			applyScript(script, context.routeKey);
		}

		removeStaleElements(wanted);

		if (context.trackPageView !== false) {
			try {
				reportPageView(meta, context);
			} catch (error) {
				if (
					typeof console !== "undefined" &&
					typeof console.warn === "function"
				) {
					console.warn(
						"[Udodi Router] reportPageView failed.",
						error,
					);
				}
			}
		}
	}

	/**
	 * Reports a Google Analytics page view if gtag is initialized.
	 *
	 * The router does not initialize Google Analytics here. Configure its
	 * bootstrap script in metadata with once: true or omit once.
	 *
	 * @param {Object} meta
	 * @param {Object} [context]
	 * @param {string} [context.url]
	 */
	function reportPageView(meta, context = {}) {
		if (destroyed || typeof win?.gtag !== "function") return;

		const analytics = meta?.analytics;

		if (analytics === false || analytics?.pageView === false) {
			return;
		}

		try {
			let location;

			try {
				location = context.url
					? new URL(context.url, win.location?.href).href
					: win.location?.href;
			} catch {
				return;
			}

			if (!location) return;

			let url;

			try {
				url = new URL(location);
			} catch {
				return;
			}

			win.gtag("event", "page_view", {
				page_title: meta?.title || doc.title,
				page_location: location,
				page_path: `${url.pathname}${url.search}${url.hash}`,
			});
		} catch (error) {
			// Analytics must never fail head application or navigation.
			if (
				typeof console !== "undefined" &&
				typeof console.warn === "function"
			) {
				console.warn(
					"[Udodi Router] reportPageView failed.",
					error,
				);
			}
		}
	}

	/**
	 * Restores adopted elements and removes elements created by this manager.
	 *
	 * Persistent and route-scoped script elements are intentionally left
	 * installed. Removing script nodes cannot undo executed code or its
	 * side effects.
	 */
	function destroy() {
		if (destroyed) return;

		destroyed = true;

		for (const element of ownedElements.values()) {
			const original = originalStates.get(element);

			if (original) {
				restoreElement(element, original);
			} else {
				element.remove();
			}
		}

		ownedElements.clear();
		originalStates.clear();
		routeScripts.clear();
	}

	return {
		apply,
		reportPageView,
		destroy,
	};
}

/**
 * Returns a no-op manager when no DOM is available.
 *
 * @returns {{
 *   apply: Function,
 *   reportPageView: Function,
 *   destroy: Function
 * }}
 */
function createNoopHeadManager() {
	const noop = () => {};

	return {
		apply: noop,
		reportPageView: noop,
		destroy: noop,
	};
}

/**
 * Creates an identifier for elements owned by one head manager.
 *
 * @returns {string}
 */
function createOwnerId() {
	return `udodi-${Math.random().toString(36).slice(2, 10)}`;
}
