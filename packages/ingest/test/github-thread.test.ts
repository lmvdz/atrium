import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GitHubClient, ThreadRef } from '../src/github-thread.js';
import {
  DuplicateSourceItemError,
  fetchDiscussionThread,
  fetchIssueThread,
  MAX_PAGES,
  SnapshotMismatchError,
  TruncatedFetchError,
} from '../src/github-thread.js';
import { serializeCorpus } from '../src/jsonl.js';
import { checkCorpus, sortMessages } from '../src/validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

const issueFixture = readFixture('github-issue.json');
const discussionFixture = readFixture('github-discussion.json');

const issueRef: ThreadRef = { owner: 'microsoft', repo: 'TypeScript', number: 9998 };
const discussionRef: ThreadRef = { owner: 'vercel', repo: 'next.js', number: 37136 };

/** Records the calls so pagination can be asserted, not assumed. */
function fakeClient(handlers: {
  rest?: (path: string) => unknown;
  graphql?: (query: string, variables: Record<string, unknown>) => unknown;
}): GitHubClient & { restCalls: string[]; graphqlCalls: Array<Record<string, unknown>> } {
  const restCalls: string[] = [];
  const graphqlCalls: Array<Record<string, unknown>> = [];
  return {
    restCalls,
    graphqlCalls,
    rest: async (path) => {
      restCalls.push(path);
      if (!handlers.rest) throw new Error(`unexpected REST call: ${path}`);
      return handlers.rest(path);
    },
    graphql: async (query, variables) => {
      graphqlCalls.push(variables);
      if (!handlers.graphql) throw new Error('unexpected GraphQL call');
      return handlers.graphql(query, variables);
    },
  };
}

// ---------------------------------------------------------------------------
// Payload builders. The failure paths below are all *shapes* rather than
// recorded traffic, so they are assembled here instead of in a fixture file —
// a stalled cursor is one field away from a healthy page, and the diff between
// the two should be readable in the test that asserts on it.
// ---------------------------------------------------------------------------

interface Connection<T> {
  totalCount: number;
  nodes: T[];
  hasNextPage?: boolean;
  endCursor?: string | null;
}

function connection<T>(options: Connection<T>) {
  return {
    totalCount: options.totalCount,
    pageInfo: { hasNextPage: options.hasNextPage ?? false, endCursor: options.endCursor ?? null },
    nodes: options.nodes,
  };
}

const reply = (n: number) => ({
  id: `DR_${n}`,
  databaseId: n,
  body: `reply ${n}`,
  createdAt: `2022-05-23T21:${String(n % 60).padStart(2, '0')}:00Z`,
  author: { login: 'leerob' },
});
type ReplyNode = ReturnType<typeof reply>;

const noReplies = () => connection<ReplyNode>({ totalCount: 0, nodes: [] });

const comment = (n: number, replies = noReplies()) => ({
  id: `DC_${n}`,
  databaseId: n,
  body: `comment ${n}`,
  createdAt: `2022-05-23T20:${String(n % 60).padStart(2, '0')}:00Z`,
  author: { login: 'timneutkens' },
  replies,
});
type CommentNode = ReturnType<typeof comment>;

const discussionPage = (options: Connection<CommentNode>) => ({
  data: {
    repository: {
      discussion: {
        number: 37136,
        title: 'RFC: Layouts',
        body: 'the opening post',
        createdAt: '2022-05-23T20:00:00Z',
        author: { login: 'timneutkens' },
        comments: connection(options),
      },
    },
  },
});

const repliesPage = (options: Connection<ReplyNode>) => ({
  data: { node: { replies: connection(options) } },
});

const isRepliesQuery = (query: string): boolean => query.includes('node(id: $id)');

describe('fetchIssueThread', () => {
  const client = fakeClient({
    rest: (path) => {
      if (path.includes('/comments')) {
        return path.includes('page=1') ? issueFixture.comments : [];
      }
      return issueFixture.issue;
    },
  });

  it('emits the issue body first, then every comment, with source-derived ids', async () => {
    const messages = await fetchIssueThread(client, issueRef);
    expect(messages.map((m) => m.id)).toEqual([
      'github:microsoft/TypeScript#9998',
      'github:microsoft/TypeScript#9998/c235870066',
      'github:microsoft/TypeScript#9998/c235870067',
      'github:microsoft/TypeScript#9998/c235870068',
    ]);
    expect(messages[0]?.author).toBe('RyanCavanaugh');
    expect(messages[0]?.ts).toBe('2016-07-28T00:03:48.000Z');
  });

  it('stores the body verbatim, CRLF and all', async () => {
    const [root] = await fetchIssueThread(client, issueRef);
    // Round 1 rewrote this: CRLF collapsed to LF, then the trailing newline
    // stripped. The corpus is meant to be what the source said, byte for byte.
    expect(root?.text).toBe((issueFixture.issue as { body: string }).body);
    expect(root?.text).toContain('\r\n');
    expect(root?.text.endsWith('side effects are?\r\n')).toBe(true);
  });

  it('renders a deleted account as ghost and keeps its empty body', async () => {
    const messages = await fetchIssueThread(client, issueRef);
    const orphan = messages.find((m) => m.id.endsWith('c235870067'));
    expect(orphan?.author).toBe('ghost');
    expect(orphan?.text).toBe('');
  });

  it('extracts markdown images, html images and upload links in document order', async () => {
    const messages = await fetchIssueThread(client, issueRef);
    expect(messages[1]?.attachments).toEqual([
      { name: 'flow diagram', url: 'https://user-images.githubusercontent.com/1/2/flow.png' },
    ]);
    expect(messages[3]?.attachments).toEqual([
      { name: 'the attachment', url: 'https://github.com/user-attachments/files/1/notes.txt' },
      { name: 'inline', url: 'https://user-images.githubusercontent.com/9/9/inline.png' },
    ]);
  });

  it('invents no reply structure — GitHub issues are flat', async () => {
    const messages = await fetchIssueThread(client, issueRef);
    expect(messages.every((m) => m.reply_to === undefined)).toBe(true);
  });

  it('pages until a short page, requesting 100 at a time', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      body: `comment ${i}`,
      user: { login: 'alice' },
      created_at: `2016-07-${String(10 + Math.floor(i / 24)).padStart(2, '0')}T0${i % 10}:00:00Z`,
    }));
    const paged = fakeClient({
      rest: (path) => {
        if (!path.includes('/comments'))
          return { ...(issueFixture.issue as object), comments: 101 };
        if (path.endsWith('&page=1')) return page1;
        if (path.endsWith('&page=2')) return [page1[0] ? { ...page1[0], id: 2000 } : {}];
        return [];
      },
    });
    const messages = await fetchIssueThread(paged, issueRef);
    expect(messages).toHaveLength(102);
    expect(paged.restCalls.filter((path) => path.includes('per_page=100'))).toHaveLength(2);
    expect(paged.restCalls.at(-1)).toContain('page=2');
  });

  it('produces a corpus that passes structural validation', async () => {
    const messages = sortMessages(await fetchIssueThread(client, issueRef));
    expect(checkCorpus(messages)).toEqual([]);
    expect(serializeCorpus(messages)).toBe(serializeCorpus(messages.toReversed()));
  });
});

describe('fetchDiscussionThread', () => {
  const client = fakeClient({
    graphql: (query, variables) => {
      if (isRepliesQuery(query)) return discussionFixture.replies2;
      return variables.after === null || variables.after === undefined
        ? discussionFixture.page1
        : discussionFixture.page2;
    },
  });

  it('threads replies onto their parent comment', async () => {
    const messages = await fetchDiscussionThread(client, discussionRef);
    const threaded = messages.find((m) => m.id.endsWith('c2807428'));
    expect(threaded?.reply_to).toBe('github:vercel/next.js#37136/c2807422');
    expect(checkCorpus(sortMessages(messages))).toEqual([]);
  });

  it('follows both cursors: comment pages and a comment’s extra reply pages', async () => {
    const messages = await fetchDiscussionThread(client, discussionRef);
    expect(messages.map((m) => m.id)).toEqual([
      'github:vercel/next.js#37136',
      'github:vercel/next.js#37136/c2807422',
      'github:vercel/next.js#37136/c2807428',
      'github:vercel/next.js#37136/c2807440',
      'github:vercel/next.js#37136/c2807500',
      'github:vercel/next.js#37136/cDC_kwDOA1_asc4AKu2a',
      'github:vercel/next.js#37136/cDC_kwDOA1_asc4AKu2b',
    ]);
    expect(client.graphqlCalls.some((vars) => vars.after === 'REPLY_CURSOR_1')).toBe(true);
    expect(client.graphqlCalls.some((vars) => vars.after === 'CURSOR_1')).toBe(true);
  });

  it('emits the opening post exactly once across pages', async () => {
    const messages = await fetchDiscussionThread(client, discussionRef);
    expect(messages.filter((m) => m.id === 'github:vercel/next.js#37136')).toHaveLength(1);
  });

  it('renders a deleted author as ghost', async () => {
    const messages = await fetchDiscussionThread(client, discussionRef);
    expect(messages.find((m) => m.id.endsWith('c2807500'))?.author).toBe('ghost');
  });

  it('keeps a reply body verbatim, hard break and all', async () => {
    const messages = await fetchDiscussionThread(client, discussionRef);
    expect(messages.find((m) => m.id.endsWith('c2807428'))?.text).toBe(
      'Yes! `.js`, `.jsx`, `.ts`, `.tsx` are all welcome  \r\nEvery one of them.  ',
    );
  });

  it('falls back to the node id — not one shared literal — when databaseId is null', async () => {
    const messages = await fetchDiscussionThread(client, discussionRef);
    const orphans = messages.filter((m) => m.id.includes('cDC_kwDOA1_asc'));
    // Round 1 gave every null-databaseId reply `<parent>-reply`, so two of them
    // under one parent collapsed into a duplicate id.
    expect(orphans).toHaveLength(2);
    expect(new Set(orphans.map((m) => m.id)).size).toBe(2);
    expect(orphans.every((m) => m.reply_to === 'github:vercel/next.js#37136/c2807500')).toBe(true);
  });

  it('rejects a payload whose shape has drifted', async () => {
    const broken = fakeClient({ graphql: () => ({ data: { repository: {} } }) });
    await expect(fetchDiscussionThread(broken, discussionRef)).rejects.toThrow();
  });
});

/**
 * The failure paths, all through the injected transport.
 *
 * Every one of these produced a *valid* corpus in round 1 — schema-clean,
 * canonically ordered, byte-stable across reruns, and missing or misreporting
 * part of the conversation. That is the shape of bug the committed corpora
 * cannot detect on their own, so it is asserted here rather than demonstrated
 * once against the live API.
 */
describe('a partial corpus is unwritable', () => {
  it('throws when the comment cursor stalls: hasNextPage with no endCursor', async () => {
    const client = fakeClient({
      graphql: (query) => {
        if (isRepliesQuery(query)) throw new Error('no reply pages expected');
        return discussionPage({
          totalCount: 9,
          nodes: [comment(1)],
          hasNextPage: true,
          endCursor: null,
        });
      },
    });
    // Round 1 returned the one comment it had and called that a corpus.
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(TruncatedFetchError);
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(/no endCursor/);
  });

  it('throws when a reply cursor stalls', async () => {
    const client = fakeClient({
      graphql: (query) => {
        if (isRepliesQuery(query)) throw new Error('unreachable: there is no cursor to follow');
        return discussionPage({
          totalCount: 1,
          nodes: [
            comment(
              1,
              connection({
                totalCount: 4,
                nodes: [reply(11)],
                hasNextPage: true,
                endCursor: null,
              }),
            ),
          ],
        });
      },
    });
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(TruncatedFetchError);
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(/replies to/);
  });

  it('throws when comment pagination exhausts the page cap', async () => {
    let page = 0;
    const client = fakeClient({
      graphql: (query) => {
        if (isRepliesQuery(query)) throw new Error('no reply pages expected');
        page++;
        return discussionPage({
          totalCount: 100_000,
          nodes: [comment(page)],
          hasNextPage: true,
          endCursor: `CURSOR_${page}`,
        });
      },
    });
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(TruncatedFetchError);
    expect(page).toBe(MAX_PAGES);
  });

  it('throws when reply pagination exhausts the page cap', async () => {
    let replyPage = 0;
    const client = fakeClient({
      graphql: (query) => {
        if (!isRepliesQuery(query)) {
          return discussionPage({
            totalCount: 1,
            nodes: [
              comment(
                1,
                connection({
                  totalCount: 100_000,
                  nodes: [reply(0)],
                  hasNextPage: true,
                  endCursor: 'REPLY_0',
                }),
              ),
            ],
          });
        }
        replyPage++;
        return repliesPage({
          totalCount: 100_000,
          nodes: [reply(replyPage)],
          hasNextPage: true,
          endCursor: `REPLY_${replyPage}`,
        });
      },
    });
    // Round 1's reply loop simply stopped at the cap and kept the partial list.
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(TruncatedFetchError);
    expect(replyPage).toBe(MAX_PAGES - 1);
  });

  it('throws when two comment pages hand back the same item', async () => {
    const client = fakeClient({
      graphql: (query, variables) => {
        if (isRepliesQuery(query)) throw new Error('no reply pages expected');
        const first = variables.after === null || variables.after === undefined;
        return discussionPage({
          totalCount: 2,
          nodes: [comment(1)],
          ...(first ? { hasNextPage: true, endCursor: 'CURSOR_1' } : {}),
        });
      },
    });
    // Two pages, two items counted, one item real: the count check alone would
    // have passed. Round 1 wrote it, and the duplicate id only surfaced later.
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(
      DuplicateSourceItemError,
    );
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(/more than once/);
  });

  it('throws when a reply arrives twice across reply pages', async () => {
    const client = fakeClient({
      graphql: (query) =>
        isRepliesQuery(query)
          ? repliesPage({ totalCount: 2, nodes: [reply(11)] })
          : discussionPage({
              totalCount: 1,
              nodes: [
                comment(
                  1,
                  connection({
                    totalCount: 2,
                    nodes: [reply(11)],
                    hasNextPage: true,
                    endCursor: 'REPLY_CURSOR_1',
                  }),
                ),
              ],
            }),
    });
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(
      DuplicateSourceItemError,
    );
  });

  it('throws when the comment count disagrees with the API’s own totalCount', async () => {
    const client = fakeClient({
      graphql: (query) => {
        if (isRepliesQuery(query)) throw new Error('no reply pages expected');
        // Someone deleted a comment between the count and the page.
        return discussionPage({ totalCount: 3, nodes: [comment(1), comment(2)] });
      },
    });
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(
      SnapshotMismatchError,
    );
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(
      /expected 3, got 2 .*changed while it was being fetched/s,
    );
  });

  it('throws when a comment’s reply count disagrees with its totalCount', async () => {
    const client = fakeClient({
      graphql: (query) => {
        if (isRepliesQuery(query)) throw new Error('no reply pages expected');
        return discussionPage({
          totalCount: 1,
          nodes: [comment(1, connection({ totalCount: 5, nodes: [reply(11)] }))],
        });
      },
    });
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(
      SnapshotMismatchError,
    );
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(/expected 5, got 1/);
  });

  it('throws when totalCount itself moves between comment pages', async () => {
    const client = fakeClient({
      graphql: (query, variables) => {
        if (isRepliesQuery(query)) throw new Error('no reply pages expected');
        const first = variables.after === null || variables.after === undefined;
        return first
          ? discussionPage({
              totalCount: 2,
              nodes: [comment(1)],
              hasNextPage: true,
              endCursor: 'CURSOR_1',
            })
          : discussionPage({ totalCount: 3, nodes: [comment(2)] });
      },
    });
    await expect(fetchDiscussionThread(client, discussionRef)).rejects.toThrow(
      SnapshotMismatchError,
    );
  });

  it('throws when an issue’s fetched comments disagree with its comment count', async () => {
    const client = fakeClient({
      rest: (path) =>
        path.includes('/comments')
          ? [
              {
                id: 1,
                body: 'only one',
                user: { login: 'alice' },
                created_at: '2016-07-28T01:00:00Z',
              },
            ]
          : { ...(issueFixture.issue as object), comments: 4 },
    });
    await expect(fetchIssueThread(client, issueRef)).rejects.toThrow(SnapshotMismatchError);
    await expect(fetchIssueThread(client, issueRef)).rejects.toThrow(/expected 4, got 1/);
  });

  it('throws when REST pagination exhausts the page cap', async () => {
    const full = (page: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: page * 1000 + i,
        body: 'x',
        user: { login: 'alice' },
        created_at: '2016-07-28T01:00:00Z',
      }));
    let page = 0;
    const client = fakeClient({
      rest: (path) => {
        if (!path.includes('/comments')) {
          return { ...(issueFixture.issue as object), comments: 100_000 };
        }
        page++;
        return full(page);
      },
    });
    await expect(fetchIssueThread(client, issueRef)).rejects.toThrow(TruncatedFetchError);
    expect(page).toBe(MAX_PAGES);
  });

  it('throws when an issue hands back the same comment on two pages', async () => {
    const page = (id: number) =>
      Array.from({ length: 100 }, () => ({
        id,
        body: 'x',
        user: { login: 'alice' },
        created_at: '2016-07-28T01:00:00Z',
      }));
    const client = fakeClient({
      rest: (path) =>
        path.includes('/comments') ? page(7) : { ...(issueFixture.issue as object), comments: 100 },
    });
    await expect(fetchIssueThread(client, issueRef)).rejects.toThrow(DuplicateSourceItemError);
  });
});
