import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GitHubClient, ThreadRef } from '../src/github-thread.js';
import { fetchDiscussionThread, fetchIssueThread } from '../src/github-thread.js';
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

  it('normalises CRLF out of bodies', async () => {
    const [root] = await fetchIssueThread(client, issueRef);
    expect(root?.text).not.toContain('\r');
    expect(root?.text.endsWith('side effects are?')).toBe(true);
  });

  it('renders a deleted account as ghost and keeps its empty body', async () => {
    const messages = await fetchIssueThread(client, issueRef);
    const orphan = messages.find((m) => m.id.endsWith('c235870067'));
    expect(orphan?.author).toBe('ghost');
    expect(orphan?.text).toBe('');
  });

  it('extracts markdown images, html images and upload links as attachments', async () => {
    const messages = await fetchIssueThread(client, issueRef);
    expect(messages[1]?.attachments).toEqual([
      { name: 'flow diagram', url: 'https://user-images.githubusercontent.com/1/2/flow.png' },
    ]);
    expect(messages[3]?.attachments).toEqual([
      { name: 'inline', url: 'https://user-images.githubusercontent.com/9/9/inline.png' },
      { name: 'the attachment', url: 'https://github.com/user-attachments/files/1/notes.txt' },
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
        if (!path.includes('/comments')) return issueFixture.issue;
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
      if (query.includes('node(id: $id)')) return discussionFixture.replies2;
      return variables.after === null || variables.after === undefined
        ? discussionFixture.page1
        : discussionFixture.page2;
    },
  });

  it('threads replies onto their parent comment', async () => {
    const messages = await fetchDiscussionThread(client, discussionRef);
    const reply = messages.find((m) => m.id.endsWith('c2807428'));
    expect(reply?.reply_to).toBe('github:vercel/next.js#37136/c2807422');
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

  it('rejects a payload whose shape has drifted', async () => {
    const broken = fakeClient({ graphql: () => ({ data: { repository: {} } }) });
    await expect(fetchDiscussionThread(broken, discussionRef)).rejects.toThrow();
  });
});
