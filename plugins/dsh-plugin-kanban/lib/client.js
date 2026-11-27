// dsh-plugin-kanban — browser half.
//
// One sidebar tab that renders a board, and nothing else. The board is drawn
// from the host document at /api/dsh-kanban/*; the panel owns no storage, so a
// card created here and a card created by a conversation are the same card.
//
// Layout follows the reference board this was modelled on: a lane is a rounded
// tinted column, a card is a white (or near-black) block with a hairline
// border, 6px between cards, 16px between lanes. Colours come from the host's
// --dsw-alias-* tokens rather than fixed hexes, so the board follows the theme
// the user picked instead of pinning one.
//
// No bundler: the factory body is plain CJS and `require('react')` resolves to
// the shell's own React.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-kanban',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    /** Must match the `main` slot key and the sidebar row id. */
    const PANEL_ID = 'dsh-plugin-kanban';
    const BRIDGE_PREFIX = '/api/dsh-kanban';

    /** Must match the drawer's exit animation in the stylesheet. */
    const DRAWER_EXIT_MS = 140;

    const PRIORITIES = [
      { id: 'urgent', label: '紧急' },
      { id: 'high', label: '高' },
      { id: 'medium', label: '中' },
      { id: 'low', label: '低' },
    ];

    // ---------------------------------------------------------------- styles
    //
    // One stylesheet, injected once per page. Everything is scoped under .dsb-
    // so nothing here can reach the shell's own DOM, and every colour is a
    // token or a color-mix of one: the board has no palette of its own.

    const CSS = `
.dsb-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  height: 100%;
  min-height: 100%;
  position: relative;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: 13px/18px var(--dsw-font-family);
  /* Three surfaces, one step apart: the page, the trough a column sits in, and
     the card that floats in the trough. Every step is mixed from the page
     colour towards the label colour, so one formula serves both themes: the
     label flips from near-black to near-white, and the trough stays neutral
     instead of picking up a blue cast. Each theme tunes how far the steps go —
     in dark mode a trough below the page reads as a hole punched in the board,
     so there the trough sits just above the page and the card above it. */
  --dsb-surface-trough: color-mix(in srgb, var(--dsw-alias-bg-base) 95%, var(--dsw-alias-label-primary) 5%);
  --dsb-surface-card: var(--dsw-static-neutral-bluish-00);
  /* The accent is DSH's own info pink — the fill the composer's send button
     uses — not --dsw-alias-brand-primary. That token is the label colour here
     (near white), so filling a button with it produced a pale grey slab with
     white text on it. --dsb-on-accent is ink mixed from the accent itself, so
     the label stays readable on a pastel fill and follows the accent if the
     theme changes it. */
  --dsb-accent: var(--dsw-alias-button-info-fill, var(--dsw-alias-brand-primary));
  --dsb-accent-hover: var(--dsw-alias-button-info-hover, var(--dsb-accent));
  --dsb-on-accent: color-mix(in srgb, var(--dsb-accent) 16%, #241016);
  /* The pastel fill is only legible as a *fill*. As text or a hairline it turns
     into a watermark on the light theme, so those uses mix the same hue towards
     the label colour instead: it darkens on white and lightens on dark, which
     is exactly what a readable accent has to do in both themes. */
  --dsb-accent-ink: color-mix(in srgb, var(--dsb-accent) 46%, var(--dsw-alias-label-primary));
}
body[data-ds-dark-theme] .dsb-root {
  --dsb-surface-trough: color-mix(in srgb, var(--dsw-alias-bg-base) 96%, var(--dsw-alias-label-primary) 4%);
  --dsb-surface-card: var(--dsw-alias-bg-layer-2);
}

.dsb-lanes {
  box-sizing: border-box;
  display: flex;
  align-items: stretch;
  gap: 20px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 20px 24px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-gutter: stable;
}

.dsb-lane {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 264px;
  max-width: 384px;
  min-height: 0;
  border-radius: 12px;
  /* The column is a trough the cards sit in: it reads as one step below the
     page, and the card is one step above it. Both steps are set once on
     .dsb-root, per theme. */
  background: var(--dsb-surface-trough);
  transition: box-shadow 120ms ease;
}
.dsb-lane[data-over="true"] {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
}

.dsb-lane-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 44px;
  padding: 4px 10px 0 14px;
}
/* The column's mark. The header is a label, not a control: there is nothing here
   to drag, rename, or configure. */
.dsb-lane-mark {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: -4px;
  color: var(--dsw-alias-label-tertiary);
}
.dsb-lane-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 500 14px/20px var(--dsw-font-family);
}

.dsb-cards {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 10px;
  overflow-y: auto;
  overflow-x: hidden;
}
.dsb-cards::-webkit-scrollbar { width: 8px; }
.dsb-cards::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--dsw-alias-scrollbar-bg-l2);
}
.dsb-cards::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2); }

.dsb-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 13px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  /* The priority edge is reserved on every card, even the ones without a
     priority, so titles in a column start on one line instead of stepping in
     and out by the width of the accent. */
  border-left-width: 3px;
  border-left-color: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  background: var(--dsb-surface-card);
  transition: border-color 120ms ease, background 120ms ease;
  cursor: grab;
}
.dsb-card:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
}
/* Priority rides on the left edge rather than a dot: a column of cards is
   scanned top to bottom, and an edge is what the eye already follows. The
   accent is a border, not a strip, so it costs no layout.
   These rules come after :hover on purpose: border-color is a shorthand and
   the hover rule would otherwise repaint the left edge grey on the card you
   are pointing at. border-left-color is longhand, so it wins here. */
.dsb-card[data-priority] {
  border-left-color: var(--dsb-priority-color, color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent));
}
.dsb-card[data-priority="urgent"] { --dsb-priority-color: var(--dsw-alias-state-error-primary); }
.dsb-card[data-priority="high"] { --dsb-priority-color: var(--dsw-alias-state-warn-primary); }
.dsb-card[data-priority="medium"] { --dsb-priority-color: var(--dsw-alias-static-amber-400, var(--dsw-alias-state-warn-primary)); }
.dsb-card[data-priority="low"] { --dsb-priority-color: var(--dsw-alias-static-blue-500, var(--dsb-accent)); }
.dsb-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
  outline-offset: 1px;
}
.dsb-card[data-dragging="true"] { opacity: 0.45; }
/* Finished cards sink back into the trough: no border, no lift, the surface
   only a hair above the column. The card is still there and still openable, it
   just stops competing for attention with the work that is not done. */
.dsb-card[data-done="true"] {
  /* Longhands: border-color would wipe the priority edge, which this card
     keeps (muted, see below) even after it is finished. */
  border-top-color: transparent;
  border-right-color: transparent;
  border-bottom-color: transparent;
  background: color-mix(in srgb, var(--dsb-surface-card) 45%, transparent);
}
.dsb-card[data-done="true"]:hover {
  /* Longhands only: border-color is a shorthand and would repaint the priority
     edge grey, the same trap the hover rule above documents. */
  border-top-color: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  border-right-color: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  border-bottom-color: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  background: var(--dsb-surface-card);
}
/* Finished work keeps its accent but muted: the priority still belongs to the
   card, it just no longer asks for anything. */
.dsb-card[data-done="true"][data-priority] {
  border-left-color: color-mix(in srgb, var(--dsb-priority-color) 45%, transparent);
}
.dsb-card[data-done="true"][data-priority] .dsb-card-priority {
  color: var(--dsw-alias-label-tertiary);
}

/* A card waiting on someone is the one thing on this board that cannot move by
   itself, so it is lifted out of the column rather than tinted: the amber ring
   surrounds the whole card, where the priority edge can only own one side, and
   it survives the finished-card treatment because a done card can still be
   waiting on a person. */
.dsb-card[data-needs-human="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 48%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, var(--dsb-surface-card));
}
.dsb-card[data-needs-human="true"]:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 68%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsb-surface-card));
}
.dsb-card[data-needs-human="true"][data-done="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 5%, transparent);
}
/* The card a session is working on: the only card on the board that is moving
   without anyone touching it. */
.dsb-card[data-executing="true"] {
  border-color: color-mix(in srgb, var(--dsb-accent-ink) 34%, transparent);
}

.dsb-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 14px;
}
.dsb-card-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font: 400 11px/14px ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.01em;
}
.dsb-card-priority {
  flex: 0 0 auto;
  color: var(--dsb-priority-color, var(--dsw-alias-label-secondary));
  font: 500 11px/14px var(--dsw-font-family);
}
.dsb-card-title {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
  font: 500 13px/18px var(--dsw-font-family);
}
.dsb-card[data-done="true"] .dsb-card-title { color: var(--dsw-alias-label-tertiary); }

.dsb-card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.dsb-card-foot:empty { display: none; }

.dsb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  color: var(--dsw-alias-label-secondary);
  font: 400 11px/18px var(--dsw-font-family);
  white-space: nowrap;
}
.dsb-chip[data-overdue="true"] { color: var(--dsw-alias-state-error-primary); }
.dsb-chip[data-needs-human="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.dsb-chip[data-executing="true"] {
  border-color: color-mix(in srgb, var(--dsb-accent-ink) 40%, transparent);
  color: var(--dsb-accent-ink);
}
.dsb-chip[data-executing="true"] .dsb-spin { animation: dsb-spin 900ms linear infinite; }
.dsb-spin { display: flex; }
.dsb-btn .dsb-spin { animation: dsb-spin 900ms linear infinite; }
@keyframes dsb-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dsb-chip[data-executing="true"] .dsb-spin,
  .dsb-btn .dsb-spin { animation: none; }
}

.dsb-drop {
  height: 2px;
  margin: -4px 0;
  border-radius: 2px;
  background: var(--dsb-accent);
}

.dsb-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsb-icon-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsb-icon-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent); outline-offset: 1px; }

.dsb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: 500 12px/18px var(--dsw-font-family);
  cursor: pointer;
}
.dsb-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsb-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent); outline-offset: 1px; }
/* Deleting is one icon, not a labelled button: it is the only action here that
   destroys something, so it should not read like a peer of the other two. */
.dsb-trash-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 8px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsb-trash-btn:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dsb-trash-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  outline-offset: 1px;
}
.dsb-btn[data-tone="danger"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dsb-btn[data-tone="danger"]:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
/* The one button on the board that starts something, so it is the one button
   that is filled rather than outlined. */
.dsb-btn[data-tone="primary"] {
  border-color: transparent;
  background: var(--dsb-accent);
  color: var(--dsb-on-accent);
}
.dsb-btn[data-tone="primary"]:hover {
  background: var(--dsb-accent-hover);
}
.dsb-btn:disabled {
  cursor: default;
  /* A disabled button does not take pointer events, so the wrapper around it
     can own the tooltip that says why it is disabled. */
  pointer-events: none;
}
/* Off keeps the same ink and only steps the fill back toward the surface. Fading
   the whole button instead (or mixing the fill far enough that it turns dark
   under a dark theme) leaves dark ink on a dark fill, which is the smudge the
   first version had. */
.dsb-btn[data-tone="primary"]:disabled {
  opacity: 1;
  background: color-mix(in srgb, var(--dsb-accent) 74%, var(--dsw-alias-bg-layer-2));
  color: var(--dsb-on-accent);
}

.dsb-drawer {
  box-sizing: border-box;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 16;
  display: flex;
  flex-direction: column;
  width: min(460px, 100%);
  border-left: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: -12px 0 32px -18px color-mix(in srgb, #000 30%, transparent);
  animation: dsb-drawer-in 180ms cubic-bezier(0.2, 0.7, 0.3, 1);
}
.dsb-drawer[data-closing="true"] {
  animation: dsb-drawer-out 140ms cubic-bezier(0.4, 0, 0.7, 0.3) forwards;
  pointer-events: none;
}
@keyframes dsb-drawer-in {
  from { transform: translateX(16px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@keyframes dsb-drawer-out {
  from { transform: none; opacity: 1; }
  to { transform: translateX(12px); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .dsb-drawer,
  .dsb-drawer[data-closing="true"] { animation-duration: 1ms; }
}
/* The dimmed area behind the drawer. It is a backdrop, not a control: the
   element is a plain div, and every state that could repaint it is pinned, so
   pointing at it or clicking it never changes what it looks like. Only the
   open/close animation moves it. */
.dsb-drawer-scrim {
  position: absolute;
  inset: 0;
  z-index: 15;
  border: 0;
  padding: 0;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 40%, transparent);
  -webkit-backdrop-filter: blur(3px) saturate(115%);
  backdrop-filter: blur(3px) saturate(115%);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  animation: dsb-scrim-in 180ms ease;
}
.dsb-drawer-scrim:hover,
.dsb-drawer-scrim:active,
.dsb-drawer-scrim:focus {
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 40%, transparent);
  outline: none;
  border: 0;
}
@keyframes dsb-scrim-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dsb-drawer-scrim[data-closing="true"] {
  /* Stays clickable-through-free for its last frame: the board must not take a
     click that was aimed at the drawer that is still on screen. */
  animation: dsb-scrim-in 140ms ease reverse forwards;
}
@media (prefers-reduced-motion: reduce) {
  .dsb-drawer-scrim,
  .dsb-drawer-scrim[data-closing="true"] { animation-duration: 1ms; }
}

.dsb-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 12px 12px 4px 20px;
}
.dsb-drawer-body {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px 20px 20px;
  overflow-y: auto;
}
.dsb-drawer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 12px 20px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

/* The title is a heading that happens to be editable: at rest it has no frame
   and no fill, so the drawer opens on the card's name rather than on a box
   waiting to be filled in. The box only appears where the editing happens —
   hover says "this is a field", focus says "this is the field you are in". */
.dsb-title-input {
  box-sizing: border-box;
  width: 100%;
  height: 38px;
  padding: 6px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: 500 15px/24px var(--dsw-font-family);
  resize: none;
  overflow: hidden;
  outline: none;
  transition: background-color 120ms ease-out, border-color 120ms ease-out;
}
.dsb-title-input:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
}
/* The field's own border is the focus feedback; the shell's blue ring is
   explicitly off, so typing never paints a coloured frame around the box. */
.dsb-title-input:focus,
.dsb-title-input:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
  background: var(--dsw-alias-bg-layer-2);
}
@media (prefers-reduced-motion: reduce) {
  .dsb-title-input { transition: none; }
}
.dsb-title-input::placeholder { color: var(--dsw-alias-label-tertiary); }

.dsb-fields {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 6px 12px;
  align-items: center;
}
.dsb-field-label {
  color: var(--dsw-alias-label-tertiary);
  font: 400 12px/20px var(--dsw-font-family);
}
.dsb-control {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  border-left-width: 3px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: 400 13px/18px var(--dsw-font-family);
  outline: none;
}
.dsb-control:focus,
.dsb-control:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
}
/* The priority select wears the same edge as the card it edits, so the colour
   you picked is visible while you are picking it. The width is reserved on
   every control so the fields below it stay aligned. */
.dsb-control[data-priority] {
  border-left-color: var(--dsb-priority-color, color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent));
}
.dsb-control[data-priority="urgent"] { --dsb-priority-color: var(--dsw-alias-state-error-primary); }
.dsb-control[data-priority="high"] { --dsb-priority-color: var(--dsw-alias-state-warn-primary); }
.dsb-control[data-priority="medium"] { --dsb-priority-color: var(--dsw-alias-static-amber-400, var(--dsw-alias-state-warn-primary)); }
.dsb-control[data-priority="low"] { --dsb-priority-color: var(--dsw-alias-static-blue-500, var(--dsb-accent)); }
/* The date is a button, not a native input: the platform picker paints its own
   popup in the browser accent, a blue no token on this board reaches. The
   trigger keeps the control's frame and only adds a calendar mark at the edge,
   so the two date rows still read as fields. */
.dsb-date-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  text-align: left;
}
.dsb-date-trigger[data-empty="true"] .dsb-date-value { color: var(--dsw-alias-label-tertiary); }
.dsb-date-trigger[aria-expanded="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
}
.dsb-date-mark { color: var(--dsw-alias-label-tertiary); }

/* Waiting on a person is a property of a card, not a column. It sits in the
   footer beside the run button: both are things you do to a card that cannot
   move itself, and neither is a field you fill in. */
.dsb-flag-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 0;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
  color: var(--dsw-alias-label-secondary);
  font: 500 12px/18px var(--dsw-font-family);
  cursor: pointer;
}
.dsb-flag-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent); }
.dsb-flag-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsb-accent-ink) 55%, transparent);
  outline-offset: 1px;
}
.dsb-flag-btn[data-on="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 90%, var(--dsw-alias-label-primary));
}
.dsb-flag-btn[data-on="true"]:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent);
}

/* The footer's right side: the two actions that are about the card as a whole
   — make it move, or say it cannot. Every other control in the drawer edits a
   field. */
.dsb-foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
/* Disabled buttons swallow the pointer, so the tooltip that explains why lives
   on this wrapper instead of on the button itself. */
.dsb-run-wrap { display: inline-flex; }

/* The calendar floats over the drawer instead of opening inside it: a field
   that grows to three hundred pixels would push the description and the log
   down the panel every time a date is looked at, which reads as the drawer
   rearranging itself rather than as a picker opening. Fixed positioning keeps
   it out of the drawer's own scrolling box, so it is never clipped by it. */
.dsb-cal-panel {
  position: fixed;
  z-index: 30;
  box-sizing: border-box;
  padding: 8px 10px 6px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 14px 32px -14px color-mix(in srgb, #000 34%, transparent);
  animation: dsb-cal-in 120ms cubic-bezier(0.2, 0.7, 0.3, 1);
}
@keyframes dsb-cal-in {
  from { transform: translateY(-3px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dsb-cal-panel { animation-duration: 1ms; }
}
.dsb-cal { --dsb-cal-cell: 30px; }
.dsb-cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 26px;
  margin-bottom: 2px;
}
.dsb-cal-nav { display: flex; gap: 2px; }
.dsb-cal-prev,
.dsb-cal-next {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsb-cal-prev:hover,
.dsb-cal-next:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsb-cal-prev:focus-visible,
.dsb-cal-next:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
  outline-offset: 1px;
}
.dsb-cal-label {
  color: var(--dsw-alias-label-primary);
  font: 500 13px/20px var(--dsw-font-family);
}
.dsb-cal-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
.dsb-cal-weekday {
  height: 24px;
  color: var(--dsw-alias-label-tertiary);
  font: 400 11px/16px var(--dsw-font-family);
}
.dsb-cal-day { padding: 1px 0; text-align: center; }
.dsb-cal-daybtn {
  width: var(--dsb-cal-cell);
  height: var(--dsb-cal-cell);
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: 400 12.5px/1 var(--dsw-font-family);
  cursor: pointer;
}
.dsb-cal-daybtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsb-cal-daybtn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
  outline-offset: -1px;
}
.dsb-cal-today:not(.dsb-cal-selected) .dsb-cal-daybtn {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
}
.dsb-cal-selected .dsb-cal-daybtn {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-1);
  font-weight: 500;
}
.dsb-cal-selected .dsb-cal-daybtn:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 84%, transparent);
}
.dsb-cal-outside .dsb-cal-daybtn { color: var(--dsw-alias-label-tertiary); }
.dsb-cal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}
.dsb-cal-action {
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: 500 12px/18px var(--dsw-font-family);
  cursor: pointer;
}
.dsb-cal-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsb-cal-action:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
  outline-offset: 1px;
}
.dsb-text {
  box-sizing: border-box;
  width: 100%;
  min-height: 140px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: 400 13px/20px var(--dsw-font-family);
  resize: vertical;
  outline: none;
}
.dsb-text:focus,
.dsb-text:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
}
.dsb-text::placeholder { color: var(--dsw-alias-label-tertiary); }

.dsb-warn {
  color: var(--dsw-alias-label-secondary);
  font: 400 12px/18px var(--dsw-font-family);
}

.dsb-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsb-history-title {
  color: var(--dsw-alias-label-tertiary);
  font: 500 11px/16px var(--dsw-font-family);
  letter-spacing: 0.02em;
}
.dsb-history-list {
  margin: 0;
  padding: 0 0 0 11px;
  list-style: none;
  border-left: 1px solid var(--dsw-alias-border-l2);
}
.dsb-history-item {
  position: relative;
  padding: 0 0 8px;
  color: var(--dsw-alias-label-secondary);
  font: 400 12px/18px var(--dsw-font-family);
  overflow-wrap: anywhere;
}
.dsb-history-item:last-child { padding-bottom: 0; }
.dsb-history-item::before {
  content: "";
  position: absolute;
  left: -14px;
  top: 6px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
}
.dsb-history-when {
  margin-right: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsb-history-field { color: var(--dsw-alias-label-tertiary); }
.dsb-history-value { color: var(--dsw-alias-label-primary); }

.dsb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  color: var(--dsw-alias-label-tertiary);
  font: 400 13px/18px var(--dsw-font-family);
}
`;

    const STYLE_ID = 'dsh-plugin-kanban-styles';

    /**
     * Inject the board stylesheet once. A reload re-runs this module body, so the
     * id guard is what keeps a second copy out of the document.
     */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => element.remove();
    }

    // ----------------------------------------------------------------- icons
    //
    // Every glyph on this board is a Lucide icon (https://lucide.dev, ISC),
    // drawn with its own 24x24 geometry so a shape can be held against the
    // source and recognised. Only the stroke width is ours: Lucide draws at 2,
    // which reads heavy at 14px beside 13px text, so the board keeps the
    // lighter 1.7 it has always used.

    function Icon({ size = 14, stroke = 1.7, children }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        children,
      );
    }

    /** Lucide `plus`. */
    const PlusIcon = (p) => h(Icon, p, h('path', { d: 'M5 12h14' }), h('path', { d: 'M12 5v14' }));

    /** Lucide `x`: closes the card drawer. */
    const CloseIcon = (p) =>
      h(Icon, p, h('path', { d: 'M18 6 6 18' }), h('path', { d: 'm6 6 12 12' }));

    /** Lucide `calendar`: the mark on a date trigger. */
    const CalendarIcon = (p) =>
      h(
        Icon,
        p,
        h('path', { d: 'M8 2v4' }),
        h('path', { d: 'M16 2v4' }),
        h('rect', { width: 18, height: 18, x: 3, y: 4, rx: 2 }),
        h('path', { d: 'M3 10h18' }),
      );

    /** Lucide `chevron-left`, one month back in the calendar. */
    const ChevronLeftIcon = (p) => h(Icon, p, h('path', { d: 'm15 18-6-6 6-6' }));

    /** Lucide `chevron-right`, one month on in the calendar. */
    const ChevronRightIcon = (p) => h(Icon, p, h('path', { d: 'm9 18 6-6-6-6' }));

    /** Lucide `user-round`: the card is waiting on a person. */
    const PersonIcon = (p) =>
      h(Icon, p, h('circle', { cx: 12, cy: 8, r: 5 }), h('path', { d: 'M20 21a8 8 0 0 0-16 0' }));

    /** Lucide `play`: start a session for this card. */
    const PlayIcon = (p) => h(Icon, p, h('path', { d: 'M6 3v18l14-9z' }));

    /** Lucide `loader-circle`, spun by CSS while a session is running. */
    const LoaderIcon = (p) => h(Icon, p, h('path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }));

    /** Lucide `arrow-up-right`: open the session this card is running in. */
    const OpenIcon = (p) =>
      h(Icon, p, h('path', { d: 'M7 7h10v10' }), h('path', { d: 'M7 17 17 7' }));

    /** Lucide `trash-2`: the one destructive action, kept as a mark not a label. */
    const TrashIcon = (p) =>
      h(
        Icon,
        p,
        h('path', { d: 'M3 6h18' }),
        h('path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }),
        h('path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }),
        h('path', { d: 'M10 11v6' }),
        h('path', { d: 'M14 11v6' }),
      );

    /**
     * One mark per column, so the board can be scanned by shape before any name
     * is read. All of them are Lucide circles at heart, which keeps the row
     * looking like one family instead of borrowed pictures: the ring changes
     * state as work moves along, and only the last one is closed and checked.
     *
     * The mark is keyed by column id, not by name — a column's identity in the
     * file is its id, and the name is just what the label says.
     */
    const COLUMN_ICONS = {
      /** Lucide `circle-dashed`: not committed yet, edges still open. */
      backlog: (p) =>
        h(
          Icon,
          p,
          h('path', { d: 'M10.1 2.182a10 10 0 0 1 3.8 0' }),
          h('path', { d: 'M13.9 21.818a10 10 0 0 1-3.8 0' }),
          h('path', { d: 'M17.609 3.721a10 10 0 0 1 2.69 2.7' }),
          h('path', { d: 'M2.182 13.9a10 10 0 0 1 0-3.8' }),
          h('path', { d: 'M20.279 17.609a10 10 0 0 1-2.7 2.69' }),
          h('path', { d: 'M21.818 10.1a10 10 0 0 1 0 3.8' }),
          h('path', { d: 'M3.721 6.391a10 10 0 0 1 2.7-2.69' }),
          h('path', { d: 'M6.391 20.279a10 10 0 0 1-2.69-2.7' }),
        ),
      /** Lucide `circle`: queued, whole, untouched. */
      todo: (p) => h(Icon, p, h('circle', { cx: 12, cy: 12, r: 10 })),
      /** Lucide `loader-circle`: the ring has opened — work is underway. */
      doing: (p) => h(Icon, p, h('path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' })),
      /** Lucide `eye`: someone has to look at it before it counts as done. */
      review: (p) =>
        h(
          Icon,
          p,
          h('path', {
            d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
          }),
          h('circle', { cx: 12, cy: 12, r: 3 }),
        ),
      /** Lucide `circle-check`: closed and checked. */
      done: (p) =>
        h(
          Icon,
          p,
          h('circle', { cx: 12, cy: 12, r: 10 }),
          h('path', { d: 'm16 9-5.5 5.5L8 12' }),
        ),
    };

    /** The column's mark: its own icon, or a plain ring for an unknown id. */
    function ColumnIcon({ columnId, size = 14 }) {
      const draw = COLUMN_ICONS[columnId] ?? COLUMN_ICONS.todo;
      return draw({ size });
    }

    // --------------------------------------------------------------- utilities

    /**
     * Call the host bridge.
     * @param {string} path - path below the bridge prefix.
     * @param {object} [body] - JSON body.
     * @returns {Promise<object>} `{ ok, board }` or `{ ok: false, error }`.
     */
    async function call(path, body) {
      const response = await fetch(`${BRIDGE_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        return { ok: false, error: text || `HTTP ${response.status}` };
      }
      if (!response.ok) return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
      return payload;
    }

    /** Month and day for a due date, in the browser's own locale. */
    function formatDue(iso) {
      if (!iso) return null;
      const date = new Date(`${iso}T00:00:00`);
      if (Number.isNaN(date.getTime())) return null;
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    /** Local calendar date as `YYYY-MM-DD`, the form the board stores. */
    function toISODate(date) {
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /** Parse a stored `YYYY-MM-DD` as a local date, not a UTC instant. */
    function fromISODate(iso) {
      if (!iso) return null;
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
      if (!match) return null;
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Number.isNaN(date.getTime()) ? null : date;
    }

    /** `2026/09/04` — a calendar date the way the date rows show it. */
    function formatDate(iso) {
      const date = fromISODate(iso);
      if (!date) return '未设置';
      return toISODate(date).replace(/-/g, '/');
    }

    /** Whether a due date is in the past. `today` is a local calendar date. */
    function isOverdue(iso) {
      if (!iso) return false;
      const today = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      const local = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      return iso < local;
    }

    /**
     * Where a pointer at `clientY` falls among the cards of one lane.
     * @param {HTMLElement|null} list - the card container.
     * @param {number} clientY - pointer position.
     * @returns {number} insertion index.
     */
    function indexAt(list, clientY) {
      if (!list) return 0;
      const cards = [...list.querySelectorAll('[data-card-id]')];
      let index = 0;
      for (const card of cards) {
        const box = card.getBoundingClientRect();
        if (clientY > box.top + box.height / 2) index += 1;
      }
      return index;
    }

    // -------------------------------------------------------------- components

    /**
     * The host context captured at apply time, so a card can jump to the session
     * it runs in. `openSession` lives on the UI workspace service; the older
     * `sessions.open` is kept as a fallback for shells that still have it.
     */
    let hostContext = null;

    /**
     * Where a session stands right now, mirroring the shell's own link check.
     * An archived session is hidden from the workspace groups and owns no live
     * scope, so asking the shell to open one lands on a released reference.
     * @param {string} sessionId - session to look up.
     * @returns {'available'|'archived'|'missing'|'loading'|'unavailable'}
     */
    function sessionLinkState(sessionId) {
      const context = hostContext;
      if (!context || typeof context.get !== 'function') return 'unavailable';
      try {
        const sessions = context.get('sessions')?.list?.getSnapshot();
        const workspaces = context.get('workspaces')?.list?.getSnapshot();
        if (!sessions || !workspaces) return 'unavailable';
        if (sessions.phase === 'pending' || workspaces.phase === 'pending') return 'loading';
        if (workspaces.archivedSessionIds?.includes(sessionId) === true) return 'archived';
        if (sessions.ids?.includes(sessionId) !== true) return 'missing';
        return 'available';
      } catch {
        return 'unavailable';
      }
    }

    /**
     * Open a session by id in this window. A card can point at a session the
     * user archived afterwards, so the archive is lifted first — an archived
     * session has no live scope and the shell refuses to open it.
     * @param {string} sessionId - session to open.
     * @returns {'opened'|'archived'|'missing'|'unavailable'}
     */
    async function openSessionById(sessionId) {
      const context = hostContext;
      if (!context || typeof context.get !== 'function') return 'unavailable';
      const ui = context.get('uiWorkspace');
      if (typeof ui?.openSession !== 'function') return 'unavailable';
      let state = sessionLinkState(sessionId);
      if (state === 'archived') {
        const workspaces = context.get('workspaces');
        if (typeof workspaces?.unarchiveSession !== 'function') return 'archived';
        try {
          await workspaces.unarchiveSession(sessionId);
        } catch {
          return 'archived';
        }
        state = sessionLinkState(sessionId);
        if (state === 'archived') return 'archived';
      }
      if (state === 'missing') return 'missing';
      try {
        ui.openSession(sessionId);
        return 'opened';
      } catch {
        return 'unavailable';
      }
    }

    /**
     * The whole board page.
     */
    function BoardPage() {
      const [board, setBoard] = useState(null);
      const [error, setError] = useState(null);
      const [openCardId, setOpenCardId] = useState(null);
      const [dragging, setDragging] = useState(null);
      const [dropTarget, setDropTarget] = useState(null);
      /** True while the drawer plays its exit animation. */
      const [closing, setClosing] = useState(false);
      /** Workspaces a card can be run in; `[]` until the host answers. */
      const [workspaces, setWorkspaces] = useState([]);

      const laneRefs = useRef({});
      const closingRef = useRef(false);
      const closeTimer = useRef(null);

      const load = useCallback(async () => {
        const payload = await call('/board');
        if (payload.ok) {
          setBoard(payload.board);
          setError(null);
        } else {
          setError(payload.error ?? '读取失败');
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      // Workspaces change far less often than the board does, but they are
      // also the one list the board cannot derive: read them once when the
      // panel mounts, and again whenever it regains focus so a workspace
      // opened in another window shows up in the picker.
      const loadWorkspaces = useCallback(async () => {
        const payload = await call('/workspaces');
        if (payload.ok) setWorkspaces(payload.workspaces ?? []);
      }, []);

      useEffect(() => {
        void loadWorkspaces();
      }, [loadWorkspaces]);

      // The same document can be changed from the conversation (board_add_card)
      // or by another window, so re-read it whenever this view regains focus.
      useEffect(() => {
        const refresh = () => {
          if (document.visibilityState === 'hidden') return;
          void load();
          void loadWorkspaces();
        };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          window.removeEventListener('focus', refresh);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, [load, loadWorkspaces]);

      // A running card settles on its own, in a session the person is looking
      // at instead of this panel — so focus never returns here and nothing
      // would repaint. While any card is running, poll: a session outlives the
      // panel's attention, and coming back to a card that still says 执行中
      // half an hour after it finished would be a lie.
      const anyRunning = useMemo(
        () => board?.projects[0]?.cards.some((card) => card.executing === true) ?? false,
        [board],
      );

      useEffect(() => {
        if (!anyRunning) return undefined;
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return;
          void load();
        }, 4000);
        return () => clearInterval(timer);
      }, [anyRunning, load]);

      /** Run a mutation and adopt whatever document the host returns. */
      const mutate = useCallback(async (path, body) => {
        const payload = await call(path, body);
        if (payload.ok) {
          setBoard(payload.board);
          setError(null);
          return payload;
        }
        setError(payload.error ?? '操作失败');
        return payload;
      }, []);

      // One board, always the first project. The document still holds a list
      // because that is its shape on disk and the conversation tools address
      // projects by id, but the panel no longer offers a way to add a second.
      const project = useMemo(() => board?.projects[0] ?? null, [board]);

      const openCard = useMemo(() => {
        if (!project || !openCardId) return null;
        return project.cards.find((card) => card.id === openCardId) ?? null;
      }, [project, openCardId]);

      /**
       * Close the drawer. Edits save on blur, and unmounting a focused field
       * never fires one, so blur first — closing must not drop keystrokes.
       *
       * The panel stays mounted for the length of the exit animation and only
       * then unmounts, so opening and closing feel like the same motion. While
       * it is leaving, further closes are ignored.
       */
      const closeDrawer = useCallback(() => {
        if (closingRef.current) return;
        const active = document.activeElement;
        if (active && typeof active.blur === 'function') active.blur();
        closingRef.current = true;
        setClosing(true);
        closeTimer.current = setTimeout(() => {
          closeTimer.current = null;
          closingRef.current = false;
          setClosing(false);
          setOpenCardId(null);
        }, DRAWER_EXIT_MS);
      }, []);

      useEffect(
        () => () => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
        },
        [],
      );

      // Escape closes the drawer. The listener is on the capture phase so the
      // drawer wins over the shell's own Escape handling: while a card is open,
      // Escape belongs to the drawer — unless a calendar is open inside it,
      // where Escape is the smaller thing and only closes the calendar.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          // A calendar open inside the drawer is the smaller thing: Escape
          // closes it and leaves the card open. The calendar's own listener
          // handles that case, so this one stands down.
          if (!openCardId || document.querySelector?.('.dsb-cal-panel')) return;
          event.preventDefault();
          event.stopPropagation();
          closeDrawer();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [openCardId, closeDrawer]);

      const cardsOf = (columnId) => project?.cards.filter((card) => card.columnId === columnId) ?? [];

      const createCard = async (columnId) => {
        if (!project) return;
        const payload = await mutate('/card/create', { projectId: project.id, columnId, title: '' });
        if (!payload.ok || !payload.board) return;
        const nextProject = payload.board.projects.find((item) => item.id === project.id);
        const created = nextProject?.cards[nextProject.cards.length - 1];
        if (created) setOpenCardId(created.id);
      };

      const moveCard = async (cardId, columnId, index) => {
        if (!project) return;
        // Optimistic: the card jumps under the pointer immediately, then the
        // host's document replaces the guess. A rejected move snaps back on its
        // own, because the eventual setBoard carries the server's order.
        setBoard((current) => {
          if (!current) return current;
          return {
            ...current,
            projects: current.projects.map((item) => {
              if (item.id !== project.id) return item;
              const card = item.cards.find((candidate) => candidate.id === cardId);
              if (!card) return item;
              const rest = item.cards.filter((candidate) => candidate.id !== cardId);
              const siblings = rest.filter((candidate) => candidate.columnId === columnId);
              const anchor = siblings[index] ?? null;
              const moved = { ...card, columnId };
              if (!anchor) return { ...item, cards: [...rest, moved] };
              const at = rest.indexOf(anchor);
              const cards = [...rest.slice(0, at), moved, ...rest.slice(at)];
              return { ...item, cards };
            }),
          };
        });
        await mutate('/card/move', { projectId: project.id, cardId, columnId, index });
      };

      /**
       * Start a session for this card. The host mints the session, puts the card
       * in 进行中 and reports back with the new board; from then on the card
       * moves itself, so there is nothing to poll here.
       */
      const runCard = async (cardId, workspaceId) => {
        if (!project) return;
        await mutate('/card/run', { projectId: project.id, cardId, workspaceId: workspaceId ?? null });
      };

      const onDragStart = (event, card) => {
        setDragging(card.id);
        event.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without data on the transfer.
        event.dataTransfer.setData('text/plain', card.id);
      };

      const onDragEnd = () => {
        setDragging(null);
        setDropTarget(null);
      };

      const onLaneDragOver = (event, column) => {
        if (!dragging) return;
        event.preventDefault();
        const list = laneRefs.current[column.id] ?? null;
        setDropTarget({ columnId: column.id, index: indexAt(list, event.clientY) });
      };

      const onLaneDrop = (event, column) => {
        event.preventDefault();
        const cardId = dragging;
        const index = dropTarget?.columnId === column.id ? dropTarget.index : cardsOf(column.id).length;
        setDragging(null);
        setDropTarget(null);
        if (cardId) void moveCard(cardId, column.id, index);
      };

      if (error && !board) {
        return h('div', { className: 'dsb-root' }, h('div', { className: 'dsb-empty' }, error));
      }
      if (!board || !project) {
        return h('div', { className: 'dsb-root' }, h('div', { className: 'dsb-empty' }, '载入中'));
      }

      return h(
        'div',
        { className: 'dsb-root' },

        // ---- lanes
        h(
          'div',
          { className: 'dsb-lanes' },
          project.columns.map((column) =>
            h(Lane, {
              key: column.id,
              column,
              cards: cardsOf(column.id),
              draggingId: dragging,
              dropTarget: dropTarget?.columnId === column.id ? dropTarget.index : null,
              listRef: (element) => {
                laneRefs.current[column.id] = element;
              },
              onOpenCard: setOpenCardId,
              onAddCard: () => void createCard(column.id),
              onDragStart,
              onDragEnd,
              onDragOverLane: onLaneDragOver,
              onDropLane: onLaneDrop,
            }),
          ),
        ),

        // ---- drawer: a frosted scrim over the board, then the panel itself.
        // Clicking the dimmed area closes the card, which is what the shadow
        // implies it does. The scrim is a div, not a button: it is decoration
        // with a click handler, and a full-panel <button> both paints native
        // hover chrome and adds a screen-sized tab stop. Keyboard users get
        // Escape and the drawer's own close button instead.
        openCard &&
          h(
            React.Fragment,
            null,
            h('div', {
              key: 'drawer-scrim',
              className: 'dsb-drawer-scrim',
              'aria-hidden': 'true',
              'data-closing': closing ? 'true' : undefined,
              onClick: closeDrawer,
            }),
            h(CardDrawer, {
              key: openCard.id,
              card: openCard,
              project,
              closing,
              workspaces,
              onClose: closeDrawer,
              onChange: (patch) =>
                void mutate('/card/update', { projectId: project.id, cardId: openCard.id, ...patch }),
              onMove: (columnId) =>
                void mutate('/card/move', {
                  projectId: project.id,
                  cardId: openCard.id,
                  columnId,
                  index: 0,
                }),
              onRun: (workspaceId) => void runCard(openCard.id, workspaceId),
              onOpenSession: async (sessionId) => {
                const outcome = await openSessionById(sessionId);
                if (outcome === 'archived') setError('这个会话在归档里，恢复不了');
                else if (outcome === 'missing') setError('这个会话已经不在了');
                else if (outcome === 'unavailable') setError('这个窗口打不开会话');
              },
              onDelete: async () => {
                await mutate('/card/delete', { projectId: project.id, cardId: openCard.id });
                setOpenCardId(null);
              },
            }),
          ),

        error &&
          h(
            'div',
            {
              role: 'status',
              style: {
                position: 'absolute',
                left: '20px',
                bottom: '16px',
                zIndex: 30,
                padding: '6px 10px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-secondary)',
                font: '400 12px/18px var(--dsw-font-family)',
              },
            },
            error,
          ),
      );
    }

    /**
     * One lane: header, card list, footer add button.
     */
    function Lane(props) {
      const {
        column,
        cards,
        draggingId,
        dropTarget,
        listRef,
        onOpenCard,
        onAddCard,
        onDragStart,
        onDragEnd,
        onDragOverLane,
        onDropLane,
      } = props;

      const [over, setOver] = useState(false);

      const rows = [];
      cards.forEach((card, index) => {
        if (dropTarget === index) rows.push(h('div', { key: `drop-${index}`, className: 'dsb-drop' }));
        rows.push(
          h(Card, {
            key: card.id,
            card,
            done: column.isFinal,
            dragging: draggingId === card.id,
            onOpen: () => onOpenCard(card.id),
            onDragStart: (event) => onDragStart(event, card),
            onDragEnd,
          }),
        );
      });
      if (dropTarget === cards.length) {
        rows.push(h('div', { key: 'drop-end', className: 'dsb-drop' }));
      }

      return h(
        'section',
        {
          className: 'dsb-lane',
          'data-over': over && draggingId ? 'true' : 'false',
          'data-final': column.isFinal ? 'true' : 'false',
          'data-column-id': column.id,
          'aria-label': `${column.name}，${cards.length} 张卡片`,
          onDragOver: (event) => {
            setOver(true);
            onDragOverLane(event, column);
          },
          onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            setOver(false);
          },
          onDrop: (event) => {
            setOver(false);
            onDropLane(event, column);
          },
        },
        h(
          'div',
          { className: 'dsb-lane-head' },
          h(
            'span',
            { className: 'dsb-lane-mark', 'aria-hidden': true },
            h(ColumnIcon, { columnId: column.id, size: 14 }),
          ),
          h('span', { className: 'dsb-lane-name' }, column.name),
          h(
            'button',
            {
              type: 'button',
              className: 'dsb-icon-btn',
              onClick: onAddCard,
              title: '新建卡片',
              'aria-label': `在「${column.name}」新建卡片`,
            },
            h(PlusIcon, { size: 14 }),
          ),
        ),
        h('div', { className: 'dsb-cards', ref: listRef }, rows),
      );
    }

    /**
     * One card. Draggable, clickable, keyboard-openable.
     */
    function Card({ card, done, dragging, onOpen, onDragStart, onDragEnd }) {
      const due = formatDue(card.dueDate);
      const start = formatDue(card.startDate);
      // One chip for the whole window: two dates stacked read as two facts when
      // they are one, and the arrow says which end is which.
      const span = start && due ? `${start} → ${due}` : (due ?? start);
      const overdue = isOverdue(card.dueDate);
      const needsHuman = card.needsHuman === true;
      const executing = card.executing === true;
      return h(
        'div',
        {
          className: 'dsb-card',
          'data-card-id': card.id,
          'data-dragging': dragging ? 'true' : 'false',
          'data-done': done ? 'true' : 'false',
          'data-priority': card.priority ?? undefined,
          'data-needs-human': needsHuman ? 'true' : 'false',
          'data-executing': executing ? 'true' : 'false',
          draggable: true,
          tabIndex: 0,
          role: 'button',
          onDragStart,
          onDragEnd,
          onClick: onOpen,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen();
            }
          },
        },
        h(
          'div',
          { className: 'dsb-card-top' },
          h('span', { className: 'dsb-card-id' }, `#${card.number}`),
          // The word, not a dot: colour alone is not a label, and the edge
          // already carries the colour. Text also survives greyscale.
          card.priority
            ? h(
                'span',
                { className: 'dsb-card-priority' },
                PRIORITIES.find((item) => item.id === card.priority)?.label ?? card.priority,
              )
            : null,
        ),
        h('div', { className: 'dsb-card-title' }, card.title || '未命名'),
        (span || needsHuman || executing) &&
          h(
            'div',
            { className: 'dsb-card-foot' },
            needsHuman &&
              h(
                'span',
                {
                  className: 'dsb-chip',
                  'data-needs-human': 'true',
                  title: '这张卡片在等人工介入',
                },
                h(PersonIcon, { size: 12 }),
                '需人工',
              ),
            executing &&
              h(
                'span',
                {
                  className: 'dsb-chip',
                  'data-executing': 'true',
                  title: '会话正在处理这张卡片',
                },
                h(
                  'span',
                  { className: 'dsb-spin', style: { display: 'flex' } },
                  h(LoaderIcon, { size: 12 }),
                ),
                '执行中',
              ),
            span &&
              h('span', { className: 'dsb-chip', 'data-overdue': overdue ? 'true' : 'false' }, span),
          ),
      );
    }

    /**
     * The change log: what happened to this card, newest last.
     *
     * A timeline rather than a table: the entries are few and the order is the
     * point, and a table of one-line facts would be wider without being clearer.
     *
     * @param {object} props - component props.
     * @param {Array} props.history - log entries.
     * @param {Array} props.columns - the project's columns, to name a status.
     * @param {Array} [props.workspaces] - known workspaces, to name one.
     */
    function History({ history, columns, workspaces }) {
      const entries = Array.isArray(history) ? history : [];
      if (entries.length === 0) return null;
      return h(
        'div',
        { className: 'dsb-history' },
        h('div', { className: 'dsb-history-title' }, '变更记录'),
        h(
          'ul',
          { className: 'dsb-history-list' },
          entries.map((entry, index) =>
            h(
              'li',
              { key: `${entry.at}-${index}`, className: 'dsb-history-item' },
              h('span', { className: 'dsb-history-when' }, formatWhen(entry.at)),
              describeChange(entry, columns, workspaces),
            ),
          ),
        ),
      );
    }

    /** Human label for a logged field. */
    const FIELD_LABEL = {
      title: '标题',
      description: '描述',
      priority: '优先级',
      startDate: '开始',
      dueDate: '截止',
      columnId: '状态',
      needsHuman: '人工介入',
      workspaceId: '工作区',
      executing: '执行',
    };

    /**
     * One log entry as a sentence: what changed, from what to what.
     * @param {object} entry - log entry.
     * @param {Array} columns - the project's columns, to name a status.
     * @param {Array} [workspaces] - known workspaces, to name one.
     * @returns {Array} children.
     */
    function describeChange(entry, columns, workspaces) {
      if (entry.field === 'created') return ['创建了卡片'];
      const label = FIELD_LABEL[entry.field] ?? entry.field;
      return [
        h('span', { className: 'dsb-history-field' }, label),
        ' ',
        h('span', { className: 'dsb-history-value' }, displayValue(entry.field, entry.from, columns, workspaces)),
        ' → ',
        h('span', { className: 'dsb-history-value' }, displayValue(entry.field, entry.to, columns, workspaces)),
      ];
    }

    /**
     * Render a logged value for a human. Empty values are a real state ("no due
     * date"), so they read as a word rather than as a blank.
     *
     * A status is stored as the column id, so it is resolved here, at read
     * time: rename a column and every entry about it reads in the new name
     * rather than in the name it happened to have that day. One vocabulary for
     * the whole board beats a faithful record of names nobody uses anymore.
     *
     * @param {string} field - field name.
     * @param {unknown} value - stored value.
     * @param {Array} [columns] - the project's columns.
     * @param {Array} [workspaces] - known workspaces, to name one.
     * @returns {string} text.
     */
    function displayValue(field, value, columns, workspaces) {
      if (value === null || value === undefined || value === '') return '空';
      if (field === 'priority') {
        return PRIORITIES.find((item) => item.id === value)?.label ?? String(value);
      }
      if (field === 'columnId') {
        const column = Array.isArray(columns) ? columns.find((item) => item.id === value) : null;
        // Live cards always land on one of the five columns. The miss is a
        // change-log entry written before the columns were fixed, still naming
        // the id the card used to have.
        return column ? column.name : '旧版看板';
      }
      if (field === 'needsHuman' || field === 'executing') return value === true ? '是' : '否';
      if (field === 'workspaceId') {
        const workspace = Array.isArray(workspaces)
          ? workspaces.find((item) => item.id === value)
          : null;
        return workspace ? (workspace.title || workspace.path) : '已移除的工作区';
      }
      if (field === 'description') {
        const text = String(value).replace(/\s+/g, ' ').trim();
        return text.length > 24 ? `${text.slice(0, 24)}…` : text;
      }
      return String(value);
    }

    /**
     * Short absolute time for the log: same day shows the clock, otherwise the
     * date. The log is read top-down in one sitting, so relative wording
     * ("3 分钟前") would age badly the moment the drawer stays open.
     * @param {number} at - epoch milliseconds.
     * @returns {string} text.
     */
    function formatWhen(at) {
      const date = new Date(Number(at) || Date.now());
      const pad = (value) => String(value).padStart(2, '0');
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      const today = new Date();
      const sameDay =
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();
      if (sameDay) return clock;
      const sameYear = date.getFullYear() === today.getFullYear();
      const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      return sameYear ? `${day} ${clock}` : `${date.getFullYear()}-${day}`;
    }

    /** Roughly how tall the calendar paints, used to decide which side it opens on. */
    const CALENDAR_HEIGHT = 300;

    /**
     * Where to paint the calendar for a trigger: under it by default, above it
     * when there is no room below. It is positioned against the viewport, so a
     * drawer that scrolls underneath cannot drag the panel along with it.
     * @param {HTMLElement} trigger - the date row that was clicked.
     * @returns {{left: number, top: number, width: number}} viewport box.
     */
    function measureAt(trigger) {
      const box = trigger.getBoundingClientRect();
      const width = Math.max(box.width, 264);
      const margin = 8;
      const below = box.bottom + 6;
      const above = box.top - CALENDAR_HEIGHT - 6;
      const roomBelow = window.innerHeight - below - margin;
      const roomAbove = box.top - margin;
      let top;
      if (roomBelow >= CALENDAR_HEIGHT) top = below;
      else if (roomAbove >= CALENDAR_HEIGHT) top = above;
      // Neither side fits whole. Open towards the roomier one and pin to the
      // viewport edge, so the grid stays readable instead of being half cut
      // off; on a window this short something has to give.
      else if (roomBelow >= roomAbove) top = Math.max(margin, window.innerHeight - CALENDAR_HEIGHT - margin);
      else top = margin;
      const left = Math.min(
        Math.max(margin, box.left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      return { left, top, width };
    }

    /** Column heads of the calendar grid, Monday first. */
    const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

    /**
     * One month, drawn from the board's own tokens. A native date input would
     * have been shorter, but its popup is painted by the platform in the
     * browser accent — a blue no token here reaches — so the grid is ours.
     *
     * Days are `<td>` with a `<button>` inside rather than buttons alone: a
     * grid needs rows to keep the columns aligned, and the header stays in one
     * line with the month label.
     */
    function Calendar({ value, onSelect }) {
      const selected = fromISODate(value);
      const [view, setView] = useState(() => {
        const base = selected ?? new Date();
        return { year: base.getFullYear(), month: base.getMonth() };
      });

      const todayIso = toISODate(new Date());
      const first = new Date(view.year, view.month, 1);
      const lead = (first.getDay() + 6) % 7;
      const count = new Date(view.year, view.month + 1, 0).getDate();

      const cells = [];
      for (let pad = 0; pad < lead; pad += 1) cells.push(null);
      for (let day = 1; day <= count; day += 1) cells.push(day);
      while (cells.length % 7 !== 0) cells.push(null);
      while (cells.length < 35) cells.push(null);

      const rows = [];
      for (let index = 0; index < cells.length; index += 7) rows.push(cells.slice(index, index + 7));

      const step = (delta) => {
        const next = new Date(view.year, view.month + delta, 1);
        setView({ year: next.getFullYear(), month: next.getMonth() });
      };

      return h(
        'div',
        { className: 'dsb-cal' },
        h(
          'div',
          { className: 'dsb-cal-head' },
          h(
            'span',
            { className: 'dsb-cal-label', 'aria-live': 'polite' },
            `${view.year}年${view.month + 1}月`,
          ),
          h(
            'div',
            { className: 'dsb-cal-nav' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsb-cal-prev',
                onClick: () => step(-1),
                title: '上个月',
                'aria-label': '上个月',
              },
              h(ChevronLeftIcon, { size: 15 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsb-cal-next',
                onClick: () => step(1),
                title: '下个月',
                'aria-label': '下个月',
              },
              h(ChevronRightIcon, { size: 15 }),
            ),
          ),
        ),
        h(
          'table',
          { className: 'dsb-cal-grid', role: 'grid' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              WEEKDAYS.map((label) =>
                h('th', { key: label, className: 'dsb-cal-weekday', scope: 'col' }, label),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((row, rowIndex) =>
              h(
                'tr',
                { key: rowIndex },
                row.map((day, index) => {
                  if (day === null) return h('td', { key: index, className: 'dsb-cal-day' });
                  const iso = toISODate(new Date(view.year, view.month, day));
                  const classes = ['dsb-cal-day'];
                  if (iso === value) classes.push('dsb-cal-selected');
                  if (iso === todayIso) classes.push('dsb-cal-today');
                  return h(
                    'td',
                    {
                      key: index,
                      className: classes.join(' '),
                      'aria-selected': iso === value ? 'true' : undefined,
                    },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsb-cal-daybtn',
                        'data-day': iso,
                        onClick: () => onSelect(iso),
                      },
                      day,
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsb-cal-actions' },
          h(
            'button',
            { type: 'button', className: 'dsb-cal-action', onClick: () => onSelect(todayIso) },
            '今天',
          ),
          value
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsb-cal-action',
                  onClick: () => onSelect(null),
                },
                '清除',
              )
            : null,
        ),
      );
    }

    /**
     * The card drawer: every field the board stores, and a delete that says what
     * it does. Edits save on blur, not on a Save button — a board has no draft
     * state, and a Save button would only exist to be forgotten.
     */
    function CardDrawer({
      card,
      project,
      closing,
      workspaces,
      onClose,
      onChange,
      onMove,
      onRun,
      onOpenSession,
      onDelete,
    }) {
      const [title, setTitle] = useState(card.title);
      const [description, setDescription] = useState(card.description ?? '');
      const [confirmDelete, setConfirmDelete] = useState(false);
      /** Which date row, if any, has its calendar open. */
      const [calendar, setCalendar] = useState(null);
      /** Viewport box the open calendar paints at; `null` until it opens. */
      const [popover, setPopover] = useState(null);
      const titleRef = useRef(null);
      const panelRef = useRef(null);

      const needsHuman = card.needsHuman === true;
      const executing = card.executing === true;
      /** The workspace this card would run in, once one is chosen. */
      const runWorkspaceId = card.workspaceId ?? null;
      const runWorkspace = workspaces.find((workspace) => workspace.id === runWorkspaceId) ?? null;

      // The panel is anchored to the viewport, so anything that moves the
      // drawer under it — scrolling, a resize — would leave it pointing at the
      // wrong row. Closing it is the honest response to both.
      useEffect(() => {
        if (!calendar) return undefined;
        const close = () => setCalendar(null);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
        return () => {
          window.removeEventListener('resize', close);
          window.removeEventListener('scroll', close, true);
        };
      }, [calendar]);

      // The calendar is a field, not a modal: a click anywhere else means the
      // date was not being changed, so it closes. Escape closes it first and
      // leaves the drawer open, because the drawer is the larger thing.
      useEffect(() => {
        if (!calendar) return undefined;
        const onPointerDown = (event) => {
          if (panelRef.current && panelRef.current.contains(event.target)) return;
          const trigger = document.getElementById(calendar === 'start' ? 'dsb-start' : 'dsb-due');
          if (trigger && trigger.contains(event.target)) return;
          setCalendar(null);
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          setCalendar(null);
        };
        document.addEventListener('mousedown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [calendar]);

      useEffect(() => {
        if (!card.title) titleRef.current?.focus();
      }, [card.title]);

      const commitTitle = () => {
        const value = title.trim();
        if (value !== card.title) void onChange({ title: value });
      };
      const commitDescription = () => {
        if (description !== (card.description ?? '')) void onChange({ description });
      };

      /**
       * A date row is a button that opens the board's own calendar. The
       * platform picker was never an option: it paints its popup in the browser
       * accent, a blue no token on this board reaches.
       */
      const dateField = (key, id, value) => {
        const open = calendar === key;
        return h(
          'button',
          {
            id,
            type: 'button',
            className: 'dsb-control dsb-date-trigger',
            'data-empty': value ? undefined : 'true',
            'aria-expanded': open ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            'aria-controls': open ? 'dsb-calendar' : undefined,
            onClick: (event) => {
              if (open) {
                setCalendar(null);
                return;
              }
              setPopover(measureAt(event.currentTarget));
              setCalendar(key);
            },
          },
          h('span', { className: 'dsb-date-value' }, formatDate(value)),
          h('span', { className: 'dsb-date-mark' }, h(CalendarIcon, { size: 14 })),
        );
      };

      const calendarValue = calendar === 'start' ? card.startDate : card.dueDate;
      const pickDate = (iso) => {
        const field = calendar === 'start' ? 'startDate' : 'dueDate';
        setCalendar(null);
        if ((iso ?? null) !== (calendarValue ?? null)) void onChange({ [field]: iso });
      };

      return h(
        'aside',
        {
          className: 'dsb-drawer',
          role: 'dialog',
          'aria-label': '卡片详情',
          'data-closing': closing ? 'true' : undefined,
        },
        h(
          'div',
          { className: 'dsb-drawer-head' },
          h('span', { className: 'dsb-card-id' }, `#${card.number}`),
          h(
            'button',
            {
              type: 'button',
              className: 'dsb-icon-btn',
              onClick: onClose,
              title: '关闭',
              'aria-label': '关闭卡片详情',
            },
            h(CloseIcon, { size: 15 }),
          ),
        ),
        h(
          'div',
          { className: 'dsb-drawer-body' },
          h('textarea', {
            ref: titleRef,
            className: 'dsb-title-input',
            value: title,
            rows: 1,
            placeholder: '卡片标题',
            'aria-label': '卡片标题',
            onChange: (event) => setTitle(event.target.value),
            onBlur: commitTitle,
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                commitTitle();
                event.currentTarget.blur();
              }
            },
          }),
          // Waiting on a person is a property of the card, and launching work is
          // the one thing here that cannot be undone by editing a field — both
          // live in the footer, apart from the fields they do not describe.
          card.executionNote
            ? h('div', { className: 'dsb-warn' }, `上次执行：${card.executionNote}`)
            : null,
          h(
            'div',
            { className: 'dsb-fields' },
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-ws' }, '工作区'),
            h(
              'select',
              {
                id: 'dsb-ws',
                className: 'dsb-control',
                value: card.workspaceId ?? '',
                disabled: card.executing === true,
                onChange: (event) => void onChange({ workspaceId: event.target.value || null }),
              },
              h('option', { value: '' }, '未选择'),
              // A workspace that has since been closed is still the honest
              // answer for a card that was pointed at it, so it is kept as an
              // option instead of silently falling back to "未选择".
              workspaces.some((workspace) => workspace.id === card.workspaceId)
                ? null
                : card.workspaceId
                  ? h('option', { value: card.workspaceId }, '已移除的工作区')
                  : null,
              workspaces.map((workspace) =>
                h('option', { key: workspace.id, value: workspace.id }, workspace.title || workspace.path),
              ),
            ),
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-col' }, '状态'),
            h(
              'select',
              {
                id: 'dsb-col',
                className: 'dsb-control',
                value: card.columnId,
                onChange: (event) => void onMove(event.target.value),
              },
              project.columns.map((column) =>
                h('option', { key: column.id, value: column.id }, column.name),
              ),
            ),
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-pri' }, '优先级'),
            h(
              'select',
              {
                id: 'dsb-pri',
                className: 'dsb-control',
                value: card.priority ?? '',
                'data-priority': card.priority ?? undefined,
                onChange: (event) => void onChange({ priority: event.target.value || null }),
              },
              h('option', { value: '' }, '无'),
              PRIORITIES.map((priority) =>
                h('option', { key: priority.id, value: priority.id }, priority.label),
              ),
            ),
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-start' }, '开始'),
            dateField('start', 'dsb-start', card.startDate),
            h('label', { className: 'dsb-field-label', htmlFor: 'dsb-due' }, '截止'),
            dateField('due', 'dsb-due', card.dueDate),
            calendar
              ? h(
                  'div',
                  {
                    id: 'dsb-calendar',
                    className: 'dsb-cal-panel',
                    role: 'dialog',
                    'aria-label': calendar === 'start' ? '选择开始日期' : '选择截止日期',
                    ref: panelRef,
                    style: popover
                      ? { left: `${popover.left}px`, top: `${popover.top}px`, width: `${popover.width}px` }
                      : { left: '-9999px', top: '0px' },
                  },
                  // Keyed by row: switching from one date to the other should
                  // open the calendar on that date's month, not on whichever
                  // month the previous calendar was left showing.
                  h(Calendar, { key: calendar, value: calendarValue, onSelect: pickDate }),
                )
              : null,
          ),
          h('textarea', {
            className: 'dsb-text',
            value: description,
            placeholder: '描述',
            'aria-label': '卡片描述',
            onChange: (event) => setDescription(event.target.value),
            onBlur: commitDescription,
          }),
          h(History, { history: card.history, columns: project.columns, workspaces }),
        ),
        h(
          'div',
          { className: 'dsb-drawer-foot' },
          confirmDelete
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('span', { className: 'dsb-warn' }, '删除后无法恢复'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsb-btn',
                    'data-tone': 'danger',
                    onClick: () => void onDelete(),
                  },
                  '删除',
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsb-btn', onClick: () => setConfirmDelete(false) },
                  '取消',
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsb-trash-btn',
                  'aria-label': '删除卡片',
                  title: '删除卡片',
                  onClick: () => setConfirmDelete(true),
                },
                h(TrashIcon, { size: 15 }),
              ),
          confirmDelete
            ? null
            : h(
                'div',
                { className: 'dsb-foot-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsb-flag-btn',
                    'data-on': needsHuman ? 'true' : 'false',
                    'aria-pressed': needsHuman ? 'true' : 'false',
                    'aria-label': needsHuman ? '取消人工介入标记' : '标记为需要人工介入',
                    title: needsHuman ? '取消人工介入标记' : '标记为需要人工介入',
                    onClick: () => void onChange({ needsHuman: !needsHuman }),
                  },
                  h(PersonIcon, { size: 13 }),
                  '人工介入',
                ),
                // A card that has run before keeps the session it ran in, so the
                // useful action afterwards is going back to that conversation
                // rather than starting a second one over the top of it.
                executing || card.sessionId
                  ? h(
                      'span',
                      {
                        className: 'dsb-run-wrap',
                        title: card.sessionId
                          ? executing
                            ? '会话正在处理这张卡片'
                            : '打开上次执行的会话'
                          : '会话还开着，稍等一下',
                      },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsb-btn',
                          'data-tone': 'primary',
                          disabled: !card.sessionId,
                          onClick: () => onOpenSession?.(card.sessionId),
                        },
                        h(OpenIcon, { size: 13 }),
                        '打开会话',
                      ),
                    )
                  : h(
                      'span',
                      {
                        className: 'dsb-run-wrap',
                        title: runWorkspace
                          ? `在「${runWorkspace.title || runWorkspace.path}」新建会话执行`
                          : '先选择一个工作区',
                      },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsb-btn',
                          'data-tone': 'primary',
                          disabled: !runWorkspace,
                          onClick: () => void onRun(runWorkspaceId),
                        },
                        h(PlayIcon, { size: 13 }),
                        '开始执行',
                      ),
                    ),
              ),
        ),
      );
    }

    /** The 18px glyph the sidebar row draws: Lucide `kanban`. */
    function BoardIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18;
      const active = props?.active === true;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M5 3v14', opacity: active ? 1 : 0.85 }),
        h('path', { d: 'M12 3v8', opacity: active ? 1 : 0.85 }),
        h('path', { d: 'M19 3v18', opacity: active ? 0.85 : 0.7 }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Held for the drawer's "open the session" button: the services are
        // resolved lazily on click, never cached at mount.
        hostContext = ctx;

        // The stylesheet lives as long as the plugin does.
        if (typeof ctx.effect === 'function') ctx.effect(ensureStyles);
        else ensureStyles();

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, BoardPage),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: '看板' },
            BoardIcon,
          ),
        );
      },
    };
  },
});
