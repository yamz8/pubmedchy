var SEARCH_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
var SUMMARY_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
var ARTICLE_BASE = "https://pubmed.ncbi.nlm.nih.gov/"

// Publication-type clauses appended to the user's term. PubMed resolves the
// [pt] tag against its own controlled vocabulary, so these stay stable.
var TYPE_CLAUSES = {
  ALL: "",
  REVIEW: "review[pt]",
  TRIAL: "clinical trial[pt]",
  META: "meta-analysis[pt]"
}

// Relative publication windows, in days, paired with datetype=pdat.
var DATE_WINDOWS = {
  any: 0,
  "1y": 365,
  "5y": 1825,
  "10y": 3650
}

function dateKey(value) {
  var normalized = String(value || "").toLowerCase()
  return DATE_WINDOWS.hasOwnProperty(normalized) ? normalized : "any"
}

function typeKey(value) {
  var normalized = String(value || "").toUpperCase()
  return TYPE_CLAUSES.hasOwnProperty(normalized) ? normalized : "ALL"
}

function sortKey(value) {
  var normalized = String(value || "").toLowerCase()
  return normalized === "pub_date" || normalized === "date" ? "pub_date" : "relevance"
}

var MAX_RESULTS = 10

function clampResultLimit(value) {
  var parsed = Number(value)
  if (!isFinite(parsed)) return 6
  return Math.max(5, Math.min(MAX_RESULTS, Math.round(parsed)))
}

// A reply can stay under the transfer cap and still carry an oversized id
// list, oversized nested arrays, or very long strings. The endpoint is not a
// trust boundary, so everything retained from a reply is bounded here, at the
// point it is read, before it reaches a URL or the model.
var MAX_PMID_DIGITS = 12
var MAX_AUTHORS = 32
var MAX_ARTICLE_IDS = 32
var MAX_ID_TYPE_CHARS = 32
var MAX_PUBTYPES = 32
var MAX_TITLE_CHARS = 400
var MAX_JOURNAL_CHARS = 120
var MAX_AUTHOR_CHARS = 80
var MAX_DOI_CHARS = 120
var MAX_DATE_CHARS = 40

// Anchored and counted, so a huge remote value is rejected rather than scanned.
var PMID_PATTERN = new RegExp("^\\d{1," + MAX_PMID_DIGITS + "}$")

function clampText(value, limit) {
  var text = String(value === null || value === undefined ? "" : value)
  return text.length > limit ? text.slice(0, limit) : text
}

function clampList(value, limit) {
  if (!Array.isArray(value)) return []
  return value.length > limit ? value.slice(0, limit) : value
}

// Defaults to the hard ceiling so an omitted limit still bounds retention.
function retainLimit(value) {
  var parsed = Number(value)
  if (!isFinite(parsed)) return MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS, Math.round(parsed)))
}

function isPmid(value) {
  return PMID_PATTERN.test(String(value))
}

function buildTerm(query, type) {
  var normalizedQuery = String(query || "").trim()
  if (normalizedQuery === "") return ""
  var clause = TYPE_CLAUSES[typeKey(type)]
  return clause ? normalizedQuery + " AND " + clause : normalizedQuery
}

function encodeParameters(parameters) {
  return parameters.map(function(parameter) {
    return encodeURIComponent(parameter[0]) + "=" + encodeURIComponent(parameter[1])
  }).join("&")
}

function buildSearchUrl(query, date, type, sort, resultLimit) {
  var term = buildTerm(query, type)
  if (term === "") return ""

  var parameters = [
    ["db", "pubmed"],
    ["term", term],
    ["retmax", String(clampResultLimit(resultLimit))],
    ["retmode", "json"],
    ["sort", sortKey(sort)]
  ]

  var window = DATE_WINDOWS[dateKey(date)]
  if (window > 0) {
    parameters.push(["reldate", String(window)])
    parameters.push(["datetype", "pdat"])
  }

  return SEARCH_BASE + "?" + encodeParameters(parameters)
}

function buildSummaryUrl(ids, resultLimit) {
  var list = clampList(ids, retainLimit(resultLimit)).filter(isPmid)
  if (list.length === 0) return ""
  return SUMMARY_BASE + "?" + encodeParameters([
    ["db", "pubmed"],
    ["id", list.join(",")],
    ["retmode", "json"]
  ])
}

// Only as many ids as were asked for are kept: the list reached us from the
// endpoint, and it goes straight back out as the second request's id argument.
function parseSearchResponse(raw, resultLimit) {
  var payload = JSON.parse(String(raw || ""))
  var result = (payload && payload.esearchresult) || {}
  return {
    totalCount: Number(result.count) || 0,
    ids: clampList(result.idlist, retainLimit(resultLimit)).filter(isPmid)
  }
}

// PubMed titles carry inline markup (<i>, <sub>, &amp;) that would render
// literally in a PlainText label, so flatten it to readable text.
function cleanTitle(value) {
  // Truncate before the rewrites, so the markup pass never walks a long string.
  var text = clampText(value, MAX_TITLE_CHARS).replace(/<[^>]*>/g, "")
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  text = text.replace(/\s+/g, " ").trim()
  text = text.replace(/\.$/, "")
  return text === "" ? "Untitled article" : text
}

function extractYear(record) {
  var candidates = [record && record.sortpubdate, record && record.pubdate, record && record.epubdate]
  for (var index = 0; index < candidates.length; index++) {
    var matched = clampText(candidates[index], MAX_DATE_CHARS).match(/\d{4}/)
    if (matched) return matched[0]
  }
  return ""
}

function articleId(record, kind) {
  var ids = clampList(record && record.articleids, MAX_ARTICLE_IDS)
  for (var index = 0; index < ids.length; index++) {
    if (ids[index] && clampText(ids[index].idtype, MAX_ID_TYPE_CHARS) === kind)
      return clampText(ids[index].value, MAX_DOI_CHARS)
  }
  return ""
}

function authorLabel(authors) {
  var names = (clampList(authors, MAX_AUTHORS).filter(function(author) {
    return author && clampText(author.authtype || "Author", 32) !== "CollectiveName"
  })).map(function(author) {
    return clampText(author.name, MAX_AUTHOR_CHARS).trim()
  }).filter(function(name) {
    return name !== ""
  })

  if (names.length === 0) return "No authors listed"
  if (names.length === 1) return names[0]
  if (names.length === 2) return names[0] + " & " + names[1]
  return names[0] + " et al."
}

function typeLabel(pubtypes) {
  var types = clampList(pubtypes, MAX_PUBTYPES)
  var preferred = ["Meta-Analysis", "Systematic Review", "Review", "Randomized Controlled Trial", "Clinical Trial", "Case Reports"]
  for (var index = 0; index < preferred.length; index++) {
    if (types.indexOf(preferred[index]) >= 0) return preferred[index]
  }
  return ""
}

function parseArticle(record) {
  var uid = clampText(record && record.uid, MAX_PMID_DIGITS + 1)
  var pmid = isPmid(uid) ? uid : ""
  var journal = clampText(record && record.source, MAX_JOURNAL_CHARS).trim()
  var doi = articleId(record, "doi")

  return {
    pmid: pmid,
    title: cleanTitle(record && record.title),
    year: extractYear(record),
    journal: journal === "" ? "Journal not listed" : journal,
    authorLabel: authorLabel(record && record.authors),
    typeLabel: typeLabel(record && record.pubtype),
    doi: doi,
    // A PMC identifier means a free full text is hosted at PubMed Central.
    freeFullText: articleId(record, "pmc") !== "",
    url: pmid ? ARTICLE_BASE + encodeURIComponent(pmid) + "/" : ""
  }
}

// esummary returns records keyed by UID. JavaScript orders numeric-like object
// keys ascending, which would silently discard PubMed's ranking, so walk the
// requested id list instead to preserve relevance or date order.
function parseSummaryResponse(raw, ids, resultLimit) {
  var payload = JSON.parse(String(raw || ""))
  var result = (payload && payload.result) || {}
  var requested = (ids && ids.length > 0) ? ids : result.uids
  var order = clampList(requested, retainLimit(resultLimit)).filter(isPmid)

  return order.map(function(id) {
    return result[id]
  }).filter(function(record) {
    return record && !record.error && record.uid
  }).map(parseArticle)
}

function formatCount(value) {
  var digits = String(Math.max(0, Math.round(Number(value) || 0)))
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
