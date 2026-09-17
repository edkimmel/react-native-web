/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Documentation drift check.
 *
 * WHY THIS EXISTS. Three separate review passes found the same two doc
 * defects in `STREAMING-SSR.md`, and both survived a full, careful rewrite of
 * that file: the rewrite re-derived the prose from scratch and re-introduced
 * claims the source had already contradicted. A fourth pass found the mirror
 * image — the source carries a heading reading "Why this reports in
 * production too" while the doc called the same warning development-only.
 *
 * Careful reading has now failed on this file more often than it has
 * succeeded, so the claims that keep drifting are asserted here instead. The
 * three defects this file exists to make impossible:
 *
 *   1. the doc described a "missing-anchor fallback" in which the chunk
 *      script creates the anchor. The script has not done that since the
 *      hydration-skew fix; it flags the bucket pending (`else{b.p=1;}`) and
 *      queues it.
 *   2. the doc called the duplicate-shell `console.error` development-only
 *      and "silent in production". `markShellEmitted` has no NODE_ENV guard
 *      and its docblock explains at length why not.
 *   3. the doc said every lower-level CSS API is a no-op or returns `''`
 *      outside a request scope. Only the two delta accessors are scope-gated;
 *      `takeShellHTML()` returns ~13KB outside a scope, and must, because the
 *      non-streaming AppRegistry SSR path depends on it.
 *
 * HOW IT WORKS. Two shapes of check, and it is worth being clear about which
 * is which, because they have very different strength.
 *
 *   MEASURED. The load-bearing checks run the real code and compare the
 *   answer to what the document says. The scope-gating table is parsed out of
 *   the markdown and each row is executed. The delta script is generated and
 *   read. The duplicate-shell warning is provoked with `NODE_ENV=production`
 *   set. These cannot go stale: the measurement is taken fresh every run, and
 *   the assertion is stated in two places (source behaviour and doc prose)
 *   that have to agree.
 *
 *   TEXTUAL. Everything else — symbols named in prose exist on the exported
 *   surface, cited files and cited test names exist, fenced examples parse.
 *   These catch rot, not wrongness: a doc can pass all of them and still
 *   describe behaviour the code does not have.
 *
 * FENCED REGIONS. A few checks need to know *where* in the document a claim
 * lives, so the document marks those regions with
 * `<!-- drift-check: NAME -->` … `<!-- /drift-check -->`. The markers are
 * load-bearing: a missing region fails this suite, so a rewrite cannot
 * quietly drop the region along with the claim it was constraining.
 *
 * THE CEILING, STATED HONESTLY. This cannot check a claim about something it
 * cannot execute. Nothing here verifies the Playwright pass/skip counts (only
 * the number of spec *files*), the "React 19.1 shipped the Suspense-aware
 * preamble" claim (that needs seven npm installs), what a browser does with
 * the emitted CSS, or any sentence of reasoning. It also cannot tell a
 * correct explanation from a plausible one: a paragraph that avoids every
 * forbidden phrase while saying something else untrue passes. What it does
 * guarantee is that the three specific claims above cannot be reintroduced,
 * and that a renamed API or a deleted test stops being citable.
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

import AppRegistry from '../exports/AppRegistry';
import Appearance from '../exports/Appearance';
import Dimensions from '../exports/Dimensions';
import StyleSheet from '../exports/StyleSheet';
import { runInRequestScope } from '../modules/asyncContext';

const PKG_DIR = path.resolve(__dirname, '../..');
const REPO_DIR = path.resolve(PKG_DIR, '../..');
const E2E_DIR = path.join(REPO_DIR, 'packages/streaming-ssr-e2e');

const DOC_FILES = {
  'STREAMING-SSR.md': path.join(PKG_DIR, 'STREAMING-SSR.md'),
  'README.md': path.join(PKG_DIR, 'README.md'),
  'REACT19-FINDINGS.md': path.join(REPO_DIR, 'REACT19-FINDINGS.md')
};

const docs = {};
Object.keys(DOC_FILES).forEach((name) => {
  if (!fs.existsSync(DOC_FILES[name])) {
    throw new Error(
      `${name} is gone. If it was deleted on purpose, drop it from DOC_FILES ` +
        `here and move any claim this file was guarding to wherever the ` +
        `documentation lives now — do not leave the checks pointing at ` +
        `nothing.`
    );
  }
  docs[name] = fs.readFileSync(DOC_FILES[name], 'utf8');
});

/**
 * The text of a `<!-- drift-check: name -->` … `<!-- /drift-check -->`
 * region. Throws rather than returning empty if the region is gone, because
 * "the region disappeared" and "the region is clean" must not look alike.
 */
function region(docName, name) {
  const open = `<!-- drift-check: ${name} -->`;
  const doc = docs[docName];
  const start = doc.indexOf(open);
  if (start === -1) {
    throw new Error(
      `${docName} no longer contains the "${name}" drift-check region. ` +
        `Either restore the ${open} … <!-- /drift-check --> markers around ` +
        `the claim they guard, or delete the check in docs-drift-test.node.js ` +
        `that reads them — do not leave the claim unguarded.`
    );
  }
  const end = doc.indexOf('<!-- /drift-check -->', start);
  if (end === -1) {
    throw new Error(`${docName}: "${name}" region is not closed.`);
  }
  return doc.slice(start + open.length, end);
}

/**
 * Markdown as one line of plain words: emphasis markers removed, whitespace
 * collapsed. Phrase checks run against this, so a claim cannot slip past by
 * being line-wrapped in the middle or by carrying an asterisk — which is
 * exactly how the original "and in production" claim was written.
 */
function flatten(text) {
  return text.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
}

/**
 * Which backticked paths this suite claims jurisdiction over. A citation into
 * an installed package (`react-dom/cjs/react-dom-server.node.development.js`)
 * is deliberately out of scope: those files live in installs the repo does not
 * own, so a check reading them would pass or fail on whatever happens to be in
 * `node_modules`.
 */
const REPO_LOCAL =
  /(^packages\/|^src\/|^configs\/|^scripts\/|^specs\/|-test\.node\.js$|-test\.js$|\.spec\.js$)/;

/** Every file in the repo, excluding node_modules, as absolute paths. */
const repoFiles = (() => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(REPO_DIR);
  return out;
})();

/**
 * Repo files a citation could mean. The docs cite tests the way a person says
 * them — `styleInjection/index-test.node.js` for a file that actually lives at
 * `src/modules/styleInjection/__tests__/index-test.node.js` — so a citation
 * matches when its basename matches and its remaining segments appear in the
 * path in that order. Interposed directories (`__tests__`) are allowed;
 * reordered or absent ones are not.
 */
function filesMatching(citation) {
  const wanted = citation.split('/').filter(Boolean);
  const base = wanted.pop();
  return repoFiles.filter((file) => {
    const parts = file.split(path.sep);
    if (parts.pop() !== base) return false;
    let at = 0;
    return wanted.every((segment) => {
      const found = parts.indexOf(segment, at);
      if (found === -1) return false;
      at = found + 1;
      return true;
    });
  });
}

// ---------------------------------------------------------------------------
// MEASURED — these run the code the prose describes.
// ---------------------------------------------------------------------------

describe('claims measured against the running code', () => {
  // Something of our own in the sheet, so the shell is non-empty for reasons
  // this file controls rather than because of RNW's built-in reset rules.
  beforeAll(() => {
    StyleSheet.create({ driftProbe: { color: 'rgb(3, 5, 7)' } });
  });

  /**
   * ADVERSARIAL-REVIEW.md #9 / ADVERSARIAL-REVIEW-2.md #8, twice-written and
   * twice-wrong: "All of these are no-ops or return `''` outside a request
   * scope". The document now carries the answer as a table instead of a
   * sentence, and the table is executed here. Verdicts are a closed set: an
   * unrecognised one fails rather than being skipped, so the table cannot be
   * softened into prose this check no longer understands.
   */
  test('the scope-gating table matches what the APIs do outside a scope', () => {
    const calls = {
      'StyleSheet.takeShellHTML()': () => StyleSheet.takeShellHTML(),
      'StyleSheet.takeShellGroups()': () => StyleSheet.takeShellGroups(),
      'StyleSheet.takeDeltaHTML()': () => StyleSheet.takeDeltaHTML(),
      'StyleSheet.takeRequestDelta()': () => StyleSheet.takeRequestDelta()
    };
    const verdicts = {
      "`''`": (value) => value === '',
      'the whole shell, same as inside a scope': (value) => value.length > 0
    };

    const rows = [];
    const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/gm;
    const table = region('STREAMING-SSR.md', 'scope-gating');
    let match;
    while ((match = rowPattern.exec(table)) != null) {
      rows.push([match[1], match[2]]);
    }
    expect(rows.length).toBe(Object.keys(calls).length);

    rows.forEach(([api, verdict]) => {
      if (calls[api] == null) {
        throw new Error(
          `the scope-gating table names ${api}, which this check does not ` +
            `know how to call. Add it to \`calls\` in docs-drift-test.node.js.`
        );
      }
      if (verdicts[verdict] == null) {
        throw new Error(
          `the scope-gating table answers "${verdict}" for ${api}. The ` +
            `recognised answers are ${Object.keys(verdicts).join(' / ')}.`
        );
      }
      // No request scope here: this is the whole point of the table.
      const value = calls[api]();
      if (!verdicts[verdict](value)) {
        throw new Error(
          `STREAMING-SSR.md says ${api} outside a request scope returns ` +
            `"${verdict}". It actually returned ` +
            `${JSON.stringify(value).slice(0, 80)} (length ${value.length}).`
        );
      }
    });
  });

  /**
   * ADVERSARIAL-REVIEW.md #4 / ADVERSARIAL-REVIEW-2.md #2, the defect that
   * survived a rewrite of its own paragraph. The measurement is the emitted
   * script itself: it contains the pending marker and no DOM-creating call.
   * While that holds, no document may describe the deleted fallback.
   */
  test('the delta script queues rather than creating a missing anchor', () => {
    const script = runInRequestScope(() => {
      // Shell first, so what follows is a delta rather than shell content.
      StyleSheet.takeShellHTML();
      StyleSheet.create({ driftDelta: { color: 'rgb(11, 13, 17)' } });
      return StyleSheet.takeDeltaHTML();
    });

    expect(script).toMatch(/^<script/);
    // The measured fact, both halves. If either flips, the doc rule below is
    // no longer the right rule and this test is the place to find that out.
    expect(script).not.toMatch(
      /createElement|appendChild|insertBefore|insertAdjacent|\.after\(|\.before\(/
    );
    expect(script).toContain('else{b.p=1;}');

    const forbidden = [
      /missing-anchor fallback/i,
      /creates the anchor itself/i,
      /the script creates the anchor/i,
      /creates the missing anchor/i,
      /rather than drop the rules/i
    ];
    ['STREAMING-SSR.md', 'README.md'].forEach((name) => {
      forbidden.forEach((pattern) => {
        if (pattern.test(docs[name])) {
          throw new Error(
            `${name} describes a missing-anchor fallback (matched ${pattern}), ` +
              `but the emitted delta script creates nothing — it sets ` +
              `\`b.p=1\` and queues the payload for the client runtime. ` +
              `See "The missing anchor: queue, never create" in ` +
              `src/exports/StyleSheet/index.js.`
          );
        }
      });
    });

    // And the guide must quote the marker it explains, so that changing the
    // source spelling forces a look at the paragraph describing it — and so
    // that a rewrite cannot drop the explanation and leave nothing behind.
    if (!docs['STREAMING-SSR.md'].includes('else{b.p=1;}')) {
      throw new Error(
        `STREAMING-SSR.md no longer quotes \`else{b.p=1;}\`, the marker the ` +
          `delta script sets when a group has no anchor. That paragraph is ` +
          `the one four reviews have found wrong; it has to say what the ` +
          `script actually does, and quote it.`
      );
    }
  });

  /**
   * ADVERSARIAL-REVIEW-2.md #3. Provoked with NODE_ENV forced to production,
   * because "development-only" is a claim about exactly that. The repo writes
   * dev-only warnings as `if (process.env.NODE_ENV !== 'production')`, which
   * is read at call time, so adding one here makes this test fail rather than
   * making the doc quietly right again.
   */
  test('the duplicate-shell warning fires in production, and is documented that way', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let messages;
    try {
      runInRequestScope(() => {
        StyleSheet.takeShellGroups();
        StyleSheet.takeShellGroups();
      });
      // Read the calls out BEFORE restoring: `mockRestore` resets them.
      messages = spy.mock.calls.map((args) => String(args[0]));
    } finally {
      process.env.NODE_ENV = previous;
      spy.mockRestore();
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      /serialised the stylesheet shell more than once/
    );

    const text = flatten(region('STREAMING-SSR.md', 'duplicate-shell'));
    const forbidden = [
      /development-only/i,
      /dev-only/i,
      /only in development/i,
      /\bsilent\b[^.]{0,80}\bin production\b/i,
      /\bin production\b[^.]{0,80}\bis silent\b/i,
      /\band in production\b/i
    ];
    forbidden.forEach((pattern) => {
      if (pattern.test(text)) {
        throw new Error(
          `STREAMING-SSR.md calls the duplicate-shell warning ` +
            `development-only (matched ${pattern}), but it was just observed ` +
            `firing with NODE_ENV=production. \`markShellEmitted\` has no ` +
            `NODE_ENV guard, deliberately — see "Why this reports in ` +
            `production too" in src/exports/StyleSheet/index.js.`
        );
      }
    });
    // And it must still say the thing that IS true of the scope gate.
    expect(text).toMatch(/outside a request scope/i);
  });

  /**
   * The one scope claim the delta accessors do make, measured from the other
   * side: inside a scope with nothing new compiled, `takeDeltaHTML` is empty.
   */
  test("takeDeltaHTML returns '' when there is nothing new", () => {
    const empty = runInRequestScope(() => {
      StyleSheet.takeShellHTML();
      return StyleSheet.takeDeltaHTML();
    });
    expect(empty).toBe('');
    expect(docs['STREAMING-SSR.md']).toMatch(
      /Returns `''` when there is nothing new/
    );
  });
});

// ---------------------------------------------------------------------------
// TEXTUAL — these catch rot: renamed symbols, deleted tests, unparseable
// examples. They do not and cannot check that a sentence is true.
// ---------------------------------------------------------------------------

describe('references in the docs still resolve', () => {
  /**
   * Every `Namespace.member` the docs name in code voice has to be on the
   * real object. This is the check that turns a rename into a failing test
   * instead of a support question.
   */
  test('every API symbol named in the docs exists on the exported surface', () => {
    const namespaces = { AppRegistry, Appearance, Dimensions, StyleSheet };
    const named = new Set();
    const pattern =
      /`(StyleSheet|AppRegistry|Appearance|Dimensions)\.([A-Za-z_$][\w$]*)/g;
    Object.keys(docs).forEach((name) => {
      let match;
      while ((match = pattern.exec(docs[name])) != null) {
        named.add([name, match[1], match[2]].join('|'));
      }
    });
    expect(named.size).toBeGreaterThan(8);

    const missing = [];
    named.forEach((entry) => {
      const [doc, ns, member] = entry.split('|');
      if (namespaces[ns][member] === undefined) {
        missing.push(`${doc} names ${ns}.${member}, which does not exist`);
      }
    });
    expect(missing).toEqual([]);
  });

  /**
   * The named imports the "Entry points" example shows must be exactly what
   * the two entry points export. This is the check the `exports`-map work
   * would have wanted: the guide is the first thing a consumer copies.
   */
  test('the entry-point example imports names that exist', () => {
    const entries = [
      [/from 'react-native-web\/server'/, require('../server')],
      [/from 'react-native-web'/, require('../index')]
    ];
    const blocks = docs['STREAMING-SSR.md'].match(/```js\n[\s\S]*?```/g) || [];
    const example = blocks.find((block) =>
      /react-native-web\/server/.test(block)
    );
    expect(example).toBeDefined();

    entries.forEach(([fromPattern, module]) => {
      const importPattern = new RegExp(
        `import\\s*\\{([^}]*)\\}\\s*${fromPattern.source}`
      );
      const found = importPattern.exec(example);
      expect(found).not.toBeNull();
      found[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => {
          if (module[name] === undefined) {
            throw new Error(
              `the Entry points example imports { ${name} } from a module ` +
                `that does not export it.`
            );
          }
        });
    });
  });

  /**
   * ADVERSARIAL-REVIEW-2.md #9: `REACT19-FINDINGS.md` cited a test name that
   * has never existed. A citation written `` `file.js › test name` `` is
   * checked against the file.
   */
  test('every cited test name exists in the file it is cited from', () => {
    const pattern =
      /`([\w./-]+(?:-test\.node|-test|\.spec)\.js)\s*›\s*([^`]+)`/g;
    const citations = [];
    Object.keys(docs).forEach((name) => {
      let match;
      while ((match = pattern.exec(docs[name])) != null) {
        citations.push([name, match[1], match[2].replace(/\s+/g, ' ').trim()]);
      }
    });
    expect(citations.length).toBeGreaterThan(0);

    citations.forEach(([doc, file, title]) => {
      const candidates = filesMatching(file);
      if (candidates.length === 0) {
        throw new Error(`${doc} cites ${file}, which does not exist.`);
      }
      const found = candidates.some((candidate) =>
        fs.readFileSync(candidate, 'utf8').replace(/\s+/g, ' ').includes(title)
      );
      if (!found) {
        throw new Error(
          `${doc} cites a test named "${title}" in ${file}. No test in that ` +
            `file has that name.`
        );
      }
    });
  });

  /**
   * Repo-local file citations. Third-party paths (`react-dom/cjs/…`) are out
   * of scope deliberately: they live in installs this suite has no claim on.
   */
  test('every repo-local file the docs cite exists', () => {
    const pattern = /`([\w][\w./-]*\.(?:js|json|md|yml))`/g;
    const cited = new Set();
    Object.keys(docs).forEach((name) => {
      let match;
      while ((match = pattern.exec(docs[name])) != null) {
        if (REPO_LOCAL.test(match[1])) cited.add([name, match[1]].join('|'));
      }
    });
    expect(cited.size).toBeGreaterThan(5);

    const missing = [];
    cited.forEach((entry) => {
      const [doc, file] = entry.split('|');
      if (filesMatching(file).length === 0)
        missing.push(`${doc} cites ${file}`);
    });
    expect(missing).toEqual([]);
  });

  /**
   * A `path.js:120` or `path.js:120-140` reference has to point into a file
   * that is at least that long. This is the weakest check here — it says
   * nothing about what is ON the line — but it does catch a citation into a
   * file that has since been deleted or halved.
   */
  test('every file:line reference points inside the file', () => {
    const pattern = /`([\w][\w./-]*\.js):(\d+)(?:-(\d+))?`/g;
    const problems = [];
    Object.keys(docs).forEach((name) => {
      let match;
      while ((match = pattern.exec(docs[name])) != null) {
        const [, file, from, to] = match;
        if (!REPO_LOCAL.test(file)) continue;
        const candidates = filesMatching(file);
        if (candidates.length === 0) {
          problems.push(`${name} cites ${file}:${from}, which does not exist`);
          continue;
        }
        const longest = Math.max(
          ...candidates.map(
            (candidate) => fs.readFileSync(candidate, 'utf8').split('\n').length
          )
        );
        const last = Number(to || from);
        if (last > longest) {
          problems.push(
            `${name} cites ${file}:${match[2]}${to ? '-' + to : ''}, but the ` +
              `file is only ${longest} lines long`
          );
        }
      }
    });
    expect(problems).toEqual([]);
  });

  /**
   * The consumer-facing guide's examples have to be syntactically real.
   * `REACT19-FINDINGS.md` is excluded on purpose: it is an investigation log
   * whose snippets are elided with `…`.
   */
  test('every fenced JS example in the guide parses', () => {
    const failures = [];
    ['STREAMING-SSR.md', 'README.md'].forEach((name) => {
      const pattern = /```(jsx?|javascript)\n([\s\S]*?)```/g;
      let match;
      let index = 0;
      while ((match = pattern.exec(docs[name])) != null) {
        index += 1;
        try {
          parser.parse(match[2], {
            sourceType: 'module',
            plugins: ['jsx', 'flow']
          });
        } catch (error) {
          failures.push(`${name} example ${index}: ${error.message}`);
        }
      }
      expect(index).toBeGreaterThan(0);
    });
    expect(failures).toEqual([]);
  });

  /**
   * The spec-file count in the guide, against the directory. The ceiling is
   * stated in the doc itself: this counts FILES. A test added inside an
   * existing spec file does not trip it, and the per-version pass/skip counts
   * in the table below it are not checkable without running the matrix.
   */
  test('the guide states the number of Playwright spec files there are', () => {
    const specs = fs
      .readdirSync(path.join(E2E_DIR, 'specs'))
      .filter((file) => file.endsWith('.spec.js'));
    const claim = /\*\*(\d+) spec files\*\*/.exec(
      region('STREAMING-SSR.md', 'spec-files')
    );
    expect(claim).not.toBeNull();
    expect(Number(claim[1])).toBe(specs.length);
  });
});
