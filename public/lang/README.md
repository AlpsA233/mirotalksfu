# UI translations (native / human)

Hand-editable translation files for the **meeting UI and entry pages**.

The homepage, room creation, login, waiting room, room customization, and active-room
pages provide an **English / 中文** picker. The pre-join screen and Settings → Language
also provide language controls. The choice applies immediately and is remembered across
these pages and reloads. Chinese uses the bundled dictionary without a Google request.
Scheduling dialogs opened from these pages use the same language.

When a file `public/lang/<lang>.json` exists for the configured UI language and native
translation is enabled, MiroTalk SFU uses it to translate the UI **and disables the
Google Translate widget** for that page. When no such file exists (or the mode forces
Google), the runtime machine translation (Google, 133+ languages) remains available on pages with the Google widget.

The configured language comes from `config.ui.brand.app.language` (env `UI_LANGUAGE`,
default `en`). See [app/src/config.template.js](../../app/src/config.template.js).

## Translation mode (`UI_TRANSLATION_MODE`)

`config.ui.brand.app.translationMode` (env `UI_TRANSLATION_MODE`) controls the strategy.
**The default is `auto`** when the value is unset, empty, or invalid.
An explicit native language selection overrides the configured mode for that browser,
including existing installations configured with `google`.

| Mode             | Behavior                                                            | In-room language switcher                      |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| `google`         | Always use Google machine translation; native files are ignored     | Google combo plus native picker                |
| `auto` (default) | Use the native file if it exists for the language, otherwise Google | Native picker (native/English) or Google combo |
| `native`         | Human files only — never load Google (missing strings stay English) | Native picker                                  |

Notes on behavior:

- In `auto`/`native`, an in-room **Language** picker (Settings → Language) lists English
  plus every language that has a native file, and switches **live without a page reload**.
- In `google`, the native picker remains available alongside the Google combo. Selecting
  Chinese uses the bundled translation. If machine translation has already modified the
  page, switching to native translation reloads it once.
- The chosen language is remembered per browser (`localStorage`): `uiLanguageOverride` for
  the native picker, `googleTransLang` for the Google combo. It overrides `UI_LANGUAGE` on
  the next load. Native choices are saved explicitly, including English. Remove
  `uiLanguageOverride` from local storage to use the server default again.

## How to add a language

Use `public/lang/en.json` as the starting point for every translation. It contains the
current in-room UI strings, grouped by namespace, with each English source string used as
both the key and the initial value.

1. Copy `en.json` to a new file named after the language code used in `UI_LANGUAGE`, e.g.
   Hungarian:

    ```bash
    cp public/lang/en.json public/lang/hu.json
    ```

2. Open `hu.json` and translate each **value**. Leave every **key** (the English source
   string) unchanged.

    ```json
    {
        "tooltips": {
            "Mute": "Némítás"
        },
        "dialogs": {
            "Cancel": "Mégse"
        }
    }
    ```

3. Enable native translation and select the language, then open a room:

    ```bash
    UI_TRANSLATION_MODE=auto   # or "native"
    UI_LANGUAGE=hu             # or config.ui.brand.app.language = 'hu'
    ```

    With an explicit `google` mode, the native file is used after the user selects
    its language in the native picker.

Missing or empty values fall back to the original English text, you can translate
incrementally and ship a partial file.

## Namespaces

Keys are grouped by UI context so the same English word can be translated differently
depending on where it appears (e.g. "Cancel" as a dialog button vs. a tooltip):

| Namespace  | Covers                                                                |
| ---------- | --------------------------------------------------------------------- |
| `tooltips` | Tippy tooltips (hover hints on controls)                              |
| `buttons`  | Text and `title`/`placeholder`/`aria-label` on `<button>` elements    |
| `labels`   | All other static UI text, headings, placeholders and label attributes |
| `dialogs`  | SweetAlert popups: titles, buttons, input placeholders, body text     |
| `toasts`   | Snackbar / toast notifications                                        |
| `pages`    | Entry pages, scheduling dialogs, and their dynamic messages           |

## Notes

- Keys must match the English source **exactly** (including punctuation and casing).
  Surrounding whitespace is ignored and internal whitespace is normalized.
- A few dynamically-built strings use a `{name}` placeholder in the key (e.g.
  `"Start with {name}"`); keep the `{name}` token unchanged in your translation. Other
  strings can pass values explicitly: `i18n.t("{count} rooms", "pages", { count: 3 })`.
  Translate before substituting user content; never treat user-provided text as a key.
- To exclude an element from translation, add `class="notranslate"`, `translate="no"`, or
  `data-i18n-skip` in the HTML.
- User-generated content (chat messages, room names, form values) must retain its original
  text. Exclude rendered user content with `translate="no"`. Documentation and recording
  pages have separate copy and are not processed by this module.

## Regenerating the English template

`en.json` is generated from the in-room source strings, and every other language file is
synchronized to the same namespace and key structure:

```bash
node app/src/scripts/extract-ui-lang.js
```

The script preserves existing translated values. Missing keys are added to each language
with the English source text as a fallback, ready for human translation, and stale keys are
removed. Curated `pages` entries, including long descriptions, are preserved. Review the
generated changes before committing them.
