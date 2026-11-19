# Community templates

Templates the sk_notes app for Android offers when a template is chosen ("Community templates").
The app carries a copy of this folder and, when this repository is public, reads the current one from
`https://raw.githubusercontent.com/Endrx2008/sk_notes/main/community/templates/`.

To add one: put the note in `<language>/<id>.md` and add an entry to `index.json`
(`id` must be unique: `<id>-<language>`; `lang` is one of en, it, es, fr, de, pt, ru, zh-CN, ja).
Templates may use `{{title}}`, `{{date}}`, `{{time}}` and `{{date:FORMAT}}`.
