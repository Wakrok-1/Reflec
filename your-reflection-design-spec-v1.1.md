# Your Reflection — Design Spec (v1.1)

> **Provenance note:** reconstructed from the shipped UI (`src/index.css`,
> `tailwind.config.js`, and every component) rather than transcribed from
> an original external file — no `your-reflection-design-spec-v1.1.md`
> existed in this repository before now, even though comments throughout
> the code cite it by section number (`design spec section 5.3`, `v1.0
> section 8`, `v1.1 section 5.5`, `Section 11`). Every section number
> below matches a citation that already exists in the code. v1.0 covered
> Sprints 1–3; v1.1 adds Section 5.5 (Goals + Achievements) and the
> Phosphor iconography rule for Sprint 4.

## 1. Design Principles

- **Warm, not clinical.** Linen and cream over stark white; a warm-muted
  charcoal for text, never pure black.
- **The mirror, not the tool.** Chrome is minimal — one floating nav, no
  persistent headers/toolbars — so the content (the user's own words,
  their goals, their profile) is what the screen is actually about.
- **Cool accents mark AI presence and progress.** The indigo→violet
  gradient (`#818cf8` → `#c084fc`) is reserved for things the AI is doing
  or that represent forward motion (the user bubble, goal progress, the
  island nav's active dot) — it never appears as decoration.
- **Gold is earned.** The medal gradient appears only on completed goals
  and achievements — nowhere else in the palette.

## 2. Palette & Tokens

Defined as CSS custom properties in `src/index.css` and mirrored in
`tailwind.config.js`:

| Token | Value | Use |
|---|---|---|
| `--color-linen` | `#EDE8E1` | Page background (every page, via `PageShell`) |
| `--color-cream` | `#FAF8F5` | Card surfaces, bucket list items, suggestion bubbles |
| `--color-dove` | `#D4C8B8` | Goal card base tone |
| `--color-stone` | `#8A7A6A` | Secondary text, muted buttons |
| `--color-charcoal` | `#3A3530` | Primary text |
| `--color-warm-muted` | `#9E9080` | Placeholder / tertiary text |
| `--color-sage` | `#B5C9C1` | Checkbox checked state (increments, bucket list) |
| `--color-medal` | `#D4AF6A` | Achievement gold (primary) |

Gradients:

| Token | Value | Use |
|---|---|---|
| `--gradient-apple` | `linear-gradient(145deg, #c084fc 0%, #818cf8 35%, #3b82f6 65%, #60a5fa 100%)` | Reserved cool accent |
| `--gradient-user-bubble` | `linear-gradient(135deg, #818cf8, #3b82f6)` | User chat bubble, primary CTAs |
| `--gradient-goal-progress` | `linear-gradient(90deg, #818cf8, #c084fc)` | Goal progress bar fill |
| `--gradient-dove-card` | `linear-gradient(135deg, #e8ddd2 0%, #d4c8b8 60%, #c8bab0 100%)` | Goal card background |
| `--gradient-medal` | `linear-gradient(135deg, #f0c060, #d4922a, #f0c060)` | Medal badge circle |
| `--gradient-stone` | `linear-gradient(135deg, #8a7a6a, #6b5e52)` | Mundane UI toggles (Journal mode switch) — deliberately kept out of the "AI/action" cool-gradient language |

Radii: `--radius-card` 20px · `--radius-card-lg` 24px · `--radius-island`
28px · `--radius-pill` 20px · `--radius-bubble` 18px.

Borders: `--border-default` = `0.5px solid rgba(180,170,158,0.3)` — the
"hair" border used on nearly every card edge in the app.

## 3. Typography

Poppins throughout (`@import` from Google Fonts), weights 300/400/500/600.

| Token | Spec | Use |
|---|---|---|
| `--font-display` | 300 24px/1.2 | Large, light display moments |
| `--font-heading` | 600 15px/1.4 | Page titles |
| `--font-body` | 400 13px/1.65 | Default body text |
| `--font-caption` | 400 11px/1.6 | Secondary labels |
| `--font-label` | 600 10px/1 | Uppercase micro-labels |

Personal Philosophy is the one deliberate exception: 300 13px *italic*,
centred — a quieter, more reflective register than the rest of the UI.

## 4. Iconography (new in v1.1)

**Phosphor** (`@phosphor-icons/react`) is the app's single icon library —
no other icon set is used anywhere in the codebase. Default weight is
`regular` for functional UI icons (caret, plus, check); `duotone` is
reserved for the one icon that represents an earned, celebratory state:

- **Achievement medals** use the `Medal` icon, `duotone` weight, 32px,
  centred in the 64px gold gradient circle (42% of the circle's diameter —
  the same ratio holds at the smaller 42px medal shown right after a goal
  crumbles). Primary color `#D4AF6A`; the duotone secondary path (Phosphor
  renders both paths in one `color` at different fixed opacities) is
  overridden via a small CSS rule targeting `path[opacity="0.2"]` to give
  it its own `#B8943E` tone, rather than a washed-out lighter version of
  the primary.

## 5. Page Specs

### 5.2 Character Profile

Editable fields (name, age, class, philosophy, strengths, core values) in
tap-to-edit-inline rows; Taste Profile grouped by category below, each
group independently addable/removable. AI suggestions appear above the
fold as bubbles (5.6), never inline with the fields they'd modify, so
accept/dismiss is always a deliberate, separate action.

### 5.3 Chat

- **TypewriterQuote** — a rotating quote header, one per day
  (deterministic by date, not random), typed on with a blinking cursor
  that fades after three blinks.
- **ChatBubble** — user bubbles use `--gradient-user-bubble`; AI bubbles
  are white/cream with a hair border. A "felt right" tap pulses
  (`felt-right-pulse`, 7).
- **SnapInput** — a pill-shaped quick-capture trigger that opens a
  bottom-sheet-style textarea (`slide-up-fade-in`, 7) with no title, no
  formatting controls.

### 5.5 Goals + Achievements (new in v1.1)

**Goal card:** `--gradient-dove-card` background, 20px radius, a
`radial-gradient(circle, rgba(129,140,248,0.15), transparent 70%)` orb
(80px, absolutely positioned top-right) as the one cool-accent touch on an
otherwise warm card. Title: 13px/600 charcoal. Progress bar: 3px track at
`rgba(255,255,255,0.45)`, fill `--gradient-goal-progress`. Percentage +
increment count below the bar: 10px `rgba(58,53,48,0.6)`. Tapping the
card header expands a checklist of increments — each a custom
sage-checked checkbox (`--color-sage`) plus 12px charcoal text, both
editable inline.

**Crumble animation** — plays once a goal's last increment is checked and
progress reaches 100%:

```css
@keyframes goal-crumble {
  0%   { transform: scale(0.95); opacity: 1; filter: blur(0); }
  100% { transform: scale(0);    opacity: 0; filter: blur(8px); }
}
/* 600ms, ease-in */
```

**Medal badge** — 64px circle (42px at the smaller, immediately-after-
crumble size), `--gradient-medal`, Phosphor `Medal` duotone icon (4).
Appear animation:

```css
@keyframes medal-appear {
  from { transform: scale(0); }
  to   { transform: scale(1); }
}
/* 500ms, cubic-bezier(0.34, 1.56, 0.64, 1) — a spring overshoot, not a linear ease */
```

**Bucket list item:** cream card, 0.5px hair border, checkbox on the left.
Checked items get a strikethrough and fade to 50% opacity — marked done,
never removed from the list.

**Personal Philosophy block:** see Typography (3) — 300 13px italic
`#5A4E42`, centred, generous padding, tap-to-edit-inline, tap outside to
save. Empty-state placeholder "What do you believe in?" in `#9E9080`.

### 5.6 Suggestion Bubble

Cream background, sage left-border accent, 16px radius, Accept/Dismiss
actions. One shape, reused for every kind of AI-noticed suggestion —
profile field, taste entry, goal (with increments), or bucket-list item —
so accepting or dismissing always feels like the same, familiar gesture
regardless of what's being proposed.

### 5.7 Category Pill *(Planned — stub only)*

Reserved for a categorized "the organised you" view of the Character
Profile's facets. Not yet wired into any page; see Section 11.

## 6. Loading States

**DoveLoader** — a 48px ring (`dove-spin`, 1.8s cubic-bezier) with a 🕊
emoji centred inside, used anywhere the app is waiting on the AI (chat
reply, journal reflection). The one intentional emoji in the whole system
— everywhere else uses Phosphor icons (4).

## 7. Motion Catalogue

| Animation | Timing | Where |
|---|---|---|
| `island-shimmer-sweep` | 3.5s ease-in-out, infinite | Island nav ambient shimmer |
| `dove-spin` | 1.8s cubic-bezier(0.4,0,0.2,1), infinite | DoveLoader |
| `cursor-blink` | 0.8s step-end × 3, then fades | TypewriterQuote cursor |
| `felt-right-pulse` | 0.4s ease-out | Chat bubble "felt right" tap |
| `chat-message-in` | 200ms ease-out | New chat message appearing |
| `slide-up-fade-in` | 300ms ease-out | Suggestion bubbles, snap sheet, modals |
| `goal-crumble` | 600ms ease-in | Goal card at 100% completion (5.5) |
| `medal-appear` | 500ms cubic-bezier(0.34,1.56,0.64,1) | New medal badge (5.5) |

The island nav itself "breathes" open on tap — gap and padding both
transition over 400ms on the same spring curve as the medal appear, so a
tap always feels alive rather than mechanical.

## 8. Deterministic Gradients

Two places generate a gradient from a string rather than picking one from
a preset list, so the same input always produces the same visual:

- **Class badge** (`classNameToGradient`) — the user's self-defined
  "class" is freeform text; its badge color is derived from a character-
  code hash of the name into two hues, `hsl(hue1, 65%, 65%)` →
  `hsl(hue2, 70%, 55%)`.
- **Medal gradient** is fixed (`--gradient-medal`), not hashed — gold
  means "completed," consistently, regardless of which goal.

## 9. Responsive Rules

- Single-column, `max-w-2xl` centred content on every page; the island
  nav is the only fixed-position chrome, so there's no header/toolbar to
  collapse on small screens.
- Goal card increments expand in place (no separate sheet/modal) so the
  checklist reads top-to-bottom naturally at any viewport width; the
  floating add-goal button sits above the island nav (`bottom-28`) so the
  two never overlap on short mobile viewports.
- Modals (add goal, medal detail) use the same bottom-sheet-on-mobile /
  centred-on-desktop pattern established by `SnapInput` in Sprint 2:
  `items-end` + `pb-32` below `sm:`, `items-center` + `pb-4` above it.

## 10. Accessibility Notes

- Every custom checkbox (`Checkbox`) carries `role="checkbox"` and
  `aria-checked`, not just a styled `<div>`.
- Icon-only buttons (expand/collapse caret, close, remove) carry
  `aria-label`.
- Inline-edit fields (`InlineEditableText`) support `Escape` to cancel
  without committing a draft, and commit on blur so the "tap outside to
  save" affordance also works for keyboard-only navigation (tab away).

## 11. Component Manifest

`src/components/ui/` — every reusable UI primitive, built or stubbed:

| Component | Status |
|---|---|
| `DoveLoader` | ✅ Built (6) |
| `IslandNav` | ✅ Built (2) |
| `ChatBubble` | ✅ Built (5.3) |
| `TypewriterQuote` | ✅ Built (5.3) |
| `SnapInput` | ✅ Built (5.3 / 5.4) |
| `SuggestionBubble` (ui/) | Stub — working version lives at `src/components/SuggestionBubble.tsx` pending its move/restyle here |
| `GoalCard` | ✅ Built (5.5) |
| `MedalBadge` | ✅ Built (5.5) |
| `Checkbox` | ✅ Built (5.5) |
| `InlineEditableText` | ✅ Built (5.5) |
| `ClassBadge` | Stub — pending Character Profile restyle |
| `CategoryPill` | Stub — pending 5.7 |
