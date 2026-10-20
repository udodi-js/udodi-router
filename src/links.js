
import { createComponent } from "udodi";

/**
 * Creates the component factory used by router.Link().
 *
 * The component definition is created once. Each Link call supplies
 * its own destination, template, and custom props.
 *
 * @param {object} router
 * @param {object} [options]
 * @param {string} [options.base="/"]
 * @returns {Function}
 */
export function createLinkFactory(router, options = {}) {
	if (!router || typeof router.push !== "function") {
		throw new TypeError(
			"createLinkFactory() requires a router with push().",
		);
	}

	const base = normalizeBase(options.base || "/");

	// Internal prop names reserved by this factory.
	const TEMPLATE_PROP = "__UdodiLinkTemplate";
	const HREF_PROP = "__UdodiLinkHref";

	/**
	 * Define the component only once. Per-instance props are provided
	 * by Link() below.
	 */
	const LinkComponent = createComponent({
		name: "RouterLink",

		computed: {
			/**
			 * Reactive active state for this link's destination.
			 *
			 * @param {object} ctx
			 * @returns {boolean}
			 */
			isActive(ctx) {
				// Track committed navigation changes.
				const currentPath = router.route.path;

				if (typeof currentPath !== "string") {
					return false;
				}

				return router.isActive(
					targetToRoutePath(ctx.to),
					ctx.exact === true,
				);
			},
		},

		onMount(root, ctx) {
			const isAnchor =
				root.nodeType === 1 &&
				root.tagName.toLowerCase() === "a";

			const href = ctx[HREF_PROP];

			if (isAnchor) {
				// The router owns the anchor destination.
				// A caller-provided href is deliberately overridden.
				root.setAttribute("href", href);
			}

			function onClick(event) {
				if (
					event.defaultPrevented ||
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.altKey
				) {
					return;
				}

				if (isAnchor) {
					if (
						root.hasAttribute("download") ||
						(root.target && root.target !== "_self") ||
						hasExternalRel(root)
					) {
						return;
					}
				}

				event.preventDefault();
				router.push(ctx.to);
			}

			root.addEventListener("click", onClick);

			ctx.cleanup(() => {
				root.removeEventListener("click", onClick);
			});
		},

		template(ctx) {
			const content = ctx[TEMPLATE_PROP];

			return typeof content === "function"
				? content(ctx)
				: content;
		},
	});

	/**
	 * Creates a Link component placeholder.
	 *
	 * @param {object} props
	 * @param {string|object} props.to
	 * @param {boolean} [props.exact=false]
	 * @param {Function|string} template
	 * @returns {string}
	 */
	return function Link(props, template) {
		if (!props || !Object.hasOwn(props, "to")) {
			throw new TypeError(
				"router.Link() requires a 'to' prop.",
			);
		}

		if (template == null) {
			throw new TypeError(
				"router.Link() requires a template.",
			);
		}

		const target = props.to;
		const exact = props.exact === true;
		const href = resolveHref(target, base);

		// Preserve all caller props without mutating their object.
		// Internal props are deliberately controlled by the router.
		return LinkComponent({
			...props,
			to: target,
			exact,
			[TEMPLATE_PROP]: template,
			[HREF_PROP]: href,
		});
	};
}

/**
 * Checks whether an anchor declares itself external.
 *
 * @param {Element} anchor
 * @returns {boolean}
 */
function hasExternalRel(anchor) {
	return anchor.relList.contains("external");
}

/**
 * Resolves a route target to its pathname.
 *
 * @param {string|object} target
 * @returns {string}
 */
function targetToRoutePath(target) {
	if (typeof target === "string") {
		return stripQueryAndHash(target);
	}

	if (!target || typeof target !== "object") {
		throw new TypeError(
			"A route target must be a string or an object.",
		);
	}

	if (typeof target.path !== "string") {
		throw new TypeError(
			"An object route target requires a string 'path'.",
		);
	}

	return stripQueryAndHash(target.path);
}

/**
 * Builds an href from a string or object route target.
 *
 * @param {string|object} target
 * @param {string} base
 * @returns {string}
 */
function resolveHref(target, base) {
	let path;
	let query = "";
	let hash = "";

	if (typeof target === "string") {
		const hashIndex = target.indexOf("#");
		const queryIndex = target.indexOf("?");

		// A query delimiter after the fragment delimiter belongs
		// to the fragment, not to the query string.
		const hasQuery =
			queryIndex !== -1 &&
			(hashIndex === -1 || queryIndex < hashIndex);

		let end = target.length;

		if (hasQuery) end = queryIndex;
		if (hashIndex !== -1) end = Math.min(end, hashIndex);

		path = target.slice(0, end);

		if (hasQuery) {
			query = target.slice(
				queryIndex + 1,
				hashIndex === -1 ? target.length : hashIndex,
			);
		}

		if (hashIndex !== -1) {
			hash = target.slice(hashIndex + 1);
		}
    
	} else if (target && typeof target === "object") {
		path = target.path;

		if (typeof path !== "string") {
			throw new TypeError(
				"An object route target requires a string 'path'.",
			);
		}

		query = stringifyQuery(target.query);
		hash = target.hash == null
			? ""
			: String(target.hash).replace(/^#/, "");
        
	} else {
		throw new TypeError(
			"A route target must be a string or an object.",
		);
	}

	if (!path) path = "/";
	if (!path.startsWith("/")) path = `/${path}`;

	const fullPath = `${base === "/" ? "" : base}${path}`;

	return (
		fullPath +
		(query ? `?${query}` : "") +
		(hash ? `#${hash}` : "")
	) || "/";
}

/**
 * Serializes query parameters.
 *
 * @param {object|string|URLSearchParams|null|undefined} query
 * @returns {string}
 */
function stringifyQuery(query) {
	if (query == null) return "";

	if (typeof query === "string") {
		return query.replace(/^\?/, "");
	}

	if (
		typeof URLSearchParams !== "undefined" &&
		query instanceof URLSearchParams
	) {
		return query.toString();
	}

	if (typeof query !== "object") {
		throw new TypeError(
			"The query must be an object, string, or URLSearchParams.",
		);
	}

	const params = new URLSearchParams();

	for (const key of Object.keys(query)) {
		const value = query[key];

		if (value == null) continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				if (item != null) params.append(key, String(item));
			}
		} else {
			params.append(key, String(value));
		}
	}

	return params.toString();
}

/**
 * Removes query and hash portions from a pathname.
 *
 * @param {string} path
 * @returns {string}
 */
function stripQueryAndHash(path) {
	const queryIndex = path.indexOf("?");
	const hashIndex = path.indexOf("#");

	let end = path.length;

	if (queryIndex !== -1) end = Math.min(end, queryIndex);
	if (hashIndex !== -1) end = Math.min(end, hashIndex);

	return path.slice(0, end) || "/";
}

/**
 * Normalizes a deployment base path.
 *
 * @param {string} base
 * @returns {string}
 */
function normalizeBase(base) {
	let value = String(base || "/").trim();

	if (!value.startsWith("/")) value = `/${value}`;

	value = value.replace(/\/+/g, "/");

	if (value !== "/" && value.endsWith("/")) {
		value = value.slice(0, -1);
	}

	return value || "/";
}
