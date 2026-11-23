---
name: generative_ui
title: Generative UI Widgets
description: Render rich interactive inline HTML, SVG, Canvas, and data-visualization widgets directly inside Sanctuary chat bubbles without external CDNs.
summary: "Render interactive diagrams, charts, calculators, or simulators inline using a fenced ```sanctuary-widget HTML block"
retrieval: vector
triggers: interactive, widget, visualization, simulator, diagram, chart, calculator, slider, visualizer, dashboard, plot, graph
---
# SKILL: Sovereign Generative UI Widgets
Briefly introduce the widget, then emit one fenced `sanctuary-widget` HTML block (compact `180px`–`460px` height):
- **Zero External CDNs**: Vanilla HTML, inline `<style>`, `<svg>`, `<canvas>`, and `<script>` only (no external scripts/fonts).
- **Theme & Accessibility**: Use `--bg-color`, `--card-bg`, `--text-primary`, `--text-secondary`, `--primary-accent`, `--border-color` and semantic `<button type="button">`, `<label>`, `<input>`, `<output>`.
