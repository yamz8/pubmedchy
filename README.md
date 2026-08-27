# pubmedchy

`pubmedchy` is a native Omarchy bar plugin for searching PubMed, the U.S.
National Library of Medicine's index of biomedical literature. Search by topic,
author, journal, MeSH term, or PMID, then refine the live results by publication
window and article type.

Each result shows its PMID, publication year, journal, authors, article type,
and whether a free full text is available at PubMed Central. Opening a result
hands it to Omarchy's configured browser.

The plugin uses the NCBI E-utilities API directly and needs no API key. A search
runs two requests: `esearch` for the ranked PMID list and match count, then
`esummary` for the citation details. Results keep PubMed's own ranking rather
than being re-sorted locally.

It does not write a cache, history, or analytics data, and clears the query and
results whenever the panel closes. Queries are still sent to NCBI, so do not
enter patient names, record numbers, or other personal identifiers.

This is a literature discovery aid, not medical advice.

## Omarchy integration

The widget uses Omarchy's native `Panel`, `BarIconButton`, `KeyboardPanel`,
`PanelHero`, `ButtonGroup`, and theme tokens. Its open-book mark is a
monochrome Nerd Font glyph, so it follows the active bar foreground color and
font instead of falling back to a colored emoji.

Runtime dependencies are `curl` and network access to `eutils.ncbi.nlm.nih.gov`.

## Install

```bash
omarchy plugin add https://github.com/yamz8/pubmedchy.git --enable
```

`omarchy plugin add` clones the repository, validates the manifest, and installs
it as `yamz8.pubmedchy`. Update later with `omarchy plugin update yamz8.pubmedchy`.

## Install from a local checkout

```bash
cp -R ./pubmedchy ~/.config/omarchy/plugins/yamz8.pubmedchy
omarchy plugin validate ~/.config/omarchy/plugins/yamz8.pubmedchy
omarchy plugin enable yamz8.pubmedchy
```

Plugin files hot reload. If the widget does not appear immediately, run:

```bash
omarchy-shell shell rescanPlugins
```

## Remove

```bash
omarchy plugin disable yamz8.pubmedchy
omarchy plugin remove yamz8.pubmedchy
```

Removing the plugin takes the widget out of the bar and deletes
`~/.config/omarchy/plugins/yamz8.pubmedchy`. The plugin stores nothing outside
that folder, so nothing else is left behind.

## Use

- Left-click the open-book icon to open the finder.
- Right-click it to open PubMed.
- Press `Enter` to search and then `Enter` again to open the selected citation.
- Press `Up`/`Down` to choose a result, `Esc` to close, or `Tab` to switch bar
  panels.

The bar editor exposes default publication window, default article type, result
order, and result-limit settings. For example:

```bash
omarchy bar set yamz8.pubmedchy defaultDate 5y
omarchy bar set yamz8.pubmedchy defaultType REVIEW
omarchy bar set yamz8.pubmedchy sortOrder pub_date
omarchy bar set yamz8.pubmedchy resultLimit 8
```

## Validate

```bash
omarchy plugin validate .
node --test tests/pubmed.test.mjs
/usr/lib/qt6/bin/qmlformat Pubmedchy.qml >/dev/null
```

## Data source

- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/)
- [ESearch parameters](https://www.ncbi.nlm.nih.gov/books/NBK25499/#chapter4.ESearch)
- [PubMed search field tags](https://pubmed.ncbi.nlm.nih.gov/help/#search-tags)

PubMed is a service of the U.S. National Library of Medicine. Please respect
NCBI's usage policy; without an API key, E-utilities allows up to three requests
per second.

## License

MIT
