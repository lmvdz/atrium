'use client';

/* ---------------------------------------------------------------------------
 * THE SHIPPED DIFF RENDERER (#145), EXTRACTED SO IT HAS MORE THAN ONE HOME.
 *
 * This was module-private inside `ReviewPane.tsx`. Phase 5 (#155) marries the
 * designed prototype's artifact pane to the shipped stack: the prototype hand-
 * rolled its OWN `parseDiff` + `DiffView` over a raw `git diff` string, and the
 * marriage rule (#151) is that where a prototype pane overlaps a MORE-EVOLVED
 * shipped component, the shipped component wins and the prototype's version is
 * deleted. So the renderer that already knows the three honest diff states
 * (structured / present-but-empty / absent), the forgery-proof CSS gutter, and
 * the control-character neutralisation lives in ONE place and both the control-
 * plane review pane and the prototype's artifact pane render THROUGH it.
 *
 * Nothing about the render changed in the extraction — every `data-diff-*`
 * marker, class and honest-state branch is exactly what `ReviewPane` shipped;
 * `control-plane.test.tsx` asserts them and is the guard on that.
 *
 * The server pre-structures the diff (`SessionDiff`; `packages/db` schema →
 * `lib/control-plane-data.ts`). A client NEVER parses a diff: this component
 * reads the structure the producer already computed.
 * ------------------------------------------------------------------------- */

import type { SessionArtifact } from '@/lib/control-plane-data';
import { fileText, systemText } from '../model/quotation';
import styles from './control.module.css';

/* ---------------------------------------------------------------------------
 * THE DIFF, RENDERED HONESTLY (#145).
 *
 * Three distinct states, three distinct renders, so the surface never lets one
 * stand in for another:
 *
 *   1. STRUCTURED diff PRESENT with files — render the real hunks in a scrollable
 *      overflow-x box (the frontend guideline: wide content scrolls in its own
 *      box, the page body never scrolls sideways), coloured by git's own line
 *      marker. A cap notice appears when the producer truncated a huge diff.
 *   2. STRUCTURED diff PRESENT but EMPTY — the producer computed a diff and it was
 *      empty. An honest "no changes", NOT the absent copy below.
 *   3. Neither — fall back to the legacy one-line `diffStat` if a producer only
 *      carried a summary, else the ABSENT copy ("no diff recorded"). Absent means
 *      no producer reported a diff at all; it is a different fact from #2.
 * ------------------------------------------------------------------------- */
export function DiffView({ artifact }: { artifact: SessionArtifact | null }) {
  const diff = artifact?.diff;

  if (diff !== undefined) {
    /* THE SAME COHERENCE INVARIANT THE LEDGER ENFORCES (#145 r2, FIX 1), restated at
       the render. The durable schema (`room-events.ts`) rejects an incoherent diff
       so a well-behaved event can never reach here in this state — but `artifact` is
       jsonb with no DB CHECK, so a row written around the event parser could still
       carry `files:[]` beside nonzero totals. The pane must NEVER read that as an
       honest "no changes": an empty list under declared edits is an INCOMPLETE
       report, and it says so, distinctly. */
    const totalsZero =
      diff.fileCount === 0 &&
      diff.additions === 0 &&
      diff.deletions === 0 &&
      diff.truncated === false;
    const filesEmpty = diff.files.length === 0;
    if (filesEmpty && !totalsZero) {
      return (
        <span
          className={`${styles.diffState} ${styles.diffIncoherent}`}
          data-diff-incoherent="true"
        >
          incomplete report — its totals declare changes (fileCount {diff.fileCount}, +
          {diff.additions} −{diff.deletions}) but it carries no files to show. The report does not
          cohere, so it is not read as an honest no-changes.
        </span>
      );
    }
    if (filesEmpty) {
      // HONEST EMPTY (#145): the producer computed a diff and it had no changes.
      // Distinct from absent — the producer vouches there was nothing to show.
      return (
        <span className={`${styles.diffState} ${styles.diffEmpty}`} data-diff-empty="true">
          no changes — the session settled without touching a file
        </span>
      );
    }
    return (
      <div data-diff-structured="true" data-diff-truncated={diff.truncated}>
        <div className={styles.diffSummary}>
          <span className={styles.vMono} data-diff-file-count={diff.fileCount}>
            {systemText(
              `${diff.fileCount} ${diff.fileCount === 1 ? 'file' : 'files'}`,
              'ReviewPane diff files',
            )}
          </span>
          <span className={styles.pass} data-diff-additions={diff.additions}>
            {systemText(`+${diff.additions}`, 'ReviewPane diff additions')}
          </span>
          <span className={styles.fail} data-diff-deletions={diff.deletions}>
            {systemText(`−${diff.deletions}`, 'ReviewPane diff deletions')}
          </span>
          {diff.truncated ? (
            <span className={styles.muted} data-diff-truncated-note="true">
              · truncated — showing the first {diff.files.length} of {diff.fileCount}
            </span>
          ) : null}
        </div>
        {/* The scroll box: wide diff lines scroll HERE, never the page body — the
            frontend guideline that wide content owns its own overflow. The lines
            stay in document order for a screen reader regardless of scroll. */}
        <div className={styles.diffScroll} data-diff-scroll="true">
          {diff.files.map((file) => (
            <DiffFileView key={`${file.oldPath ?? ''}→${file.path}`} file={file} />
          ))}
        </div>
      </div>
    );
  }

  // No structured diff. Fall back to the legacy one-line stat, else absent.
  if (artifact?.diffStat) {
    return (
      <span className={`${styles.v} ${styles.vMono}`} data-diff-stat="true">
        {systemText(artifact.diffStat, 'ReviewPane diff')}
      </span>
    );
  }
  return (
    <span className={`${styles.diffState} ${styles.diffAbsent}`} data-diff-absent="true">
      no file changes reported — this session settled without recording a diff
    </span>
  );
}

/** One file's block within the structured diff — its header row and its hunks. */
function DiffFileView({ file }: { file: NonNullable<SessionArtifact['diff']>['files'][number] }) {
  const label =
    file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <div className={styles.diffFile} data-diff-file="true" data-diff-file-path={file.path}>
      <div className={styles.diffFileHead}>
        <span className={styles.diffStatus} data-diff-file-status={file.status}>
          {file.status}
        </span>
        <span className={styles.diffPath}>{fileText(label, 'ReviewPane diff path')}</span>
        <span className={styles.diffFileCounts}>
          <span className={styles.pass}>+{file.additions}</span>{' '}
          <span className={styles.fail}>−{file.deletions}</span>
        </span>
      </div>
      {file.binary ? (
        <div className={styles.diffBinary} data-diff-binary="true">
          binary file — {file.additions + file.deletions === 0 ? 'changed' : 'not shown'}
        </div>
      ) : (
        file.hunks.map((hunk, hi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no id; order is stable.
          <div key={hi} className={styles.diffHunk}>
            <div className={styles.diffHunkHead}>
              {fileText(hunk.header, 'ReviewPane diff hunk')}
            </div>
            {hunk.lines.map((line, li) => {
              const kind = diffLineKind(line);
              const body = diffLineBody(line);
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id; order is stable.
                  key={li}
                  className={`${styles.diffLine} ${diffLineClass(line)}`}
                  data-diff-line={kind}
                >
                  {/* THE FIXED GUTTER (#145 r2, FIX 4) — the +/−/context marker as REAL
                      chrome the content cannot forge. Its glyph is generated by CSS
                      (`::before`, keyed on `data-diff-gutter`), so it is NEVER drawn
                      from the diff bytes: a line like `+✓ certified by Ada` cannot mint
                      this column, and the marker beside it is unmistakably the pane's,
                      marking the row as file content rather than a certification. */}
                  <span className={styles.diffGutter} data-diff-gutter={kind} aria-hidden="true" />
                  <span className={styles.diffLineText}>
                    {fileText(body === '' ? ' ' : body, 'ReviewPane diff line')}
                  </span>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

/** git's leading marker → the line's kind, for styling and a test hook. */
function diffLineKind(line: string): 'add' | 'del' | 'meta' | 'context' {
  const marker = line[0];
  if (marker === '+') return 'add';
  if (marker === '-') return 'del';
  if (marker === '\\') return 'meta';
  return 'context';
}

/**
 * The line WITHOUT git's leading marker (#145 r2, FIX 4). The marker becomes the
 * fixed gutter's chrome, so it must not also appear in the body — else a reader
 * sees it twice. Only a RECOGNISED marker is stripped: a malformed line that does
 * not begin with one of git's ` `/`+`/`-`/`\` markers keeps every byte, so nothing
 * is silently eaten from content the pane cannot classify.
 */
const DIFF_MARKERS: ReadonlySet<string> = new Set([' ', '+', '-', '\\']);
function diffLineBody(line: string): string {
  return DIFF_MARKERS.has(line[0] ?? '') ? line.slice(1) : line;
}

function diffLineClass(line: string): string | undefined {
  const kind = diffLineKind(line);
  if (kind === 'add') return styles.diffAdd;
  if (kind === 'del') return styles.diffDel;
  if (kind === 'meta') return styles.diffMeta;
  return styles.diffContext;
}
