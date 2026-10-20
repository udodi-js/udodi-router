#!/usr/bin/env node
/**
 * udodi-router post-build script
 *
 * Runs after tsup finishes. Responsibilities:
 * 1. Copy hand-written type declarations (and docs) into dist/
 * 2. Verify package.json fields consumers rely on
 * 3. Lightly check that public exports have matching declarations
 *
 * Usage: node scripts/postbuild.js
 * Hooked via: "build": "tsup && node scripts/postbuild.js"
 */

import { copyFile, mkdir, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

// ────────────────────────────────────────────────
// Files that must end up in dist/
// ────────────────────────────────────────────────
const FILES_TO_COPY = [
	// Hand-written declarations (JS + JSDoc project)
	{ src: "types/index.d.ts", dest: "index.d.ts" },
	{ src: "types/server.d.ts", dest: "server.d.ts" },

	// Optional docs next to the build (only if you publish from dist/)
	// Prefer listing these in package.json "files" from the repo root instead.
	// { src: "README.md", dest: "README.md" },
	// { src: "LICENSE", dest: "LICENSE" },
];

const REQUIRED_PACKAGE_FIELDS = [
	"name",
	"version",
	"type",
	"main",
	"module",
	"types",
	"exports",
	"files",
	"peerDependencies",
];

/** @type {Array<{ entry: string, js: string, dts: string }>} */
const PUBLIC_ENTRIES = [
	{
		entry: ".",
		js: "src/index.js",
		dts: "dist/index.d.ts",
	},
	{
		entry: "./server",
		js: "src/server.js",
		dts: "dist/server.d.ts",
	},
];

async function exists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function ensureDir(dir) {
	await mkdir(dir, { recursive: true });
}

async function copyFiles() {
	console.log("📦 Copying distribution files…");

	for (const { src, dest } of FILES_TO_COPY) {
		const from = join(ROOT, src);
		const to = join(DIST, dest);

		if (!(await exists(from))) {
			console.warn(`  ⚠️  Skipping missing file: ${src}`);
			continue;
		}

		await ensureDir(dirname(to));
		await copyFile(from, to);
		console.log(`  ✓ ${src} → dist/${dest}`);
	}
}

async function verifyPackageJson() {
	console.log("🔍 Verifying package.json fields…");

	const pkgPath = join(ROOT, "package.json");
	const pkg = JSON.parse(await readFile(pkgPath, "utf8"));

	const missing = REQUIRED_PACKAGE_FIELDS.filter((f) => !(f in pkg));
	if (missing.length) {
		throw new Error(
			`package.json is missing required fields: ${missing.join(", ")}`,
		);
	}

	// Dual entry points
	const exportsField = pkg.exports;
	if (!exportsField || typeof exportsField !== "object") {
		throw new Error('package.json must define an "exports" map');
	}

	for (const key of [".", "./server"]) {
		const entry = exportsField[key];
		if (!entry || typeof entry !== "object") {
			throw new Error(`package.json exports is missing "${key}"`);
		}
		if (!entry.import) {
			console.warn(`  ⚠️  exports["${key}"].import is missing`);
		}
		if (!entry.types) {
			console.warn(`  ⚠️  exports["${key}"].types is missing`);
		}
	}

	// Peer dependency on Udodi
	if (!pkg.peerDependencies?.udodi) {
		console.warn('  ⚠️  peerDependencies.udodi is missing');
	}

	// Publish set
	const files = pkg.files || [];
	if (!files.includes("dist") && !files.some((f) => f.startsWith("dist"))) {
		console.warn('  ⚠️  package.json "files" does not list "dist"');
	}

	// Built artifacts referenced by package.json should exist after copy
	const pathsToCheck = [
		pkg.main,
		pkg.module,
		pkg.types,
		exportsField["."]?.import,
		exportsField["."]?.types,
		exportsField["./server"]?.import,
		exportsField["./server"]?.types,
	].filter(Boolean);

	for (const rel of pathsToCheck) {
		const abs = join(ROOT, rel);
		if (!(await exists(abs))) {
			throw new Error(`Referenced package file does not exist: ${rel}`);
		}
	}

	console.log("  ✓ package.json looks good");
}

/**
 * Extract named exports from an ESM source file.
 * @param {string} source
 * @returns {{ names: Set<string>, hasDefault: boolean }}
 */
function collectExports(source) {
	const names = new Set();

	for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
		const parts = match[1]
			.split(",")
			.map((s) => s.trim().split(/\s+as\s+/).pop()?.trim())
			.filter(Boolean);
		for (const name of parts) names.add(name);
	}

	for (const match of source.matchAll(
		/export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g,
	)) {
		names.add(match[1]);
	}

	const hasDefault = /\bexport\s+default\b/.test(source);
	return { names, hasDefault };
}

/**
 * Heuristic: named exports in src entry should appear in the matching .d.ts.
 * @param {string} label
 * @param {string} jsPath
 * @param {string} dtsPath
 */
async function validateEntryDeclarations(label, jsPath, dtsPath) {
	if (!(await exists(jsPath)) || !(await exists(dtsPath))) {
		console.log(`  ℹ️  Skipping ${label} (source or declaration missing)`);
		return;
	}

	const jsSource = await readFile(jsPath, "utf8");
	const dtsSource = await readFile(dtsPath, "utf8");
	const { names, hasDefault } = collectExports(jsSource);

	const missing = [];

	for (const name of names) {
		const pattern = new RegExp(
			[
				`export\\s+(?:declare\\s+)?(?:function|const|class|type|interface|enum)\\s+${name}\\b`,
				`export\\s*\\{[^}]*\\b${name}\\b`,
				`declare\\s+(?:function|const|class|type|interface|enum)\\s+${name}\\b`,
			].join("|"),
		);

		if (!pattern.test(dtsSource)) {
			missing.push(name);
		}
	}

	if (
		hasDefault &&
		!/export\s+default\b|export\s*\{[^}]*\bdefault\b/.test(dtsSource)
	) {
		missing.push("default");
	}

	if (missing.length) {
		throw new Error(
			`[${label}] Missing declarations: ${missing.join(", ")}`,
		);
	}

	console.log(
		`  ✓ ${label}: ${names.size} export(s) appear to have declarations`,
	);
}

async function validateExportsHaveDeclarations() {
	console.log("🔎 Validating exports have declarations…");

	for (const { entry, js, dts } of PUBLIC_ENTRIES) {
		await validateEntryDeclarations(
			entry,
			join(ROOT, js),
			join(ROOT, dts),
		);
	}
}

async function main() {
	console.log("\n udodi-router post-build\n");

	if (!(await exists(DIST))) {
		throw new Error("dist/ folder does not exist. Did tsup run successfully?");
	}

	// tsup output must exist before we copy types on top
	for (const file of ["index.js", "server.js"]) {
		if (!(await exists(join(DIST, file)))) {
			throw new Error(`Expected tsup output missing: dist/${file}`);
		}
	}

	await copyFiles();
	await verifyPackageJson();
	await validateExportsHaveDeclarations();

	console.log("\n✅ Post-build completed successfully\n");
}

main().catch((err) => {
	console.error("\n❌ Post-build failed:\n", err.message || err);
	process.exit(1);
});
