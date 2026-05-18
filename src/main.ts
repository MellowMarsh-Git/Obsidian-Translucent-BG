/**
 * Obsidian Translucent BG
 * ======================
 * An Obsidian plugin (Windows only) that applies native Windows 11 background
 * materials (Mica, Acrylic, Tabbed) to the Obsidian window, then layers a
 * theme-aware tint overlay on top so the result integrates cleanly with any
 * Obsidian color theme.
 *
 * Architecture overview
 * ---------------------
 * 1. On load the plugin asks Electron to set the window's background material
 *    (via `BrowserWindow.setBackgroundMaterial`).
 * 2. It adds `is-translucent` to `<body>` so Obsidian's own CSS uses its
 *    translucent workspace background variable.
 * 3. It injects a full-screen overlay `<div>` at z-index:-1 that carries the
 *    tint color and optional extra blur via CSS custom properties.
 * 4. CSS custom properties exposed to themes:
 *    --tbg-light-opacity  — opacity of the tint in light mode (default 35%)
 *    --tbg-dark-opacity   — opacity of the tint in dark mode  (default 45%)
 *    --tbg-tint-base      — solid (alpha=1) tint color used when the theme
 *                           handles opacity (see themeHandlesOpacity setting)
 *    Themes can override the opacity variables on :root when themeHandlesOpacity
 *    is enabled; the plugin will not write them as inline styles in that mode.
 * 5. A MutationObserver watches `<body>` class changes (theme-dark / theme-light)
 *    so the tint reacts instantly when the user switches themes.
 */

import { App, Plugin, PluginSettingTab, Setting, Platform, Notice } from 'obsidian';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of Windows 11 background materials available via Electron.
 * - mica     : blurs content behind the entire window (subtle, energy-efficient)
 * - acrylic  : stronger acrylic blur — more frosted-glass feel
 * - tabbed   : Mica variant used for tabbed app windows
 * - none     : disables the material effect entirely
 */
type TranslucentBgMaterial = 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed';

// ---------------------------------------------------------------------------
// Settings interface & defaults
// ---------------------------------------------------------------------------

/**
 * All persisted settings for the plugin.
 * Colors are stored as CSS hex strings (#rrggbb); opacity as a 0–1 float.
 */
interface TranslucentBgSettings {
    /** Which Windows material to apply to the window chrome. */
    material: TranslucentBgMaterial;

    /** Hex color of the tint overlay in light mode. */
    lightTintColor: string;
    /** Opacity of the tint overlay in light mode (0 = transparent, 1 = opaque). */
    lightTintOpacity: number;

    /** Hex color of the tint overlay in dark mode. */
    darkTintColor: string;
    /** Opacity of the tint overlay in dark mode (0 = transparent, 1 = opaque). */
    darkTintOpacity: number;

    /** Extra CSS backdrop-filter blur (px) added on top of the native material. */
    extraBlur: number;

    /** When true the plugin automatically reacts to light/dark theme switches. */
    followTheme: boolean;

    /**
     * When true the plugin does NOT write --tbg-light-opacity / --tbg-dark-opacity
     * as inline styles, letting a theme's :root declarations win. The overlay is
     * hidden; tinting is driven entirely through --workspace-background-translucent.
     */
    themeHandlesOpacity: boolean;
}

/** Sane defaults — light and dark tints are low-opacity neutrals. */
const DEFAULT_SETTINGS: TranslucentBgSettings = {
    material: 'mica',
    lightTintColor: '#ffffff',
    lightTintOpacity: 0.35,
    darkTintColor: '#1e1e1e',
    darkTintOpacity: 0.45,
    extraBlur: 0,
    followTheme: true,
    themeHandlesOpacity: false,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DOM id of the injected tint overlay element. */
const OVERLAY_ID = 'translucent-bg-overlay';

// ---------------------------------------------------------------------------
// Main plugin class
// ---------------------------------------------------------------------------

/**
 * TranslucentBgPlugin
 * -------------------
 * Entry point registered with Obsidian. Manages the full lifecycle:
 * - Acquiring the Electron BrowserWindow reference
 * - Applying the chosen background material
 * - Injecting and styling the tint overlay div
 * - Exposing CSS variables so themes can fine-tune opacity
 * - Cleaning everything up on unload
 */
export default class TranslucentBgPlugin extends Plugin {
    settings: TranslucentBgSettings;

    /** Reference to the Electron BrowserWindow for the current Obsidian window. */
    electronWindow: any = null;

    /** Watches <body> class mutations to react to theme switches. */
    private themeObserver: MutationObserver | null = null;

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    async onload() {
        await this.loadSettings();

        if (!Platform.isWin) {
            console.warn('Translucent BG: Windows only — plugin inactive on this platform.');
            return;
        }

        this.electronWindow = this.getElectronWindow();
        if (!this.electronWindow) {
            new Notice('Translucent BG: Could not access Electron window. Please report this issue.');
            return;
        }

        this.addSettingTab(new TranslucentBgSettingTab(this.app, this));

        this.enableTranslucency();
        this.applyMaterial(this.settings.material);
        this.injectOverlay();
        this.updateOverlayStyle();
        this.observeThemeChanges();

        this.addCommand({
            id: 'cycle-material',
            name: 'Cycle background material',
            callback: () => this.cycleMaterial(),
        });

        this.addCommand({
            id: 'open-settings',
            name: 'Open Translucent BG settings',
            callback: () => {
                // @ts-ignore — app.setting is available at runtime
                this.app.setting.open();
                // @ts-ignore
                this.app.setting.openTabById(this.manifest.id);
            },
        });

        this.addRibbonIcon('layers', 'Translucent BG: cycle material', () => this.cycleMaterial());
    }

    /**
     * Clean up everything when the plugin is disabled or Obsidian closes.
     * Restores default window material and removes all CSS modifications.
     */
    onunload() {
        if (!Platform.isWin) return;

        try {
            this.electronWindow?.setBackgroundMaterial?.('none');
        } catch {
            // Silently ignore — window may already be closing.
        }

        document.body.classList.remove('is-translucent');
        document.body.classList.remove('translucent-bg-enabled');
        document.body.classList.remove('translucent-bg-theme-opacity');
        document.body.removeAttribute('data-tbg-material');
        document.body.style.removeProperty('--workspace-background-translucent');
        document.body.style.removeProperty('--titlebar-background');
        document.body.style.removeProperty('--titlebar-background-focused');
        document.body.style.removeProperty('--tbg-tint-color');
        document.body.style.removeProperty('--tbg-extra-blur');

        document.getElementById(OVERLAY_ID)?.remove();

        this.themeObserver?.disconnect();
        this.themeObserver = null;
    }

    // -----------------------------------------------------------------------
    // Settings persistence
    // -----------------------------------------------------------------------

    async loadSettings() {
        const raw = (await this.loadData()) ?? {};
        // Strip obsolete keys from earlier forks (e.g. "vibrancy" from pseudo-mica).
        const migrated: Partial<TranslucentBgSettings> = { ...raw };
        if ((raw as any).vibrancy !== undefined) delete (migrated as any).vibrancy;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // -----------------------------------------------------------------------
    // Material management
    // -----------------------------------------------------------------------

    applyMaterial(material: TranslucentBgMaterial) {
        if (!this.electronWindow?.setBackgroundMaterial) {
            new Notice('Translucent BG: setBackgroundMaterial unavailable — Electron version may be too old.');
            return;
        }
        try {
            this.electronWindow.setBackgroundMaterial(material);
            document.body.setAttribute('data-tbg-material', material);
        } catch (e) {
            console.error('Translucent BG: failed to apply material', e);
            new Notice(`Translucent BG: failed to apply '${material}'.`);
        }
    }

    /** Cycles: mica → acrylic → tabbed → none → mica. */
    cycleMaterial() {
        const order: TranslucentBgMaterial[] = ['mica', 'acrylic', 'tabbed', 'none'];
        const idx = order.indexOf(this.settings.material);
        const next = order[(idx + 1) % order.length];
        this.settings.material = next;
        this.applyMaterial(next);
        this.updateOverlayStyle();
        this.saveSettings();
        new Notice(`Translucent BG: material = ${next}`);
    }

    // -----------------------------------------------------------------------
    // Translucency setup
    // -----------------------------------------------------------------------

    /**
     * Adds Obsidian's `is-translucent` class and zeroes out the backgrounds
     * that would otherwise paint over the native material. Inner elements
     * (code blocks, modals, sidebars) keep their own themed backgrounds.
     */
    private enableTranslucency() {
        document.body.classList.add('is-translucent');
        document.body.classList.add('translucent-bg-enabled');
        document.body.style.setProperty('--workspace-background-translucent', 'transparent', 'important');
        document.body.style.setProperty('--titlebar-background', 'transparent', 'important');
        document.body.style.setProperty('--titlebar-background-focused', 'transparent', 'important');
    }

    // -----------------------------------------------------------------------
    // Overlay (tint layer)
    // -----------------------------------------------------------------------

    private injectOverlay() {
        if (document.getElementById(OVERLAY_ID)) return;
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.classList.add('translucent-bg-overlay');
        document.body.prepend(overlay);
    }

    /**
     * Recomputes and applies tint variables based on current settings.
     *
     * Plugin-managed mode (themeHandlesOpacity = false):
     *   Bakes a pre-computed rgba() into --tbg-tint-color for the overlay div.
     *   --workspace-background-translucent stays transparent.
     *
     * Theme-managed mode (themeHandlesOpacity = true):
     *   Sets --workspace-background-translucent to an rgb(from …) expression
     *   using --background-secondary + the theme's opacity variables. The overlay
     *   div is hidden; --translucent-light/dark-opacity are never written as
     *   inline styles so the theme's :root values take precedence.
     */
    updateOverlayStyle() {
        // Disconnect while mutating body classes to avoid recursive re-triggers.
        this.themeObserver?.disconnect();

        const isDark = document.body.classList.contains('theme-dark');

        document.body.style.setProperty('--tbg-extra-blur', `${this.settings.extraBlur}px`);

        if (this.settings.themeHandlesOpacity) {
            document.body.classList.add('translucent-bg-theme-opacity');

            const opacityVar = isDark
                ? 'var(--translucent-dark-opacity, 50%)'
                : 'var(--translucent-light-opacity, 50%)';
            const workspaceBg = `rgb(from var(--background-secondary) r g b / ${opacityVar})`;
            document.body.style.setProperty('--workspace-background-translucent', workspaceBg, 'important');

            document.body.style.removeProperty('--tbg-tint-color');
            document.body.style.removeProperty('--tbg-tint-base');
        } else {
            document.body.classList.remove('translucent-bg-theme-opacity');

            document.body.style.setProperty('--workspace-background-translucent', 'transparent', 'important');

            const color = isDark ? this.settings.darkTintColor   : this.settings.lightTintColor;
            const alpha = isDark ? this.settings.darkTintOpacity : this.settings.lightTintOpacity;
            document.body.style.setProperty('--tbg-tint-color', hexToRgba(color, alpha));
            document.body.style.removeProperty('--tbg-tint-base');
        }

        this.resumeThemeObserver();
    }

    // -----------------------------------------------------------------------
    // Theme observer
    // -----------------------------------------------------------------------

    private observeThemeChanges() {
        if (!this.settings.followTheme) return;
        this.themeObserver?.disconnect();
        this.themeObserver = new MutationObserver(() => {
            this.updateOverlayStyle();
        });
        this.themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    /** Re-attaches the observer after updateOverlayStyle finishes its own class mutations. */
    private resumeThemeObserver() {
        if (!this.settings.followTheme || !this.themeObserver) return;
        this.themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    // -----------------------------------------------------------------------
    // Electron window access
    // -----------------------------------------------------------------------

    /**
     * Resolves the Electron BrowserWindow for the current renderer process.
     * Tries window.electron, then window.require('electron'), then @electron/remote.
     */
    private getElectronWindow(): any {
        try {
            // @ts-ignore
            const electron = window.electron ?? (window as any).require?.('electron');
            // @ts-ignore
            return electron?.remote?.getCurrentWindow?.()
                // @ts-ignore
                ?? electron?.getCurrentWindow?.()
                // @ts-ignore
                ?? require('@electron/remote')?.getCurrentWindow?.();
        } catch {
            return null;
        }
    }
}

// ---------------------------------------------------------------------------
// Settings Tab
// ---------------------------------------------------------------------------

/**
 * TranslucentBgSettingTab
 * -----------------------
 * Renders the plugin's settings UI inside Obsidian's Settings modal.
 * Each control immediately applies its change and persists it to disk.
 */
class TranslucentBgSettingTab extends PluginSettingTab {
    plugin: TranslucentBgPlugin;

    constructor(app: App, plugin: TranslucentBgPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Translucent BG' });
        containerEl.createEl('p', {
            text: 'Apply Windows 11 background materials (Mica, Acrylic) with a theme-aware tint overlay. Window dragging is preserved via the titlebar.',
            cls: 'setting-item-description',
        });

        // ---- Background material ----
        new Setting(containerEl)
            .setName('Background material')
            .setDesc(
                'Mica: subtle texture from the desktop wallpaper, energy-efficient. ' +
                'Acrylic: stronger acrylic blur with tint. ' +
                'Tabbed: Mica variant for tabbed app windows. ' +
                'None: disables the effect entirely.'
            )
            .addDropdown((dd) =>
                dd
                    .addOption('mica',    'Mica')
                    .addOption('acrylic', 'Acrylic')
                    .addOption('tabbed',  'Tabbed')
                    .addOption('none',    'None (disable)')
                    .setValue(this.plugin.settings.material)
                    .onChange(async (value: TranslucentBgMaterial) => {
                        this.plugin.settings.material = value;
                        this.plugin.applyMaterial(value);
                        this.plugin.updateOverlayStyle();
                        await this.plugin.saveSettings();
                    })
            );

        // ---- Let the theme handle background opacity ----
        new Setting(containerEl)
            .setName('Let the theme handle background opacity')
            .setDesc(
                'When enabled, the plugin uses --workspace-background-translucent with ' +
                'rgb(from var(--background-secondary) r g b / var(--translucent-light/dark-opacity)) — ' +
                'the same mechanism Obsidian themes use. Your theme controls opacity via ' +
                '--translucent-light-opacity and --translucent-dark-opacity on :root. ' +
                'The tint color pickers and opacity sliders below are hidden in this mode. ' +
                'Disable to use the plugin\'s own color and opacity controls instead.'
            )
            .addToggle((t) =>
                t
                    .setValue(this.plugin.settings.themeHandlesOpacity)
                    .onChange(async (value) => {
                        this.plugin.settings.themeHandlesOpacity = value;
                        this.plugin.updateOverlayStyle();
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        // ---- Tint controls — hidden in theme-managed mode ----
        if (!this.plugin.settings.themeHandlesOpacity) {

            // ---- Light tint color ----
            new Setting(containerEl)
                .setName('Light mode tint color')
                .setDesc('Base color of the overlay in light mode. Combine with the opacity slider to fine-tune.')
                .addColorPicker((cp) =>
                    cp
                        .setValue(this.plugin.settings.lightTintColor)
                        .onChange(async (value) => {
                            this.plugin.settings.lightTintColor = value;
                            this.plugin.updateOverlayStyle();
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName('Light mode tint opacity')
                .setDesc(
                    'Opacity of the tint overlay in light mode (0 = invisible, 1 = fully opaque). ' +
                    'Enable "Let the theme handle background opacity" above to let your theme ' +
                    'control this via --translucent-light-opacity instead.'
                )
                .addSlider((s) =>
                    s
                        .setLimits(0, 1, 0.01)
                        .setValue(this.plugin.settings.lightTintOpacity)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            this.plugin.settings.lightTintOpacity = value;
                            this.plugin.updateOverlayStyle();
                            await this.plugin.saveSettings();
                        })
                );

            // ---- Dark tint color ----
            new Setting(containerEl)
                .setName('Dark mode tint color')
                .setDesc('Base color of the overlay in dark mode.')
                .addColorPicker((cp) =>
                    cp
                        .setValue(this.plugin.settings.darkTintColor)
                        .onChange(async (value) => {
                            this.plugin.settings.darkTintColor = value;
                            this.plugin.updateOverlayStyle();
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName('Dark mode tint opacity')
                .setDesc(
                    'Opacity of the tint overlay in dark mode (0 = invisible, 1 = fully opaque). ' +
                    'Enable "Let the theme handle background opacity" above to let your theme ' +
                    'control this via --translucent-dark-opacity instead.'
                )
                .addSlider((s) =>
                    s
                        .setLimits(0, 1, 0.01)
                        .setValue(this.plugin.settings.darkTintOpacity)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            this.plugin.settings.darkTintOpacity = value;
                            this.plugin.updateOverlayStyle();
                            await this.plugin.saveSettings();
                        })
                );

        } // end !themeHandlesOpacity

        // ---- Extra CSS blur ----
        new Setting(containerEl)
            .setName('Extra CSS blur')
            .setDesc(
                'Additional CSS backdrop-filter blur (pixels) on top of the native material. ' +
                'Higher values increase the frosted-glass effect but cost GPU performance. ' +
                'Leave at 0 for a pure native material look.'
            )
            .addSlider((s) =>
                s
                    .setLimits(0, 40, 1)
                    .setValue(this.plugin.settings.extraBlur)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.extraBlur = value;
                        this.plugin.updateOverlayStyle();
                        await this.plugin.saveSettings();
                    })
            );

        // ---- Reset ----
        new Setting(containerEl)
            .setName('Reset to defaults')
            .setDesc('Restore all settings to their factory defaults.')
            .addButton((b) =>
                b
                    .setButtonText('Reset')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                        await this.plugin.saveSettings();
                        this.plugin.applyMaterial(this.plugin.settings.material);
                        this.plugin.updateOverlayStyle();
                        this.display(); // Re-render to reflect new values
                    })
            );
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a CSS hex color string and a 0–1 alpha value into an `rgba()` string.
 * Accepts both shorthand (#rgb) and full (#rrggbb) hex formats.
 *
 * @example
 * hexToRgba('#1e1e1e', 0.45) // → 'rgba(30, 30, 30, 0.45)'
 */
function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace('#', '').trim();
    let r = 0, g = 0, b = 0;

    if (clean.length === 3) {
        r = parseInt(clean[0] + clean[0], 16);
        g = parseInt(clean[1] + clean[1], 16);
        b = parseInt(clean[2] + clean[2], 16);
    } else if (clean.length === 6) {
        r = parseInt(clean.substring(0, 2), 16);
        g = parseInt(clean.substring(2, 4), 16);
        b = parseInt(clean.substring(4, 6), 16);
    }

    const a = Math.max(0, Math.min(1, alpha));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}
