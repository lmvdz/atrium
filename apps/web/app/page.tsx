import styles from './shell.module.css';

/**
 * The three-region shell. This is placeholder content over the real
 * information architecture (init.md §3): Conversation on the left, what the
 * group now understands in the middle, what needs *you* on the right.
 *
 * Every fact rendered here carries its epistemic marking — `✓` accepted,
 * `~` proposed-but-unaccepted — because a claim never dresses as a fact. When
 * live data lands it replaces the fixtures below; the grammar does not change.
 */

const messages = [
  {
    id: 'm1',
    at: '10:02',
    author: 'alex',
    body: 'Scaffold is up. Compose brings postgres + minio.',
  },
  { id: 'm2', at: '10:04', author: 'sam', body: 'I will wire the flag into the server today.' },
  { id: 'm3', at: '10:07', author: 'alex', body: 'Do we keep the flag after launch?' },
];

const state = [
  {
    id: 's1',
    kind: 'decision',
    mark: '✓',
    text: 'Self-host on one VPS; identical compose stack locally.',
  },
  {
    id: 's2',
    kind: 'commitment',
    mark: '✓',
    text: 'sam — wire the flag into the server (due today).',
  },
  { id: 's3', kind: 'open question', mark: '✓', text: 'Do we keep the flag after launch?' },
  {
    id: 's4',
    kind: 'claim',
    mark: '~',
    text: 'sam says the migration is reversible — unverified.',
  },
];

const attention = [
  {
    id: 'a1',
    label: 'open question',
    text: 'Do we keep the flag after launch?',
    rationale: 'needs you specifically — you opened the question and nobody else can settle it',
  },
];

export default function HomePage() {
  return (
    <main className={styles.regions}>
      <section
        className={styles.region}
        aria-labelledby="region-conversation"
        data-region="conversation"
      >
        <h2 className={styles.regionTitle} id="region-conversation">
          Conversation
        </h2>
        <p className={styles.regionNote}>What people and agents are saying.</p>
        <ol className={styles.feed}>
          {messages.map((message) => (
            <li className={styles.message} key={message.id}>
              <span className={styles.timestamp}>{message.at}</span>
              <span className={styles.author}>{message.author}</span>
              <span className={styles.body}>{message.body}</span>
            </li>
          ))}
        </ol>
        <div className={styles.composer} aria-hidden="true">
          message #scaffold…
        </div>
      </section>

      <section
        className={styles.region}
        aria-labelledby="region-current-state"
        data-region="current-state"
      >
        <h2 className={styles.regionTitle} id="region-current-state">
          Current state
        </h2>
        <p className={styles.regionNote}>What the group now understands and is committed to.</p>
        <ul className={styles.stateList}>
          {state.map((item) => (
            <li className={styles.stateItem} key={item.id}>
              <span
                className={item.mark === '✓' ? styles.markAccepted : styles.markProposed}
                title={item.mark === '✓' ? 'accepted' : 'proposed — not yet accepted'}
              >
                {item.mark}
              </span>
              <span className={styles.stateKind}>{item.kind}</span>
              <span className={styles.stateText}>{item.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.region} aria-labelledby="region-needs-you" data-region="needs-you">
        <h2 className={styles.regionTitle} id="region-needs-you">
          Needs you
        </h2>
        <p className={styles.regionNote}>What specifically requires this person.</p>
        <ul className={styles.attentionList}>
          {attention.map((item) => (
            <li className={styles.attentionItem} key={item.id}>
              <span className={styles.attentionLabel}>{item.label}</span>
              <span className={styles.attentionText}>{item.text}</span>
              <span className={styles.attentionRationale}>{item.rationale}</span>
            </li>
          ))}
        </ul>
        <p className={styles.trailer}>everything else is green.</p>
      </section>
    </main>
  );
}
