#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * =============================================================================
 * Character-set guard - fails on undeclared non-ASCII in test and db sources
 * =============================================================================
 *   node db/check-charset.js        # exit 0 clean, exit 1 on a finding
 *
 * WHY THIS EXISTS
 * A Cyrillic small letter o (U+043E) is visually identical to a Latin o
 * (U+006F) in every editor and in every diff. A test tag containing one
 * passes review, passes lint, and runs - it simply is not the string anyone
 * believes it is. That happened in this repository: three Cyrillic homoglyphs
 * (U+0435, U+043E, U+0440) were typed into a test fixture tag and were found
 * only because someone happened to scan for non-ASCII.
 *
 * A check that depends on someone remembering to run it is not a control.
 *
 * HOW IT IS SCOPED - and this is the important part
 * The allowlist is of CODEPOINTS, not of files.
 *
 * A file allowlist would have been the obvious approach: schema.test.js
 * legitimately contains an e-with-acute fixture for the accent-sensitivity
 * assertions, so exempt that file. But that exempts the file from the whole
 * check, and schema.test.js is precisely where a homoglyph would do the most
 * damage - an accent test whose "e" was Cyrillic would assert nothing while
 * looking exactly right.
 *
 * So instead: every non-ASCII codepoint in scope must appear in ALLOWED below,
 * with a reason. Anything else fails, wherever it appears. Adding a
 * legitimately-needed character is a deliberate one-line change with a
 * justification attached, which is the behaviour we want.
 * =============================================================================
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Directories scanned, relative to Backend/.
//
// Scoped to the two trees V2 named. Both are where correctness-critical string
// literals live: test fixtures and assertions, and the schema/guard scripts.
// Widening this to routes/ and middleware/ is a one-line change and is worth
// doing when Phase 3 starts writing route code, but those files currently
// contain non-ASCII in user-facing strings (checkmarks and arrows in console
// output) that would need declaring first.
const SCAN_DIRS = ['test', 'db'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.sql']);

/**
 * Codepoints permitted anywhere in scope. Each needs a reason.
 * Written numerically so this file itself stays pure ASCII.
 */
const ALLOWED = new Map([
  [
    0x00e9,
    'LATIN SMALL LETTER E WITH ACUTE - "jose" vs "jose with acute" is the ' +
      'fixture pair that proves users.email is accent-SENSITIVE (B1a).',
  ],
]);

/** Codepoints that look like ASCII letters and are the reason this check exists. */
const KNOWN_CONFUSABLES = new Map([
  [0x0435, 'CYRILLIC SMALL LETTER IE  - looks identical to Latin "e"'],
  [0x043e, 'CYRILLIC SMALL LETTER O   - looks identical to Latin "o"'],
  [0x0440, 'CYRILLIC SMALL LETTER ER  - looks identical to Latin "p"'],
  [0x0430, 'CYRILLIC SMALL LETTER A   - looks identical to Latin "a"'],
  [0x0441, 'CYRILLIC SMALL LETTER ES  - looks identical to Latin "c"'],
  [0x0445, 'CYRILLIC SMALL LETTER HA  - looks identical to Latin "x"'],
  [0x0456, 'CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I - looks like "i"'],
  [0x03bf, 'GREEK SMALL LETTER OMICRON - looks identical to Latin "o"'],
  [0x0391, 'GREEK CAPITAL LETTER ALPHA - looks identical to Latin "A"'],
  [0x00a0, 'NO-BREAK SPACE            - looks identical to a space'],
  [0x200b, 'ZERO WIDTH SPACE          - invisible'],
  [0x200e, 'LEFT-TO-RIGHT MARK        - invisible'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE - invisible (stray BOM)'],
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, out);
    } else if (SCAN_EXTENSIONS.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

function describe(cp) {
  if (KNOWN_CONFUSABLES.has(cp)) return KNOWN_CONFUSABLES.get(cp);
  return 'not in the allowlist';
}

function main() {
  const root = path.resolve(__dirname, '..');
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(root, d)));

  const findings = [];
  let scanned = 0;
  let allowedSeen = 0;

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;

    let line = 1;
    let col = 1;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (ch === '\n') {
        line += 1;
        col = 1;
        continue;
      }
      if (cp > 127) {
        if (ALLOWED.has(cp)) {
          allowedSeen += 1;
        } else {
          findings.push({
            file: path.relative(root, file),
            line,
            col,
            cp,
            why: describe(cp),
          });
        }
      }
      col += 1;
    }
  }

  console.log(`\nCharacter-set guard: ${scanned} file(s) in ${SCAN_DIRS.join(', ')}`);

  if (findings.length === 0) {
    console.log(
      `  clean - no undeclared non-ASCII (${allowedSeen} allowlisted occurrence(s) seen)\n`
    );
    process.exit(0);
  }

  console.error(`\n  ${findings.length} undeclared non-ASCII character(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}:${f.col}`);
    console.error(`      U+${f.cp.toString(16).toUpperCase().padStart(4, '0')}  ${f.why}`);
  }
  console.error('');
  console.error('  If the character is genuinely needed, add its codepoint to ALLOWED');
  console.error('  in db/check-charset.js with a reason. Otherwise it is almost');
  console.error('  certainly a homoglyph typed by accident - replace it with the ASCII');
  console.error('  letter it resembles.\n');
  process.exit(1);
}

main();
