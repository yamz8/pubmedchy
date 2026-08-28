import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../PubMed.js", import.meta.url), "utf8")
const context = vm.createContext({
  Array,
  JSON,
  Math,
  Number,
  String,
  encodeURIComponent,
  isFinite
})
vm.runInContext(source, context)

const searchFixture = JSON.stringify({
  esearchresult: {
    count: "14293",
    retmax: "3",
    idlist: ["38786024", "38308006", "34968414"]
  }
})

const summaryFixture = JSON.stringify({
  result: {
    uids: ["38786024", "34968414"],
    34968414: {
      uid: "34968414",
      title: "Base editing of <i>Escherichia coli</i> genomes &amp; beyond.",
      source: "Nature",
      sortpubdate: "2021/12/29 00:00",
      pubdate: "2021 Dec 29",
      pubtype: ["Journal Article"],
      authors: [{ name: "Chen L", authtype: "Author" }],
      articleids: [{ idtype: "pubmed", value: "34968414" }]
    },
    38786024: {
      uid: "38786024",
      title: "CRISPR-Based Gene Therapies: From Preclinical to Clinical Treatments.",
      source: "Cells",
      sortpubdate: "2024/05/08 00:00",
      pubdate: "2024 May 8",
      pubtype: ["Journal Article", "Review", "Research Support, Non-U.S. Gov't"],
      authors: [
        { name: "Laurent M", authtype: "Author" },
        { name: "Geoffroy M", authtype: "Author" },
        { name: "Pavani G", authtype: "Author" }
      ],
      articleids: [
        { idtype: "pubmed", value: "38786024" },
        { idtype: "pmc", value: "PMC11119143" },
        { idtype: "doi", value: "10.3390/cells13100800" }
      ]
    }
  }
})

test("buildSearchUrl encodes the term and appends a publication-type clause", () => {
  const url = new URL(context.buildSearchUrl("  CRISPR & aging  ", "any", "REVIEW", "relevance", 6))
  assert.equal(url.origin + url.pathname, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi")
  assert.equal(url.searchParams.get("db"), "pubmed")
  assert.equal(url.searchParams.get("term"), "CRISPR & aging AND review[pt]")
  assert.equal(url.searchParams.get("retmax"), "6")
  assert.equal(url.searchParams.get("sort"), "relevance")
  assert.equal(url.searchParams.get("reldate"), null)
})

test("buildSearchUrl maps a relative date window onto reldate and pdat", () => {
  const url = new URL(context.buildSearchUrl("asthma", "5y", "ALL", "pub_date", 10))
  assert.equal(url.searchParams.get("term"), "asthma")
  assert.equal(url.searchParams.get("reldate"), "1825")
  assert.equal(url.searchParams.get("datetype"), "pdat")
  assert.equal(url.searchParams.get("sort"), "pub_date")
})

test("buildSearchUrl returns an empty string for a blank query", () => {
  assert.equal(context.buildSearchUrl("   ", "any", "ALL", "relevance", 6), "")
})

test("unknown filter values fall back to safe defaults", () => {
  assert.equal(context.dateKey("nonsense"), "any")
  assert.equal(context.typeKey("nonsense"), "ALL")
  assert.equal(context.sortKey("nonsense"), "relevance")
  assert.equal(context.clampResultLimit(99), 10)
  assert.equal(context.clampResultLimit(1), 5)
  assert.equal(context.clampResultLimit("abc"), 6)
})

test("buildSummaryUrl joins ids and rejects non-numeric input", () => {
  const url = new URL(context.buildSummaryUrl(["38786024", "not-an-id", "34968414"]))
  assert.equal(url.searchParams.get("id"), "38786024,34968414")
  assert.equal(url.searchParams.get("retmode"), "json")
  assert.equal(context.buildSummaryUrl([]), "")
  assert.equal(context.buildSummaryUrl(["../etc/passwd"]), "")
})

test("parseSearchResponse extracts the total count and id list", () => {
  const parsed = context.parseSearchResponse(searchFixture)
  assert.equal(parsed.totalCount, 14293)
  assert.deepEqual(parsed.ids, ["38786024", "38308006", "34968414"])
})

test("parseSearchResponse handles a zero-result reply", () => {
  const parsed = context.parseSearchResponse(JSON.stringify({
    esearchresult: { count: "0", idlist: [] }
  }))
  assert.equal(parsed.totalCount, 0)
  assert.deepEqual(parsed.ids, [])
})

test("parseSummaryResponse preserves the requested ranking, not numeric key order", () => {
  const requested = ["38786024", "34968414"]
  const results = context.parseSummaryResponse(summaryFixture, requested)
  assert.deepEqual(results.map((article) => article.pmid), requested)
})

test("parseSummaryResponse maps a record onto display fields", () => {
  const [article] = context.parseSummaryResponse(summaryFixture, ["38786024"])
  assert.equal(article.pmid, "38786024")
  assert.equal(article.title, "CRISPR-Based Gene Therapies: From Preclinical to Clinical Treatments")
  assert.equal(article.year, "2024")
  assert.equal(article.journal, "Cells")
  assert.equal(article.authorLabel, "Laurent M et al.")
  assert.equal(article.typeLabel, "Review")
  assert.equal(article.doi, "10.3390/cells13100800")
  assert.equal(article.freeFullText, true)
  assert.equal(article.url, "https://pubmed.ncbi.nlm.nih.gov/38786024/")
})

test("titles are stripped of inline markup and entities", () => {
  const [article] = context.parseSummaryResponse(summaryFixture, ["34968414"])
  assert.equal(article.title, "Base editing of Escherichia coli genomes & beyond")
  assert.equal(article.freeFullText, false)
  assert.equal(article.typeLabel, "")
  assert.equal(article.authorLabel, "Chen L")
})

test("author labels collapse by count", () => {
  const label = (names) => context.parseSummaryResponse(JSON.stringify({
    result: {
      uids: ["1"],
      1: { uid: "1", title: "t", authors: names.map((name) => ({ name, authtype: "Author" })) }
    }
  }), ["1"])[0].authorLabel

  assert.equal(label([]), "No authors listed")
  assert.equal(label(["Solo A"]), "Solo A")
  assert.equal(label(["First A", "Second B"]), "First A & Second B")
  assert.equal(label(["First A", "Second B", "Third C"]), "First A et al.")
})

test("records that failed to load are dropped", () => {
  const results = context.parseSummaryResponse(JSON.stringify({
    result: {
      uids: ["1", "2"],
      1: { uid: "1", error: "cannot get document summary" },
      2: { uid: "2", title: "Kept." }
    }
  }), ["1", "2"])
  assert.equal(results.length, 1)
  assert.equal(results[0].pmid, "2")
})

test("parseSearchResponse keeps no more ids than were requested", () => {
  const flood = JSON.stringify({
    esearchresult: {
      count: "9000000",
      idlist: Array.from({ length: 5000 }, (_, index) => String(30000000 + index))
    }
  })
  assert.equal(context.parseSearchResponse(flood, 6).ids.length, 6)
  assert.equal(context.parseSearchResponse(flood, 99).ids.length, 10)
  assert.equal(context.parseSearchResponse(flood).ids.length, 10)
})

test("parseSearchResponse rejects ids that are not plausible PMIDs", () => {
  const parsed = context.parseSearchResponse(JSON.stringify({
    esearchresult: {
      count: "3",
      idlist: ["38786024", "9".repeat(4000), "12; rm -rf /", "34968414"]
    }
  }), 10)
  assert.deepEqual(parsed.ids, ["38786024", "34968414"])
})

test("buildSummaryUrl caps the id argument even when handed a long list", () => {
  const ids = Array.from({ length: 500 }, (_, index) => String(30000000 + index))
  const url = new URL(context.buildSummaryUrl(ids, 6))
  assert.equal(url.searchParams.get("id").split(",").length, 6)
  assert.ok(context.buildSummaryUrl(ids).length < 200)
})

test("parseSummaryResponse caps the retained result list", () => {
  const uids = Array.from({ length: 400 }, (_, index) => String(30000000 + index))
  const records = { uids }
  for (const uid of uids) records[uid] = { uid, title: "t" }
  const results = context.parseSummaryResponse(JSON.stringify({ result: records }), [], 6)
  assert.equal(results.length, 6)
})

test("remote strings are truncated to practical display lengths", () => {
  const [article] = context.parseSummaryResponse(JSON.stringify({
    result: {
      uids: ["1"],
      1: {
        uid: "1",
        title: "T".repeat(50000),
        source: "J".repeat(50000),
        sortpubdate: "2".repeat(50000),
        authors: [{ name: "A".repeat(50000), authtype: "Author" }],
        articleids: [{ idtype: "doi", value: "10.1/".concat("d".repeat(50000)) }]
      }
    }
  }), ["1"], 6)

  assert.equal(article.title.length, 400)
  assert.equal(article.journal.length, 120)
  assert.equal(article.authorLabel.length, 80)
  assert.equal(article.doi.length, 120)
  // The date is read from a 40-character window, not the whole remote string.
  assert.equal(article.year, "2222")
})

test("nested remote lists are bounded before they are scanned", () => {
  const [article] = context.parseSummaryResponse(JSON.stringify({
    result: {
      uids: ["1"],
      1: {
        uid: "1",
        title: "t",
        authors: Array.from({ length: 10000 }, (_, index) => ({
          name: `Author ${index}`,
          authtype: "Author"
        })),
        pubtype: Array.from({ length: 10000 }, () => "Journal Article").concat("Review"),
        articleids: Array.from({ length: 10000 }, () => ({ idtype: "pubmed", value: "1" }))
          .concat({ idtype: "doi", value: "10.1/kept" })
      }
    }
  }), ["1"], 6)

  // Capped past the preferred type and the DOI, which is the point: a record
  // that large is not a real citation, and scanning it is the cost being cut.
  assert.equal(article.authorLabel, "Author 0 et al.")
  assert.equal(article.typeLabel, "")
  assert.equal(article.doi, "")
})

test("a uid that is not a plausible PMID yields no article link", () => {
  const [article] = context.parseSummaryResponse(JSON.stringify({
    result: {
      uids: ["1"],
      1: { uid: "9".repeat(40), title: "t" }
    }
  }), ["1"], 6)
  assert.equal(article.pmid, "")
  assert.equal(article.url, "")
})

test("an idtype longer than the requested kind does not match it", () => {
  const [article] = context.parseSummaryResponse(JSON.stringify({
    result: {
      uids: ["1"],
      1: { uid: "1", title: "t", articleids: [{ idtype: "doix", value: "not-a-doi" }] }
    }
  }), ["1"], 6)
  assert.equal(article.doi, "")
})

test("formatCount groups thousands", () => {
  assert.equal(context.formatCount(14293), "14,293")
  assert.equal(context.formatCount(0), "0")
  assert.equal(context.formatCount("1250"), "1,250")
})
