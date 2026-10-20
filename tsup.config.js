import { defineConfig } from "tsup";

const shared = {
	outDir: "dist",
	clean: false, // only the first config should clean
	sourcemap: true,
	target: "es2020",
	dts: false,
	splitting: false,
	treeshake: true,
	external: ["udodi"],
};

export default defineConfig([
	// Package builds (ESM) — npm / bundlers
	{
		...shared,
		clean: true,
		entry: {
			index: "src/index.js",
			server: "src/server.js",
		},
		format: ["esm"],
		minify: true,

		outExtension() {
			return { js: ".js" };
		},
	},

	// CDN build (IIFE) — browser global
	{
		...shared,
		entry: {
			"udodi-router": "src/index.js", // browser entry only
		},
		format: ["iife"],
		globalName: "UdodiRouter",
		minify: true,

		// IIFE file name: dist/udodi-router.global.js
		outExtension({ format }) {
			if (format === "iife") return { js: ".global.js" };
			return { js: ".js" };
		},
	},
]);
