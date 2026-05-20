---
description: Apply a concise Linear-inspired dark product design system
argument-hint: [screen, component, or flow]
---

# Linear-inspired Design

Design `$ARGUMENTS` with a dark, precise, product-led style inspired by Linear.

## Core style

- Dark-mode native. Build on near-black surfaces, not a light UI inverted.
- Minimal color. Use cool grays plus one indigo/violet accent.
- High precision. Use thin borders, tight type, subtle elevation, and generous spacing.
- Product-first. Let UI screenshots, panels, command palettes, and data views carry the page.
- Avoid decoration. Every glow, border, color, and motion must clarify hierarchy.

## Palette

```txt
Page bg:        #08090a
Panel bg:       #0f1011
Elevated:       #191a1b
Hover surface:  #28282c
Text primary:   #f7f8f8
Text secondary: #d0d6e0
Text muted:     #8a8f98
Text faint:     #62666d
Accent:         #5e6ad2
Accent active:  #7170ff
Accent hover:   #828fff
Success:        #10b981 / #27a644
Border subtle:  rgba(255,255,255,0.05)
Border default: rgba(255,255,255,0.08)
Overlay:        rgba(0,0,0,0.85)
```

Use accent color only for primary CTAs, selected states, links, and key focus areas.

## Typography

Use Inter Variable for UI and Berkeley Mono for code or technical labels.

Global Inter settings:

```css
font-feature-settings: "cv01", "ss03";
```

Type scale:

| Role | Size | Weight | Line height | Letter spacing |
| --- | ---: | ---: | ---: | ---: |
| Hero | 72px | 510 | 1.0 | -1.584px |
| Display | 48px | 510 | 1.0 | -1.056px |
| H1 | 32px | 400 | 1.13 | -0.704px |
| H2 | 24px | 400 | 1.33 | -0.288px |
| H3 | 20px | 590 | 1.33 | -0.24px |
| Body large | 18px | 400 | 1.6 | -0.165px |
| Body | 16px | 400 | 1.5 | normal |
| UI label | 14px | 510 | 1.5 | -0.182px |
| Caption | 13px | 400-510 | 1.5 | -0.13px |
| Micro | 11-12px | 510 | 1.4 | normal |
| Mono | 12-14px | 400 | 1.4-1.5 | normal |

Rules:

- Use 400 for reading, 510 for UI emphasis, 590 for strong emphasis.
- Avoid 700 bold.
- Use negative tracking on headings; relax to normal below 16px.
- Use `#f7f8f8` instead of pure white for primary text.

## Components

### Buttons

Primary:

```txt
bg #5e6ad2, text #fff, radius 6px, padding 8px 16px
hover #828fff
```

Ghost:

```txt
bg rgba(255,255,255,0.02)
text #e2e4e7
border 1px solid rgba(255,255,255,0.08)
radius 6px
```

Toolbar/icon:

```txt
bg rgba(255,255,255,0.03-0.05)
border rgba(255,255,255,0.05-0.08)
radius 2px for toolbar, 50% for icon buttons
font 12px / weight 510
```

### Cards and panels

```txt
bg rgba(255,255,255,0.02-0.05)
border 1px solid rgba(255,255,255,0.08)
radius 8px cards, 12px panels, 22px large feature shells
hover by raising bg opacity slightly
```

Use luminance changes for depth. Do not rely on dark drop shadows.

### Inputs

```txt
bg rgba(255,255,255,0.02)
text #d0d6e0
placeholder #62666d
border rgba(255,255,255,0.08)
radius 6px
padding 12px 14px
```

### Badges and pills

```txt
pill radius 9999px
neutral text #d0d6e0
border #23252a or rgba(255,255,255,0.08)
font 12px / weight 510
```

Use green only for real success, active, or completed states.

### Navigation

- Sticky dark header on `#0f1011` or transparent over `#08090a`.
- Left brand, center/left links, right CTA.
- Links: 13-14px, weight 510, `#d0d6e0`; hover `#f7f8f8`.
- Bottom border: `1px solid rgba(255,255,255,0.05)`.
- Collapse to hamburger below tablet widths.

## Layout

- Use an 8px spacing base.
- Favor `8 / 16 / 24 / 32 / 48 / 80` spacing steps.
- Max content width: about 1200px.
- Give hero sections large vertical padding.
- Use 2-3 column feature grids on desktop; collapse to one column on mobile.
- Let near-black background act as whitespace.
- Put dense, tight headings inside generous empty space.

## Depth

```txt
Level 0: #08090a page background
Level 1: rgba(255,255,255,0.02) subtle panels
Level 2: rgba(255,255,255,0.05) cards/inputs
Level 3: #191a1b elevated surfaces
Dialog: #191a1b + border + soft layered shadow
Focus: visible ring/shadow without bright outlines
```

Use semi-transparent white borders as the main depth cue.

## Responsive behavior

- Hero: 72px → 48px → 32px.
- Grids: 3 columns → 2 columns → 1 column.
- Reduce section padding from 80px+ to 48px on mobile.
- Keep touch targets comfortable.
- Preserve card borders and radius at all sizes.

## Do

- Use Inter Variable with `"cv01", "ss03"`.
- Use weight 510 for the signature UI feel.
- Use thin translucent borders.
- Keep surfaces nearly transparent on dark backgrounds.
- Reserve violet/indigo for primary interaction.
- Use Berkeley Mono for code, IDs, technical labels, and metrics.

## Don't

- Do not use pure white as default text.
- Do not use bold 700.
- Do not add warm UI chrome colors.
- Do not decorate with accent color.
- Do not use opaque bright borders.
- Do not turn every card into a glowing panel.
- Do not use generic dark mode; keep the system precise and restrained.

## Quick prompt

Use this when you need a compact instruction:

```txt
Create a Linear-inspired dark UI: #08090a page bg, #0f1011 panels, #191a1b elevated cards, Inter Variable with "cv01" and "ss03", weights 400/510/590, tight negative heading tracking, #f7f8f8 primary text, #8a8f98 muted text, thin rgba(255,255,255,0.05-0.08) borders, subtle translucent surfaces, #5e6ad2 primary CTA, Berkeley Mono for technical labels, generous spacing, minimal color, no heavy shadows.
```
