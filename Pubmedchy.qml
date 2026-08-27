import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "PubMed.js" as PubMed

Panel {
  id: root

  moduleName: "yamz8.pubmedchy"
  ipcTarget: "yamz8.pubmedchy"

  implicitWidth: barButton.implicitWidth
  implicitHeight: barButton.implicitHeight

  // An open book (U+F05DA) from the Material Design Icons range. The glyph
  // comes from Omarchy's configured Nerd Font, so it is monochrome,
  // theme-tinted, and optically aligned by the same BarIconButton used by
  // built-in widgets. No other bar widget uses a book, which keeps it
  // distinguishable from the neighbouring search-style marks.
  readonly property string pubmedIcon: "󰗚"
  // Hard ceiling on how much of an NCBI response the shell will ever hold.
  // Two stages of ten records run well under 100 KB, so 2 MiB leaves ample
  // headroom while keeping a hostile or hijacked endpoint from growing the
  // shell process without bound. Enforced outside the shell, in the fetch
  // pipeline, and re-checked here before anything is parsed.
  readonly property int maxResponseBytes: 2 * 1024 * 1024
  readonly property int resultLimit: PubMed.clampResultLimit(setting("resultLimit", 6))
  readonly property string sortOrder: PubMed.sortKey(setting("sortOrder", "relevance"))
  readonly property int resultRowHeight: Style.space(84)
  // Keep the panel compact when a user asks the API for 7–10 records; the
  // remaining records stay reachable by wheel or keyboard inside ListView.
  readonly property int visibleRows: Math.max(1, Math.min(results.length, 5))
  readonly property int resultsHeight: results.length > 0 ? visibleRows * resultRowHeight : 0
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color accent: Color.accent
  readonly property color selectedBackground: Color.menu.selectedBackground
  readonly property color selectedText: Color.menu.selectedText
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  property string query: ""
  property string dateFilter: "any"
  property string typeFilter: "ALL"
  property string resultsQuery: ""
  property string lastSignature: ""
  property var results: []
  property var pendingIds: []
  property int totalCount: 0
  property int selectedIndex: 0
  property bool searching: false
  property bool aborting: false
  property string errorText: ""

  function searchSignature() {
    return root.query.trim() + "\n" + root.dateFilter + "\n" + root.typeFilter + "\n" + root.sortOrder
  }

  function dateFilterLabel() {
    if (root.dateFilter === "1y") return "Past year"
    if (root.dateFilter === "5y") return "Past 5 years"
    if (root.dateFilter === "10y") return "Past 10 years"
    return "Any date"
  }

  function typeFilterLabel() {
    if (root.typeFilter === "REVIEW") return "Reviews"
    if (root.typeFilter === "TRIAL") return "Clinical trials"
    if (root.typeFilter === "META") return "Meta-analyses"
    return "Any type"
  }

  function sortLabel() {
    return root.sortOrder === "pub_date" ? "Newest first" : "Best match"
  }

  function filterSummary() {
    return root.dateFilterLabel() + "  ·  " + root.typeFilterLabel() + "  ·  " + root.sortLabel()
  }

  function restoreDefaults() {
    root.dateFilter = PubMed.dateKey(root.setting("defaultDate", "any"))
    root.typeFilter = PubMed.typeKey(root.setting("defaultType", "ALL"))
  }

  function stopRequests() {
    if (searchProcess.running) searchProcess.running = false
    if (summaryProcess.running) summaryProcess.running = false
  }

  function clearSensitiveState() {
    root.aborting = true
    root.stopRequests()
    root.query = ""
    root.resultsQuery = ""
    root.lastSignature = ""
    root.results = []
    root.pendingIds = []
    root.totalCount = 0
    root.selectedIndex = 0
    root.searching = false
    root.errorText = ""
  }

  function failWith(message) {
    root.searching = false
    root.results = []
    root.pendingIds = []
    root.totalCount = 0
    root.errorText = message
  }

  // curl is capped twice over. --max-filesize stops the transfer at the limit
  // even when the endpoint declares no Content-Length, and the head -c stage
  // holds the same bound on curl builds that only honour a declared length.
  // pipefail keeps curl's own status as the pipeline status, so timeouts and
  // transport failures still reach onExited unchanged. The URL is passed as a
  // positional argument and after --, never spliced into the script text.
  function fetchCommand(url) {
    return [
      "bash",
      "-c",
      "set -o pipefail; "
        + "curl -fsS --max-time 12 --connect-timeout 5 "
        + "--max-filesize " + root.maxResponseBytes + " "
        + "--user-agent pubmedchy/1.0 -- \"$1\" "
        + "| head -c " + root.maxResponseBytes,
      "pubmedchy",
      url
    ]
  }

  // A response that reaches the cap was truncated mid-flight and cannot be
  // valid JSON, so it is refused before any parser sees it.
  function refuseOversized(raw) {
    if (raw.length < root.maxResponseBytes) return false
    root.failWith("PubMed returned an oversized response — narrow the search and retry")
    return true
  }

  function runSearch() {
    var url = PubMed.buildSearchUrl(root.query, root.dateFilter, root.typeFilter,
                                    root.sortOrder, root.resultLimit)
    if (!url) {
      searchField.forceActiveFocus()
      return
    }
    if (root.searching) return

    root.aborting = false
    root.searching = true
    root.errorText = ""
    root.results = []
    root.pendingIds = []
    root.totalCount = 0
    root.selectedIndex = 0
    root.resultsQuery = root.query.trim()
    root.lastSignature = root.searchSignature()
    searchProcess.command = root.fetchCommand(url)
    searchProcess.running = true
  }

  // Stage one: esearch returns the ranked id list and the total match count.
  function applySearch(raw) {
    if (!root.opened || root.aborting) return
    if (root.refuseOversized(raw)) return
    var parsed
    try {
      parsed = PubMed.parseSearchResponse(raw)
    } catch (error) {
      root.failWith("PubMed returned an unreadable response — retry shortly")
      return
    }

    root.totalCount = parsed.totalCount
    if (parsed.ids.length === 0) {
      root.searching = false
      root.results = []
      root.pendingIds = []
      root.errorText = "No matching citations found — try broader terms or filters"
      return
    }

    var summaryUrl = PubMed.buildSummaryUrl(parsed.ids)
    if (!summaryUrl) {
      root.failWith("PubMed returned an unreadable response — retry shortly")
      return
    }

    root.pendingIds = parsed.ids
    summaryProcess.command = root.fetchCommand(summaryUrl)
    summaryProcess.running = true
  }

  // Stage two: esummary fills in the citation details for those ids.
  function applySummaries(raw) {
    if (!root.opened || root.aborting) return
    if (root.refuseOversized(raw)) return
    try {
      var articles = PubMed.parseSummaryResponse(raw, root.pendingIds)
      root.results = articles
      root.selectedIndex = 0
      root.errorText = articles.length === 0
        ? "No matching citations found — try broader terms or filters"
        : ""
    } catch (error) {
      root.results = []
      root.errorText = "PubMed returned an unreadable response — retry shortly"
    }
    root.pendingIds = []
    root.searching = false
  }

  function networkError(exitCode) {
    // 28 is curl's timeout. 63 is --max-filesize, 23 is curl failing to write
    // once head -c has closed the pipe, and 141 is that same stage seen as
    // SIGPIPE — all three mean the response outgrew the cap.
    if (exitCode === 28) return "PubMed timed out — check the connection and retry"
    if (exitCode === 63 || exitCode === 23 || exitCode === 141)
      return "PubMed returned an oversized response — narrow the search and retry"
    return "PubMed is unavailable — check the connection and retry"
  }

  function refreshAfterFilterChange() {
    if (root.resultsQuery !== "" && !root.searching) root.runSearch()
  }

  function moveSelection(delta) {
    if (root.results.length === 0) return
    root.selectedIndex = Math.max(0, Math.min(root.results.length - 1, root.selectedIndex + delta))
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  function openSelected() {
    if (root.selectedIndex < 0 || root.selectedIndex >= root.results.length) return
    var url = root.results[root.selectedIndex].url
    if (!url) return
    Quickshell.execDetached(["omarchy-launch-browser", url])
    root.close()
  }

  function openPubMed() {
    Quickshell.execDetached(["omarchy-launch-browser", "https://pubmed.ncbi.nlm.nih.gov/"])
    root.close()
  }

  function handleKey(event) {
    if (event.key === Qt.Key_Escape) {
      root.close()
      return true
    }
    if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
      root.switchPanel((event.modifiers & Qt.ShiftModifier) || event.key === Qt.Key_Backtab ? -1 : 1)
      return true
    }
    if (event.key === Qt.Key_Down) {
      root.moveSelection(1)
      return true
    }
    if (event.key === Qt.Key_Up) {
      root.moveSelection(-1)
      return true
    }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      if (!root.searching && root.results.length > 0
          && root.lastSignature === root.searchSignature()) root.openSelected()
      else root.runSearch()
      return true
    }
    return false
  }

  onOpenedChanged: {
    root.clearSensitiveState()
    root.restoreDefaults()
    if (root.opened) Qt.callLater(function() { searchField.forceActiveFocus() })
  }

  Process {
    id: searchProcess

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applySearch(text)
    }
    stderr: StdioCollector {
      waitForEnd: true
    }
    onExited: function(exitCode) {
      if (root.aborting) {
        root.aborting = false
        return
      }
      if (exitCode !== 0 && root.opened) root.failWith(root.networkError(exitCode))
    }
  }

  Process {
    id: summaryProcess

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applySummaries(text)
    }
    stderr: StdioCollector {
      waitForEnd: true
    }
    onExited: function(exitCode) {
      if (root.aborting) {
        root.aborting = false
        return
      }
      if (exitCode !== 0 && root.opened) root.failWith(root.networkError(exitCode))
    }
  }

  BarIconButton {
    id: barButton

    anchors.fill: parent
    bar: root.bar
    text: root.pubmedIcon
    tooltipText: "pubmedchy · search the biomedical literature"

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) root.openPubMed()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: popout

    anchorItem: barButton
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: searchField
    contentWidth: popout.fittedContentWidth(Style.space(680))
    contentHeight: popout.fittedContentHeight(content.implicitHeight, Style.space(820))

    Column {
      id: content

      width: parent.width
      spacing: Style.space(12)

      PanelHero {
        width: parent.width
        title: "pubmedchy"
        meta: "NCBI PubMed citation index"
        detail: "LIVE"
        foreground: root.foreground
        fontFamily: root.fontFamily

        iconComponent: Component {
          Text {
            text: root.pubmedIcon
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
          }
        }

        trailingControl: Component {
          Button {
            text: "Open PubMed"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            onClicked: root.openPubMed()
          }
        }
      }

      PanelSeparator {
        width: parent.width
        foreground: root.foreground
      }

      Column {
        width: parent.width
        spacing: Style.space(8)

        PanelSectionHeader {
          width: parent.width
          text: "FIND A CITATION"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Row {
          width: parent.width
          spacing: Style.spacing.sm

          TextField {
            id: searchField

            width: parent.width - searchButton.width - parent.spacing
            foreground: root.foreground
            placeholderText: "Base editing, Doudna JA, Lancet, 38786024…"
            text: root.query
            onTextChanged: root.query = text
            Keys.priority: Keys.BeforeItem
            Keys.onPressed: function(event) {
              if (root.handleKey(event)) event.accepted = true
            }
          }

          Button {
            id: searchButton

            width: Math.max(Style.space(88), implicitWidth)
            text: root.searching ? "Searching…" : "Search"
            bordered: true
            selected: true
            enabled: root.query.trim() !== "" && !root.searching
            opacity: enabled ? 1 : 0.45
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: root.runSearch()
          }
        }

        Text {
          width: parent.width
          text: root.results.length > 0 && root.lastSignature !== root.searchSignature()
            ? "Search changed — press Enter or Search to refresh these results"
            : "Topic, author, journal, MeSH term, or PMID"
          textFormat: Text.PlainText
          color: root.foreground
          opacity: root.results.length > 0 && root.lastSignature !== root.searchSignature() ? 0.72 : 0.42
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Column {
        width: parent.width
        spacing: Style.space(10)

        Item {
          width: parent.width
          implicitHeight: Math.max(dateHeader.implicitHeight, dateGroup.implicitHeight)

          PanelSectionHeader {
            id: dateHeader

            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "PUBLISHED"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          ButtonGroup {
            id: dateGroup

            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            options: [
              { value: "any", label: "Any" },
              { value: "1y", label: "1 year" },
              { value: "5y", label: "5 years" },
              { value: "10y", label: "10 years" }
            ]
            value: root.dateFilter
            foreground: root.foreground
            background: "transparent"
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            focusable: false
            onChanged: function(value) {
              root.dateFilter = value
              root.refreshAfterFilterChange()
              searchField.forceActiveFocus()
            }
          }
        }

        Item {
          width: parent.width
          implicitHeight: Math.max(typeHeader.implicitHeight, typeGroup.implicitHeight)

          PanelSectionHeader {
            id: typeHeader

            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "ARTICLE TYPE"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          ButtonGroup {
            id: typeGroup

            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            options: [
              { value: "ALL", label: "Any" },
              { value: "REVIEW", label: "Review", tooltip: "Narrative and systematic reviews" },
              { value: "TRIAL", label: "Trial", tooltip: "Clinical trial reports" },
              { value: "META", label: "Meta", tooltip: "Meta-analyses" }
            ]
            value: root.typeFilter
            foreground: root.foreground
            background: "transparent"
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            focusable: false
            onChanged: function(value) {
              root.typeFilter = value
              root.refreshAfterFilterChange()
              searchField.forceActiveFocus()
            }
          }
        }
      }

      PanelSeparator {
        width: parent.width
        foreground: root.foreground
      }

      Item {
        width: parent.width
        visible: root.results.length > 0
        implicitHeight: visible ? Math.max(resultsHeader.implicitHeight, resultsMeta.implicitHeight) : 0

        PanelSectionHeader {
          id: resultsHeader

          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: "RESULTS"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Text {
          id: resultsMeta

          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: PubMed.formatCount(root.totalCount) + " citations  ·  showing "
                + root.results.length + "  ·  " + root.sortLabel()
          textFormat: Text.PlainText
          color: root.foreground
          opacity: 0.48
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      ListView {
        id: resultList

        width: parent.width
        height: root.resultsHeight
        visible: root.results.length > 0
        clip: true
        model: root.results
        currentIndex: root.selectedIndex
        boundsBehavior: Flickable.StopAtBounds

        delegate: Rectangle {
          required property var modelData
          required property int index

          width: ListView.view.width
          height: root.resultRowHeight
          radius: Style.cornerRadius / 2
          color: index === root.selectedIndex ? root.selectedBackground : "transparent"

          Rectangle {
            anchors {
              left: parent.left
              right: parent.right
              bottom: parent.bottom
            }
            visible: index < root.results.length - 1 && index !== root.selectedIndex
            height: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
          }

          Text {
            id: resultTitle

            anchors {
              left: parent.left
              right: yearBadge.left
              top: parent.top
              leftMargin: Style.spacing.rowPaddingX
              rightMargin: Style.space(12)
              topMargin: Style.space(11)
            }
            text: modelData.title
            textFormat: Text.PlainText
            color: index === root.selectedIndex ? root.selectedText : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: index === root.selectedIndex
            wrapMode: Text.WordWrap
            maximumLineCount: 2
            elide: Text.ElideRight
          }

          BorderSurface {
            id: yearBadge

            anchors {
              right: parent.right
              top: parent.top
              rightMargin: Style.spacing.rowPaddingX
              topMargin: Style.space(10)
            }
            implicitWidth: Math.min(Style.space(96), badgeLabel.implicitWidth + Style.space(14))
            implicitHeight: badgeLabel.implicitHeight + Style.space(6)
            color: "transparent"
            borderSpec: Border.controlSpec("normal", index === root.selectedIndex ? root.selectedText : root.foreground, root.accent)
            radius: Style.cornerRadius

            Text {
              id: badgeLabel

              anchors {
                left: parent.left
                right: parent.right
                verticalCenter: parent.verticalCenter
                leftMargin: Style.space(7)
                rightMargin: Style.space(7)
              }
              text: modelData.year === "" ? "No date" : modelData.year
              textFormat: Text.PlainText
              color: index === root.selectedIndex ? root.selectedText : root.foreground
              opacity: 0.68
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
              elide: Text.ElideRight
            }
          }

          Text {
            anchors {
              left: parent.left
              right: parent.right
              bottom: parent.bottom
              leftMargin: Style.spacing.rowPaddingX
              rightMargin: Style.spacing.rowPaddingX
              bottomMargin: Style.space(11)
            }
            text: "PMID " + modelData.pmid
                  + "  ·  " + modelData.journal
                  + "  ·  " + modelData.authorLabel
                  + (modelData.typeLabel !== "" ? "  ·  " + modelData.typeLabel : "")
                  + (modelData.freeFullText ? "  ·  FREE FULL TEXT" : "")
            textFormat: Text.PlainText
            color: index === root.selectedIndex ? root.selectedText : root.foreground
            opacity: 0.5
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onEntered: root.selectedIndex = index
            onClicked: {
              root.selectedIndex = index
              root.openSelected()
            }
          }
        }
      }

      BorderSurface {
        id: emptyState

        width: parent.width
        visible: root.results.length === 0
        implicitHeight: visible ? Style.space(92) : 0
        color: Style.controlFill(false, false, root.foreground, root.accent)
        borderSpec: Border.controlSpec("normal", root.foreground, root.accent)
        radius: Style.cornerRadius

        Column {
          width: parent.width - Style.space(40)
          anchors.centerIn: parent
          spacing: Style.space(5)

          Text {
            width: parent.width
            text: root.searching ? "Searching PubMed…"
              : root.errorText !== "" ? "Couldn’t load citations"
              : root.resultsQuery !== "" ? "No citations found"
              : "Search the biomedical literature"
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            width: parent.width
            text: root.searching ? root.filterSummary()
              : root.errorText !== "" ? root.errorText
              : root.resultsQuery !== "" ? "Try broader terms, a longer window, or any type"
              : "Choose filters, then search by topic, author, or PMID"
            textFormat: Text.PlainText
            color: root.foreground
            opacity: 0.48
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }
      }

      PanelSeparator {
        width: parent.width
        foreground: root.foreground
      }

      Item {
        width: parent.width
        implicitHeight: Math.max(safetyNote.implicitHeight, keyHints.implicitHeight)

        Text {
          id: safetyNote

          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: "Research only  ·  no patient identifiers"
          textFormat: Text.PlainText
          color: root.foreground
          opacity: 0.46
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          id: keyHints

          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: "↑↓ select  ·  Enter open  ·  Esc close"
          textFormat: Text.PlainText
          color: root.foreground
          opacity: 0.32
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
