/**
 * @fileoverview Server-safe entry for Udodi Router.
 *
 * Exports pure matching helpers only. No DOM, history, or Udodi runtime.
 * Metadata resolution/rendering can be added here later without pulling
 * browser code into server bundles.
 *
 * @module udodi-router/server
 */

export { createMatcher, matchRoutes } from "./matcher.js";
//export { resolveMetadata, renderMetadata } from "./metadata.js";
