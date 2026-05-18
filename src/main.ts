/**
 * Obsidian Translucent BG
 * ======================
 * Applies native Windows 11 background materials (Mica, Acrylic, Tabbed) to
 * the Obsidian window, then layers a theme-aware tint overlay on top.
 *
 * Architecture overview
 * ---------------------
 * 1. On load the plugin asks Electron to set the window's background material
 *    via `BrowserWindow.setBackgroundMaterial`.
 * 2. It adds `is-translucent` to `<body>` so Obsidian uses its translucent
 *    workspace background variable.
 * 3. It injects a full-screen overlay `<div>` at z-index:-1 carrying the tint
 *    color and optional extra blur via CSS custom properties.
 * 4. CSS custom properties exposed to themes:
 *    --tbg-light-opacity  — tint opacity in light mode (default 35%)
 *    --tbg-dark-opacity   — tint opacity in dark mode  (default 45%)
 *    --tbg-tint-base      — solid tint color when themeHandlesOpacity is enabled
 * 5. A MutationObserver watches `<body>` class changes so the tint reacts
 *    instantly when the user switches themes.
 */

import { App, Plugin, PluginSettingTab, Setting, Platform, Notice } from 'obsidian';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TranslucentBgMaterial = 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * All persisted settings for the plugin.
 * Colors are stored as CSS hex strings (#rrggbb); opacity as a 0–1 float.
 */
interface TranslucentBgSettings {
    material: TranslucentBgMaterial;
    lightTintColor: string;
    lightTintOpacity: number;
    darkTintColor: string;
    darkTintOpacity: number;
    /** Extra CSS backdrop-filter blur (px) layered on top of the native material. */
    extraBlur: number;
    followTheme: boolean;
    /**
     * When true the plugin does not write opacity variables as inline styles,
     * letting a theme's :root declarations win. The overlay is hidden and tinting
     * is driven by --workspace-background-translucent + theme opacity vars.
     */
    themeHandlesOpacity: boolean;
}

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

const OVERLAY_ID = 'translucent-bg-overlay';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class TranslucentBgPlugin extends Plugin {
    settings: TranslucentBgSettings;
    electronWindow: any = null;
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
                // @ts-ignore
                this.app.setting.open();
                // @ts-ignore
                this.app.setting.openTabById(this.manifest.id);
            },
        });

        this.addRibbonIcon('layers', 'Translucent BG: cycle material', () => this.cycleMaterial());
    }

    onunload() {
        if (!Platform.isWin) return;

        try {
            this.electronWindow?.setBackgroundMaterial?.('none');
        } catch {
            // Window may already be closing.
        }

        document.body.classList.remove('is-translucent', 'translucent-bg-enabled', 'translucent-bg-theme-opacity');
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
        const next = order[(order.indexOf(this.settings.material) + 1) % order.length];
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
     * that would paint over the native material. Inner elements (code blocks,
     * modals, sidebars) retain their themed backgrounds for readability.
     */
    private enableTranslucency() {
        document.body.classList.add('is-translucent', 'translucent-bg-enabled');
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
     * Recomputes tint variables from current settings.
     *
     * Plugin-managed mode (themeHandlesOpacity = false):
     *   Bakes rgba() into --tbg-tint-color for the overlay div.
     *   --workspace-background-translucent stays transparent.
     *
     * Theme-managed mode (themeHandlesOpacity = true):
     *   Sets --workspace-background-translucent to an rgb(from …) expression
     *   using --background-secondary + the theme's opacity variables. The
     *   overlay div is hidden; --translucent-light/dark-opacity are never
     *   written as inline styles so the theme's :root values take precedence.
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
            document.body.style.setProperty(
                '--workspace-background-translucent',
                `rgb(from var(--background-secondary) r g b / ${opacityVar})`,
                'important'
            );
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
        this.themeObserver = new MutationObserver(() => this.updateOverlayStyle());
        this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    /** Re-attaches the observer after updateOverlayStyle finishes its own class mutations. */
    private resumeThemeObserver() {
        if (!this.settings.followTheme || !this.themeObserver) return;
        this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
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

        new Setting(containerEl)
            .setName('Let the theme handle background opacity')
            .setDesc(
                'When enabled, the plugin sets --workspace-background-translucent using ' +
                'rgb(from var(--background-secondary) r g b / var(--translucent-light/dark-opacity)) ' +
                '— the same mechanism Obsidian themes use. Disable to use the plugin\'s own ' +
                'color and opacity controls instead.'
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

        if (!this.plugin.settings.themeHandlesOpacity) {
            new Setting(containerEl)
                .setName('Light mode tint color')
                .setDesc('Base color of the overlay in light mode.')
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
                .setDesc('Opacity of the tint overlay in light mode (0 = invisible, 1 = fully opaque).')
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
                .setDesc('Opacity of the tint overlay in dark mode (0 = invisible, 1 = fully opaque).')
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
        }

        new Setting(containerEl)
            .setName('Extra CSS blur')
            .setDesc(
                'Additional backdrop-filter blur (px) on top of the native material. ' +
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
                        this.display();
                    })
            );
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a hex color string and a 0–1 alpha into an `rgba()` string.
 * Accepts both shorthand (#rgb) and full (#rrggbb) formats.
 *
 * @example hexToRgba('#1e1e1e', 0.45) → 'rgba(30, 30, 30, 0.45)'
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

    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}
