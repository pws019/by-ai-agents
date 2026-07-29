---
name: Contextual Flow
colors:
  surface: '#faf8ff'
  surface-dim: '#d9d9e5'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3fe'
  surface-container: '#ededf9'
  surface-container-high: '#e7e7f3'
  surface-container-highest: '#e1e2ed'
  on-surface: '#191b23'
  on-surface-variant: '#434655'
  inverse-surface: '#2e3039'
  inverse-on-surface: '#f0f0fb'
  outline: '#737686'
  outline-variant: '#c3c6d7'
  surface-tint: '#0053db'
  primary: '#004ac6'
  on-primary: '#ffffff'
  primary-container: '#2563eb'
  on-primary-container: '#eeefff'
  inverse-primary: '#b4c5ff'
  secondary: '#505f76'
  on-secondary: '#ffffff'
  secondary-container: '#d0e1fb'
  on-secondary-container: '#54647a'
  tertiary: '#943700'
  on-tertiary: '#ffffff'
  tertiary-container: '#bc4800'
  on-tertiary-container: '#ffede6'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b4c5ff'
  on-primary-fixed: '#00174b'
  on-primary-fixed-variant: '#003ea8'
  secondary-fixed: '#d3e4fe'
  secondary-fixed-dim: '#b7c8e1'
  on-secondary-fixed: '#0b1c30'
  on-secondary-fixed-variant: '#38485d'
  tertiary-fixed: '#ffdbcd'
  tertiary-fixed-dim: '#ffb596'
  on-tertiary-fixed: '#360f00'
  on-tertiary-fixed-variant: '#7d2d00'
  background: '#faf8ff'
  on-background: '#191b23'
  surface-variant: '#e1e2ed'
typography:
  headline-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  sidebar-width: 280px
  container-max-width: 800px
  gutter: 16px
  stack-gap: 24px
  inset-padding: 12px
---

## Brand & Style
The design system focuses on a "playground" aesthetic—a functional, high-utility environment where the interface recedes to let the conversation lead. It targets professional users who require speed and clarity in AI interactions. The visual style is **Minimalist** with a **Corporate** influence, utilizing generous whitespace and a restricted color palette to minimize cognitive load. The emotional response is one of calm, reliability, and precision, avoiding any decorative elements that do not serve a functional purpose.

## Colors
The palette is built on a foundation of professional grays to differentiate workspace zones.
- **Primary:** Corporate Blue (#2563eb) is reserved for the most important actions: the "New Chat" button, active navigation states, and the user's conversation presence.
- **Surface Layering:** A two-tone background strategy is used. The sidebar utilizes a light gray (#f9fafb) to provide structural anchoring, while the main conversation stage uses pure white (#ffffff) to maximize text contrast.
- **Typography:** Deep Slate (#1e293b) ensures WCAG AA compliance for all primary reading, while Medium Gray (#64748b) handles metadata like timestamps and secondary labels.
- **Boundaries:** Subtle borders (#e2e8f0) are preferred over heavy shadows to maintain a clean, flat, modern workspace feel.

## Typography
The design system utilizes **Inter** exclusively to ensure a systematic, utilitarian appearance. The hierarchy is lean:
- **Headlines:** Small but bolded to differentiate session titles in the sidebar without consuming vertical space.
- **Body:** Standardized at 16px for the agent's responses to ensure comfortable reading of long-form AI content.
- **Labels:** Used for timestamps and button text, often with a slightly heavier weight (500) to maintain legibility at smaller sizes.
- **Mobile scaling:** Typography remains consistent across devices as the chosen sizes are already optimized for handheld legibility.

## Layout & Spacing
The layout follows a **Fixed-Fluid hybrid** model. 
- **Sidebar:** A fixed 280px column on desktop that collapses into a drawer on mobile. 
- **Main Stage:** The chat container has a max-width of 800px and is centered to prevent line lengths from becoming too long for comfortable reading.
- **Rhythm:** A base-4 spacing system is used. Messaging bubbles are separated by a 24px vertical gap to clearly distinguish between turns in the conversation. 
- **Input:** A persistent bottom-docked container with a 16px margin from the screen edges on mobile, or integrated into the main stage flow on desktop.

## Elevation & Depth
This design system avoids heavy shadows to maintain its "playground" utility. 
- **Level 0:** Main background surfaces (White and Light Gray).
- **Level 1:** Floating input area and active dropdown menus use an **Ambient Shadow**: `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`.
- **Dividers:** Horizontal lines are 1px thick using the `#e2e8f0` border color to separate the input area from the chat history.

## Shapes
A **Soft** shape language (0.25rem - 0.75rem) is applied throughout the design system to balance professional rigor with modern approachability.
- **Standard (4px):** Used for input fields and small UI controls.
- **Large (8px):** Used for chat bubbles and the sidebar navigation items.
- **Extra Large (12px):** Used for the primary container of the "New Chat" button and the main input text area.

## Components
- **Chat Bubbles:** 
    - **User:** Primary Blue background with White text. Aligned to the right. 
    - **Agent:** Light Gray (#f1f5f9) background with Deep Slate text. Aligned to the left. No heavy borders.
- **Buttons:** 
    - **Primary (New Chat):** Solid Blue with White text. Full width in sidebar.
    - **Secondary/Ghost:** Transparent background with Medium Gray text. Used for "Rename" or "Delete" actions; these should only appear on hover in the sidebar to reduce visual noise.
- **Input Area:** A large text area with a subtle 1px border. The "Send" icon is a minimalist arrow, becoming Primary Blue only when text is present.
- **Sidebar Items:** Clear, single-line text items with an active state indicated by a subtle background change (#f1f5f9) and a 2px blue left-border.
- **Lists:** Clean vertical stacks with 8px spacing between items, prioritizing the session title as the primary label.