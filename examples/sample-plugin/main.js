// Sample sk_notes plugin (native API). Licensed GPL-3.0-or-later like sk_notes.
// Install: Settings → Community plugins → From folder… → choose this folder.
'use strict';

const sk = require('sknotes');

const DEFAULTS = { greeting: 'Hello from the sample plugin' };

class SampleSettingTab extends sk.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    new sk.Setting(this.containerEl)
      .setName('Greeting')
      .setDesc('Text inserted by the "Insert greeting" command.')
      .addText((t) => t.setValue(this.plugin.settings.greeting).onChange(async (v) => {
        this.plugin.settings.greeting = v;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}

module.exports = class SamplePlugin extends sk.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());

    // status bar: number of notes in the vault, kept up to date
    const status = this.addStatusBarItem();
    const update = () => status.setText(`${sk.vault.list('md').length} notes`);
    update();
    this.register(sk.vault.onChange(update));

    this.addCommand({
      id: 'insert-greeting',
      name: 'Insert greeting',
      editorCallback: () => sk.workspace.insert(this.settings.greeting),
    });

    this.addCommand({
      id: 'explain-selection',
      name: 'Ask SKAI to explain the selection',
      checkCallback: (checking) => {
        const text = sk.workspace.selection();
        if (!text || !sk.skai.available()) return false;
        if (!checking) {
          sk.skai.ask(`Explain in two sentences:\n\n${text}`)
            .then((answer) => sk.notice(answer, 15000))
            .catch((e) => sk.notice(String(e.message || e)));
        }
        return true;
      },
    });

    this.addRibbonIcon('sparkles', 'Sample plugin', () => sk.notice(this.settings.greeting));
    this.addSettingTab(new SampleSettingTab(this.app, this));
  }
};
