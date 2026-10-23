# udodi-router

[![npm version](https://img.shields.io/npm/v/udodi-router.svg)](https://www.npmjs.com/package/udodi-router)
[![License: MIT](https://img.shields.io/github/license/udodi-js/udodi-router)](https://github.com/udodi-js/udodi-router/blob/main/LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/udodi-js/udodi-router/ci.yml?branch=main)](https://github.com/udodi-js/udodi-router/actions)

**udodi-router** is an optional, lightweight navigation layer for [Udodi](https://udodi.dev) applications. It handles URL matching, nested routes, guards, loaders, links, outlets, and document metadata while staying aligned with Udodi's model: **routing should feel like ordinary Udodi code, not like adopting another framework.**

It does not introduce a virtual DOM, a second reactivity system, or `eval` / `new Function()`. It builds on Udodi's existing `createComponent()`, `reactive()`, `effect()`, and lifecycle APIs.

## Key features

- **No virtual DOM**: Route views are normal Udodi components.
- **Reactive route state**: Committed path, params, query, matched chain, meta, and loader data.
- **Composition-first**: Layouts, links, and outlets are ordinary components.
- **Deterministic matcher**: Static lookup plus specificity-ordered parametric routes, including constrained params.
- **Guards & loaders**: Transactional navigation; the active route only changes after preparation succeeds.
- **Scroll restoration**: Restores saved scroll positions during browser history navigation; supports hash targets and configurable scroll behavior.
- **Semantic metadata**: Title, Open Graph, Twitter, JSON-LD, and custom head tags via plain objects.
- **CSP-friendly / no required build**: Plain ESM and native `import()` for lazy routes.
- **Server-safe matching**: Pure `matchRoutes`, `resolveMetadata`, `renderMetadata`, and `resolveHead` via `udodi-router/server` for SEO pipelines, without pulling in browser code.

## Installation

```sh
npm install udodi udodi-router
```

Peer dependency: **udodi** (declare it in your app; the router does not bundle a second copy).

### CDN (browser global)

Load Udodi first, then the router IIFE (global name: `UdodiRouter`):

```html
<script src="https://cdn.jsdelivr.net/npm/udodi@latest/dist/index.global.js"></script>
<script src="https://cdn.jsdelivr.net/npm/udodi-router@latest/dist/index.global.js"></script>
<script>
  const { createRouter } = UdodiRouter;
  // ...
</script>
```

**Note:** `@latest` always resolves to the newest npm release. For production, pin explicit versions.

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

const NotFound = createComponent({
  name: "NotFound",
  template: html`<p>Is like your lost.</p>`,
});

const router = createRouter({
  routes: [
    { path: "/", component: Home, meta: { title: "Home" } },
    { path: "/about", component: About, meta: { title: "About us" } },
    { path: "*", component: NotFound, meta: { title: "Not found" } },
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

`router.Link(options, template)` uses your template as the link component's own template, so `isActive` is available in that instance context. Prefer setting the destination with `to`; the router sets `href` on anchors for client navigation.

## Paths

Route `path` values are matched against the **pathname** only (query and hash are handled separately). Paths should be application-absolute when defined at the root (leading `/`). Child paths are relative to their parent unless they begin with `/`.

| Syntax | Example | Notes |
|--------|---------|--------|
| Static | `/users/new` | Exact segment match |
| Parameter | `/users/:id` | One path segment; decoded into `params.id` |
| Constrained parameter | `/users/:id(\\d+)` | Same as a parameter, but the segment must match the regex |
| Index child | `path: ""` | Shares the parent URL; preferred when both match |
| Absolute child | `/login` | Ignores parent prefix; stays `/login` |
| Fallback | `path: "*"` | Global not-found; root level only |

### Constrained parameters

Use a regex in parentheses after the param name when a segment must match a pattern (digits, fixed locales, etc.):

```js
{ path: "/users/:id(\\d+)", component: User }
{ path: "/:locale(en|fr|de)/about", component: About }
```

Constraints are **case-sensitive** and apply to a **single segment** after decoding. Optional parameters and scoped catch-alls are not supported. Prefer constrained params over ad hoc parsing in loaders when the URL shape itself should reject invalid segments.

### Nesting

```js
{
  path: "/admin",
  component: AdminLayout,
  children: [
    { path: "", component: AdminHome },          // /admin
    { path: "users/:id", component: AdminUser }, // /admin/users/:id
    { path: "/login", component: Login },        // /login (absolute)
  ],
}
```

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

  onMount(_root, ctx) {
    const stop = effect(() => {
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

The root app still renders `${router.RouterView()}` for depth 0.

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

Optional `base` (for example `/app`) is applied by history and matching consistently.

## Scroll restoration

The router can restore a previously saved window scroll position when the user returns via Back/Forward, scroll to a hash target, or apply a custom policy.

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

| Case | Typical return |
|------|----------------|
| History navigation with a saved position | `savedPosition` |
| Hash target | `{ el: to.hash, top?: number }` |
| New navigation | `{ top: 0 }` or `{ top, left }` |
| Leave scroll unchanged | `false` / `null` / `undefined` |

Positions are stored per history entry. Nested scroll containers are not managed automatically. If a hash target is rendered asynchronously, coordinate scrolling with rendering (for example after data settles).

## Document metadata

Route `meta` is a **semantic object** (or a function that returns one). The router resolves inheritance along the **matched parent chain**, normalizes the result, and applies it to `document.head` after a successful commit.

### Static meta

```js
{
  path: "/",
  component: Home,
  meta: {
    title: "Udodi - Lightweight JavaScript UI Framework",
    description: "A lightweight, zero-dependency reactive UI framework.",
    keywords: ["javascript", "ui framework", "reactivity"],
    author: "Udodi",
    canonical: "https://udodi.dev/",
    icon: "/favicon.svg",

    openGraph: {
      type: "website",
      siteName: "Udodi",
      locale: "en_US",
      title: "Udodi - Lightweight JavaScript UI Framework",
      description: "A lightweight, zero-dependency reactive UI framework.",
      image: {
        url: "https://udodi.dev/udodi-logo.png",
        width: 400,
        height: 400,
        alt: "Udodi logo",
      },
    },

    twitter: {
      card: "summary",
      site: "@udodi_js",
      title: "Udodi",
      description: "A lightweight, zero-dependency reactive UI framework.",
      image: "https://udodi.dev/udodi-logo.png",
      imageAlt: "Udodi logo",
    },

    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Udodi",
      applicationCategory: "DeveloperApplication",
    },
  },
}
```

### Dynamic meta (after loaders)

```js
{
  path: "/posts/:id",
  component: Post,
  loader: async ({ params, signal }) => fetchPost(params.id, signal),
  meta: ({ params, data }) => ({
    title: data?.title ?? `Post ${params.id}`,
    description: data?.excerpt,
    canonical: `https://udodi.dev/posts/${params.id}`,
    openGraph: {
      title: data?.title,
      image: data?.coverUrl, // string or { url, width, height, alt }
    },
  }),
}
```

### Router-level defaults

Defaults merge first; each matched route then merges parent to child.

```js
const router = createRouter({
  routes,
  meta: {
    title: "My App",
    openGraph: { siteName: "My App" },
  },
});
```

### Inheritance rules

| Value | Meaning |
|--------|---------|
| Property **omitted** | Inherit from parent (or defaults) |
| `null` | Clear that field / section |
| Nested `openGraph` / `twitter` | Shallow merge; child keys win; `null` clears the section |

Inheritance is **parent-chain only**. Metadata from a previously committed page does not leak into the next route.

### Custom tags

```js
meta: {
  title: "Docs",
  custom: {
    meta: [
      { name: "theme-color", content: "#ffffff" },
    ],
    links: [
      {
        rel: "alternate",
        type: "application/rss+xml",
        href: "/feed.xml",
        title: "RSS",
      },
    ],
  },
}
```

### Scripts (trusted configuration only)

```js
meta: {
  scripts: [
    // once: true (default) — install once per document identity
    {
      src: "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
      async: true,
      once: true,
    },
    {
      key: "gtag-config",
      content: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-XXXX');`,
      once: true,
    },
  ],
  analytics: {
    // set pageView: false to skip automatic gtag page_view reporting
    pageView: true,
  },
}
```

- **`once: true` (default):** first install wins; return visits skip the same identity.
- **`once: false`:** remove and re-insert when that **route pathname** is entered again (query/hash do not create separate slots).

Removing a script node does not undo JavaScript that has already run. Prefer loading analytics bootstrap once at the app shell; use route meta for page-level data and optional page views.

### Client usage is enough for most apps

For a normal SPA it is enough to declare `meta` on routes (and optional router defaults). After a successful navigation the router resolves inheritance and updates `document.head` for you. Read committed values from `router.route.meta` when the UI needs them, no extra meta imports on the client.

```js
createRouter({
  routes: [
    {
      path: "/about",
      component: About,
      meta: { title: "About", description: "..." },
    },
  ],
  meta: { openGraph: { siteName: "My App" } },
});

// Optional: read what was committed
effect(() => {
  console.log(router.route.meta.title);
});
```

## Server-side matching & SEO

Use the server entry when you want crawler-visible titles and tags without a full SSR framework. Matching and metadata helpers stay free of browser APIs.

### One-shot helper (`resolveHead`)

To match paths, run loaders, resolve metadata, and render HTML all in one step, use `resolveHead`:

```js
import { resolveHead } from "udodi-router/server";
import { readFile } from "node:fs/promises";

export async function handleRequest(request) {
  const url = new URL(request.url);

  const { match, head } = await resolveHead({
    routes, // same route table as the client
    pathname: url.pathname,
    signal: request.signal,
    defaults: { openGraph: { siteName: "Udodi" } },
  });

  if (!match) {
    return new Response("Not found", { status: 404 });
  }

  const shell = await readFile("./index.shell.html", "utf8");
  const html = shell.replace("<!-- UDODI_HEAD -->", head);

  return new Response(html, {
    status: match.record.path === "*" ? 404 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
```

### Step-by-step (full control)

```js
import {
  matchRoutes,
  resolveMetadata,
  renderMetadata,
} from "udodi-router/server";
import { readFile } from "node:fs/promises";

// Run each matched record's loader (parent to child).
// Same loader functions as the client.
async function runLoaders(matched, params, signal) {
  const loaderData = new Map();

  for (const record of matched) {
    if (typeof record.loader !== "function") {
      loaderData.set(record, null);
      continue;
    }

    const data = await record.loader({
      params,
      query: Object.create(null),
      signal,
      context: {},
    });

    loaderData.set(record, data);
  }

  return loaderData;
}

export async function handleRequest(request) {
  const url = new URL(request.url);
  const match = matchRoutes(
    routes, // same route table as the client
    url.pathname,
  );

  if (!match) {
    return new Response("Not found", { status: 404 });
  }

  const loaderData = await runLoaders(
    match.matched,
    match.params,
    request.signal,
  );

  const metadata = await resolveMetadata({
    matched: match.matched,
    params: match.params,
    loaderData,
  });

  const headTags = renderMetadata(metadata);

  const shell = await readFile("./index.shell.html", "utf8");
  const html = shell.replace("<!-- UDODI_HEAD -->", headTags);

  return new Response(html, {
    status: match.record.path === "*" ? 404 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
```

| Helper | Role |
|--------|------|
| `resolveHead({ routes, pathname, ... })` | Match → loaders → resolve meta → HTML (typical SEO path) |
| `matchRoutes(routes, pathname)` | Pure match → `{ path, params, record, matched }` or `null` |
| `resolveMetadata({ matched, params, ... })` | Run route `meta` (static or async), parent → child merge |
| `renderMetadata(metadata)` | Safe HTML string for injection into your document shell |

`resolveHead` options include `base`, `defaults`, `context`, `query`, `signal`, `runLoaders` (default `true`), `loaderData` (when `runLoaders: false`), and `includeScripts` (default `false`).

You choose the backend (Node, PHP, static generator, etc.). The router does not require hydration or a meta-framework.

## Active routes

`router.isActive(path, exact?)` answers whether a path belongs to the **currently committed** matched chain. It is reactive: it tracks `router.route.activeVersion`, so templates and effects that call it update after navigation.

### Prefix vs exact

| Call | Meaning |
|------|---------|
| `router.isActive("/dashboard")` | `true` when the committed path is `/dashboard` **or** any nested child under that matched record (for example `/dashboard/settings`) |
| `router.isActive("/dashboard", true)` | `true` only when the committed pathname equals `/dashboard` |

Prefix matching uses the compiled matched-route paths (layouts and parents stay "active" while a child is shown). Exact matching compares normalized pathnames only.

### With `router.Link`

`Link` already exposes `isActive` in the link template's instance context. That is the usual place to toggle CSS classes:

```js
${router.Link({ to: "/dashboard" }, html`
  <a @class="isActive=>'active' 'nav-link'">Dashboard</a>
`)}

${router.Link({ to: "/dashboard", exact: true }, html`
  <a @class="isActive=>'active' 'nav-link'">Overview</a>
`)}
```

Use **exact** on the layout index link when both `/dashboard` and `/dashboard/settings` should not highlight the same item.

### Manual checks in components

```js
import { createComponent, html, effect } from "udodi";

const SideNav = createComponent({
  name: "SideNav",

  state() {
    return {
      dashboardActive: false,
      settingsExact: false,
    };
  },

  onMount(_root, ctx) {
    const stop = effect(() => {
      ctx.dashboardActive = router.isActive("/dashboard");
      ctx.settingsExact = router.isActive("/dashboard/settings", true);
    });

    ctx.cleanup(stop);
  },

  template: html`
    <nav>
      <a href="/dashboard" @class="dashboardActive=>'active'">Dashboard</a>
      <a
        href="/dashboard/settings"
        @class="settingsExact=>'active'"
      >Settings</a>
    </nav>
  `,
});
```

### Programmatic UI

```js
// Breadcrumb or tab visibility after navigation
if (router.isActive("/account")) {
  showAccountChrome();
}

// Guard-style UX (not a replacement for beforeEnter)
if (!router.isActive("/checkout", true)) {
  highlightCheckoutStep();
}
```

Paths passed to `isActive` should be application-absolute (leading `/`), the same style as route `path` values. Query and hash are ignored for matching.

## API surface

| Export | From | Role |
|--------|------|------|
| `createRouter` | `udodi-router` | Main router instance |
| `createWebHistory` | `udodi-router` | HTML5 history (default) |
| `createHashHistory` | `udodi-router` | Hash history |
| `createMemoryHistory` | `udodi-router` | In-memory history (tests) |
| `createMatcher` / `matchRoutes` | `udodi-router/server` | Pure pathname matching |
| `resolveHead` | `udodi-router/server` | One-shot match → loaders → meta → HTML |
| `resolveMetadata` / `renderMetadata` | `udodi-router/server` | Server SEO primitives (custom pipelines) |

Instance API: `push`, `replace`, `back`, `forward`, `go`, `isActive`, `Link`, `RouterView`, `destroy`, reactive `route`, and `ready`.

### `createRouter` options (common)

| Option | Description |
|--------|-------------|
| `routes` | Route record array (required) |
| `history` | Custom history adapter |
| `base` | Deployment base path |
| `scrollBehavior` | `(to, from, savedPosition) => ...` |
| `maxKeepAlive` | Inactive views retained per outlet (default `10`) |
| `context` | Shared object passed to guards, loaders, and meta |
| `meta` | Default semantic metadata merged before route meta |

## Documentation

Visit **[udodi.dev](https://udodi.dev)** for the complete documentation, including routing guides, API reference, and examples for **udodi-router**.

The documentation source is maintained in the [docs/](https://github.com/udodi-js/udodi/blob/main/docs/udodi-router) directory of this repository.


## Development

```sh
npm install
npm test
npm run build
```

```text
udodi-router/
├── dist/           # ESM + optional IIFE
├── src/            # matcher, history, navigation, links, view, meta, head, server
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
