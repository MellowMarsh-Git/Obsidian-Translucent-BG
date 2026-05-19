# Obsidian Translucent BG

An [Obsidian](https://obsidian.md) plugin for **Windows** that applies native Windows 11 background materials (Mica, Acrylic, Tabbed) to the Obsidian window, then layers a theme-aware color tint on top so the effect integrates cleanly with any Obsidian color theme.

> **Windows only.** Requires Obsidian running as a native desktop app on Windows 10/11 with a version of Electron that supports `BrowserWindow.setBackgroundMaterial`.

---

## Preview

### Mica material — light theme

<!-- Preview image placeholder: replace with a screenshot of Obsidian with Mica enabled in light mode -->
![Mica light mode preview](docs/preview-mica-light.png)

### Acrylic material — dark theme

<!-- Preview image placeholder: replace with a screenshot of Obsidian with Acrylic enabled in dark mode -->
![Acrylic dark mode preview](docs/preview-acrylic-dark.png)

### Settings panel

<!-- Preview image placeholder: replace with a screenshot of the plugin's settings tab -->
![Settings panel preview](docs/preview-settings.png)

---

## Features

- **Three Windows 11 materials** — Mica, Acrylic, and Tabbed, applied via the native Electron API
- **Theme-aware tint overlay** — separate color and opacity for light and dark mode; reacts automatically when you switch Obsidian themes
- **CSS variables for theme authors** — expose `--tbg-light-opacity` and `--tbg-dark-opacity` so theme CSS can integrate seamlessly (see [For Theme Authors](#for-theme-authors))
- **Extra CSS blur** — optional `backdrop-filter` blur stacked on top of the native material for a stronger frosted-glass look
- **Cycle command** — keyboard command and ribbon icon to cycle through materials without opening settings
- **Clean unload** — restoring the window to its default opaque state when the plugin is disabled

---

## Installation

### Manual

1. Download the latest release from the [Releases](https://github.com/MellowMarsh-Git/Obsidian-Translucent-BG/releases) page.
2. Copy `main.js`, `styles.css`, and `manifest.json` into your vault at:
   ```
   <vault>/.obsidian/plugins/translucent-bg/
   ```
3. Enable the plugin in **Settings → Community plugins**.

### From source

```bash
git clone https://github.com/MellowMarsh-Git/Obsidian-Translucent-BG.git
cd Obsidian-Translucent-BG
npm install
npm run build
```

Then copy `main.js`, `styles.css`, and `manifest.json` into your vault's plugin folder as above.

---

## Settings

| Setting | Description |
|---|---|
| **Background material** | Choose between Mica, Acrylic, Tabbed, or None |
| **Light mode tint color** | Hex color of the overlay in light mode |
| **Light mode tint opacity** | Opacity of the overlay in light mode (0–1) |
| **Dark mode tint color** | Hex color of the overlay in dark mode |
| **Dark mode tint opacity** | Opacity of the overlay in dark mode (0–1) |
| **Extra CSS blur** | Additional `backdrop-filter` blur in pixels (0–40 px) |
| **Reset to defaults** | Restore all settings to factory defaults |

---

## Commands

| Command | Description |
|---|---|
| `Translucent BG: Cycle background material` | Cycles Mica → Acrylic → Tabbed → None → Mica |
| `Translucent BG: Open Translucent BG settings` | Opens the plugin's settings tab directly |

A ribbon icon (stacked layers) also triggers the cycle command.

---

## For Theme Authors

The plugin writes the following CSS custom properties to `<body>` at runtime. Theme authors can reference or override these to integrate the translucent background into their palette.

### Available variables

```css
--tbg-tint-color       /* rgba() string of the current tint — computed from user settings */
--tbg-extra-blur       /* backdrop-filter blur amount, e.g. "0px" */
--tbg-light-opacity    /* tint opacity in light mode as a percentage, e.g. "35%" */
--tbg-dark-opacity     /* tint opacity in dark mode  as a percentage, e.g. "45%" */
```

### Override opacity from your theme

```css
:root {
  --tbg-light-opacity: 40%;
  --tbg-dark-opacity:  55%;
}
```

### Use your theme's background color as the tint

Use the modern CSS relative-color syntax to derive the tint from your own `--background-secondary` instead of the user's chosen hex color:

```css
body.theme-light.translucent-bg-enabled {
  --workspace-background-translucent:
    rgb(from var(--background-secondary) r g b / var(--tbg-light-opacity));
}

body.theme-dark.translucent-bg-enabled {
  --workspace-background-translucent:
    rgb(from var(--background-secondary) r g b / var(--tbg-dark-opacity));
}
```

This approach means the tint automatically matches your theme's color palette and the user controls only the opacity via the plugin settings.

---

## How it works

1. The plugin calls `BrowserWindow.setBackgroundMaterial(material)` via Electron to set the native Windows material on the app window.
2. It adds Obsidian's `is-translucent` class to `<body>`, which causes Obsidian's own CSS to use `--workspace-background-translucent` (set to `transparent`) for the workspace area.
3. A full-screen `<div id="translucent-bg-overlay">` is prepended to `<body>` at `z-index: -1`. This sits between the native material and the Obsidian UI, carrying the tint color and optional extra blur.
4. A `MutationObserver` watches `<body>` class changes so the tint updates immediately when you switch between light and dark themes.
5. On unload, all modifications are reversed — the window returns to opaque and all CSS properties are removed.

---

## Building

```bash
npm install       # install dev dependencies
npm run dev       # development build (source maps, no minification)
npm run build     # production build  (minified, no source maps)
```

Output is `main.js` at the project root.

---

## License

ISC
