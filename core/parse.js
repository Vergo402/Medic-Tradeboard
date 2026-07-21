/**
 * W2W tradeboard HTML parser.
 * Parses monthly tradeboard grids and extracts shift entries.
 */

const KIND = {
  "*": "open",
  "#": "trade_post",
  "!": "my_post",
  "$": "my_shift",
};

/**
 * Decode HTML entities including named (&amp;, &lt;, etc.) and numeric (&#NNN;, &#xHH;).
 */
function decodeHtmlEntities(s) {
  const map = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    apos: "'",
    nbsp: " ",
  };

  return s
    .replace(/&([a-z]+);/gi, (match, name) => {
      const lower = name.toLowerCase();
      return lower in map ? map[lower] : match;
    })
    .replace(/&#(\d+);/g, (match, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Clean shift text: strip tags, unescape HTML entities, collapse whitespace.
 */
function clean(s) {
  // Remove HTML tags
  let cleaned = s.replace(/<[^>]+>/g, " ");
  // Unescape HTML entities
  cleaned = decodeHtmlEntities(cleaned);
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

/**
 * Parse a single month of tradeboard HTML.
 * @param {string} html - The HTML content
 * @param {number} year - Year (e.g., 2026)
 * @param {number} month - Month 1-12
 * @returns {{records: Array, anchors: number}} - Parsed records and anchor count
 */
export function parseMonth(html, year, month) {
  const records = [];

  // Regex for <td> elements
  const tdRegex = /<td\b[^>]*>[\s\S]*?<\/td>/g;

  // Regex for three-branch alternation in shift groups:
  // 1. Position header: <div class="skh"...>POSITION</div>
  // 2. Time range: class="shiftgroup">HH:MM - HH:MM
  // 3. Anchor: onClick="return CCL(this,'MARKER+ID')"...class="CSS">TEXT</a>
  // Note: text can contain HTML tags (e.g., <b>name</b>), so we use [\s\S]*? not [^<]*
  // The anchor branch matches on[Cc]lick: raw W2W HTML writes onClick=, but the
  // "dom" scan strategy feeds SERIALIZED DOM, where Chrome lowercases attribute
  // names to onclick=. Both forms must be matched here since callers can feed
  // this parser either raw HTML or serialized DOM.
  const innerRegex =
    /<div class="skh"[^>]*>([\s\S]*?)<\/div>|class="shiftgroup">(\d{1,2}:\d{2}) - (\d{1,2}:\d{2})|on[Cc]lick="return CCL\(this,'([*#!$])(\d+)'\)"[^>]*class="(\w+)">([\s\S]*?)<\/a>/g;

  // Anchor count regex (for drift detection)
  const anchorRegex = /CCL\(this,'[*#!$]\d+'\)/g;

  // Extract all <tr> rows
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let trMatch;
  let currentDays = null;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowContent = trMatch[1];
    const tds = [];
    let tdMatch;

    // Extract all <td> from this row
    while ((tdMatch = tdRegex.exec(rowContent)) !== null) {
      tds.push(tdMatch[0]);
    }

    if (tds.length === 0) continue;

    // Check if this is a day-number row (class="dnum")
    if (tds.some((td) => td.includes('class="dnum"'))) {
      const days = tds.map((td) => {
        const cleaned = clean(td);
        return /^\d+$/.test(cleaned) ? parseInt(cleaned, 10) : null;
      });
      if (days.length === 7) {
        currentDays = days;
      }
      continue;
    }

    // Check if this is a content row (class="week")
    if (tds.some((td) => td.includes('class="week'))) {
      if (!currentDays || tds.length !== 7) {
        continue;
      }

      // Process each cell in this content row
      for (let idx = 0; idx < tds.length; idx++) {
        const td = tds[idx];
        if (!td.includes('class="week') || currentDays[idx] === null) {
          continue;
        }

        const day = currentDays[idx];
        let pos = null;
        let t1 = null;
        let t2 = null;

        // Reset regex for this cell
        innerRegex.lastIndex = 0;
        let match;
        while ((match = innerRegex.exec(td)) !== null) {
          if (match[1] !== undefined) {
            // Position header
            pos = clean(match[1]);
          } else if (match[2] !== undefined) {
            // Time range
            t1 = match[2];
            t2 = match[3];
          } else if (match[4] !== undefined) {
            // Anchor (marker and id defined)
            const marker = match[4];
            const id = match[5];
            const cls = match[6];
            const text = match[7];

            records.push({
              date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
              start: t1,
              end: t2,
              position: pos,
              kind: KIND[marker],
              w2w_id: id,
              css: cls,
              text: clean(text),
            });
          }
        }
      }
    }
  }

  // Count anchors for drift detection
  const anchors = (html.match(anchorRegex) || []).length;

  return { records, anchors };
}

/**
 * Merge records from multiple months, deduping by w2w_id (first occurrence wins)
 * and sorting by (date, start || "").
 * @param {Array<Array>} perMonthRecords - Array of record arrays
 * @returns {Array} - Merged, deduped, sorted records
 */
export function mergeMonths(perMonthRecords) {
  const all = [];
  const seen = new Set();

  // Flatten and dedupe by w2w_id (first occurrence wins)
  for (const monthRecords of perMonthRecords) {
    for (const record of monthRecords) {
      if (!seen.has(record.w2w_id)) {
        seen.add(record.w2w_id);
        all.push(record);
      }
    }
  }

  // Sort by (date, start || "")
  all.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    const aStart = a.start || "";
    const bStart = b.start || "";
    if (aStart < bStart) return -1;
    if (aStart > bStart) return 1;
    return 0;
  });

  return all;
}

/**
 * Check for schema drift: records == 0 while anchors > 0.
 * @param {{records: Array, anchors: number}} parseResult - Result from parseMonth
 * @returns {boolean} - True if drift detected
 */
export function driftCheck(parseResult) {
  return parseResult.records.length === 0 && parseResult.anchors > 0;
}
