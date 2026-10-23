/**
 * @fileoverview Core navigation engine for Udodi Router.
 *
 * Coordinates route matching, guards, loaders, lazy component resolution,
 * metadata, history updates, and reactive route-state commits.
 *
 * Navigation is transactional: the active route remains unchanged until
 * the destination has passed its guards and all required asynchronous
 * preparation has completed successfully.
 *
 * @module navigation
 */

import { reactive } from "udodi";
import { createMatcher } from "./matcher.js";
import { createWebHistory } from "./history.js";
import { createLinkFactory } from "./links.js";
import { createViewFactory } from "./view.js";
import { createHeadManager } from "./head.js";
import { normalizeMeta, resolveMeta } from "./meta.js";

/**
 * @typedef {import("./matcher.js").RouteRecord} RouteRecord
 * @typedef {import("./matcher.js").MatchResult} MatchResult
 * @typedef {import("./history.js").HistoryAdapter} HistoryAdapter
 * @typedef {import("./history.js").HistoryLocation} HistoryLocation
 */

/**
 * @typedef {Object} RouteState
 * @property {string} path Normalized pathname, excluding query and hash.
 * @property {string} fullPath Complete application-relative URL.
 * @property {Object<string, string>} params Decoded route parameters.
 * @property {Object<string, string>} query Decoded query parameters.
 * @property {string} hash Fragment including `#`, or an empty string.
 * @property {Array<RouteRecord & {data: *, record: RouteRecord}>} matched
 *   Active route records from parent to child, with each record's loader data.
 * @property {Object<string, *>} meta Merged route metadata.
 * @property {*} data Active leaf route's loader result.
 * @property {boolean} pending Whether the latest navigation is preparing.
 * @property {Error|null} error Error from the latest failed navigation.
 * @property {number} activeVersion Reactive version for active-route lookups.
 */

/**
 * @typedef {Object} NavigationResult
 * @property {"completed"|"cancelled"|"redirected"|"error"} type
 * @property {RouteState} [route]
 * @property {string} [redirectTo]
 * @property {Error} [error]
 */

/**
 * @typedef {Object} ScrollBehaviorResult
 * @property {number} [top]
 *   Absolute vertical scroll position in pixels, unless `el` is supplied,
 *   in which case it is the offset from the element's document position
 *   (useful for fixed headers).
 * @property {number} [left] Horizontal scroll position in pixels.
 * @property {string} [el] CSS selector for an element to scroll to.
 */

/**
 * @typedef {Object} RouterOptions
 * @property {RouteRecord[]} routes
 * @property {HistoryAdapter} [history]
 * @property {string} [base]
 * @property {number} [maxKeepAlive=10]
 *   Maximum inactive route views retained per RouterView outlet.
 * @property {(
 *   to: RouteState,
 *   from: RouteState|null,
 *   savedPosition: {top: number, left: number}|null
 * ) => ScrollBehaviorResult|false|null|void|Promise<ScrollBehaviorResult|false|null|void>} [scrollBehavior]
 *   Callback that controls window scrolling after a successful navigation.
 */

/**
 * @typedef {"initial"|"push"|"replace"|"traverse"|"none"} HistoryAction
 */

/**
 * @typedef {Object} ScrollSnapshot
 * @property {string} key History-entry key the coordinates belong to.
 * @property {{top: number, left: number}} position Window scroll coordinates.
 */

/**
 * @typedef {Object} ResolvedTarget
 * @property {string} path
 * @property {string} fullPath
 * @property {string} search
 * @property {string} hash
 * @property {Object<string, string>} query
 */

/**
 * Normalize a pathname for route-state comparisons.
 *
 * Base stripping is handled by the matcher and history adapter.
 *
 * @param {string} pathname
 * @returns {string}
 */
function normalizePathname(pathname) {
	let path = pathname || "/";

	if (!path.startsWith("/")) {
		path = `/${path}`;
	}

	path = path.replace(/\/{2,}/g, "/");

	if (path.length > 1 && path.endsWith("/")) {
		path = path.slice(0, -1);
	}

	return path || "/";
}

/**
 * Parse a URL search string into a prototype-free dictionary.
 *
 * Repeated query keys use the last value.
 *
 * @param {string} search
 * @returns {Object<string, string>}
 */
function parseQuery(search) {
	/** @type {Object<string, string>} */
	const query = Object.create(null);

	if (!search || search === "?") {
		return query;
	}

	const params = new URLSearchParams(
		search.startsWith("?") ? search.slice(1) : search,
	);

	for (const [key, value] of params) {
		query[key] = value;
	}

	return query;
}

/**
 * Serialize a query object.
 *
 * Undefined and null values are omitted. Array values produce repeated keys.
 *
 * @param {Object<string, *>} query
 * @returns {string}
 */
function stringifyQuery(query) {
	if (!query || typeof query !== "object") {
		return "";
	}

	const params = new URLSearchParams();

	for (const key of Object.keys(query)) {
		const value = query[key];

		if (value == null) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				if (item != null) {
					params.append(key, String(item));
				}
			}
		
		} else {
			params.append(key, String(value));
		}
	}

	const result = params.toString();
	return result ? `?${result}` : "";
}

/**
 * Parse an application-relative URL into its components.
 *
 * Absolute URLs and protocol-relative URLs are not valid router targets.
 *
 * @param {string} target
 * @returns {{pathname: string, search: string, hash: string}}
 */
function splitLocation(target) {
	if (typeof target !== "string") {
		throw new TypeError(
			"[Udodi Router] Navigation target must be a string.",
		);
	}

	const value = target || "/";
	let pathname = value;
	let search = "";
	let hash = "";

	const hashIndex = pathname.indexOf("#");

	if (hashIndex !== -1) {
		hash = pathname.slice(hashIndex);
		pathname = pathname.slice(0, hashIndex);
	}

	const searchIndex = pathname.indexOf("?");

	if (searchIndex !== -1) {
		search = pathname.slice(searchIndex);
		pathname = pathname.slice(0, searchIndex);
	}

	if (!pathname) {
		pathname = "/";
	}

	if (!pathname.startsWith("/") || pathname.startsWith("//")) {
		throw new TypeError(
			`[Udodi Router] Expected an absolute application path, received "${target}".`,
		);
	}

	return {
		pathname: normalizePathname(pathname),
		search,
		hash,
	};
}

/**
 * Normalize a navigation target into an application-relative URL.
 *
 * String targets preserve their query-string representation.
 * Object targets support `path`, optional `query`, and optional `hash`.
 *
 * @param {string|{path: string, query?: Object<string, *>, hash?: string}} to
 * @returns {string}
 */
function resolveTarget(to) {
	if (typeof to === "string") {
		const { pathname, search, hash } = splitLocation(to);
		return `${pathname}${search}${hash}`;
	}

	if (!to || typeof to !== "object" || typeof to.path !== "string") {
		throw new TypeError("[Udodi Router] Invalid navigation target.");
	}

	const { pathname } = splitLocation(to.path);
	const search = stringifyQuery(to.query);
	const hash = to.hash
		? to.hash.startsWith("#")
			? to.hash
			: `#${to.hash}`
		: "";

	return `${pathname}${search}${hash}`;
}

/**
 * Resolve a target into the fields needed by matching and route state.
 *
 * @param {string} target
 * @returns {ResolvedTarget}
 */
function resolveLocation(target) {
	const { pathname, search, hash } = splitLocation(target);

	return {
		path: pathname,
		fullPath: `${pathname}${search}${hash}`,
		search,
		hash,
		query: parseQuery(search),
	};
}

/**
 * Convert an unknown thrown value into an Error.
 *
 * @param {*} value
 * @returns {Error}
 */
function toError(value) {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * Create a consistent abort error.
 *
 * @param {AbortSignal} signal
 * @returns {Error}
 */
function getAbortError(signal) {
	if (signal.reason instanceof Error) {
		return signal.reason;
	}

	return new DOMException("Navigation aborted.", "AbortError");
}

/**
 * Resolve metadata from matched parent-to-child records.
 *
 * Uses {@link resolveMeta} so inheritance is parent-chain only (never the
 * previously committed page). Each callback receives that route's loader data.
 * Callbacks may be asynchronous.
 *
 * @param {RouteRecord[]} matched
 * @param {Object<string, string>} params
 * @param {Map<RouteRecord, *>} loaderData
 * @param {Object<string, *>} context
 * @param {Object|Function} [defaults]
 * @returns {Promise<Object<string, *>>}
 */
async function resolveMetadata(
	matched,
	params,
	loaderData,
	context,
	defaults,
) {
	const wrapped = matched.map((record) => ({
		record,
		params,
		data: loaderData.has(record) ? loaderData.get(record) : null,
	}));

	return resolveMeta({
		defaults,
		matched: wrapped,
		context,
	});
}

/**
 * Create a router instance.
 *
 * Route preparation runs before the active route is committed. Superseded
 * navigations are cancelled and cannot overwrite a newer committed route or
 * persist their own scroll snapshots.
 *
 * @param {RouterOptions & {context?: Object<string, *>}} options
 * @returns {object}
 */
export function createRouter(options) {
	if (!options || !Array.isArray(options.routes)) {
		throw new TypeError(
			"[Udodi Router] createRouter requires a routes array.",
		);
	}

	const base = options.base || "";
	const ownsHistory = !options.history;
	const history = options.history || createWebHistory({ base });
	const match = createMatcher(options.routes, { base });
	const scrollBehavior = typeof options.scrollBehavior === "function"
		? options.scrollBehavior
		: null;
	const context = options.context || Object.create(null);
	const metaDefaults = options.meta ?? Object.create(null);
	/** Head manager is always created; it no-ops when document is unavailable. */
	const headManager = createHeadManager();

	/** @type {RouteState} */
	const routeState = reactive({
		path: "/",
		fullPath: "/",
		params: Object.create(null),
		query: Object.create(null),
		hash: "",
		matched: [],
		meta: Object.create(null),
		data: undefined,
		pending: false,
		error: null,
		activeVersion: 0,
	});

	/** @type {Record<string, true>} */
	const activeMap = Object.create(null);
	/** @type {string[]} */
	const activeKeys = [];

	/** @type {Map<RouteRecord, Promise<*>>} */
	const componentCache = new Map();
	/** @type {Map<RouteRecord, *>} */
	const resolvedComponents = new Map();

	let currentNavigationId = 0;
	let activeAbortController = null;
	let stopHistoryListen = null;
	let disposed = false;
	let writingHistory = false;
	let resolveReady;
	let viewFactory = null;

	/** @type {Map<string, {top: number, left: number}>} */
	const savedPositions = new Map();
	let activeHistoryKey = null;
	let previousScrollRestoration = null;
	const MAX_SAVED_POSITIONS = 100;

	/**
	 * Store a window scroll snapshot for one history-entry key.
	 *
	 * Map insertion order is used as a simple LRU eviction order.
	 *
	 * @param {string|null|undefined} key
	 * @param {{top: number, left: number}} position
	 * @returns {void}
	 */
	function storeScrollPosition(key, position) {
		if (key == null) {
			return;
		}

		savedPositions.delete(key);
		savedPositions.set(key, {
			top: position.top,
			left: position.left,
		});

		while (savedPositions.size > MAX_SAVED_POSITIONS) {
			const oldestKey = savedPositions.keys().next().value;

			if (oldestKey === undefined) {
				break;
			}

			savedPositions.delete(oldestKey);
		}
	}

	/**
	 * Read the current window scroll without writing the saved-position map.
	 *
	 * @returns {{top: number, left: number}|null}
	 */
	function readWindowScrollPosition() {
		if (typeof window === "undefined") {
			return null;
		}

		return {
			top: window.scrollY ?? window.pageYOffset ?? 0,
			left: window.scrollX ?? window.pageXOffset ?? 0,
		};
	}

	/**
	 * Persist the current window scroll under `activeHistoryKey`.
	 *
	 * Reserved for explicit recovery paths. Ordinary navigations snapshot
	 * first and only call `storeScrollPosition` after a successful commit.
	 *
	 * @returns {void}
	 */
	function saveCurrentScrollPosition() {
		if (activeHistoryKey == null) {
			return;
		}

		const position = readWindowScrollPosition();

		if (position) {
			storeScrollPosition(activeHistoryKey, position);
		}
	}

	/**
	 * Return the saved position for a history entry, if one was captured.
	 *
	 * @param {string|null|undefined} key
	 * @returns {{top: number, left: number}|null}
	 */
	function getSavedPosition(key) {
		if (key == null) {
			return null;
		}

		const position = savedPositions.get(key);

		return position
			? { top: position.top, left: position.left }
			: null;
	}

	if (typeof window !== "undefined" && scrollBehavior) {
		// Prevent native restoration from racing with the router's callback.
		if ("scrollRestoration" in window.history) {
			previousScrollRestoration = window.history.scrollRestoration;
			window.history.scrollRestoration = "manual";
		}
	}

	/** Resolves once with the result of the initial navigation attempt. */
	const ready = new Promise((resolve) => {
		resolveReady = resolve;
	});

	/**
	 * Update the private active-path lookup from the committed route chain.
	 *
	 * @param {Array<{path: string}>} matched
	 * @returns {void}
	 */
	function rebuildActiveMap(matched) {
		for (let i = 0; i < activeKeys.length; i++) {
			delete activeMap[activeKeys[i]];
		}

		activeKeys.length = 0;

		for (let i = 0; i < matched.length; i++) {
			const path = matched[i].path;

			if (activeMap[path] !== true) {
				activeMap[path] = true;
				activeKeys.push(path);
			}
		}
	}

	/**
	 * Create public matched-record entries with route-specific loader data.
	 *
	 * Original route definitions are not mutated.
	 *
	 * @param {RouteRecord[]} matched
	 * @param {Map<RouteRecord, *>} loaderData
	 * @returns {Array<RouteRecord & {data: *, record: RouteRecord}>}
	 */
	function createMatchedEntries(matched, loaderData) {
		const entries = new Array(matched.length);

		for (let i = 0; i < matched.length; i++) {
			const record = matched[i];

			entries[i] = {
				...record,
				data: loaderData.has(record) ? loaderData.get(record) : null,
				record,
			};
		}

		return entries;
	}

	/**
	 * Return the component definition prepared for a committed matched entry.
	 *
	 * @param {object} entry
	 * @returns {*}
	 */
	function getResolvedComponent(entry) {
		const record = entry.record || entry;

		if (entry.resolvedComponent != null) {
			return entry.resolvedComponent;
		}

		if (resolvedComponents.has(record)) {
			return resolvedComponents.get(record);
		}

		return record.component;
	}

	/**
	 * Commit a fully prepared route.
	 *
	 * Private lookup state is updated before the reactive version increments.
	 *
	 * @param {object} next
	 * @returns {void}
	 */
	function commit(next) {
		rebuildActiveMap(next.matched);

		routeState.path = next.path;
		routeState.fullPath = next.fullPath;
		routeState.params = next.params;
		routeState.query = next.query;
		routeState.hash = next.hash;
		routeState.matched = next.matched;
		routeState.meta = next.meta;
		routeState.data = next.data;
		routeState.pending = false;
		routeState.error = null;
		routeState.activeVersion++;
	}

	/**
	 * Read a snapshot of the committed route for guards.
	 *
	 * @returns {object|null}
	 */
	function getCurrentRouteSnapshot() {
		if (!routeState.matched.length && routeState.fullPath === "/") {
			return null;
		}

		return {
			path: routeState.path,
			fullPath: routeState.fullPath,
			params: routeState.params,
			query: routeState.query,
			hash: routeState.hash,
			matched: routeState.matched,
			meta: routeState.meta,
			data: routeState.data,
		};
	}

	/**
	 * Determine whether a navigation attempt is still current.
	 *
	 * @param {number} navigationId
	 * @returns {boolean}
	 */
	function isCurrentNavigation(navigationId) {
		return !disposed && navigationId === currentNavigationId;
	}

	/**
	 * Cancel the currently preparing navigation, if any.
	 *
	 * @returns {void}
	 */
	function cancelActiveNavigation() {
		if (!activeAbortController) {
			return;
		}

		activeAbortController.abort();
		activeAbortController = null;
	}

	/**
	 * Resolve a route's component definition before committing navigation.
	 *
	 * Lazy routes use `loadComponent: () => import("./Page.js")`.
	 * Successful definitions are cached; rejected loads can be retried.
	 *
	 * The shared cache holds only the module-load promise. `signal` controls
	 * whether *this* navigation continues to wait; aborting it does not reject
	 * or remove the shared load. A later navigation can still adopt the same
	 * in-flight import.
	 *
	 * @param {RouteRecord} record
	 * @param {AbortSignal} signal
	 * @returns {Promise<*>}
	 */
	async function resolveComponent(record, signal) {
		if (resolvedComponents.has(record)) {
			return resolvedComponents.get(record);
		}

		if (typeof record.loadComponent !== "function") {
			return record.component;
		}

		let pending = componentCache.get(record);

		if (!pending) {
			// Load is independent of any navigation AbortSignal so concurrent
			// navigations share one import and an abort never poisons the cache.
			const loading = Promise.resolve().then(() =>
				record.loadComponent(),
			);

			pending = loading.then((loaded) => {
				const definition =
					loaded &&
					(typeof loaded === "object" || typeof loaded === "function") &&
					"default" in loaded
						? loaded.default
						: loaded;

				if (definition == null) {
					throw new TypeError(
						`[Udodi Router] Lazy component for "${record.path}" resolved to an empty value.`,
					);
				}

				resolvedComponents.set(record, definition);
				return definition;
			});

			componentCache.set(record, pending);

			// Clear only true load failures so the next navigation can retry.
			pending.catch(() => {
				if (componentCache.get(record) === pending) {
					componentCache.delete(record);
				}
			});
		}

		if (signal.aborted) {
			throw getAbortError(signal);
		}

		// Wait for the shared load, or stop waiting if this navigation is cancelled.
		return await new Promise((resolve, reject) => {
			let settled = false;

			const cleanup = () => {
				signal.removeEventListener("abort", onAbort);
			};

			const onAbort = () => {
				if (settled) {
					return;
				}

				settled = true;
				cleanup();
				// Reject only this waiter — `pending` stays in cache and may
				// still resolve for another navigation.
				reject(getAbortError(signal));
			};

			signal.addEventListener("abort", onAbort, { once: true });

			pending.then(
				(value) => {
					if (settled) {
						return;
					}

					settled = true;
					cleanup();
					resolve(value);
				},
				(error) => {
					if (settled) {
						return;
					}

					settled = true;
					cleanup();
					reject(error);
				},
			);

			if (signal.aborted) {
				onAbort();
			}
		});
	}

	/**
	 * Run route guards in parent-to-child order.
	 *
	 * Guard outcomes:
	 * - `true` or `undefined`: continue
	 * - `false`: cancel
	 * - string or `{ path }`: redirect
	 * - thrown / rejected: fail
	 *
	 * @param {RouteRecord[]} matched
	 * @param {object} to
	 * @param {object|null} from
	 * @param {AbortSignal} signal
	 * @returns {Promise<{type: "continue"|"cancelled"|"redirect", target?: string}>}
	 */
	async function runGuards(matched, to, from, signal) {
		for (let i = 0; i < matched.length; i++) {
			if (signal.aborted) {
				return { type: "cancelled" };
			}

			const record = matched[i];

			if (typeof record.beforeEnter !== "function") {
				continue;
			}

			const result = await record.beforeEnter({
				to,
				from,
				signal,
				context,
			});

			if (signal.aborted) {
				return { type: "cancelled" };
			}

			if (result === false) {
				return { type: "cancelled" };
			}

			if (result === true || result === undefined) {
				continue;
			}

			if (
				typeof result === "string" ||
				(result &&
					typeof result === "object" &&
					typeof result.path === "string")
			) {
				return {
					type: "redirect",
					target: resolveTarget(result),
				};
			}

			throw new TypeError(
				`[Udodi Router] Guard for "${record.path}" returned an unsupported result.`,
			);
		}

		return { type: "continue" };
	}

	/**
	 * Run route loaders in parent-to-child order.
	 *
	 * Results are keyed by the original route-record objects.
	 *
	 * @param {RouteRecord[]} records
	 * @param {Object<string, string>} params
	 * @param {Object<string, string>} query
	 * @param {AbortSignal} signal
	 * @returns {Promise<Map<RouteRecord, *>>}
	 */
	async function runLoaders(records, params, query, signal) {
		/** @type {Map<RouteRecord, *>} */
		const results = new Map();

		for (let i = 0; i < records.length; i++) {
			if (signal.aborted) {
				throw getAbortError(signal);
			}

			const record = records[i];
			let data;

			if (typeof record.loader === "function") {
				data = await record.loader({
					params,
					query,
					signal,
					context,
				});
			}

			if (signal.aborted) {
				throw getAbortError(signal);
			}

			results.set(record, data);
		}

		return results;
	}

	/**
	 * Restore the browser URL to the currently committed route.
	 *
	 * Used after a cancelled or failed history traversal. `history.replace()`
	 * preserves the entry key (see history.js). An optional outgoing snapshot
	 * is written so a blocked Back/Forward does not lose that page's scroll.
	 *
	 * @param {ScrollSnapshot|null} [outgoingSnapshot=null]
	 * @returns {void}
	 */
	function restoreCommittedURL(outgoingSnapshot = null) {
		if (disposed) {
			return;
		}

		if (outgoingSnapshot) {
			storeScrollPosition(
				outgoingSnapshot.key,
				outgoingSnapshot.position,
			);
		}

		writingHistory = true;

		try {
			history.replace(routeState.fullPath);
		} catch {
			// Preserve the original navigation outcome.
		} finally {
			writingHistory = false;

			const location = history.location();

			if (location?.key != null) {
				activeHistoryKey = location.key;
			}
		}
	}

	/**
	 * Apply scroll behavior after the destination view has rendered.
	 *
	 * Returning `false`, `null`, or `undefined` leaves the current position
	 * unchanged. With `el`, numeric `top` is an offset from the element's
	 * document position. Without `el`, `top` is an absolute scroll position.
	 *
	 * @param {RouteState} to Destination route state.
	 * @param {RouteState|null} from Previously committed route state.
	 * @param {{top: number, left: number}|null} savedPosition
	 *   Position saved for a history traversal, or `null`.
	 * @returns {Promise<void>}
	 */
	async function applyScrollBehavior(to, from, savedPosition) {
		if (!scrollBehavior || typeof window === "undefined") {
			return;
		}

		try {
			await viewFactory?.afterRender?.();

			const result = await scrollBehavior(to, from, savedPosition);

			if (result == null || result === false) {
				return;
			}

			if (typeof result.el === "string") {
				let element = null;

				try {
					// Selectors from hashes / app config can be invalid CSS
					// (e.g. leading digits). Never let querySelector throw out
					// of the post-commit scroll path.
					element = document.querySelector(result.el);
				} catch {
					element = null;
				}

				if (element) {
					if (typeof result.top === "number") {
						const documentTop =
							element.getBoundingClientRect().top +
							(window.scrollY ?? window.pageYOffset ?? 0);

						window.scrollTo({
							left:
								result.left ??
								(window.scrollX ?? window.pageXOffset ?? 0),
							top: documentTop - result.top,
						});

					} else {
						element.scrollIntoView();
					}

					return;
				}
			}

			window.scrollTo({
				left: result.left ?? 0,
				top: result.top ?? 0,
			});

		} catch (error) {
			// Scrolling is post-commit and cannot roll back navigation.
			if (
				typeof console !== "undefined" &&
				typeof console.warn === "function"
			) {
				console.warn(
					"[Udodi Router] scrollBehavior failed after navigation committed.",
					error,
				);
			}
		}
	}

	/**
	 * Run one navigation transaction.
	 *
	 * Redirects preserve the original history intent and outgoing snapshot.
	 * Only the outermost call may resolve `router.ready`.
	 *
	 * @param {string|object} to
	 * @param {{
	 *   replace?: boolean,
	 *   fromHistory?: boolean,
	 *   initial?: boolean,
	 *   historyKey?: string,
	 *   redirectChain?: Set<string>,
	 *   redirectedFrom?: string,
	 *   historyAction?: HistoryAction,
	 *   outgoingSnapshot?: ScrollSnapshot|null
	 * }} [navOptions]
	 * @returns {Promise<NavigationResult>}
	 */
	async function navigate(to, navOptions = {}) {
		if (disposed) {
			return {
				type: "error",
				error: new Error("[Udodi Router] Router has been destroyed."),
			};
		}

		let target;

		try {
			target = resolveTarget(to);

		} catch (error) {
			const err = toError(error);

			routeState.error = err;

			const result = { type: "error", error: err };

			if (navOptions.initial) {
				resolveReady(result);
			}

			return result;
		}

		const redirectChain = navOptions.redirectChain || new Set();

		if (redirectChain.has(target) || redirectChain.size >= 20) {
			const error = new Error(
				`[Udodi Router] Redirect loop detected at "${target}".`,
			);

			routeState.error = error;

			const result = { type: "error", error };

			if (navOptions.initial) {
				resolveReady(result);
			}

			return result;
		}

		const navigationId = ++currentNavigationId;

		/** @type {HistoryAction} */
		const historyAction =
			navOptions.historyAction ||
			(navOptions.initial
				? "initial"
				: navOptions.fromHistory
					? "traverse"
					: navOptions.replace
						? "replace"
						: "push");

		/**
		 * Snapshot the outgoing page synchronously without mutating the map.
		 * Redirect children inherit this snapshot.
		 *
		 * @type {ScrollSnapshot|null}
		 */
		let outgoingScroll = navOptions.outgoingSnapshot !== undefined
			? navOptions.outgoingSnapshot
			: null;

		if (
			navOptions.outgoingSnapshot === undefined &&
			!navOptions.initial &&
			activeHistoryKey != null
		) {
			const position = readWindowScrollPosition();

			if (position) {
				outgoingScroll = {
					key: activeHistoryKey,
					position,
				};
			}
		}

		cancelActiveNavigation();

		const abortController = new AbortController();

		activeAbortController = abortController;

		const { signal } = abortController;
		const from = getCurrentRouteSnapshot();
		const resolved = resolveLocation(target);

		routeState.pending = true;
		routeState.error = null;

		/** @type {NavigationResult|undefined} */
		let outcome;

		/**
		 * @returns {NavigationResult}
		 */
		function cancelledResult() {
			return { type: "cancelled" };
		}

		try {
			const matchResult = match(resolved.path);

			if (!matchResult) {
				throw new Error(
					`[Udodi Router] No route matches "${resolved.path}".`,
				);
			}

			const matchedRecords = matchResult.matched;
			const params = matchResult.params;

			const toRoute = {
				path: matchResult.path,
				fullPath: resolved.fullPath,
				params,
				query: resolved.query,
				hash: resolved.hash,
				matched: matchedRecords,
				meta: Object.create(null),
				data: undefined,
			};

			const guardResult = await runGuards(
				matchedRecords,
				toRoute,
				from,
				signal,
			);

			if (!isCurrentNavigation(navigationId) || signal.aborted) {
				outcome = cancelledResult();
				return outcome;
			}

			if (guardResult.type === "cancelled") {
				outcome = cancelledResult();

				if (historyAction === "traverse") {
					restoreCommittedURL(outgoingScroll);
				}

				return outcome;
			}

			if (guardResult.type === "redirect") {
				const redirectTo = guardResult.target;

				if (redirectChain.has(redirectTo)) {
					throw new Error(
						`[Udodi Router] Redirect loop detected at "${redirectTo}".`,
					);
				}

				redirectChain.add(target);

				// Keep original history intent and outgoing snapshot.
				// Do not pass initial: true — only the outermost call owns ready.
				const redirectResult = await navigate(redirectTo, {
					redirectChain,
					redirectedFrom: navOptions.redirectedFrom || target,
					historyKey: navOptions.historyKey,
					historyAction,
					outgoingSnapshot: outgoingScroll,
					fromHistory: historyAction === "traverse",
					replace: historyAction === "replace",
				});

				outcome = redirectResult.type === "completed"
					? {
							type: "redirected",
							route: redirectResult.route,
							redirectTo,
						}
					: redirectResult;

				return outcome;
			}

			const loaderData = await runLoaders(
				matchedRecords,
				params,
				resolved.query,
				signal,
			);

			if (!isCurrentNavigation(navigationId) || signal.aborted) {
				outcome = cancelledResult();
				return outcome;
			}

			const componentDefinitions = new Map();

			for (let i = 0; i < matchedRecords.length; i++) {
				const record = matchedRecords[i];

				if (typeof record.loadComponent === "function") {
					const definition = await resolveComponent(record, signal);
					componentDefinitions.set(record, definition);

				} else if (record.component != null) {
					componentDefinitions.set(record, record.component);
				}

				if (!isCurrentNavigation(navigationId) || signal.aborted) {
					outcome = cancelledResult();
					return outcome;
				}
			}

			const meta = await resolveMetadata(
				matchedRecords,
				params,
				loaderData,
				context,
				metaDefaults,
			);

			if (!isCurrentNavigation(navigationId) || signal.aborted) {
				outcome = cancelledResult();
				return outcome;
			}

			const matched = createMatchedEntries(matchedRecords, loaderData);

			for (let i = 0; i < matched.length; i++) {
				const record = matched[i].record;

				if (componentDefinitions.has(record)) {
					matched[i].resolvedComponent = componentDefinitions.get(record);
				}
			}

			const leafRecord = matchedRecords[matchedRecords.length - 1];

			const next = {
				path: matchResult.path,
				fullPath: resolved.fullPath,
				params,
				query: resolved.query,
				hash: resolved.hash,
				matched,
				meta,
				data: leafRecord && loaderData.has(leafRecord)
					? loaderData.get(leafRecord)
					: undefined,
			};

			if (!isCurrentNavigation(navigationId) || signal.aborted) {
				outcome = cancelledResult();
				return outcome;
			}

			/** @type {HistoryAction} */
			let appliedHistoryAction = "none";

			// Destination saved position for Back/Forward (and traversal redirects).
			// history.replace() preserves the entry key (history.js contract).
			const traversalKey = navOptions.historyKey ?? history.location()?.key ?? null;

			const savedPosition = historyAction === "traverse"
				? getSavedPosition(traversalKey)
				: null;

			if (historyAction === "push") {
				const current = history.location();

				if (!current || current.fullPath !== target) {
					writingHistory = true;

					try {
						history.push(target);
						appliedHistoryAction = "push";
					} finally {
						writingHistory = false;
					}
				}

			} else if (historyAction === "replace") {
				writingHistory = true;

				try {
					history.replace(target);
					appliedHistoryAction = "replace";
				} finally {
					writingHistory = false;
				}

			} else if (
				(historyAction === "traverse" || historyAction === "initial") &&
				navOptions.redirectedFrom
			) {
				// The browser already selected the traversal entry, or this is
				// the initial URL. Replace that entry with the final redirect
				// target; the adapter keeps the same key.
				writingHistory = true;

				try {
					history.replace(target);
					appliedHistoryAction = "replace";
				} finally {
					writingHistory = false;
				}
			}

			if (!isCurrentNavigation(navigationId) || signal.aborted) {
				outcome = cancelledResult();
				return outcome;
			}

			commit(next);

			// Head updates and analytics are post-commit side effects.
			// They must not turn a committed navigation into a failed navigation.
			//
			// Script policy (from head.js):
			// - once: true (default): install once per document identity; skip on return visits
			// - once: false: remove previous node for this routeKey+identity and re-insert
			try {
				// routeKey is route-level (pathname only) so query/hash changes
				// do not accumulate separate once:false script nodes.
				// url is an absolute href for analytics when a browser origin exists.
				let pageUrl = next.fullPath;

				if (
					typeof globalThis !== "undefined" &&
					globalThis.window?.location?.origin
				) {
					try {
						pageUrl = new URL(
							next.fullPath,
							globalThis.window.location.origin,
						).href;
					} catch {
						pageUrl = next.fullPath;
					}
				}

				headManager.apply(normalizeMeta(next.meta), {
					routeKey: next.path,
					url: pageUrl,
				});
			} catch (error) {
				if (
					typeof console !== "undefined" &&
					typeof console.error === "function"
				) {
					console.error(
						"[Udodi Router] Failed to apply document metadata after navigation committed.",
						error,
					);
				}
			}

			// Persist outgoing scroll when that stack entry remains reachable.
			// Ordinary replace reuses the key — do not keep the old offset.
			// Traversal leaves the previous entry on the stack even when a
			// redirect replaces the selected entry's URL.
			if (
				outgoingScroll &&
				(appliedHistoryAction !== "replace" ||
					historyAction === "traverse")
			) {
				storeScrollPosition(
					outgoingScroll.key,
					outgoingScroll.position,
				);
			}

			const committedLocation = history.location();

			activeHistoryKey =
				committedLocation?.key ??
				navOptions.historyKey ??
				activeHistoryKey;

			// Ordinary replace: drop obsolete position for the reused key.
			// Traversal redirect: keep the selected entry's saved position.
			if (
				appliedHistoryAction === "replace" &&
				historyAction !== "traverse"
			) {
				const replacedKey = committedLocation?.key;

				if (replacedKey != null) {
					savedPositions.delete(replacedKey);
				}
			}

			outcome = { type: "completed", route: routeState };

			await applyScrollBehavior(routeState, from, savedPosition);

			return outcome;

		} catch (error) {
			if (!isCurrentNavigation(navigationId) || signal.aborted) {
				outcome = cancelledResult();

				return outcome;
			}

			const err = toError(error);

			routeState.pending = false;
			routeState.error = err;

			if (historyAction === "traverse") {
				restoreCommittedURL(outgoingScroll);
			}

			outcome = { type: "error", error: err };
			return outcome;

		} finally {
			if (isCurrentNavigation(navigationId)) {
				activeAbortController = null;
				routeState.pending = false;
			}

			// Only the outermost navigation owns router.ready.
			if (navOptions.initial) {
				resolveReady(outcome || cancelledResult());
			}
		}
	}

	/**
	 * Check whether a target pathname is active.
	 *
	 * Exact matching compares normalized pathnames. Non-exact matching checks
	 * the committed matched-route hierarchy.
	 *
	 * @param {string} targetPath
	 * @param {boolean} [exact=false]
	 * @returns {boolean}
	 */
	function isActive(targetPath, exact = false) {
		const path = normalizePathname(
			splitLocation(targetPath || "/").pathname,
		);

		void routeState.activeVersion;

		if (exact) {
			return routeState.path === path;
		}

		return activeMap[path] === true;
	}

	/**
	 * Handle navigation initiated by the history adapter.
	 *
	 * @param {{fullPath: string, key?: string}|null} location
	 * @returns {Promise<NavigationResult>|undefined}
	 */
	function onHistoryChange(location) {
		if (disposed || writingHistory || !location) {
			return;
		}

		return navigate(location.fullPath, {
			fromHistory: true,
			historyKey: location.key,
			historyAction: "traverse",
		});
	}

	stopHistoryListen = history.listen(onHistoryChange);

	const initial = history.location();

	if (initial) {
		activeHistoryKey = initial.key ?? null;

		void navigate(initial.fullPath, {
			initial: true,
			historyKey: initial.key,
			historyAction: "initial",
		});

	} else {
		const error = new Error(
			"[Udodi Router] Current browser URL is outside the configured history base.",
		);

		routeState.error = error;
		resolveReady({ type: "error", error });
	}

	const router = {
		/** Reactive committed route state. */
		route: routeState,

		/** Resolves once with the initial navigation attempt's result. */
		ready,

		/**
		 * Navigate and push a history entry after successful preparation.
		 *
		 * @param {string|object} to
		 * @returns {Promise<NavigationResult>}
		 */
		push(to) {
			return navigate(to, { historyAction: "push" });
		},

		/**
		 * Navigate and replace the current history entry after preparation.
		 *
		 * @param {string|object} to
		 * @returns {Promise<NavigationResult>}
		 */
		replace(to) {
			return navigate(to, {
				replace: true,
				historyAction: "replace",
			});
		},

		/** @returns {void} */
		back() {
			if (!disposed) {
				history.back();
			}
		},

		/** @returns {void} */
		forward() {
			if (!disposed) {
				history.forward();
			}
		},

		/**
		 * Move through the history stack.
		 *
		 * @param {number} delta
		 * @returns {void}
		 */
		go(delta) {
			if (!disposed) {
				history.go(delta);
			}
		},

		/** @type {(path: string, exact?: boolean) => boolean} */
		isActive,

		/** Composition-first link component factory, assigned below. */
		Link: null,

		/** Route outlet component factory, assigned below. */
		RouterView: null,

		/**
		 * Dispose router work and listeners.
		 *
		 * An internally created history adapter is destroyed by this router.
		 * Externally supplied adapters are left intact.
		 *
		 * @returns {void}
		 */
		destroy() {
			if (disposed) {
				return;
			}

			disposed = true;
			currentNavigationId++;
			cancelActiveNavigation();
			viewFactory?.destroy();
			headManager.destroy();

			if (
				previousScrollRestoration !== null &&
				typeof window !== "undefined" &&
				"scrollRestoration" in window.history
			) {
				window.history.scrollRestoration = previousScrollRestoration;
				previousScrollRestoration = null;
			}

			savedPositions.clear();
			activeHistoryKey = null;

			if (stopHistoryListen) {
				stopHistoryListen();
				stopHistoryListen = null;
			}

			if (ownsHistory && typeof history.destroy === "function") {
				history.destroy();
			}

			componentCache.clear();
			resolvedComponents.clear();
			activeKeys.length = 0;

			for (const key of Object.keys(activeMap)) {
				delete activeMap[key];
			}

			routeState.pending = false;
		},
	};

	const linkFactory = createLinkFactory(router, { base });

	viewFactory = createViewFactory(router, {
		getComponent: getResolvedComponent,
		maxKeepAlive: options.maxKeepAlive ?? 10,
	});

	router.Link = linkFactory;
	router.RouterView = viewFactory.RouterView;

	return router;
}
