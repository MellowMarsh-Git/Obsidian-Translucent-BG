import { App, Plugin, PluginSettingTab, Setting, Platform, Notice } from 'obsidian';

// ---------------------------------------------------------------------------
// Types & Settings
// ---------------------------------------------------------------------------

type TranslucentBgMaterial = 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed';

interface TranslucentBgSettings {
    material: TranslucentBgMaterial;
    lightTintColor: string;
    lightTintOpacity: number;
    darkTintColor: string;
    darkTintOpacity: number;
    extraBlur: number;
    followTheme: boolean;
    /** When true the overlay is hidden; opacity is driven by the theme's :root variables. */
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

const OVERLAY_ID = 'translucent-bg-overlay';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class TranslucentBgPlugin extends Plugin {
    settings: TranslucentBgSettings;
    electronWindow: any = null;
    private themeObserver: MutationObserver | null = null;

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
    // Settings
    // -----------------------------------------------------------------------

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) ?? {});
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // -----------------------------------------------------------------------
    // Material
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
    // Translucency
    // -----------------------------------------------------------------------

    private enableTranslucency() {
        document.body.classList.add('is-translucent');
        document.body.classList.add('translucent-bg-enabled');
        document.body.style.setProperty('--workspace-background-translucent', 'transparent', 'important');
        document.body.style.setProperty('--titlebar-background', 'transparent', 'important');
        document.body.style.setProperty('--titlebar-background-focused', 'transparent', 'important');
    }

    // -----------------------------------------------------------------------
    // Overlay
    // -----------------------------------------------------------------------

    private injectOverlay() {
        if (document.getElementById(OVERLAY_ID)) return;
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.classList.add('translucent-bg-overlay');
        document.body.prepend(overlay);
    }

    /**
     * themeHandlesOpacity=false: bakes rgba() into --tbg-tint-color for the overlay.
     * themeHandlesOpacity=true:  sets --workspace-background-translucent using the
     *   theme's --translucent-light/dark-opacity variables; overlay is hidden.
     */
    updateOverlayStyle() {
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

    private resumeThemeObserver() {
        if (!this.settings.followTheme || !this.themeObserver) return;
        this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // -----------------------------------------------------------------------
    // Electron window
    // -----------------------------------------------------------------------

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
                'Additional CSS backdrop-filter blur (pixels) on top of the native material. ' +
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
 * Converts a hex color (#rgb or #rrggbb) and 0–1 alpha into an rgba() string.
 * @example hexToRgba('#1e1e1e', 0.45) // → 'rgba(30, 30, 30, 0.45)'
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