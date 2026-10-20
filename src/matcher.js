/**
 * @fileoverview Pure route matcher for Udodi Router.
 *
 * Compiles route definitions once into static and parameterized lookup tables.
 * Matching is deterministic and does not access the DOM, browser history, or
 * reactive state.
 *
 * Supported path syntax:
 * - Static segments: `/users/new`
 * - Required parameters: `/users/:id`
 * - Constrained parameters: `/users/:id(\\d+)` or `/:locale(en|fr|de)/products`
 * - Nested relative paths: `users/:id` under `/admin` becomes `/admin/users/:id`
 * - Absolute child paths: `/login` remains `/login`, regardless of its parent
 * - Index children: `path: ""` share the parent's URL and take precedence at that URL
 * - One global fallback: `path: "*"`, only at the root route level
 *
 * Optional parameters and scoped catch-all routes are not supported. Parameter
 * constraints use case-sensitive JavaScript regular-expression syntax within
 * one path segment. Query strings and hashes must be removed before matching.
 *
 * @module matcher
 */

/**
 * @typedef {Object} RouteRecord
 * @property {string} path Route path. Child paths are relative unless they begin with `/`.
 * @property {Function|Object} [component] Component definition or lazy component loader.
 * @property {Function} [loader] Route data loader, executed by the router rather than matcher.
 * @property {Object|Function} [meta] Route metadata.
 * @property {Function} [beforeEnter] Route navigation guard.
 * @property {boolean} [keepAlive] Whether the router may retain this route's mounted view.
 * @property {boolean} [notFound] Application-defined not-found marker; does not affect matching.
 * @property {RouteRecord[]} [children] Nested route records.
 * @property {Object} [data] Runtime-owned data; not read by the matcher.
 */

/**
 * @typedef {Object} CompiledRecord
 * @property {string} path Normalized application-relative path pattern.
 * @property {string[]} segments Path segments in the normalized pattern.
 * @property {(string|null)[]} paramNames Parameter name per segment, or `null` for static segments.
 * @property {(RegExp|null)[]} paramConstraints Compiled parameter constraint per segment.
 * @property {number[]} segmentRanks Specificity rank for each segment.
 * @property {number} totalSegments Number of path segments.
 * @property {RouteRecord} record Original route record.
 * @property {RouteRecord[]} matched Parent-to-leaf ancestor chain.
 * @property {number} staticCount Number of static segments.
 * @property {number} paramCount Number of parameter segments, including constrained parameters.
 * @property {number} constrainedParamCount Number of constrained parameter segments.
 * @property {boolean} isCatchAll Whether this is the global `*` fallback.
 * @property {number} order Original depth-first declaration order.
 */

/**
 * @typedef {Object} MatchResult
 * @property {string} path Normalized application-relative pathname.
 * @property {Object<string, string>} params Decoded route parameters in a null-prototype object.
 * @property {RouteRecord} record Leaf route record selected for this pathname.
 * @property {RouteRecord[]} matched Full parent-to-leaf chain, including the selected record.
 */

/**
 * @typedef {Object} MatcherOptions
 * @property {string} [base=""] Deployment base path, e.g. `/app`. Route definitions remain base-relative.
 */

/**
 * @typedef {Object} CompileContext
 * @property {Object<string, CompiledRecord>} staticRoutes Static route lookup table.
 * @property {Map<number, CompiledRecord[]>} parametricByLength Parameterized routes grouped by segment count.
 * @property {Map<string, CompiledRecord>} patterns Canonical route-pattern registry used for duplicate detection.
 * @property {CompiledRecord|null} catchAllRoute Global fallback route, if configured.
 * @property {number} order Next depth-first declaration index.
 */

/**
 * Normalize a route pathname without applying a deployment base.
 * Duplicate slashes are collapsed and trailing slashes are removed except for `/`.
 *
 * @param {string} pathname
 * @returns {string}
 */
function normalizeRoutePath(pathname) {
	if (typeof pathname !== "string") {
		throw new TypeError("[udodi-router] Route path must be a string");
	}

	if (pathname.includes("?") || pathname.includes("#")) {
		throw new Error(
			`[udodi-router] Route path must not contain a query or hash: "${pathname}"`,
		);
	}

	let path = `/${pathname.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");

	if (path.length > 1 && path.endsWith("/")) {
		path = path.slice(0, -1);
	}

	return path || "/";
}

/**
 * Normalize and validate a deployment base path.
 *
 * @param {string} base
 * @returns {string} Empty string when no base is configured.
 */
function normalizeBase(base) {
	if (typeof base !== "string") {
		throw new TypeError('[udodi-router] option "base" must be a string');
	}

	if (base === "" || base === "/") return "";

	if (base.includes("?") || base.includes("#")) {
		throw new Error(
			'[udodi-router] option "base" must not contain a query or hash',
		);
	}

	let normalized = `/${base.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");

	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}

	return normalized;
}

/**
 * Remove the configured deployment base from a request pathname.
 * A pathname outside the base returns `null` rather than being matched.
 *
 * @param {string} pathname
 * @param {string} base
 * @returns {string|null}
 */
function normalizeRequestPath(pathname, base) {
	if (typeof pathname !== "string") return null;

	// The matcher accepts pathname values, not URL strings with query/hash parts.
	if (pathname.includes("?") || pathname.includes("#")) return null;

	let path = `/${pathname.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");

	if (path.length > 1 && path.endsWith("/")) {
		path = path.slice(0, -1);
	}

	if (base) {
		if (path === base) return "/";
		if (!path.startsWith(`${base}/`)) return null;
		path = path.slice(base.length) || "/";
	}

	return path || "/";
}

/**
 * Split a normalized path into non-empty segments.
 *
 * @param {string} path
 * @returns {string[]}
 */
function splitPath(path) {
	return path === "/" ? [] : path.slice(1).split("/");
}

/**
 * Join a child path to its parent. A leading slash marks a full absolute path;
 * an empty child path is an index route at the parent's path.
 *
 * @param {string} parentPath
 * @param {string} childPath
 * @returns {string}
 */
function joinPaths(parentPath, childPath) {
	if (childPath === "") return parentPath;
	if (childPath.startsWith("/")) return normalizeRoutePath(childPath);

	return normalizeRoutePath(
		parentPath === "/" ? `/${childPath}` : `${parentPath}/${childPath}`,
	);
}

/**
 * Compare route patterns by segment specificity, from left to right.
 * Static segments outrank constrained parameters, which outrank ordinary
 * parameters. Declaration order breaks ties between equally specific routes.
 *
 * @param {CompiledRecord} a
 * @param {CompiledRecord} b
 * @returns {number}
 */
function compareRouteSpecificity(a, b) {
	const length = Math.min(a.totalSegments, b.totalSegments);

	for (let i = 0; i < length; i++) {
		if (a.segmentRanks[i] !== b.segmentRanks[i]) {
			return b.segmentRanks[i] - a.segmentRanks[i];
		}
	}

	if (a.totalSegments !== b.totalSegments) {
		return b.totalSegments - a.totalSegments;
	}

	return a.order - b.order;
}

/**
 * Parse one parameter segment and compile its optional constraint.
 * Constraints are anchored to the whole segment and cannot match path
 * separators, even if the supplied expression attempts to do so.
 *
 * Constraints are case-sensitive. JavaScript's inline `(?i)` syntax is not
 * supported by this route grammar.
 *
 * @param {string} segment
 * @param {string} routePath
 * @returns {{name: string, constraint: RegExp|null}|null}
 */
function parseParameterSegment(segment, routePath) {
	if (!segment.startsWith(":")) return null;

	const open = segment.indexOf("(");
	const name = open === -1 ? segment.slice(1) : segment.slice(1, open);

	if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
		throw new Error(
			`[udodi-router] Invalid parameter syntax in route "${routePath}"`,
		);
	}

	if (open === -1) return { name, constraint: null };

	if (!segment.endsWith(")")) {
		throw new Error(
			`[udodi-router] Constraint must end the parameter segment in route "${routePath}"`,
		);
	}

	const source = segment.slice(open + 1, -1);

	if (!source.trim()) {
		throw new Error(
			`[udodi-router] Parameter constraint cannot be empty or whitespace-only in route "${routePath}"`,
		);
	}

	// Reject constraints that can consume a path separator. Matching is always
	// segment-based, so accepting these would be misleading and inconsistent.
	if (source.includes("/")) {
		throw new Error(
			`[udodi-router] Parameter constraints cannot contain "/" in route "${routePath}"`,
		);
	}

	let constraint;

	try {
		constraint = new RegExp(`^(?:${source})$`);
	} catch (error) {
		throw new Error(
			`[udodi-router] Invalid constraint for parameter ":${name}" in route "${routePath}": ${error.message}`,
		);
	}

	return { name, constraint };
}

/**
 * Return a canonical route pattern that ignores parameter names but retains
 * constraints. `/users/:id(\\d+)` and `/users/:value(\\d+)` are duplicates,
 * while `/users/:id(\\d+)` and `/users/:slug([a-z]+)` are distinct patterns.
 *
 * Typed segment descriptors avoid collisions caused by delimiter-based keys.
 *
 * @param {CompiledRecord} compiled
 * @returns {string}
 */
function getCanonicalPattern(compiled) {
	const descriptors = compiled.segments.map((segment, index) => {
		if (compiled.paramNames[index] === null) {
			return ["static", segment];
		}

		const constraint = compiled.paramConstraints[index];

		return constraint ? ["constrained", constraint.source] : ["param"];
	});

	return JSON.stringify(descriptors);
}

/**
 * Register a compiled parameterized route by segment count.
 *
 * @param {Map<number, CompiledRecord[]>} parametricByLength
 * @param {CompiledRecord} compiled
 * @returns {void}
 */
function addParametricRoute(parametricByLength, compiled) {
	let group = parametricByLength.get(compiled.totalSegments);

	if (!group) {
		group = [];
		parametricByLength.set(compiled.totalSegments, group);
	}

	group.push(compiled);
}

/**
 * Replace an existing parameterized route inside its segment-length group.
 * Used when an index child takes precedence over its parent pattern.
 *
 * @param {Map<number, CompiledRecord[]>} parametricByLength
 * @param {CompiledRecord} compiled
 * @param {string} canonical
 * @returns {void}
 */
function replaceParametricRoute(parametricByLength, compiled, canonical) {
	const group = parametricByLength.get(compiled.totalSegments);

	if (!group) {
		addParametricRoute(parametricByLength, compiled);
		return;
	}

	const index = group.findIndex(
		(item) => getCanonicalPattern(item) === canonical,
	);

	if (index !== -1) {
		group[index] = compiled;
	} else {
		group.push(compiled);
	}
}

/**
 * Compile one route and its descendants into the lookup tables.
 *
 * @param {RouteRecord} route
 * @param {CompileContext} ctx
 * @param {string} parentPath
 * @param {RouteRecord[]} ancestors
 * @param {boolean} isRoot
 * @returns {void}
 */
function compileRoute(route, ctx, parentPath, ancestors, isRoot) {
	if (!route || typeof route !== "object" || Array.isArray(route)) {
		throw new TypeError("[udodi-router] Every route must be an object");
	}

	if (typeof route.path !== "string") {
		throw new TypeError('[udodi-router] Every route must have a string "path"');
	}

	if (route.children !== undefined && !Array.isArray(route.children)) {
		throw new TypeError(
			`[udodi-router] "children" must be an array for route "${route.path}"`,
		);
	}

	const isCatchAll = route.path === "*";

	if (route.path.includes("*") && !isCatchAll) {
		throw new Error(
			`[udodi-router] Only a standalone root-level "*" catch-all is supported: "${route.path}"`,
		);
	}

	if (isCatchAll && !isRoot) {
		throw new Error(
			'[udodi-router] Catch-all route "*" must be declared at the root level',
		);
	}

	if (isCatchAll && route.children && route.children.length > 0) {
		throw new Error('[udodi-router] Catch-all route "*" cannot have children');
	}

	const normalized = isCatchAll ? "*" : joinPaths(parentPath, route.path);
	const segments = isCatchAll ? [] : splitPath(normalized);

	/** @type {(string|null)[]} */
	const paramNames = [];

	/** @type {(RegExp|null)[]} */
	const paramConstraints = [];

	/** @type {number[]} */
	const segmentRanks = [];

	let staticCount = 0;
	let paramCount = 0;
	let constrainedParamCount = 0;

	const seenNames = new Set();

	for (const segment of segments) {
		const parameter = parseParameterSegment(segment, normalized);

		if (parameter) {
			const { name, constraint } = parameter;

			if (seenNames.has(name)) {
				throw new Error(
					`[udodi-router] Duplicate parameter ":${name}" in route "${normalized}"`,
				);
			}

			seenNames.add(name);
			paramNames.push(name);
			paramConstraints.push(constraint);
			segmentRanks.push(constraint ? 2 : 1);
			paramCount++;

			if (constraint) constrainedParamCount++;
            
		} else {
			if (
				segment.includes(":") ||
				segment.includes("(") ||
				segment.includes(")")
			) {
				throw new Error(
					`[udodi-router] Invalid parameter syntax in route "${normalized}"`,
				);
			}

			paramNames.push(null);
			paramConstraints.push(null);
			segmentRanks.push(3);
			staticCount++;
		}
	}

	const matched = [...ancestors, route];

	/** @type {CompiledRecord} */
	const compiled = {
		path: normalized,
		segments,
		paramNames,
		paramConstraints,
		segmentRanks,
		totalSegments: segments.length,
		record: route,
		matched,
		staticCount,
		paramCount,
		constrainedParamCount,
		isCatchAll,
		order: ctx.order++,
	};

	if (isCatchAll) {
		if (ctx.catchAllRoute) {
			throw new Error(
				'[udodi-router] Only one root-level catch-all route "*" is supported',
			);
		}

		ctx.catchAllRoute = compiled;

	} else {
		const canonical = getCanonicalPattern(compiled);
		const existing = ctx.patterns.get(canonical);
		const isIndexChild = route.path === "" && ancestors.length > 0;

		if (existing) {
			// A pathless index child is the one supported exception: it shares its
			// parent's URL and becomes the selected leaf while retaining the parent chain.
			const parentIsExisting =
				isIndexChild && existing.record === ancestors[ancestors.length - 1];

			if (!parentIsExisting) {
				throw new Error(
					`[udodi-router] Duplicate route pattern "${normalized}"`,
				);
			}

			ctx.patterns.set(canonical, compiled);

			if (paramCount === 0) {
				ctx.staticRoutes[normalized] = compiled;
			} else {
				replaceParametricRoute(ctx.parametricByLength, compiled, canonical);
			}

		} else {
			ctx.patterns.set(canonical, compiled);

			if (paramCount === 0) {
				ctx.staticRoutes[normalized] = compiled;
			} else {
				addParametricRoute(ctx.parametricByLength, compiled);
			}
		}
	}

	for (const child of route.children || []) {
		compileRoute(
			child,
			ctx,
			normalized === "*" ? "/" : normalized,
			matched,
			false,
		);
	}
}

/**
 * Compile route definitions into a reusable, deterministic pathname matcher.
 * Route definitions are application-relative; `base` applies only to incoming
 * request pathnames.
 *
 * @param {RouteRecord[]} routes
 * @param {MatcherOptions} [options]
 * @returns {(pathname: string) => MatchResult|null}
 */
export function createMatcher(routes, { base = "" } = {}) {
	if (!Array.isArray(routes)) {
		throw new TypeError("[udodi-router] routes must be an array");
	}

	const normalizedBase = normalizeBase(base);

	/** @type {Object<string, CompiledRecord>} */
	const staticRoutes = Object.create(null);

	/** @type {Map<number, CompiledRecord[]>} */
	const parametricByLength = new Map();

	/** @type {Map<string, CompiledRecord>} */
	const patterns = new Map();

	/** @type {CompileContext} */
	const ctx = {
		staticRoutes,
		parametricByLength,
		patterns,
		catchAllRoute: null,
		order: 0,
	};

	for (const route of routes) {
		compileRoute(route, ctx, "/", [], true);
	}

	// Sort each segment-length group by specificity.
	for (const candidates of parametricByLength.values()) {
		candidates.sort(compareRouteSpecificity);
	}

	/**
	 * Match a pathname against the compiled route table.
	 *
	 * @param {string} pathname Pathname only; query strings and hashes are not accepted.
	 * @returns {MatchResult|null}
	 */
	return function match(pathname) {
		const path = normalizeRequestPath(pathname, normalizedBase);

		if (path === null) return null;

		// Fast static lookup.
		const staticHit = staticRoutes[path];

		if (staticHit !== undefined) {
			return {
				path,
				params: Object.create(null),
				record: staticHit.record,
				matched: staticHit.matched,
			};
		}

		// Match only parameterized routes with the same segment count.
		const targetSegments = splitPath(path);
		const candidates = parametricByLength.get(targetSegments.length);

		if (candidates) {
			for (let i = 0, length = candidates.length; i < length; i++) {
				const candidate = candidates[i];

				/** @type {Object<string, string>} */
				const params = Object.create(null);

				let matches = true;

				for (let j = 0; j < candidate.totalSegments; j++) {
					const expectedParam = candidate.paramNames[j];
					const actual = targetSegments[j];

					if (expectedParam === null) {
						if (candidate.segments[j] !== actual) {
							matches = false;
							break;
						}

						continue;
					}

					let decoded;

					try {
						decoded = decodeURIComponent(actual);
					} catch {
						matches = false;
						break;
					}

					// Keep a parameter confined to one path segment after decoding.
					if (decoded.includes("/") || decoded.includes("\\")) {
						matches = false;
						break;
					}

					const constraint = candidate.paramConstraints[j];

					if (constraint && !constraint.test(decoded)) {
						matches = false;
						break;
					}

					params[expectedParam] = decoded;
				}

				if (matches) {
					return {
						path,
						params,
						record: candidate.record,
						matched: candidate.matched,
					};
				}
			}
		}

		// Global fallback.
		if (ctx.catchAllRoute) {
			return {
				path,
				params: Object.create(null),
				record: ctx.catchAllRoute.record,
				matched: ctx.catchAllRoute.matched,
			};
		}

		return null;
	};
}

/**
 * Convenience helper that compiles routes and immediately matches a pathname.
 * Prefer `createMatcher()` when matching multiple paths against the same table.
 *
 * @param {RouteRecord[]} routes
 * @param {string} pathname
 * @param {MatcherOptions} [options]
 * @returns {MatchResult|null}
 */
export function matchRoutes(routes, pathname, options) {
	return createMatcher(routes, options)(pathname);
}
