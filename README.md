# udodi-router

[![npm version](https://img.shields.io/npm/v/udodi-router.svg)](https://www.npmjs.com/package/udodi-router)
[![License: MIT](https://img.shields.io/github/license/udodi-js/udodi-router)](https://github.com/udodi-js/udodi-router/blob/main/LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/udodi-js/udodi-router/ci.yml?branch=main)](https://github.com/udodi-js/udodi-router/actions)

**udodi-router** is an optional, lightweight navigation layer for [Udodi](https://udodi.dev) applications. It handles URL matching, nested routes, guards, loaders, links, and outlets while staying aligned with Udodi’s model: **routing should feel like ordinary Udodi code, not like adopting another framework.**

It does not introduce a virtual DOM, a second reactivity system, or `eval` / `new Function()`. It builds on Udodi’s existing `createComponent()`, `html`, `reactive()`, `effect()`, and lifecycle APIs.

## Key features

- **No virtual DOM**: Route views are normal Udodi components.
- **Reactive route state**: Committed path, params, query, matched chain, meta, and loader data.
- **Composition-first**: Layouts, links, and outlets are ordinary components.
- **Deterministic matcher**: Static lookup plus specificity-ordered parametric routes, including constrained params.
- **Guards & loaders**: Transactional navigation; the active route only changes after preparation succeeds.
- **Scroll restoration**: Restores saved scroll positions during browser history navigation, supports hash targets and configurable scroll behavior.
- **CSP-friendly / no required build**: Plain ESM and native `import()` for lazy routes.
- **Server-safe matching**: Pure `matchRoutes` via `udodi-router/server` for SEO metadata pipelines, without pulling in browser code.

## Installation

```sh
npm install udodi udodi-router
```

Peer dependency: **udodi** (declare it in your app; the router does not bundle a second copy).

### CDN (browser global)

Load Udodi first, then the router IIFE (global name: `UdodiRouter`):

```html
<script src="https://cdn.jsdelivr.net/npm/udodi@latest/dist/udodi.global.js"></script>
<script src="https://cdn.jsdelivr.net/npm/udodi-router@latest/dist/udodi-router.global.js"></script>
<script>
  const { createRouter } = UdodiRouter;
  // ...
</script>
```

**Note**: `@latest` always resolves to the latest npm release, which is convenient for quick setup. For production applications, pinning explicit versions is more reproducible and helps prevent unexpected changes after a new release.

## Quick start

```js
import { createComponent, html, render } from "udodi";
import { createRouter } from "udodi-router";

const Home = createComponent({
  name: "Home",
  template: html`
    <div>
      <h1>Welcome Home</h1>
      <p>Built with Udodi.</p>
    </div>
  `,
});

const About = createComponent({
  name: "About",
  template: html`<h1>About Us</h1>`,
});

const router = createRouter({
  routes: [
    { path: "/", component: Home, meta: { title: "Home" } },
    { path: "/about", component: About, meta: { title: "About us" } },
    { path: "*", component: About, meta: { title: "Not found" } },
  ],
});

const App = createComponent({
  name: "App",
  template: html`
    <nav>
      ${router.Link({ to: "/" }, html`
        <a @class="isActive=>'active' 'nav-item'">Home</a>
      `)}
      ${router.Link({ to: "/about" }, html`
        <a @class="isActive=>'active' 'nav-item'">About</a>
      `)}
    </nav>
    <main class="page-content">
      ${router.RouterView()}
    </main>
  `,
});

render(App(), "#app");
```

`router.Link(options, template)` uses your template as the link component’s own template, so `isActive` is available in that instance context. Prefer setting destination via `to`; the router sets `href` on anchors for client navigation.

## Route parameters & loaders

Navigation is transactional: guards run, loaders run, lazy components resolve, then the route is committed.

```js
import { createComponent, html, effect } from "udodi";
import { createRouter } from "udodi-router";

let router;

const Post = createComponent({
  name: "Post",

  state() {
    return {
      title: "Loading post...",
      content: "",
    };
  },

  onMount(root, ctx) {
    const stop = effect(() => {
      // Track committed route data
      ctx.title = router.route.data?.title ?? "Loading post...";
      ctx.content = router.route.data?.content ?? "";
    });

    ctx.cleanup(stop);
  },

  template: html`
    <article>
      <h1 @text="title"></h1>
      <p @text="content"></p>
    </article>
  `,
});

const routes = [
  {
    path: "/posts/:id",
    component: Post,
    loader: async ({ params, signal }) => {
      const res = await fetch(
        `/api/posts/${encodeURIComponent(params.id)}`,
        { signal },
      );

      if (!res.ok) throw new Error("Unable to fetch post.");

      return res.json();
    },
    meta: ({ params, data }) => ({
      title: data?.title ?? `Post ${params.id}`,
      description: data?.excerpt ?? "Read this post.",
    }),
  },
];

router = createRouter({ routes });
```

Constrained parameters (e.g. digits or locales):

```js
{ path: "/users/:id(\\d+)", component: User }
{ path: "/:locale(en|fr|de)/about", component: About }
```

## Guards & navigation results

```js
{
  path: "/account/settings",
  component: SettingsView,
  beforeEnter: () => {
    if (!isUserAuthenticated()) {
      return { path: "/login", query: { redirect: "/account/settings" } };
    }
    return true;
  },
}
```

```js
const result = await router.push("/account/settings");
// result.type: "completed" | "cancelled" | "redirected" | "error"
```

## Nested layouts

The parent layout is a normal component that includes another `RouterView`. Nested depth is detected automatically.

```js
const DashboardLayout = createComponent({
  name: "DashboardLayout",
  template: html`
    <div class="dashboard">
      <aside>...</aside>
      <main>${router.RouterView()}</main>
    </div>
  `,
});

const routes = [
  {
    path: "/dashboard",
    component: DashboardLayout,
    children: [
      { path: "", component: OverviewPanel },
      { path: "settings", component: SettingsPanel },
    ],
  },
];
```

Root app still renders `${router.RouterView()}` for depth 0.

## Lazy routes

```js
{
  path: "/reports",
  loadComponent: () => import("./pages/Reports.js"),
  // Resolved module.default (or the module itself) must be a component factory
}
```

## History modes

By default, `createRouter()` uses HTML5 history.

```js
import {
  createRouter,
  createHashHistory,
  createMemoryHistory,
} from "udodi-router";

// Hash mode (when the server cannot fall back to index.html)
createRouter({
  routes,
  history: createHashHistory({ base: "/app" }),
});

// Tests / non-browser
createRouter({
  routes,
  history: createMemoryHistory({ initial: "/" }),
});
```

Optional `base` (e.g. `/app`) is applied by history and matching consistently.

## Scroll restoration

The router supports scroll restoration during navigation. It can restore a previously saved position when the user returns to a history entry, scroll to a hash target, or apply a custom scroll policy.

This is useful when navigating away from a long page and returning with the browser’s Back or Forward controls: the previous scroll position can be restored instead of always starting at the top.

### Default behavior

The scroll behavior can distinguish between navigation types:

- **History navigation**: Restore the saved scroll position when one is available.
- **Hash navigation**: Scroll to the element identified by the URL hash when the target exists.
- **New navigation**: Apply the configured scroll policy, commonly starting at the top of the page.
- **Missing saved position or hash target**: Fall back to the configured behavior.

Scroll restoration is intended for the browser window. It does not automatically manage arbitrary nested scroll containers.

### Custom scroll behavior

Configure scroll behavior through the router’s scroll behavior option:

```js
const router = createRouter({
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      return savedPosition;
    }

    if (to.hash) {
      return { el: to.hash, top: 16 };
    }

    return { top: 0 };
  },
});
```

In this example, browser history navigation restores the saved position when available. Hash navigation targets the matching element with a 16-pixel top offset, and other navigation starts at the top.

The `savedPosition` argument is only available when a stored position exists for the destination history entry. On initial navigation or when no position has been saved, it is `null`.

### Notes

- Scroll positions are associated with history entries so Back and Forward navigation can restore the appropriate location.
- Scroll event handling can be coalesced with `requestAnimationFrame` to avoid processing every scroll event synchronously.
- Hash scrolling depends on the target element existing when the scroll behavior is applied. If a target is rendered asynchronously, the application may need to coordinate scrolling with rendering.
- Custom behavior should return the position or target supported by the router’s scroll behavior implementation.

## Server-side matching

Pure matching is available without the browser entry:

```js
import { matchRoutes } from "udodi-router/server";

const match = matchRoutes(routes, pathname);
// match: { path, params, record, matched } | null
```

You can run loaders and build `<title>` / meta tags in your own server handler. A dedicated `resolveMetadata` / `renderMetadata` helper may be published on this entry later; until then, reuse the same route `meta` functions in your app code after matching.

## Active routes

```js
router.isActive("/dashboard");        // true for /dashboard and nested children
router.isActive("/dashboard", true);  // exact path only
```

## API surface

| Export | From | Role |
|--------|------|------|
| `createRouter` | `udodi-router` | Main router instance |
| `createWebHistory` | `udodi-router` | HTML5 history (default) |
| `createHashHistory` | `udodi-router` | Hash history |
| `createMemoryHistory` | `udodi-router` | In-memory history (tests) |
| `createMatcher` / `matchRoutes` | `udodi-router` or `udodi-router/server` | Pure pathname matching |

Instance methods include `push`, `replace`, `back`, `forward`, `go`, `isActive`, `Link`, `RouterView`, `destroy`, plus reactive `route` and `ready`.

## Documentation

- Guide and design notes: see the repository docs / [Udodi](https://udodi.dev) site when published.
- Issues: [github.com/udodi-js/udodi-router](https://github.com/udodi-js/udodi-router)

## Development

```sh
npm install
npm test
npm run build
```

```text
udodi-router/
├── dist/           # ESM + optional IIFE
├── src/            # matcher, history, navigation, links, view, entries
├── types/          # hand-written .d.ts
├── tests/
├── scripts/        # postbuild, etc.
└── tsup.config.js
```

## License

**udodi-router** is open-source software licensed under the terms of the [MIT License](LICENSE).

<p align="center">
  Made with ❤️ in Nigeria.
</p>
