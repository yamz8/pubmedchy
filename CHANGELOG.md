# Changelog

## 1.0.2 - 2026-08-28

- Bound everything retained from an NCBI reply. A reply can sit under the
  2 MiB transfer cap and still carry an oversized id list, oversized nested
  arrays, or very long strings, so the requested result limit now caps the
  retained PMIDs and results, nested author/articleid/pubtype lists are capped
  before they are scanned, and every retained remote string is truncated to a
  practical display length.
- Reject a PMID that is not a plausible identifier instead of truncating it
  into one, so a malformed uid yields no article link.

## 1.0.1 - 2026-08-27

- Cap how much of an NCBI response is ever held in memory. Both requests now
  run under a 2 MiB ceiling enforced outside the shell, so an endpoint that
  streams without end cannot grow the shell process.

## 1.0.0 - 2026-08-27

- Add live PubMed search via the NCBI E-utilities esearch and esummary APIs.
- Add publication-window and article-type filters.
- Add relevance and newest-first result ordering as a bar setting.
- Add keyboard result navigation and direct opening of a citation.
- Show journal, authors, article type, and free-full-text availability per result.
- Add native Omarchy components and a theme-aware Nerd Font bar icon.
- Clear query and results on close and show research-use guidance.
