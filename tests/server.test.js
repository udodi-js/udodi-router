import { describe, expect, it } from "vitest";
import {
	matchRoutes,
	renderMetadata,
	resolveHead,
	resolveMetadata,
} from "../src/server.js";

describe("matchRoutes (server)", () => {
	const routes = [
		{ path: "/", meta: { title: "Home" } },
		{
			path: "/posts/:id",
			meta: ({ params }) => ({ title: `Post ${params.id}` }),
		},
		{ path: "*", meta: { title: "Missing" } },
	];

	it("matches static and parametric paths", () => {
		expect(matchRoutes(routes, "/").path).toBe("/");
		expect(matchRoutes(routes, "/posts/42").params.id).toBe("42");
	});

	it("respects base", () => {
		const match = matchRoutes(routes, "/app/posts/7", { base: "/app" });

		expect(match.path).toBe("/posts/7");
		expect(match.params.id).toBe("7");
	});
});

describe("resolveMetadata + renderMetadata", () => {
	it("resolves parent → child meta and escapes HTML", async () => {
		const routes = [
			{
				path: "/",
				meta: {
					title: "App",
					openGraph: { siteName: "Udodi" },
				},
				children: [
					{
						path: "about",
						meta: {
							title: 'About <script>alert(1)</script>',
							description: 'A "quoted" description',
						},
					},
				],
			},
		];

		const match = matchRoutes(routes, "/about");
		const metadata = await resolveMetadata({
			matched: match.matched,
			params: match.params,
		});

		expect(metadata.title).toContain("<script>");
		expect(metadata.openGraph.siteName).toBe("Udodi");

		const html = renderMetadata(metadata);

		expect(html).toContain("<title>About &lt;script&gt;alert(1)&lt;/script&gt;</title>");
		expect(html).toContain('content="A &quot;quoted&quot; description"');
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("uses loader data in meta functions", async () => {
		const record = {
			path: "/posts/:id",
			loader: async ({ params }) => ({
				title: `Hello ${params.id}`,
				excerpt: "Summary",
			}),
			meta: ({ data, params }) => ({
				title: data.title,
				description: data.excerpt,
				canonical: `https://udodi.dev/posts/${params.id}`,
			}),
		};

		const match = matchRoutes([record], "/posts/9");
		const loaderData = new Map([
			[record, await record.loader({ params: match.params })],
		]);

		const metadata = await resolveMetadata({
			matched: match.matched,
			params: match.params,
			loaderData,
		});

		expect(metadata.title).toBe("Hello 9");
		expect(metadata.canonical).toBe("https://udodi.dev/posts/9");

		const html = renderMetadata(metadata);

		expect(html).toContain("<title>Hello 9</title>");
		expect(html).toContain('rel="canonical"');
		expect(html).toContain('href="https://udodi.dev/posts/9"');
	});

	it("renders JSON-LD without breaking out of the script tag", async () => {
		const metadata = await resolveMetadata({
			matched: [
				{
					path: "/",
					meta: {
						structuredData: {
							"@context": "https://schema.org",
							"@type": "Organization",
							name: "Udodi</script><script>alert(1)",
						},
					},
				},
			],
		});

		const html = renderMetadata(metadata);

		expect(html).toContain("application/ld+json");
		expect(html).toContain("\\u003c");
		expect(html).not.toMatch(/<\/script><script>alert/);
	});
});

describe("resolveHead", () => {
	it("matches, loads, resolves, and renders in one call", async () => {
		const routes = [
			{
				path: "/posts/:id",
				loader: async ({ params }) => ({
					title: `Post ${params.id}`,
					excerpt: "From loader",
				}),
				meta: ({ data }) => ({
					title: data.title,
					description: data.excerpt,
				}),
			},
		];

		const result = await resolveHead({
			routes,
			pathname: "/posts/3",
		});

		expect(result.match.params.id).toBe("3");
		expect(result.metadata.title).toBe("Post 3");
		expect(result.head).toContain("<title>Post 3</title>");
		expect(result.head).toContain('content="From loader"');
		expect(result.loaderData.size).toBe(1);
	});

	it("returns empty head when nothing matches and no catch-all", async () => {
		const result = await resolveHead({
			routes: [{ path: "/only", meta: { title: "Only" } }],
			pathname: "/missing",
		});

		expect(result.match).toBeNull();
		expect(result.metadata).toBeNull();
		expect(result.head).toBe("");
	});

	it("accepts precomputed loaderData when runLoaders is false", async () => {
		const record = {
			path: "/x",
			meta: ({ data }) => ({ title: data.label }),
		};
		const loaderData = new Map([[record, { label: "Cached" }]]);

		const result = await resolveHead({
			routes: [record],
			pathname: "/x",
			runLoaders: false,
			loaderData,
		});

		expect(result.metadata.title).toBe("Cached");
		expect(result.head).toContain("<title>Cached</title>");
	});
});
