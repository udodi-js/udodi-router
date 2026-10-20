import { describe, expect, it } from "vitest";
import { createMatcher, matchRoutes } from "../src/matcher.js";

describe("createMatcher", () => {
	it("matches static routes", () => {
		const match = createMatcher([
			{ path: "/", component: "Home" },
			{ path: "/about", component: "About" },
		]);

		expect(match("/").record.component).toBe("Home");
		expect(match("/about").record.component).toBe("About");
		expect(match("/missing")).toBeNull();
	});

	it("matches required parameters", () => {
		const match = createMatcher([{ path: "/users/:id", component: "User" }]);

		const result = match("/users/42");
		expect(result.params.id).toBe("42");
		expect(result.record.component).toBe("User");
	});

	it("matches constrained parameters", () => {
		const match = createMatcher([
			{ path: "/users/:id(\\d+)", component: "User" },
			{ path: "/users/:slug", component: "Slug" },
		]);

		expect(match("/users/42").record.component).toBe("User");
		expect(match("/users/alice").record.component).toBe("Slug");
	});

	it("prefers static segments over parameters", () => {
		const match = createMatcher([
			{ path: "/users/new", component: "New" },
			{ path: "/users/:id", component: "User" },
		]);

		expect(match("/users/new").record.component).toBe("New");
		expect(match("/users/1").record.component).toBe("User");
	});

	it("supports nested routes and index children", () => {
		const match = createMatcher([
			{
				path: "/admin",
				component: "AdminLayout",
				children: [
					{ path: "", component: "Dashboard" },
					{ path: "users", component: "Users" },
				],
			},
		]);

		const index = match("/admin");
		expect(index.matched.map((r) => r.component)).toEqual([
			"AdminLayout",
			"Dashboard",
		]);

		const users = match("/admin/users");
		expect(users.matched.map((r) => r.component)).toEqual([
			"AdminLayout",
			"Users",
		]);
	});

	it("supports a root catch-all", () => {
		const match = createMatcher([
			{ path: "/about", component: "About" },
			{ path: "*", component: "NotFound" },
		]);

		expect(match("/missing").record.component).toBe("NotFound");
	});

	it("strips a configured base from request pathnames", () => {
		const match = createMatcher([{ path: "/about", component: "About" }], {
			base: "/app",
		});

		expect(match("/app/about").record.component).toBe("About");
		expect(match("/about")).toBeNull();
	});

	it("rejects duplicate route patterns", () => {
		expect(() =>
			createMatcher([
				{ path: "/users/:id", component: "A" },
				{ path: "/users/:userId", component: "B" },
			]),
		).toThrow(/Duplicate route pattern/);
	});
});

describe("matchRoutes", () => {
	it("compiles and matches in one call", () => {
		const result = matchRoutes(
			[{ path: "/posts/:id", component: "Post" }],
			"/posts/7",
		);
		expect(result.params.id).toBe("7");
	});
});
