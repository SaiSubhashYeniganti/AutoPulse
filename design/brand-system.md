# Cars24 Brief — Brand & Design System

This document outlines the strict design specifications for the Cars24 Brief, ensuring an "Awwwards-level" Apple-inspired editorial aesthetic.

## 1. Typography
We rely entirely on the native Apple system font stack to make the app feel like a built-in OS feature.
*   **Font Family:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif`.
*   **Characteristics:** Clean, highly legible, professional.
*   **Tracking/Spacing:** Apply a slight negative letter-spacing (`-0.015em`) to body text for a tight, premium feel.

## 2. Color Palette
Extreme restraint. The UI should fade away so the content is the only focus.
*   **Background:** Pure white (`#FFFFFF`) for pristine contrast. 
*   **Primary Text:** Off-black (`#1D1D1F`) for high contrast but less eye strain than pure black.
*   **Secondary Text:** Muted gray (`#86868B`) for timestamps, tags, and metadata.
*   **Accent/Interactive:** Apple Native Blue (`#0066CC`) for links, active states, and calls to action.
*   **Dividers/Borders:** Ultra-faint gray (`#E5E5EA` or `#F5F5F7`) used only as thin 1px horizontal dividers.

## 3. Depth & Layout (The "No-Card" Rule)
We do not use generic floating white boxes on gray backgrounds.
*   **Standard Content Row:** Content flows seamlessly on the pure white canvas. Rows are separated by a 1px `#E5E5EA` border on the bottom.
*   **Hover States:** Background subtly shifts to `#F5F5F7` on hover. No elevation changes, no heavy shadows.
*   **Padding:** Generous vertical and horizontal padding (e.g., `py-6 px-4`) to let the typography breathe.
*   **Width Constraint:** Max reading width is `46rem` to maintain comfortable eye tracking.

## 4. UI Patterns & Interactions
*   **Time Horizons:** Avoid long vertical scrolls for chronological data. Use Segmented Controls (e.g., Today / Last 7 Days / Archive) to swap content in place.
*   **Micro-Interactions:** Fast and fluid (using cubic-bezier easing).
