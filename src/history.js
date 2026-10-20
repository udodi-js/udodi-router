/**
 * @fileoverview History adapters for Udodi Router.
 *
 * HTML5 and hash history attach a stable key to each browser history entry.
 * The router uses these keys to associate saved scroll positions with the
 * correct entry during Back/Forward navigation. Memory history implements the
 * same contract for deterministic tests and non-browser environments.
 *
 * @module history
 */

/**
 * @typedef {Object} HistoryLocation
 * @property {string} pathname Application-relative pathname.
 * @property {string} search Query string including `?`, or an empty string.
 * @property {string} hash Fragment including `#`, or an empty string.
 * @property {string} fullPath Complete application path including query and hash.
 * @property {string} key Stable identity for this history entry.
 */

/**
 * @typedef {Object} HistoryAdapter
 * @property {() => HistoryLocation|null} location
 * Returns the current location, or `null` when it falls outside the configured
 * base. Throws if the adapter has been destroyed.
 *
 * @property {(to: string) => void} push
 * Pushes a new history entry and notifies listeners.
 *
 * @property {(to: string) => void} replace
 * Replaces the current history entry and notifies listeners.
 *
 * @property {(delta: number) => void} go
 * Traverses the history by the specified integer delta.
 *
 * @property {() => void} back
 * Traverses to the previous history entry.
 *
 * @property {() => void} forward
 * Traverses to the next history entry.
 *
 * @property {(listener: (location: HistoryLocation) => void) => () => void} listen
 * Subscribes to location changes and returns an unsubscribe function.
 *
 * @property {() => void} destroy
 * Removes listeners and releases adapter resources. Safe to call repeatedly.
 */

/**
 * @typedef {Object} HistoryOptions
 * @property {string} [base=""] Application base path.
 */

/**
 * @typedef {Object} MemoryHistoryOptions
 * @property {string} [base=""] Reserved for a consistent history-options shape.
 * @property {string} [initial="/"] Initial application path.
 */

const HISTORY_KEY = "__udodi_router_entry_key__";
let keySequence = 0;

/**
 * Generates a unique key for a history entry.
 *
 * The key remains associated with an entry as the user navigates away from it
 * and later returns through Back/Forward navigation.
 *
 * @returns {string} A new history-entry key.
 * @private
 */
function createKey() {
	keySequence = (keySequence + 1) % Number.MAX_SAFE_INTEGER;

	return `udodi-${Date.now().toString(36)}-${keySequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalizes an application base path.
 *
 * Leading and trailing slashes are removed before a single leading slash is
 * added. Empty bases and `/` normalize to an empty string.
 *
 * @param {string} [base=""] Base path to normalize.
 * @returns {string} Normalized base path.
 * @throws {TypeError} If the base is not a string or contains a query, hash,
 * or dot segments.
 * @private
 */
function normalizeBase(base = "") {
	if (typeof base !== "string") {
		throw new TypeError("[Udodi Router] History base must be a string.");
	}

	const value = base.trim();

	if (!value || value === "/") {
		return "";
	}

	if (value.includes("?") || value.includes("#")) {
		throw new TypeError(
			"[Udodi Router] History base must not contain a query or hash.",
		);
	}

	const normalized = `/${value.replace(/^\/+|\/+$/g, "")}`.replace(
		/\/{2,}/g,
		"/",
	);

	if (
		normalized
			.split("/")
			.some((segment) => segment === "." || segment === "..")
	) {
		throw new TypeError(
			"[Udodi Router] History base must not contain dot segments.",
		);
	}

	return normalized;
}

/**
 * Creates a normalized location object.
 *
 * Ensures that query strings and fragments include their expected prefixes
 * and constructs `fullPath` from the normalized location parts.
 *
 * @param {string} pathname Application-relative pathname.
 * @param {string} [search=""] Query string, with or without `?`.
 * @param {string} [hash=""] Fragment, with or without `#`.
 * @param {string} [key=createKey()] History-entry identity.
 * @returns {HistoryLocation} Normalized location.
 * @private
 */
function createLocation(pathname, search = "", hash = "", key = createKey()) {
	const path = pathname || "/";
	const query = search
		? search.startsWith("?")
			? search
			: `?${search}`
		: "";
	const fragment = hash
		? hash.startsWith("#")
			? hash
			: `#${hash}`
		: "";

	return {
		pathname: path,
		search: query,
		hash: fragment,
		fullPath: `${path}${query}${fragment}`,
		key,
	};
}

/**
 * Parses and validates an application-relative navigation target.
 *
 * The pathname must begin with exactly one leading slash. Query strings and
 * fragments are separated from the pathname before returning the result.
 *
 * @param {string} to Navigation target.
 * @returns {{pathname: string, search: string, hash: string}} Parsed path parts.
 * @throws {TypeError} If the target is not a string or is not an absolute
 * application path.
 * @private
 */
function parsePath(to) {
	if (typeof to !== "string") {
		throw new TypeError("[Udodi Router] History target must be a string.");
	}

	let pathname = to || "/";
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
			`[Udodi Router] History target must be an absolute application path: "${to}".`,
		);
	}

	return { pathname, search, hash };
}

/**
 * Removes the configured base from a browser pathname.
 *
 * A pathname outside the base returns `null`. A pathname equal to the base
 * resolves to `/`.
 *
 * @param {string} browserPathname Browser pathname.
 * @param {string} base Normalized base path.
 * @returns {string|null} Application-relative pathname, or `null` when outside
 * the base.
 * @private
 */
function stripBase(browserPathname, base) {
	const pathname = browserPathname || "/";

	if (!base) {
		return pathname;
	}

	if (pathname === base) {
		return "/";
	}

	if (!pathname.startsWith(`${base}/`)) {
		return null;
	}

	return pathname.slice(base.length) || "/";
}

/**
 * Prefixes an application pathname with the configured base.
 *
 * @param {string} pathname Application-relative pathname.
 * @param {string} base Normalized base path.
 * @returns {string} Browser pathname including the base.
 * @private
 */
function applyBase(pathname, base) {
	if (!base) {
		return pathname || "/";
	}

	if (pathname === "/") {
		return base;
	}

	return `${base}${pathname}`;
}

/**
 * Notifies a snapshot of the current listener set.
 *
 * Iterating over a snapshot prevents subscriptions or unsubscriptions during
 * notification from changing the listeners visited by the current dispatch.
 *
 * @param {Set<Function>} listeners Registered location listeners.
 * @param {HistoryLocation} location Current location.
 * @returns {void}
 * @private
 */
function notifyListeners(listeners, location) {
	for (const listener of [...listeners]) {
		listener(location);
	}
}

/**
 * Creates a location-listener subscription function.
 *
 * @param {Set<Function>} listeners Registered location listeners.
 * @param {() => boolean} isDestroyed Checks whether the adapter was destroyed.
 * @returns {(listener: (location: HistoryLocation) => void) => () => void}
 * A function that subscribes to location changes and returns an unsubscribe
 * function.
 * @private
 */
function createListen(listeners, isDestroyed) {
	return function listen(listener) {
		if (isDestroyed()) {
			throw new Error(
				"[Udodi Router] Cannot subscribe to destroyed history.",
			);
		}

		if (typeof listener !== "function") {
			throw new TypeError(
				"[Udodi Router] History listener must be a function.",
			);
		}

		listeners.add(listener);

		let subscribed = true;

		return () => {
			if (!subscribed) {
				return;
			}

			subscribed = false;
			listeners.delete(listener);
		};
	};
}

/**
 * Ensures that a history adapter has not been destroyed.
 *
 * @param {boolean} destroyed Whether the adapter has been destroyed.
 * @returns {void}
 * @throws {Error} If the adapter has been destroyed.
 * @private
 */
function assertActive(destroyed) {
	if (destroyed) {
		throw new Error("[Udodi Router] History adapter has been destroyed.");
	}
}

/**
 * Creates a history state object containing the entry key.
 *
 * Existing state properties are preserved when the state is an object.
 * A fresh object is returned so the caller does not mutate the original state.
 *
 * @param {*} state Existing browser history state.
 * @param {string} key History-entry key.
 * @returns {Object} A state object containing the Udodi entry key.
 * @private
 */
function stateWithKey(state, key) {
	const next = state && typeof state === "object" ? { ...state } : {};

	next[HISTORY_KEY] = key;

	return next;
}

/**
 * Reads the current browser history-entry key, assigning one if missing.
 *
 * The current entry is updated with `replaceState` when it does not already
 * have a valid key. This preserves the current URL and history-stack position.
 *
 * @returns {string} The current history-entry key.
 * @private
 */
function readOrAssignBrowserKey() {
	const state = window.history.state;
	const key = state && typeof state[HISTORY_KEY] === "string"
		? state[HISTORY_KEY]
		: null;

	if (key) {
		return key;
	}

	const nextKey = createKey();

	window.history.replaceState(
		stateWithKey(state, nextKey),
		"",
		window.location.href,
	);

	return nextKey;
}

/**
 * Creates an HTML5 History API adapter.
 *
 * Uses `pushState`, `replaceState`, and `popstate` to manage navigation.
 * Each browser history entry receives a stable key used by the router to
 * associate saved scroll positions with that entry.
 *
 * The configured base is stripped from browser locations and added to
 * application-relative navigation targets.
 *
 * @param {HistoryOptions} [options={}] Adapter configuration.
 * @param {string} [options.base=""] Application base path.
 * @returns {HistoryAdapter} HTML5 history adapter.
 * @throws {Error} If called outside a browser environment.
 * @throws {TypeError} If the base path is invalid.
 * @public
 */
function createWebHistory({ base = "" } = {}) {
	if (typeof window === "undefined") {
		throw new Error(
			"[Udodi Router] HTML5 history requires a browser environment.",
		);
	}

	const normalizedBase = normalizeBase(base);
	const listeners = new Set();
	let destroyed = false;

	/**
	 * Reads the current browser location and converts it to an application path.
	 *
	 * @returns {HistoryLocation|null} Current location, or `null` if outside
	 * the configured base.
	 * @private
	 */
	function getLocation() {
		const { pathname, search, hash } = window.location;
		const appPath = stripBase(pathname, normalizedBase);

		if (appPath === null) {
			return null;
		}

		return createLocation(
			appPath,
			search,
			hash,
			readOrAssignBrowserKey(),
		);
	}

	/**
	 * Pushes or replaces a browser history entry.
	 *
	 * Push navigation creates a new entry key. Replace navigation preserves
	 * the current entry key so saved position tracking remains associated with
	 * the same history entry.
	 *
	 * @param {string} to Application-relative navigation target.
	 * @param {"push"|"replace"} method History operation.
	 * @returns {void}
	 * @private
	 */
	function changeLocation(to, method) {
		assertActive(destroyed);

		const { pathname, search, hash } = parsePath(to);
		const url = `${applyBase(pathname, normalizedBase)}${search}${hash}`;
		const currentState = window.history.state;
		const key = method === "push" ? createKey() : readOrAssignBrowserKey();

		window.history[method === "push" ? "pushState" : "replaceState"](
			stateWithKey(method === "push" ? null : currentState, key),
			"",
			url,
		);

		notifyListeners(
			listeners,
			createLocation(pathname, search, hash, key),
		);
	}

	/**
	 * Handles browser Back/Forward navigation.
	 *
	 * @returns {void}
	 * @private
	 */
	function onPopState() {
		if (destroyed) {
			return;
		}

		const location = getLocation();

		if (location !== null) {
			notifyListeners(listeners, location);
		}
	}

	window.addEventListener("popstate", onPopState);

	return {
		/**
		 * Returns the current application location.
		 *
		 * @returns {HistoryLocation|null} Current location.
		 */
		location() {
			assertActive(destroyed);
			return getLocation();
		},

		/**
		 * Pushes a new browser history entry.
		 *
		 * @param {string} to Application-relative navigation target.
		 * @returns {void}
		 */
		push(to) {
			changeLocation(to, "push");
		},

		/**
		 * Replaces the current browser history entry.
		 *
		 * @param {string} to Application-relative navigation target.
		 * @returns {void}
		 */
		replace(to) {
			changeLocation(to, "replace");
		},

		/**
		 * Traverses the browser history by the specified number of entries.
		 *
		 * @param {number} delta Integer offset from the current entry.
		 * @returns {void}
		 * @throws {TypeError} If `delta` is not an integer.
		 */
		go(delta) {
			assertActive(destroyed);

			if (!Number.isInteger(delta)) {
				throw new TypeError(
					"[Udodi Router] History delta must be an integer.",
				);
			}

			window.history.go(delta);
		},

		/**
		 * Traverses to the previous browser history entry.
		 *
		 * @returns {void}
		 */
		back() {
			assertActive(destroyed);
			window.history.back();
		},

		/**
		 * Traverses to the next browser history entry.
		 *
		 * @returns {void}
		 */
		forward() {
			assertActive(destroyed);
			window.history.forward();
		},

		/** @type {HistoryAdapter["listen"]} */
		listen: createListen(listeners, () => destroyed),

		/**
		 * Removes the browser event listener and clears subscriptions.
		 *
		 * Safe to call multiple times.
		 *
		 * @returns {void}
		 */
		destroy() {
			if (destroyed) {
				return;
			}

			destroyed = true;
			window.removeEventListener("popstate", onPopState);
			listeners.clear();
		},
	};
}

/**
 * Creates a hash-based History API adapter.
 *
 * Application paths are stored in the URL fragment, leaving the browser
 * pathname available for hosting the application. The adapter listens for
 * `hashchange` and assigns stable keys to browser history entries.
 *
 * @param {HistoryOptions} [options={}] Adapter configuration.
 * @param {string} [options.base=""] Application base path.
 * @returns {HistoryAdapter} Hash history adapter.
 * @throws {Error} If called outside a browser environment.
 * @throws {TypeError} If the base path is invalid.
 * @public
 */
function createHashHistory({ base = "" } = {}) {
	if (typeof window === "undefined") {
		throw new Error(
			"[Udodi Router] Hash history requires a browser environment.",
		);
	}

	const normalizedBase = normalizeBase(base);
	const listeners = new Set();
	let destroyed = false;

	/**
	 * Checks whether the current browser pathname is inside the configured base.
	 *
	 * @returns {boolean} Whether the pathname is within the base.
	 * @private
	 */
	function isWithinBase() {
		return stripBase(window.location.pathname, normalizedBase) !== null;
	}

	/**
	 * Reads the application location from the current URL fragment.
	 *
	 * @returns {HistoryLocation|null} Current location, or `null` if outside
	 * the configured base.
	 * @private
	 */
	function getLocation() {
		if (!isWithinBase()) {
			return null;
		}

		const rawHash = window.location.hash.slice(1);
		const target = rawHash || "/";
		const parsed = parsePath(
			target.startsWith("/") ? target : `/${target}`,
		);

		return createLocation(
			parsed.pathname,
			parsed.search,
			parsed.hash,
			readOrAssignBrowserKey(),
		);
	}

	/**
	 * Handles browser hash navigation.
	 *
	 * @returns {void}
	 * @private
	 */
	function onHashChange() {
		if (destroyed) {
			return;
		}

		const location = getLocation();

		if (location !== null) {
			notifyListeners(listeners, location);
		}
	}

	/**
	 * Pushes or replaces a hash-based history entry.
	 *
	 * Push navigation generates a new entry key; replace navigation preserves
	 * the current key. Listeners are notified synchronously after the history
	 * state and URL have been updated.
	 *
	 * @param {string} to Application-relative navigation target.
	 * @param {"push"|"replace"} method History operation.
	 * @returns {void}
	 * @throws {Error} If the current browser pathname is outside the base.
	 * @private
	 */
	function changeLocation(to, method) {
		assertActive(destroyed);

		if (!isWithinBase()) {
			throw new Error(
				"[Udodi Router] Cannot navigate outside the configured history base.",
			);
		}

		const { pathname, search, hash } = parsePath(to);
		const url = `${window.location.pathname}${window.location.search}#${pathname}${search}${hash}`;
		const currentState = window.history.state;
		const key = method === "push" ? createKey() : readOrAssignBrowserKey();

		window.history[method === "push" ? "pushState" : "replaceState"](
			stateWithKey(method === "push" ? null : currentState, key),
			"",
			url,
		);

		notifyListeners(
			listeners,
			createLocation(pathname, search, hash, key),
		);
	}

	window.addEventListener("hashchange", onHashChange);

	return {
		/**
		 * Returns the current application location.
		 *
		 * @returns {HistoryLocation|null} Current location.
		 */
		location() {
			assertActive(destroyed);
			return getLocation();
		},

		/**
		 * Pushes a new hash-based history entry.
		 *
		 * @param {string} to Application-relative navigation target.
		 * @returns {void}
		 */
		push(to) {
			changeLocation(to, "push");
		},

		/**
		 * Replaces the current hash-based history entry.
		 *
		 * @param {string} to Application-relative navigation target.
		 * @returns {void}
		 */
		replace(to) {
			changeLocation(to, "replace");
		},

		/**
		 * Traverses the browser history by the specified number of entries.
		 *
		 * @param {number} delta Integer offset from the current entry.
		 * @returns {void}
		 * @throws {TypeError} If `delta` is not an integer.
		 */
		go(delta) {
			assertActive(destroyed);

			if (!Number.isInteger(delta)) {
				throw new TypeError(
					"[Udodi Router] History delta must be an integer.",
				);
			}

			window.history.go(delta);
		},

		/**
		 * Traverses to the previous browser history entry.
		 *
		 * @returns {void}
		 */
		back() {
			assertActive(destroyed);
			window.history.back();
		},

		/**
		 * Traverses to the next browser history entry.
		 *
		 * @returns {void}
		 */
		forward() {
			assertActive(destroyed);
			window.history.forward();
		},

		/** @type {HistoryAdapter["listen"]} */
		listen: createListen(listeners, () => destroyed),

		/**
		 * Removes the browser event listener and clears subscriptions.
		 *
		 * Safe to call multiple times.
		 *
		 * @returns {void}
		 */
		destroy() {
			if (destroyed) {
				return;
			}

			destroyed = true;
			window.removeEventListener("hashchange", onHashChange);
			listeners.clear();
		},
	};
}

/**
 * Creates an in-memory history adapter.
 *
 * Stores history entries in an array and maintains a current index. It follows
 * the same location-key contract as browser adapters, making it useful for
 * deterministic tests and environments without a browser.
 *
 * No browser globals or events are required.
 *
 * @param {MemoryHistoryOptions} [options={}] Adapter configuration.
 * @param {string} [options.initial="/"] Initial application path.
 * @returns {HistoryAdapter} Memory history adapter.
 * @throws {TypeError} If the initial path is invalid.
 * @public
 */
function createMemoryHistory({ initial = "/" } = {}) {
	const stack = [];
	const listeners = new Set();
	let index = 0;
	let destroyed = false;

	/**
	 * Parses a target and creates a history location.
	 *
	 * @param {string} to Application-relative navigation target.
	 * @param {string} [key=createKey()] History-entry key.
	 * @returns {HistoryLocation} Parsed location.
	 * @private
	 */
	function resolveTo(to, key = createKey()) {
		const parsed = parsePath(to);

		return createLocation(
			parsed.pathname,
			parsed.search,
			parsed.hash,
			key,
		);
	}

	/**
	 * Notifies subscribers of the current stack entry.
	 *
	 * @returns {void}
	 * @private
	 */
	function notify() {
		notifyListeners(listeners, stack[index]);
	}

	stack.push(resolveTo(initial));

	return {
		/**
		 * Returns the current in-memory location.
		 *
		 * @returns {HistoryLocation|null} Current location, or `null` if the
		 * history stack is empty.
		 */
		location() {
			assertActive(destroyed);
			return stack[index] ?? null;
		},

		/**
		 * Pushes a new entry and discards any forward entries.
		 *
		 * @param {string} to Application-relative navigation target.
		 * @returns {void}
		 */
		push(to) {
			assertActive(destroyed);

			stack.splice(index + 1);
			stack.push(resolveTo(to));
			index = stack.length - 1;

			notify();
		},

		/**
		 * Replaces the current entry while preserving its key.
		 *
		 * Preserving the key associates the replacement with the same history
		 * entry for features such as scroll-position tracking.
		 *
		 * @param {string} to Application-relative navigation target.
		 * @returns {void}
		 */
		replace(to) {
			assertActive(destroyed);

			stack[index] = resolveTo(to, stack[index].key);

			notify();
		},

		/**
		 * Traverses the in-memory history stack by the specified delta.
		 *
		 * Does nothing if the destination is outside the stack or is the
		 * current entry.
		 *
		 * @param {number} delta Integer offset from the current entry.
		 * @returns {void}
		 * @throws {TypeError} If `delta` is not an integer.
		 */
		go(delta) {
			assertActive(destroyed);

			if (!Number.isInteger(delta)) {
				throw new TypeError(
					"[Udodi Router] History delta must be an integer.",
				);
			}

			const next = index + delta;

			if (next < 0 || next >= stack.length || next === index) {
				return;
			}

			index = next;
			notify();
		},

		/**
		 * Traverses to the previous in-memory history entry.
		 *
		 * @returns {void}
		 */
		back() {
			this.go(-1);
		},

		/**
		 * Traverses to the next in-memory history entry.
		 *
		 * @returns {void}
		 */
		forward() {
			this.go(1);
		},

		/** @type {HistoryAdapter["listen"]} */
		listen: createListen(listeners, () => destroyed),

		/**
		 * Clears subscriptions and releases the in-memory history stack.
		 *
		 * Safe to call multiple times.
		 *
		 * @returns {void}
		 */
		destroy() {
			if (destroyed) {
				return;
			}

			destroyed = true;
			listeners.clear();
			stack.length = 0;
			index = -1;
		},
	};
}

export { createWebHistory, createHashHistory, createMemoryHistory };