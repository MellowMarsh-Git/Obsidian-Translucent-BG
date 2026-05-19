# Obsidian Translucent BG

An [Obsidian](https://obsidian.md) plugin for **Windows** that applies native Windows 11 background materials (Mica, Acrylic, Tabbed) to the Obsidian window, with two tinting modes: a built-in plugin-controlled overlay, or full handoff to your Obsidian theme using the standard translucency variable system.

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
- **Two tinting modes** — plugin-managed (color picker + opacity sliders) or theme-managed (defers to your theme's standard opacity variables)
- **Theme integration** — when theme mode is on, uses `--workspace-background-translucent` with `rgb(from var(--background-secondary) …)` exactly as Obsidian themes expect
- **Auto theme switching** — tint reacts instantly when you switch between light and dark themes
- **Extra CSS blur** — optional `backdrop-filter` blur stacked on top of the native material
- **Cycle command** — keyboard command and ribbon icon to cycle through materials without opening settings
- **Clean unload** — all modifications reversed when the plugin is disabled

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
| **Background material** | Mica, Acrylic, Tabbed, or None |
| **Let the theme handle background opacity** | Toggle between plugin-managed and theme-managed tinting (see below) |
| **Light mode tint color** | Color of the tint overlay in light mode *(plugin-managed only)* |
| **Light mode tint opacity** | Opacity of the tint in light mode, 0–1 *(plugin-managed only)* |
| **Dark mode tint color** | Color of the tint overlay in dark mode *(plugin-managed only)* |
| **Dark mode tint opacity** | Opacity of the tint in dark mode, 0–1 *(plugin-managed only)* |
| **Extra CSS blur** | Additional `backdrop-filter` blur in pixels (0–40 px) |
| **Reset to defaults** | Restore all settings to factory defaults |

The color and opacity controls are hidden when **Let the theme handle background opacity** is enabled — they have no effect in that mode.

---

## Commands

| Command | Description |
|---|---|
| `Translucent BG: Cycle background material` | Cycles Mica → Acrylic → Tabbed → None → Mica |
| `Translucent BG: Open Translucent BG settings` | Opens the plugin's settings tab directly |

A ribbon icon (stacked layers) also triggers the cycle command.

---

## How it works

### Plugin-managed mode (default)

1. The plugin calls `BrowserWindow.setBackgroundMaterial(material)` via Electron to apply the chosen Windows 11 material to the window.
2. Obsidian's `is-translucent` class is added to `<body>` and `--workspace-background-translucent` is set to `transparent`, letting the native material show through the workspace area.
3. A full-screen `<div>` at `z-index: -1` is injected behind all Obsidian UI, carrying a pre-computed `rgba()` tint color based on the settings color pickers and opacity sliders.
4. A `MutationObserver` watches `<body>` class changes and updates the tint instantly when you switch themes.

### Theme-managed mode

When **Let the theme handle background opacity** is enabled:

1. The overlay div is hidden — it is not used for tinting in this mode.
2. `--workspace-background-translucent` is set by the plugin to a `rgb(from …)` expression using `--background-secondary` and the theme's opacity variable:
   - Light: `rgb(from var(--background-secondary) r g b / var(--translucent-light-opacity, 50%))`
   - Dark: `rgb(from var(--background-secondary) r g b / var(--translucent-dark-opacity, 50%))`
3. Obsidian's own `is-translucent` shell reads `--workspace-background-translucent` and applies it as the workspace background — this is the same mechanism Obsidian themes use natively.
4. The plugin never writes `--translucent-light-opacity` or `--translucent-dark-opacity` as inline styles, so your theme's `:root` declarations always take effect.

---

## For Theme Authors

### Theme-managed mode variables

When the user enables **Let the theme handle background opacity**, the plugin defers to these standard variables:

```css
--translucent-light-opacity   /* opacity of the workspace tint in light mode */
--translucent-dark-opacity    /* opacity of the workspace tint in dark mode  */
```

Define them on `:root` in your theme and they will control the tint with no further configuration needed from the user:

```css
:root {
  --translucent-light-opacity: 50%;
  --translucent-dark-opacity:  50%;
}
```

The tint color is automatically derived from your theme's `--background-secondary`, so it always matches your palette.

### Plugin-managed mode variable

In plugin-managed mode (the default), the plugin writes one variable that can be read by themes or snippets:

```css
--tbg-tint-color   /* pre-computed rgba() of the current tint */
--tbg-extra-blur   /* current extra blur amount, e.g. "0px"   */
```

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
