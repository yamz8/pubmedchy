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

function clampResultLimit(value) {
  var parsed = Number(value)
  if (!isFinite(parsed)) return 6
  return Math.max(5, Math.min(10, Math.round(parsed)))
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

function buildSummaryUrl(ids) {
  var list = (ids || []).filter(function(id) {
    return /^\d+$/.test(String(id))
  })
  if (list.length === 0) return ""
  return SUMMARY_BASE + "?" + encodeParameters([
    ["db", "pubmed"],
    ["id", list.join(",")],
    ["retmode", "json"]
  ])
}

function parseSearchResponse(raw) {
  var payload = JSON.parse(String(raw || ""))
  var result = (payload && payload.esearchresult) || {}
  var ids = Array.isArray(result.idlist) ? result.idlist : []
  return {
    totalCount: Number(result.count) || 0,
    ids: ids.filter(function(id) {
      return /^\d+$/.test(String(id))
    })
  }
}

// PubMed titles carry inline markup (<i>, <sub>, &amp;) that would render
// literally in a PlainText label, so flatten it to readable text.
function cleanTitle(value) {
  var text = String(value || "").replace(/<[^>]*>/g, "")
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  text = text.replace(/\s+/g, " ").trim()
  text = text.replace(/\.$/, "")
  return text === "" ? "Untitled article" : text
}

function extractYear(record) {
  var candidates = [record && record.sortpubdate, record && record.pubdate, record && record.epubdate]
  for (var index = 0; index < candidates.length; index++) {
    var matched = String(candidates[index] || "").match(/\d{4}/)
    if (matched) return matched[0]
  }
  return ""
}

function articleId(record, kind) {
  var ids = (record && record.articleids) || []
  for (var index = 0; index < ids.length; index++) {
    if (ids[index] && String(ids[index].idtype) === kind)
      return String(ids[index].value || "")
  }
  return ""
}

function authorLabel(authors) {
  var names = ((authors || []).filter(function(author) {
    return author && String(author.authtype || "Author") !== "CollectiveName"
  })).map(function(author) {
    return String(author.name || "").trim()
  }).filter(function(name) {
    return name !== ""
  })

  if (names.length === 0) return "No authors listed"
  if (names.length === 1) return names[0]
  if (names.length === 2) return names[0] + " & " + names[1]
  return names[0] + " et al."
}

function typeLabel(pubtypes) {
  var types = pubtypes || []
  var preferred = ["Meta-Analysis", "Systematic Review", "Review", "Randomized Controlled Trial", "Clinical Trial", "Case Reports"]
  for (var index = 0; index < preferred.length; index++) {
    if (types.indexOf(preferred[index]) >= 0) return preferred[index]
  }
  return ""
}

function parseArticle(record) {
  var pmid = String((record && record.uid) || "")
  var journal = String((record && record.source) || "").trim()
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
function parseSummaryResponse(raw, ids) {
  var payload = JSON.parse(String(raw || ""))
  var result = (payload && payload.result) || {}
  var order = (ids && ids.length > 0) ? ids : (result.uids || [])

  return order.map(function(id) {
    return result[String(id)]
  }).filter(function(record) {
    return record && !record.error && record.uid
  }).map(parseArticle)
}

function formatCount(value) {
  var digits = String(Math.max(0, Math.round(Number(value) || 0)))
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
