/**
 * Browser entry for Udodi Router.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * import { createRouter, createWebHistory } from "udodi-router";
 *
 * const router = createRouter({
 *   routes: [
 *     { path: "/", component: Home, meta: { title: "Home" } },
 *     { path: "/posts/:id", component: Post },
 *   ],
 *   history: createWebHistory({ base: "/app" }),
 * });
 *
 * await router.ready;
 * ```
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Shared primitives
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Values accepted when building query objects for navigation targets / redirects.
 * Serialized via URL-style encoding; keep entries flat (no nested objects).
 */
export type QueryParamValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| Array<string | number | boolean>;

/** Outbound query map (navigation / redirect). */
export type QueryInput = Record<string, QueryParamValue>;

/** Normalized query/params after parsing (string values only). */
export type StringRecord = Record<string, string>;

/* ────────────────────────────────────────────────────────────────────────── *
 * Matcher
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * One route definition. Child paths are relative unless they begin with `/`.
 */
export interface RouteRecord {
	path: string;
	/** Synchronous component factory or definition. Prefer `loadComponent` for lazy routes. */
	component?: unknown;
	/** Lazy component loader, e.g. `() => import("./Page.js")`. */
	loadComponent?: () => Promise<unknown>;
	/** Async data loader. Receives `{ params, query, signal, context }`. */
	loader?: (ctx: RouteHookContext) => unknown | Promise<unknown>;
	/**
	 * Static metadata object or a function of `{ params, data, context, route }`.
	 * May be async.
	 */
	meta?:
		| RouteMeta
		| ((ctx: MetaFunctionContext) => RouteMeta | Promise<RouteMeta>);
	/**
	 * Guard. Return `true` / `undefined` to continue, `false` to cancel,
	 * or a path / `{ path, query?, hash? }` to redirect.
	 */
	beforeEnter?: (
		ctx: GuardContext,
	) =>
		| boolean
		| void
		| string
		| { path: string; query?: QueryInput; hash?: string }
		| Promise<
				| boolean
				| void
				| string
				| { path: string; query?: QueryInput; hash?: string }
		  >;
	/** When true, the outlet may retain this view while inactive. */
	keepAlive?: boolean;
	/** Application marker only; does not affect matching. */
	notFound?: boolean;
	children?: RouteRecord[];
	/** Runtime-owned field; not read by the matcher. */
	data?: unknown;
	[key: string]: unknown;
}

export interface RouteHookContext {
	readonly params: StringRecord;
	readonly query: StringRecord;
	readonly signal: AbortSignal;
	readonly context: Record<string, unknown>;
}

export interface MetaFunctionContext {
	readonly params: StringRecord;
	readonly data: unknown;
	readonly context: Record<string, unknown>;
	readonly route: RouteRecord;
}

export interface GuardContext {
	readonly to: {
		readonly path: string;
		readonly fullPath: string;
		readonly params: StringRecord;
		readonly query: StringRecord;
		readonly hash: string;
		readonly matched: readonly RouteRecord[];
		readonly meta: Readonly<Record<string, unknown>>;
		readonly data: unknown;
	};
	readonly from: RouteStateSnapshot | null;
	readonly signal: AbortSignal;
	readonly context: Record<string, unknown>;
}

/**
 * Semantic page metadata. Used by the client head manager and server render helpers.
 */
export interface RouteMeta {
	title?: string | null;
	description?: string | null;
	keywords?: string | string[] | null;
	author?: string | null;
	canonical?: string | null;
	icon?: string | MetaIcon | Array<string | MetaIcon> | null;
	openGraph?: OpenGraphMeta | null;
	twitter?: TwitterMeta | null;
	structuredData?: Record<string, unknown> | Record<string, unknown>[] | null;
	custom?: {
		meta?: Array<{ name?: string; property?: string; content: string }>;
		links?: Array<Record<string, string>>;
	} | null;
	scripts?: MetaScript | MetaScript[] | null;
	analytics?: { pageView?: boolean } | null;
	[key: string]: unknown;
}

export interface MetaIcon {
	href?: string;
	url?: string;
	type?: string;
	sizes?: string;
	media?: string;
	rel?: string;
}

export interface OpenGraphMeta {
	type?: string;
	siteName?: string;
	locale?: string;
	title?: string;
	description?: string;
	url?: string;
	image?:
		| string
		| { url: string; width?: number; height?: number; alt?: string };
	[key: string]: unknown;
}

export interface TwitterMeta {
	card?: string;
	site?: string;
	creator?: string;
	title?: string;
	description?: string;
	image?:
		| string
		| { url: string; width?: number; height?: number; alt?: string };
	imageAlt?: string;
	[key: string]: unknown;
}

export interface MetaScript {
	src?: string;
	content?: string;
	type?: string;
	key?: string;
	async?: boolean;
	defer?: boolean;
	once?: boolean;
	crossOrigin?: string;
	integrity?: string;
	referrerPolicy?: string;
}

export interface MatchResult {
	readonly path: string;
	readonly params: StringRecord;
	readonly record: RouteRecord;
	readonly matched: RouteRecord[];
}

export interface MatcherOptions {
	/** Deployment base path, e.g. `"/app"`. */
	base?: string;
}

/**
 * Compile routes into a reusable pathname matcher.
 *
 * @example
 * ```ts
 * const match = createMatcher(routes, { base: "/app" });
 * const result = match("/app/posts/1");
 * ```
 */
export function createMatcher(
	routes: RouteRecord[],
	options?: MatcherOptions,
): (pathname: string) => MatchResult | null;

/* ────────────────────────────────────────────────────────────────────────── *
 * History
 * ────────────────────────────────────────────────────────────────────────── */

export interface HistoryLocation {
	readonly pathname: string;
	readonly search: string;
	readonly hash: string;
	readonly fullPath: string;
	/** Stable identity for this history entry (scroll restoration). */
	readonly key?: string;
}

export interface HistoryAdapter {
	location(): HistoryLocation | null;
	push(to: string): void;
	replace(to: string): void;
	go(delta: number): void;
	back(): void;
	forward(): void;
	listen(callback: (location: HistoryLocation) => void): () => void;
	destroy?(): void;
}

export interface WebHistoryOptions {
	base?: string;
}

export interface MemoryHistoryOptions {
	/** Initial application path. Defaults to `"/"`. */
	initial?: string;
}

/**
 * HTML5 history adapter (default for `createRouter`).
 *
 * @example
 * ```ts
 * createRouter({ routes, history: createWebHistory({ base: "/app" }) });
 * ```
 */
export function createWebHistory(options?: WebHistoryOptions): HistoryAdapter;

/** Hash history adapter for hosts without HTML5 fallback. */
export function createHashHistory(options?: WebHistoryOptions): HistoryAdapter;

/** In-memory history for tests and non-browser environments. */
export function createMemoryHistory(
	options?: MemoryHistoryOptions,
): HistoryAdapter;

/* ────────────────────────────────────────────────────────────────────────── *
 * Router
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Snapshot of committed route fields (read-only for application code).
 * The router replaces this object on successful navigation; do not mutate it.
 */
export interface RouteStateSnapshot {
	readonly path: string;
	readonly fullPath: string;
	readonly params: StringRecord;
	readonly query: StringRecord;
	readonly hash: string;
	readonly matched: ReadonlyArray<
		RouteRecord & { readonly data: unknown; readonly record: RouteRecord }
	>;
	readonly meta: Readonly<Record<string, unknown>>;
	readonly data: unknown;
}

/**
 * Reactive committed route state (`router.route`).
 * Fields are read-only for apps; the engine updates them on commit.
 */
export interface RouteState extends RouteStateSnapshot {
	readonly pending: boolean;
	readonly error: Error | null;
	readonly activeVersion: number;
}

export type NavigationResultType =
	| "completed"
	| "cancelled"
	| "redirected"
	| "error";

export interface NavigationResult {
	readonly type: NavigationResultType;
	readonly route?: RouteState;
	readonly redirectTo?: string;
	readonly error?: Error;
}

export interface ScrollPosition {
	readonly top: number;
	readonly left: number;
}

export interface ScrollBehaviorResult {
	top?: number;
	left?: number;
	/** CSS selector; with `top`, treated as offset from the element. */
	el?: string;
}

export type ScrollBehavior = (
	to: RouteState,
	from: RouteStateSnapshot | null,
	savedPosition: ScrollPosition | null,
) =>
	| ScrollBehaviorResult
	| false
	| null
	| void
	| Promise<ScrollBehaviorResult | false | null | void>;

export interface RouterOptions {
	routes: RouteRecord[];
	history?: HistoryAdapter;
	base?: string;
	/** Max inactive keep-alive views per outlet. Default `10`. Use `0` to disable. */
	maxKeepAlive?: number;
	scrollBehavior?: ScrollBehavior;
	/** Shared object passed to guards, loaders, and meta functions. */
	context?: Record<string, unknown>;
	/**
	 * Default semantic metadata merged before each route's meta.
	 * Static object or async/sync function (same as route `meta`).
	 */
	meta?:
		| RouteMeta
		| ((ctx: MetaFunctionContext) => RouteMeta | Promise<RouteMeta>);
}

export type NavigationTarget =
	| string
	| { path: string; query?: QueryInput; hash?: string };

export interface LinkOptions {
	to: NavigationTarget;
	/** Prefer exact active matching for this link. */
	exact?: boolean;
	replace?: boolean;
	[key: string]: unknown;
}

/**
 * Router instance returned by {@link createRouter}.
 */
export interface Router {
	/** Reactive committed route state (do not assign to nested fields). */
	readonly route: RouteState;
	/** Resolves once with the result of the initial navigation attempt. */
	readonly ready: Promise<NavigationResult>;

	push(to: NavigationTarget): Promise<NavigationResult>;
	replace(to: NavigationTarget): Promise<NavigationResult>;
	back(): void;
	forward(): void;
	go(delta: number): void;

	/**
	 * Whether `path` is active in the committed matched chain.
	 *
	 * @param path - Application-absolute path (query/hash ignored).
	 * @param exact - When true, requires an exact pathname match.
	 *
	 * @example
	 * ```ts
	 * router.isActive("/dashboard");       // prefix (layouts stay active)
	 * router.isActive("/dashboard", true); // exact only
	 * ```
	 */
	isActive(path: string, exact?: boolean): boolean;

	/**
	 * Composition-first link factory for Udodi templates.
	 *
	 * @example
	 * ```ts
	 * router.Link({ to: "/about" }, html`
	 *   <a ⁣@class="isActive=>'active'">About</a>
	 * `)
	 * ```
	 */
	Link: (options: LinkOptions, contentTemplate?: unknown) => unknown;

	/**
	 * Route outlet for the matched depth (auto-detected when nested).
	 *
	 * @example
	 * ```ts
	 * html`<main>${router.RouterView()}</main>`
	 * ```
	 */
	RouterView: () => unknown;

	/** Dispose listeners, views, head manager, and owned history. */
	destroy(): void;
}

/**
 * Create a router instance.
 *
 * Navigation is transactional: guards, loaders, and lazy components run before
 * the active route is committed.
 *
 * @example
 * ```ts
 * const router = createRouter({
 *   routes: [
 *     {
 *       path: "/",
 *       component: Layout,
 *       children: [
 *         { path: "", component: Home },
 *         {
 *           path: "posts/:id",
 *           loadComponent: () => import("./Post.js"),
 *           loader: async ({ params, signal }) => fetchPost(params.id, signal),
 *           meta: ({ data }) => ({ title: data?.title }),
 *         },
 *       ],
 *     },
 *     { path: "*", component: NotFound },
 *   ],
 *   scrollBehavior(to, from, saved) {
 *     if (saved) return saved;
 *     if (to.hash) return { el: to.hash, top: 16 };
 *     return { top: 0 };
 *   },
 * });
 *
 * await router.ready;
 * ```
 */
export function createRouter(options: RouterOptions): Router;
