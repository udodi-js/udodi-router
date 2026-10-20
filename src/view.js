
import { createComponent, effect, render } from "udodi";

/**
 * Maximum number of inactive route views retained by default.
 *
 * @type {number}
 */
const DEFAULT_MAX_KEEP_ALIVE = 10;

/**
 * DOM attribute identifying a route-view host and its matched depth.
 *
 * Nested RouterView instances use this attribute to determine which
 * entry in router.route.matched they are responsible for rendering.
 *
 * @type {string}
 */
const VIEW_DEPTH_ATTR = "data-udodi-route-depth";

/**
 * Internal representation of a mounted route view.
 *
 * @typedef {Object} RouteViewEntry
 * @property {object} record Original route record used as cache identity.
 * @property {object} routeEntry Latest committed matched entry for the record.
 * @property {HTMLElement} host DOM host for the route component.
 * @property {{ context?: object, unmount: Function }|null} instance
 * Mounted Udodi component instance.
 */

/**
 * Creates the RouterView component factory and its view lifecycle manager.
 *
 * Route components are rendered through Udodi's public render() API.
 * Each outlet manages its own active view and keep-alive cache.
 *
 * Original route records are used as cache identities. A parameter change on the
 * same route record reuses that record's view; navigating to a different
 * record creates, restores, or destroys the corresponding view.
 *
 * Lazy component resolution must happen before the route is committed.
 * getComponent() is therefore synchronous and must return an already-
 * resolved component factory.
 *
 * @param {object} router
 * @param {object} options
 * @param {(record: object) => Function} options.getComponent
 * Returns the resolved Udodi component factory for a route record.
 * @param {number} [options.maxKeepAlive=10]
 * Maximum number of inactive views retained per outlet.
 * Use 0 to disable view caching.
 * @returns {{ RouterView: Function, afterRender: () => Promise<void>, destroy: Function }}
 */
export function createViewFactory(
	router,
	{
		getComponent,
		maxKeepAlive = DEFAULT_MAX_KEEP_ALIVE,
	} = {},
) {
	if (!router || !router.route) {
		throw new TypeError(
			"createViewFactory() requires a router with reactive route state.",
		);
	}

	if (typeof getComponent !== "function") {
		throw new TypeError(
			"createViewFactory() requires a getComponent() function.",
		);
	}

	if (
		!Number.isInteger(maxKeepAlive) ||
		maxKeepAlive < 0
	) {
		throw new TypeError(
			"maxKeepAlive must be a non-negative integer.",
		);
	}

	/**
	 * All mounted outlet managers belonging to this router.
	 *
	 * Router disposal clears active views and retained views even when
	 * an outlet has not yet been unmounted by the application.
	 *
	 * @type {Set<Function>}
	 */
	const outlets = new Set();

	/**
	 * Creates one RouterView component definition.
	 *
	 * The outlet root is deliberately a simple element. Route components
	 * are mounted into dedicated hosts inside it, allowing retained views
	 * to stay connected to the DOM while inactive.
	 */
	const RouterViewComponent = createComponent({
		name: "RouterView",

		template: "<div data-udodi-router-view></div>",

		onMount(root, ctx) {
			/**
			 * Determine this outlet's depth from its enclosing route host.
			 *
			 * The application-level outlet has depth 0. An outlet inside
			 * the component rendered at depth 0 has depth 1, and so on.
			 */
			const parentHost = root.parentElement?.closest(
				`[${VIEW_DEPTH_ATTR}]`,
			);

			const depth = parentHost
				? Number(parentHost.getAttribute(VIEW_DEPTH_ATTR)) + 1
				: 0;

			/**
			 * Mounted route views retained by this outlet.
			 *
			 * Keys are original route-record objects. Parameter changes
			 * on the same record reuse the same component instance.
			 *
			 * Map insertion order provides the LRU eviction order.
			 *
			 * @type {Map<object, RouteViewEntry>}
			 */
			const cache = new Map();

			/** @type {RouteViewEntry|null} */
			let activeEntry = null;

			let disposed = false;
			let stopEffect = null;

			/**
			 * Creates a host for one route component.
			 *
			 * display: contents keeps the host from introducing a normal
			 * layout box. The host remains in the DOM while cached, so
			 * Udodi's detached-root cleanup does not destroy its instance.
			 *
			 * @param {object} record
			 * @returns {HTMLElement}
			 */
			function createHost(routeEntry) {
				const host = document.createElement("div");

				host.setAttribute(VIEW_DEPTH_ATTR, String(depth));
				host.setAttribute("data-udodi-route-view", "");
				host.setAttribute("data-udodi-route-path", routeEntry.path || "");

				host.hidden = true;
				host.style.display = "none";

				return host;
			}

			/**
			 * Show or hide a route-view host.
			 *
			 * @param {RouteViewEntry} entry
			 * @param {boolean} visible
			 */
			function setVisible(entry, visible) {
				entry.host.hidden = !visible;
				entry.host.style.display = visible ? "contents" : "none";
			}

			/**
			 * Invoke an optional route-view lifecycle method exposed by
			 * the component's public context.
			 *
			 * Components can define these as ordinary methods:
			 *
			 * methods: {
			 *   onRouteActivate(route) {},
			 *   onRouteDeactivate(route) {}
			 * }
			 *
			 * These are router notifications, not replacements for
			 * Udodi's normal onMount() and onUnmount() lifecycle hooks.
			 *
			 * @param {RouteViewEntry} entry
			 * @param {"onRouteActivate"|"onRouteDeactivate"} name
			 */
			function callViewHook(entry, name) {
				const hook = entry.instance?.context?.[name];

				if (typeof hook === "function") {
					hook(router.route);
				}
			}

			/**
			 * Destroys a route view through Udodi's normal unmount path.
			 *
			 * @param {RouteViewEntry} entry
			 */
			function destroyEntry(entry) {
				try {
					entry.instance?.unmount();
				} finally {
					entry.host.remove();
					entry.instance = null;
				}
			}

			/**
			 * Retains an inactive view and evicts the least-recently-used
			 * entries when the configured cache limit is exceeded.
			 *
			 * @param {RouteViewEntry} entry
			 */
			function retainEntry(entry) {
				if (
					entry.record.keepAlive !== true ||
					maxKeepAlive === 0
				) {
					destroyEntry(entry);
					return;
				}

				setVisible(entry, false);
				callViewHook(entry, "onRouteDeactivate");

				cache.delete(entry.record);
				cache.set(entry.record, entry);

				while (cache.size > maxKeepAlive) {
					const oldest = cache.entries().next().value;

					if (!oldest) break;

					const [record, evictedEntry] = oldest;

					cache.delete(record);
					destroyEntry(evictedEntry);
				}
			}

			/**
			 * Returns a cached view and marks it as recently used.
			 *
			 * @param {object} record
			 * @returns {RouteViewEntry|undefined}
			 */
			function getCachedEntry(record) {
				const entry = cache.get(record);

				if (!entry) return undefined;

				cache.delete(record);
				cache.set(record, entry);

				return entry;
			}

			/**
			 * Creates and mounts a route component in a new host.
			 *
			 * This is intentionally completed before the previous active
			 * view is deactivated. If mounting fails, the current view
			 * remains available.
			 *
			 * The navigation layer must have resolved lazy components
			 * before committing the target route.
			 *
			 * @param {object} record
			 * @returns {RouteViewEntry}
			 */
			function createEntry(routeEntry) {
				const record = routeEntry.record || routeEntry;
				const componentFactory = getComponent(routeEntry);

				if (typeof componentFactory !== "function") {
					throw new TypeError(
						`[udodi-router] Route "${routeEntry.path}" does not have a resolved component factory.`,
					);
				}

				const host = createHost(routeEntry);

				// Insert the host before rendering so nested RouterView
				// instances can determine their matched depth.
				root.appendChild(host);

				/** @type {RouteViewEntry} */
				const entry = {
					record,
					routeEntry,
					host,
					instance: null,
				};

				try {
					entry.instance = render(
						componentFactory(),
						host,
					);
				} catch (error) {
					host.remove();
					throw error;
				}

				return entry;
			}

			/**
			 * Activates a view, optionally notifying a previously
			 * retained component that it has resumed.
			 *
			 * @param {RouteViewEntry} entry
			 * @param {boolean} resumed
			 */
			function activateEntry(entry, resumed) {
				setVisible(entry, true);
				activeEntry = entry;

				if (resumed) {
					callViewHook(entry, "onRouteActivate");
				}
			}

			/**
			 * Deactivates the current view.
			 *
			 * A view is retained only when its own route record opts in.
			 * Otherwise it is unmounted immediately.
			 */
			function deactivateActiveEntry() {
				if (!activeEntry) return;

				const previous = activeEntry;
				activeEntry = null;

				retainEntry(previous);
			}

			/**
			 * Synchronizes this outlet with the committed matched chain.
			 *
			 * A parent layout stays mounted while its record remains at
			 * this depth. Its nested outlet independently manages the
			 * next record in the matched chain.
			 */
			function syncView() {
				if (disposed) return;

				const route = router.route;
				const matched = route.matched;
				const nextRouteEntry = Array.isArray(matched)
					? matched[depth] ?? null
					: null;

				if (nextRouteEntry === null) {
					deactivateActiveEntry();
					return;
				}

				const nextRecord = nextRouteEntry.record || nextRouteEntry;

				// Matched entries are recreated on each commit. Use the
				// original route record as the stable view identity.
				if (activeEntry && activeEntry.record === nextRecord) {
					activeEntry.routeEntry = nextRouteEntry;
					return;
				}

				// Try the cache first. If the view is not cached, mount
				// the target before deactivating the current active view.
				let nextEntry = getCachedEntry(nextRecord);
				const resumed = nextEntry !== undefined;

				if (!nextEntry) {
					nextEntry = createEntry(nextRouteEntry);
				} else {
					nextEntry.routeEntry = nextRouteEntry;
				}

				deactivateActiveEntry();
				activateEntry(nextEntry, resumed);
			}

			/**
			 * Releases this outlet and all views it owns.
			 *
			 * Idempotent because router disposal and component unmount
			 * may both attempt to release the same outlet.
			 */
			function disposeOutlet() {
				if (disposed) return;

				disposed = true;

				stopEffect?.();
				stopEffect = null;

				if (activeEntry) {
					const entry = activeEntry;
					activeEntry = null;
					destroyEntry(entry);
				}

				for (const entry of cache.values()) {
					destroyEntry(entry);
				}

				cache.clear();
				outlets.delete(disposeOutlet);
			}

			outlets.add(disposeOutlet);

			// Register cleanup before the immediate first effect run. If the
			// initial route component fails to mount, the outlet still has a
			// cleanup path for its manager and any views already created.
			ctx.cleanup(disposeOutlet);

			// Depend on committed route state. The route object uses
			// shallow reactivity, so navigation replaces matched at commit.
			stopEffect = effect(() => {
				void router.route.fullPath;
				syncView();
			});
		},
	});

	/**
	 * Creates a RouterView placeholder for use in Udodi templates.
	 *
	 * @returns {string}
	 */
	function RouterView() {
		return RouterViewComponent();
	}

	/**
	 * Wait until queued reactive effects have run and the browser has had a
	 * rendering opportunity. Navigation uses this before applying scroll
	 * behavior so destination content is present and layout can be measured.
	 *
	 * @returns {Promise<void>}
	 */
	function afterRender() {
		return new Promise((resolve) => {
			queueMicrotask(() => {
				if (typeof requestAnimationFrame === "function") {
					requestAnimationFrame(() => resolve());
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Destroys all outlet managers and their retained views.
	 *
	 * Call from router.destroy(). Normal component unmounting remains
	 * safe because outlet disposal is idempotent.
	 */
	function destroy() {
		for (const disposeOutlet of [...outlets]) {
			disposeOutlet();
		}
	}

	return {
		RouterView,
		afterRender,
		destroy,
	};
}
