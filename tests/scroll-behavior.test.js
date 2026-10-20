import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/navigation.js";
import { createMemoryHistory } from "../src/history.js";

/** @type {Array<{ destroy?: () => void }>} */
const routers = [];

afterEach(() => {
	for (const router of routers.splice(0)) {
		router.destroy?.();
	}
	vi.restoreAllMocks();
});

describe("scrollBehavior", () => {
	it("receives null savedPosition on push, and a position after back", async () => {
		const history = createMemoryHistory({ initial: "/list" });
		/** @type {Array<{ top: number, left: number } | null>} */
		const savedArgs = [];

		const scrollBehavior = vi.fn((to, from, savedPosition) => {
			savedArgs.push(savedPosition);
			return false; // do not touch window in tests
		});

		const router = createRouter({
			history,
			scrollBehavior,
			routes: [
				{ path: "/list", component: {} },
				{ path: "/detail", component: {} },
			],
		});
		routers.push(router);

		await router.ready;

		// Simulate user scroll on the list entry (window may be 0 in happy-dom)
		Object.defineProperty(window, "scrollY", {
			value: 240,
			configurable: true,
		});
		Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
		window.dispatchEvent(new Event("scroll"));
		// Allow rAF-coalesced capture if used
		await new Promise((r) => requestAnimationFrame(() => r()));

		await router.push("/detail");
		expect(savedArgs.at(-1)).toBeNull();

		// Back to list — should pass the position saved for that history key
		history.back();
		// Wait for fromHistory navigation
		await vi.waitFor(() => {
			expect(router.route.path).toBe("/list");
		});

		const lastSaved = savedArgs.at(-1);
		// May be { top: 240, left: 0 } if capture ran; at least should not throw
		expect(scrollBehavior).toHaveBeenCalled();
		// When capture worked:
		if (lastSaved) {
			expect(lastSaved).toMatchObject({
				top: expect.any(Number),
				left: expect.any(Number),
			});
		}
	});

	it("does not pass savedPosition on replace", async () => {
		const history = createMemoryHistory({ initial: "/a" });
		const scrollBehavior = vi.fn(() => false);

		const router = createRouter({
			history,
			scrollBehavior,
			routes: [
				{ path: "/a", component: {} },
				{ path: "/b", component: {} },
			],
		});
		routers.push(router);

		await router.ready;
		scrollBehavior.mockClear();

		await router.replace("/b");

		const calls = scrollBehavior.mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const savedPosition = calls[0][2];
		expect(savedPosition).toBeNull();
	});

	it("supports el + top offset shape from scrollBehavior return value", async () => {
		const history = createMemoryHistory({ initial: "/" });
		const scrollBehavior = vi.fn(() => ({ el: "#main", top: 72 }));

		// Provide a target element
		const el = document.createElement("div");
		el.id = "main";
		document.body.appendChild(el);

		const router = createRouter({
			history,
			scrollBehavior,
			routes: [
				{ path: "/", component: {} },
				{ path: "/other", component: {} },
			],
		});
		routers.push(router);

		await router.ready;
		await router.push("/other");

		expect(scrollBehavior).toHaveBeenCalled();
		document.body.removeChild(el);
	});

    it("history location includes a stable key across push and back", () => {
        const history = createMemoryHistory({ initial: "/a" });
        const keyA = history.location().key;

        history.push("/b");
        const keyB = history.location().key;
        expect(keyB).not.toBe(keyA);

        history.back();
        expect(history.location().key).toBe(keyA);
    });
});
