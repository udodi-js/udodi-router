import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "happy-dom",

		include: ["tests/**/*.{test,spec}.{js,mjs}"],

		exclude: ["node_modules", "dist", "examples", "scripts"],

		// Useful defaults for a router package
		restoreMocks: true,
		clearMocks: true,

		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			include: ["src/**/*.js"],
			exclude: ["src/index.js", "src/server.js"],
		},
	},

	resolve: {
		alias: {
			// Peer dependency installed in this package for tests
			udodi: path.resolve(root, "node_modules/udodi"),

			// import package source
			"udodi-router": path.resolve(root, "src/index.js"),
			"udodi-router/server": path.resolve(root, "src/server.js"),
		},
	},
});
