export function installPluginManager(app) {
  app.plugins = { plugins: {}, manifests: {}, enabledPlugins: new Set(), settingTabs: [], async loadAll() {}, renderSettings(el) { el.setText('…'); } };
}
