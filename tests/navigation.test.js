import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/navigation.js";

function createMockHistory(initialPath = "/") {
	/** @type {string[]} */
	const entries = [initialPath];
	let index = 0;
	/** @type {((loc: { fullPath: string }) => unknown) | null} */
	let listener = null;

	function location() {
		return { fullPath: entries[index] };
	}

	function push(path) {
		entries.splice(index + 1);
		entries.push(path);
		index = entries.length - 1;
		listener?.(location());
	}

	function replace(path) {
		entries[index] = path;
		listener?.(location());
	}

	function go(delta) {
		const next = index + delta;
		if (next < 0 || next >= entries.length) return;
		index = next;
		listener?.(location());
	}

	function listen(callback) {
		listener = callback;
		return () => {
			if (listener === callback) listener = null;
		};
	}

	/** Simulate back/forward: move to an existing entry or replace current without stacking. */
	function simulatePopState(path) {
		const existing = entries.indexOf(path);
		if (existing !== -1) {
			index = existing;
		} else {
			entries[index] = path;
		}
		return listener?.(location());
	}

	return {
		location,
		push,
		replace,
		back: () => go(-1),
		forward: () => go(1),
		go,
		listen,
		simulatePopState,
		getEntries: () => [...entries],
		getIndex: () => index,
		destroy() {
			listener = null;
		},
	};
}

function createSignal() {
	/** @type {() => void} */
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve: () => resolve() };
}

/** @type {Array<{ destroy?: () => void }>} */
const routers = [];

afterEach(() => {
	for (const router of routers.splice(0)) {
		router.destroy?.();
	}
	vi.restoreAllMocks();
});

describe("createRouter navigation", () => {
	it("redirects during initial navigation via beforeEnter and resolves ready", async () => {
		const history = createMockHistory("/dashboard");

		const router = createRouter({
			history,
			routes: [
				{
					path: "/dashboard",
					component: {},
					beforeEnter: () => "/login",
				},
				{
					path: "/login",
					component: {},
				},
			],
		});
		routers.push(router);

		const result = await router.ready;

		expect(result.type).toBe("redirected");
		expect(result.redirectTo).toBe("/login");
		expect(router.route.path).toBe("/login");
		expect(router.route.pending).toBe(false);
		expect(history.location().fullPath).toBe("/login");
	});

	it("cancels the initial navigation when a newer navigation supersedes it", async () => {
		const history = createMockHistory("/home");
		const loaderStarted = createSignal();
		const releaseLoader = createSignal();

		const router = createRouter({
			history,
			routes: [
			{
				path: "/home",
				component: {},
				loader: async ({ signal }) => {
				loaderStarted.resolve();

				// Wait until released or aborted
				await new Promise((resolve, reject) => {
					const onAbort = () => {
					cleanup();
					reject(
						signal.reason instanceof Error
						? signal.reason
						: new DOMException("Navigation aborted.", "AbortError"),
					);
					};
					const cleanup = () => {
					signal.removeEventListener("abort", onAbort);
					};
					signal.addEventListener("abort", onAbort, { once: true });

					releaseLoader.promise.then(() => {
					cleanup();
					resolve();
					});

					if (signal.aborted) onAbort();
				});

				return { page: "home" };
				},
			},
			{
				path: "/profile",
				component: {},
			},
			],
		});
		routers.push(router);

		await loaderStarted.promise;

		const secondResult = await router.push("/profile");
		const initialResult = await router.ready;

		// Unblock anything still waiting (safe if already aborted)
		releaseLoader.resolve();

		expect(initialResult.type).toBe("cancelled");
		expect(secondResult.type).toBe("completed");
		expect(router.route.path).toBe("/profile");
		expect(router.route.pending).toBe(false);
	});

	it("allows a failed lazy component load to be retried", async () => {
		const history = createMockHistory("/lazy-view");
		let loadAttempts = 0;

		const router = createRouter({
			history,
			routes: [
				{
					path: "/lazy-view",
					loadComponent: async () => {
						loadAttempts += 1;
						if (loadAttempts === 1) {
							throw new Error("Network Error");
						}
						return { default: {} };
					},
				},
			],
		});
		routers.push(router);

		const initialResult = await router.ready;

		expect(initialResult.type).toBe("error");
		expect(initialResult.error?.message).toBe("Network Error");
		expect(loadAttempts).toBe(1);

		const retryResult = await router.push("/lazy-view");

		expect(retryResult.type).toBe("completed");
		expect(loadAttempts).toBe(2);
		expect(router.route.path).toBe("/lazy-view");
		expect(router.route.pending).toBe(false);
	});

	it("restores the committed URL when a popstate navigation is blocked by a guard", async () => {
		const history = createMockHistory("/allowed-page");

		const router = createRouter({
			history,
			routes: [
				{ path: "/allowed-page", component: {} },
				{
					path: "/secure-page",
					component: {},
					beforeEnter: () => false,
				},
			],
		});
		routers.push(router);

		const initialResult = await router.ready;
		expect(initialResult.type).toBe("completed");
		expect(router.route.path).toBe("/allowed-page");

		await history.simulatePopState("/secure-page");

		expect(router.route.path).toBe("/allowed-page");
		expect(history.location().fullPath).toBe("/allowed-page");
		expect(router.route.pending).toBe(false);
	});

	it("runs loaders and exposes leaf data on the committed route", async () => {
		const history = createMockHistory("/posts/42");

		const router = createRouter({
			history,
			routes: [
				{
					path: "/posts/:id",
					component: {},
					loader: async ({ params }) => ({ id: params.id, title: "Hello" }),
				},
			],
		});
		routers.push(router);

		const result = await router.ready;
		expect(result.type).toBe("completed");
		expect(router.route.params.id).toBe("42");
		expect(router.route.data).toEqual({ id: "42", title: "Hello" });
	});

	it("isActive tracks committed matched ancestors", async () => {
		const history = createMockHistory("/dashboard/settings");

		const router = createRouter({
			history,
			routes: [
				{
					path: "/dashboard",
					component: {},
					children: [
						{ path: "", component: {} },
						{ path: "settings", component: {} },
					],
				},
			],
		});
		routers.push(router);

		await router.ready;

		expect(router.isActive("/dashboard")).toBe(true);
		expect(router.isActive("/dashboard/settings", true)).toBe(true);
		expect(router.isActive("/dashboard", true)).toBe(false);
		expect(router.isActive("/dashboard-old")).toBe(false);
	});
});
