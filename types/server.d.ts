/**
 * Server entry for Udodi Router.
 *
 * Pure pathname matching and document-metadata helpers for SEO pipelines.
 * Does not import browser-only modules (history, navigation, DOM head).
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * import { resolveHead } from "udodi-router/server";
 *
 * const { match, head } = await resolveHead({
 *   routes,
 *   pathname: url.pathname,
 *   defaults: { openGraph: { siteName: "Udodi" } },
 * });
 *
 * if (!match) return notFound();
 * html = shell.replace("<!-- UDODI_HEAD -->", head);
 * ```
 */

import type {
	MatchResult,
	MatcherOptions,
	MetaFunctionContext,
	QueryInput,
	RouteMeta,
	RouteRecord,
	StringRecord,
} from "./index.js";

export type {
	MatchResult,
	MatcherOptions,
	QueryInput,
	RouteMeta,
	RouteRecord,
	StringRecord,
} from "./index.js";

/**
 * Compile routes into a reusable pathname matcher.
 */
export function createMatcher(
	routes: RouteRecord[],
	options?: MatcherOptions,
): (pathname: string) => MatchResult | null;

/**
 * Compile routes and match a single pathname.
 */
export function matchRoutes(
	routes: RouteRecord[],
	pathname: string,
	options?: MatcherOptions,
): MatchResult | null;

/** Wrapper or raw record accepted by {@link resolveMetadata}. */
export type MatchedMetaEntry =
	| RouteRecord
	| {
			record: RouteRecord;
			params?: StringRecord;
			data?: unknown;
			context?: Record<string, unknown>;
	  };

/** Static object or function — same evaluation rules as client `resolveMeta`. */
export type MetaDefaults =
	| RouteMeta
	| ((ctx: MetaFunctionContext) => RouteMeta | Promise<RouteMeta>);

export interface ResolveMetadataOptions {
	/** Parent → child matched records (raw or `{ record, params, data }`). */
	matched?: MatchedMetaEntry[];
	params?: StringRecord;
	/** Loader results keyed by route record, or a path → data map. */
	loaderData?: Map<RouteRecord, unknown> | Record<string, unknown> | null;
	/**
	 * Router-level defaults merged first.
	 * Supports a static object or an async/sync function (evaluated by `resolveMeta`).
	 */
	defaults?: MetaDefaults;
	context?: Record<string, unknown>;
}

/**
 * Resolve semantic route metadata for a matched chain.
 */
export function resolveMetadata(
	options?: ResolveMetadataOptions,
): Promise<RouteMeta>;

export interface RenderMetadataOptions {
	/** When true (default), run internal normalization before serializing. */
	normalize?: boolean;
	/**
	 * When true, emit `<script>` tags from `meta.scripts`.
	 * Default `false`. Script descriptors must be trusted application config.
	 */
	includeScripts?: boolean;
}

/**
 * Render resolved semantic metadata to an HTML string for a document shell.
 */
export function renderMetadata(
	metadata: RouteMeta | null | undefined,
	options?: RenderMetadataOptions,
): string;

export interface ResolveHeadOptions {
	routes: RouteRecord[];
	/** Pathname only (no query or hash). */
	pathname: string;
	base?: string;
	/** Static or functional defaults (same as {@link ResolveMetadataOptions.defaults}). */
	defaults?: MetaDefaults;
	context?: Record<string, unknown>;
	query?: QueryInput;
	signal?: AbortSignal | null;
	/** When false, use `loaderData` instead of calling route loaders. Default true. */
	runLoaders?: boolean;
	loaderData?: Map<RouteRecord, unknown> | null;
	includeScripts?: boolean;
}

export interface ResolveHeadResult {
	readonly match: MatchResult | null;
	readonly metadata: RouteMeta | null;
	/** HTML snippets safe to inject into `<!-- UDODI_HEAD -->`. Empty when no match. */
	readonly head: string;
	readonly loaderData: Map<RouteRecord, unknown>;
}

/**
 * One-shot helper: match → loaders → resolve metadata → render HTML.
 */
export function resolveHead(
	options: ResolveHeadOptions,
): Promise<ResolveHeadResult>;
