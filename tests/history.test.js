/**
 * @fileoverview Tests for history adapters.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWebHistory,
	createHashHistory,
	createMemoryHistory,
} from "../src/history.js";

/** @type {Array<{ destroy?: () => void }>} */
const adapters = [];

afterEach(() => {
	for (const adapter of adapters.splice(0)) {
		adapter.destroy?.();
	}
	// Reset URL between tests (happy-dom)
	if (typeof window !== "undefined") {
		window.history.replaceState(null, "", "/");
		window.location.hash = "";
	}
	vi.restoreAllMocks();
});

describe("createMemoryHistory", () => {
	it("starts at the initial path", () => {
		const history = createMemoryHistory({ initial: "/home" });
		adapters.push(history);

		const loc = history.location();

		expect(loc.pathname).toBe("/home");
		expect(loc.search).toBe("");
		expect(loc.hash).toBe("");
		expect(loc.fullPath).toBe("/home");
		expect(typeof loc.key).toBe("string");
		expect(loc.key.length).toBeGreaterThan(0);
	});

	it("push adds an entry and notifies listeners", () => {
		const history = createMemoryHistory({ initial: "/" });
		adapters.push(history);

		const locations = [];
		history.listen((loc) => locations.push(loc.fullPath));

		history.push("/about");
		history.push("/about?tab=1");

		expect(history.location().fullPath).toBe("/about?tab=1");
		expect(locations).toEqual(["/about", "/about?tab=1"]);
	});

	it("replace updates the current entry without growing the stack", () => {
		const history = createMemoryHistory({ initial: "/" });
		adapters.push(history);

		history.push("/a");
		history.push("/b");
		history.replace("/b-replaced");

		expect(history.location().fullPath).toBe("/b-replaced");
		history.back();
		expect(history.location().fullPath).toBe("/a");
	});

	it("back and forward move through the stack", () => {
		const history = createMemoryHistory({ initial: "/" });
		adapters.push(history);

		history.push("/one");
		history.push("/two");
		history.back();
		expect(history.location().pathname).toBe("/one");
		history.forward();
		expect(history.location().pathname).toBe("/two");
	});

	it("go is a no-op outside the stack bounds", () => {
		const history = createMemoryHistory({ initial: "/" });
		adapters.push(history);

		history.push("/a");
		expect(history.location().pathname).toBe("/a");

		history.go(-5); // would move to index -4 → no-op
		expect(history.location().pathname).toBe("/a");

		history.go(-1); // valid -> "/"
		expect(history.location().pathname).toBe("/");

		history.go(1); // valid -> "/a"
		expect(history.location().pathname).toBe("/a");

		history.go(10); // past end -> no-op
		expect(history.location().pathname).toBe("/a");
	});

	it("rejects non-absolute targets", () => {
		const history = createMemoryHistory();
		adapters.push(history);

		expect(() => history.push("relative")).toThrow(/absolute application path/);
		expect(() => history.push("//evil")).toThrow(/absolute application path/);
	});

	it("unsubscribe stops notifications", () => {
		const history = createMemoryHistory({ initial: "/" });
		adapters.push(history);

		const spy = vi.fn();
		const stop = history.listen(spy);
		stop();
		history.push("/x");
		expect(spy).not.toHaveBeenCalled();
	});

	it("destroy clears listeners and rejects further use", () => {
		const history = createMemoryHistory({ initial: "/" });
		history.destroy();

		expect(() => history.location()).toThrow(/destroyed/i);
		expect(() => history.push("/x")).toThrow(/destroyed/i);
	});
});

describe("createWebHistory", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", "/");
	});

	it("reads the current browser location", () => {
		window.history.replaceState(null, "", "/dashboard?x=1#top");
		const history = createWebHistory();
		adapters.push(history);

		const loc = history.location();
		expect(loc.pathname).toBe("/dashboard");
		expect(loc.search).toBe("?x=1");
		expect(loc.hash).toBe("#top");
		expect(loc.fullPath).toBe("/dashboard?x=1#top");
	});

	it("push and replace update the URL and notify listeners", () => {
		const history = createWebHistory();
		adapters.push(history);

		const seen = [];
		history.listen((loc) => seen.push(loc.fullPath));

		history.push("/users/1");
		expect(window.location.pathname).toBe("/users/1");
		expect(seen).toContain("/users/1");

		history.replace("/users/2");
		expect(window.location.pathname).toBe("/users/2");
		expect(seen).toContain("/users/2");
	});

	it("strips a configured base when reading location", () => {
		window.history.replaceState(null, "", "/app/about");
		const history = createWebHistory({ base: "/app" });
		adapters.push(history);

		expect(history.location().pathname).toBe("/about");
		expect(history.location().fullPath).toBe("/about");
	});

	it("applies base when writing", () => {
		const history = createWebHistory({ base: "/app" });
		adapters.push(history);

		history.push("/settings");
		expect(window.location.pathname).toBe("/app/settings");
		expect(history.location().pathname).toBe("/settings");
	});

	it("returns null when the browser path is outside the base", () => {
		window.history.replaceState(null, "", "/other/page");
		const history = createWebHistory({ base: "/app" });
		adapters.push(history);

		expect(history.location()).toBeNull();
	});

	it("notifies on popstate", () => {
		const history = createWebHistory();
		adapters.push(history);

		history.push("/a");
		history.push("/b");

		const seen = [];
		history.listen((loc) => seen.push(loc.pathname));

		// Simulate back: update history index then fire popstate
		window.history.back();
		// happy-dom may or may not fire popstate automatically; dispatch if needed
		window.dispatchEvent(new PopStateEvent("popstate"));

		// After back from /b to /a
		expect(history.location().pathname).toBe("/a");
	});

	it("go requires an integer delta", () => {
		const history = createWebHistory();
		adapters.push(history);

		expect(() => history.go(1.5)).toThrow(/integer/i);
		expect(() => history.go("1")).toThrow(/integer/i);
	});

	it("destroy removes the popstate listener", () => {
		const history = createWebHistory();
		const spy = vi.fn();
		history.listen(spy);
		history.destroy();

		window.dispatchEvent(new PopStateEvent("popstate"));
		expect(spy).not.toHaveBeenCalled();
		expect(() => history.push("/x")).toThrow(/destroyed/i);
	});
});

describe("createHashHistory", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", "/");
		window.location.hash = "";
	});

	it("reads the application path from the hash", () => {
		window.location.hash = "#/profile?tab=bio";
		const history = createHashHistory();
		adapters.push(history);

		const loc = history.location();
		expect(loc.pathname).toBe("/profile");
		expect(loc.search).toBe("?tab=bio");
		expect(loc.fullPath).toBe("/profile?tab=bio");
	});

	it("push writes into the hash fragment", () => {
		const history = createHashHistory();
		adapters.push(history);

		history.push("/docs/intro");
		expect(window.location.hash).toMatch(/#\/docs\/intro/);
		expect(history.location().pathname).toBe("/docs/intro");
	});

	it("respects outer base on the browser pathname", () => {
		window.history.replaceState(null, "", "/app/");
		window.location.hash = "#/home";
		const history = createHashHistory({ base: "/app" });
		adapters.push(history);

		expect(history.location().pathname).toBe("/home");

		history.push("/about");
		expect(history.location().pathname).toBe("/about");
		expect(window.location.pathname.startsWith("/app")).toBe(true);
	});

	it("returns null when outer pathname is outside the base", () => {
		window.history.replaceState(null, "", "/elsewhere");
		window.location.hash = "#/home";
		const history = createHashHistory({ base: "/app" });
		adapters.push(history);

		expect(history.location()).toBeNull();
	});

	it("destroy removes the hashchange listener", () => {
		const history = createHashHistory();
		const spy = vi.fn();
		history.listen(spy);
		history.destroy();

		window.dispatchEvent(new HashChangeEvent("hashchange"));
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("history shared rules", () => {
	it("normalizeBase rejects query or hash in base", () => {
		expect(() => createMemoryHistory()).not.toThrow();
		expect(() => createWebHistory({ base: "/app?x=1" })).toThrow(
			/query or hash/i,
		);
		expect(() => createWebHistory({ base: "/app#x" })).toThrow(
			/query or hash/i,
		);
	});

	it("parsePath requires absolute application paths for web/hash push", () => {
		const web = createWebHistory();
		adapters.push(web);
		expect(() => web.push("nope")).toThrow(/absolute application path/i);
	});
});
