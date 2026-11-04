# How it works

Each island has a component name and a one-line public props JSON string. A build
produces a server bundle, independent browser verification bundle and build id.
The cache key is `md5(buildId + '|' + component + '|' + exactProps)`. Liquid escapes
literal `<` as `\u003c` before hashing and embedding the props. Exact bytes matter.

```text
Browser request
      |
      v
Shopify Liquid -> build id + component + props -> md5 key
      |
      v
metaobjects.ssr_fragment[key]
      |
      +-- hit  -> cached HTML -> Vue hydration
      |
      +-- miss -> empty root -> Vue client render
```

The CLI crawls a configured sitemap or explicit public pages, checks deployed build
markers and recomputes the keys. On a miss it renders the component from local
code. It verifies hydration using an independent browser compilation in fresh
jsdom windows at all configured widths. Only verified HTML within the size limit
is written to the public `ssr_fragment` metaobject. The next request can use it.
Reports and offline cases retain failures for repair. Browser captures supply props
and key evidence, while the local renderer supplies cache HTML.

The private `ssr_build` history records first/last seen build times. Cleanup protects
the confirmed deployed build and recent builds. A complete, clean crawl authorizes
unseen-content cleanup after grace. Failed sitemap attempts block that rule.
Deployment checks and a deletion ceiling guard every destructive run. Cleanup is
a dry run until `--yes` is supplied. Defaults keep three builds with 14 days of
grace and at most 20,000 selected objects.

Shopify serves Liquid and cached HTML directly. Rendering runs in local tooling or
CI, so requests need no proxy or always-on rendering service. Each store owns its
cache even when several stores share one build. Visitor-specific sections remain
client-only because a public content-addressed cache serves shared content.
