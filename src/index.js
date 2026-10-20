/**
 * @fileoverview Browser entry for Udodi Router.
 *
 * @module udodi-router
 */

export { createRouter } from "./navigation.js";

export {
	createWebHistory,
	createHashHistory,
	createMemoryHistory,
} from "./history.js";

export { createMatcher, matchRoutes } from "./matcher.js";
