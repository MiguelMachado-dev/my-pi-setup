---
description: Audit current page or component for SEO best practices
allowed-tools: Read, Glob, Grep, Bash(curl:*), WebFetch
---

# SEO Audit

Audit the current page/component for SEO issues: $ARGUMENTS

## Process

1. **Find Target**
   - If `$ARGUMENTS` specifies a page/route, locate its files
   - Otherwise, audit the main layout and index pages

2. **Meta Tags**
   - Check `<title>` exists and is 50-60 characters
   - Check `<meta name="description">` exists and is 150-160 characters
   - Verify canonical URL is set
   - Check `robots` meta if applicable

3. **Open Graph / Social**
   - Verify `og:title`, `og:description`, `og:image`, `og:url`
   - Verify `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
   - Check image dimensions (1200x630 for OG, 1200x600 for Twitter)

4. **Structured Data**
   - Check for JSON-LD schema markup
   - Verify schema type matches content (Article, Product, WebSite)

5. **HTML Semantics**
   - Single `<h1>` per page
   - Heading hierarchy (h1 > h2 > h3, no skips)
   - All images have `alt` text
   - Semantic elements (`<main>`, `<nav>`, `<article>`, `<section>`)

6. **Performance Signals**
   - Images use modern formats (WebP/AVIF)
   - Lazy loading on below-fold images
   - No render-blocking resources flagged

7. **Output**

```
## SEO Audit: [page]

### Critical
- [Issues that hurt ranking]

### Warnings
- [Issues that could be improved]

### Passing
- [What's already correct]
```
