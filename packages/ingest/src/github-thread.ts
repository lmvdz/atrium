import { z } from 'zod';
import { extractAttachments, normalizeTimestamp, verbatimBody } from './text.js';
import type { IngestMessage } from './validate.js';

/**
 * GitHub thread → canonical JSONL.
 *
 * Two sources, because GitHub models them differently:
 *
 *  - **Issues** (REST, paginated): a flat list of comments. GitHub carries no
 *    threading here, so no `reply_to` is invented — a quoted reply is text,
 *    not structure, and guessing at it would be interpretation (out of scope).
 *  - **Discussions** (GraphQL, paginated twice: comments, then each comment's
 *    replies): genuinely threaded, so replies carry `reply_to`.
 *
 * Every field comes from the API payload. Nothing here reads a clock, and the
 * transport is injected (`GitHubClient`) so the whole conversion is testable
 * against recorded fixtures without a network.
 *
 * ## A partial corpus must be unwritable
 *
 * A truncated fetch is the dangerous failure, because its output is *valid*:
 * schema-clean, canonically ordered, byte-stable across reruns, and silently
 * missing half the argument. Nothing downstream can tell. So every way this
 * file could come back with less than the whole thread throws instead:
 *
 *  - a page that claims `hasNextPage` but hands back no `endCursor`
 *    ({@link TruncatedFetchError}) — following it is impossible, and treating
 *    that as "done" is exactly the silent truncation;
 *  - the {@link MAX_PAGES} guard being reached with pages still outstanding,
 *    at either pagination level;
 *  - the fetched count disagreeing with the API's own `totalCount` / issue
 *    `comments` count ({@link SnapshotMismatchError}) — that is a thread
 *    someone edited mid-fetch, and the corpus would be a snapshot of no
 *    moment that ever existed;
 *  - the same item arriving twice ({@link DuplicateSourceItemError}) —
 *    repeating pagination that would otherwise pass a count check by
 *    substituting a duplicate for something it never delivered.
 */

export interface GitHubClient {
  /** GET a REST path, e.g. `repos/microsoft/TypeScript/issues/9998`. */
  rest(path: string): Promise<unknown>;
  /** POST a GraphQL query with variables. */
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

export interface ThreadRef {
  owner: string;
  repo: string;
  number: number;
}

/** The fetch could not be completed, so no corpus may be written from it. */
export class TruncatedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruncatedFetchError';
  }
}

/** The thread changed under the fetch: what arrived is not one snapshot. */
export class SnapshotMismatchError extends Error {
  constructor(
    readonly what: string,
    readonly expected: number,
    readonly got: number,
  ) {
    super(
      `${what}: expected ${expected}, got ${got} — the thread changed while it was being fetched, ` +
        'so this would be a snapshot of no single moment. Refusing to write it; rerun the ingest.',
    );
    this.name = 'SnapshotMismatchError';
  }
}

/** Pagination handed back the same item twice, so a count check proves nothing. */
export class DuplicateSourceItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateSourceItemError';
  }
}

/** Guard against a pagination bug turning into an unbounded fetch loop. */
export const MAX_PAGES = 200;
const REST_PAGE_SIZE = 100;
const GRAPHQL_PAGE_SIZE = 50;
const GRAPHQL_REPLY_PAGE_SIZE = 100;

const RestUser = z.object({ login: z.string().min(1) }).nullish();

const RestIssue = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullish(),
  user: RestUser,
  created_at: z.string(),
  /** GitHub's own count of the thread's comments — the reconciliation target. */
  comments: z.number().int().nonnegative(),
});

const RestComment = z.object({
  id: z.number().int(),
  body: z.string().nullish(),
  user: RestUser,
  created_at: z.string(),
});

const RestComments = z.array(RestComment);

const GraphQLAuthor = z.object({ login: z.string().min(1) }).nullish();

const DiscussionReply = z.object({
  /** The GraphQL node id. Always present, unlike `databaseId`. */
  id: z.string().min(1),
  databaseId: z.number().int().nullable(),
  body: z.string().nullish(),
  author: GraphQLAuthor,
  createdAt: z.string(),
});

const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });
type PageInfo = z.infer<typeof PageInfo>;

const ReplyConnection = z.object({
  totalCount: z.number().int().nonnegative(),
  pageInfo: PageInfo,
  nodes: z.array(DiscussionReply),
});

const DiscussionComment = DiscussionReply.extend({ replies: ReplyConnection });
type DiscussionComment = z.infer<typeof DiscussionComment>;

const DiscussionResponse = z.object({
  data: z.object({
    repository: z.object({
      discussion: z.object({
        number: z.number().int(),
        title: z.string(),
        body: z.string().nullish(),
        author: GraphQLAuthor,
        createdAt: z.string(),
        comments: z.object({
          totalCount: z.number().int().nonnegative(),
          pageInfo: PageInfo,
          nodes: z.array(DiscussionComment),
        }),
      }),
    }),
  }),
});

const RepliesResponse = z.object({
  data: z.object({ node: z.object({ replies: ReplyConnection }) }),
});

/** Deleted GitHub accounts surface as `null`; GitHub itself renders them `ghost`. */
const GHOST = 'ghost';

function authorOf(user: { login: string } | null | undefined): string {
  return user?.login ?? GHOST;
}

/** `github:owner/repo#number` — the opening post of a thread. */
export function threadRootId(ref: ThreadRef): string {
  return `github:${ref.owner}/${ref.repo}#${ref.number}`;
}

/** `github:owner/repo#number/c<comment id>` — stable across refetches. */
export function threadCommentId(ref: ThreadRef, commentId: number | string): string {
  return `${threadRootId(ref)}/c${commentId}`;
}

/**
 * The id for a discussion comment or reply.
 *
 * `databaseId` is preferred because it is short, numeric and matches what the
 * REST API and the web UI call the same object. It is nullable, though, and
 * round 1 fell back to a *shared* literal for every null in a thread, which
 * collides the moment two of them appear. The GraphQL node id is unique per
 * object and equally stable across refetches, so it is the right fallback.
 */
function discussionItemId(ref: ThreadRef, item: { databaseId: number | null; id: string }): string {
  return threadCommentId(ref, item.databaseId ?? item.id);
}

function toMessage(input: {
  id: string;
  author: string;
  ts: string;
  body: string | null | undefined;
  replyTo?: string;
}): IngestMessage {
  const text = verbatimBody(input.body ?? '');
  const attachments = extractAttachments(text);
  const message: IngestMessage = {
    id: input.id,
    author: input.author,
    ts: normalizeTimestamp(input.ts),
    text,
  };
  if (input.replyTo !== undefined) message.reply_to = input.replyTo;
  if (attachments.length > 0) message.attachments = attachments;
  return message;
}

/**
 * The cursor for the next page, or `null` when the connection is exhausted.
 *
 * `hasNextPage` with no `endCursor` is the stalled-cursor case: the API says
 * there is more and gives us no way to ask for it. Round 1 returned what it had.
 */
function nextCursor(pageInfo: PageInfo, what: string): string | null {
  if (!pageInfo.hasNextPage) return null;
  const cursor = pageInfo.endCursor ?? null;
  if (cursor === null) {
    throw new TruncatedFetchError(
      `${what}: the API reports more pages (hasNextPage) but returned no endCursor, ` +
        'so the rest is unreachable. Refusing to write a truncated corpus.',
    );
  }
  return cursor;
}

function capReached(what: string): TruncatedFetchError {
  return new TruncatedFetchError(
    `${what}: still paginating after ${MAX_PAGES} pages. Refusing to write a truncated corpus — ` +
      'raise MAX_PAGES if the thread really is this large.',
  );
}

function reconcile(what: string, expected: number, got: number): void {
  if (expected !== got) throw new SnapshotMismatchError(what, expected, got);
}

/** Collects messages, refusing to hold the same id twice. */
class MessageSink {
  private readonly seen = new Set<string>();
  readonly messages: IngestMessage[] = [];

  constructor(private readonly label: string) {}

  push(message: IngestMessage): void {
    if (this.seen.has(message.id)) {
      throw new DuplicateSourceItemError(
        `${this.label}: the API returned ${message.id} more than once. Pagination is repeating ` +
          'items, which means something else was skipped. Refusing to write the corpus.',
      );
    }
    this.seen.add(message.id);
    this.messages.push(message);
  }
}

/**
 * Fetch an issue thread: the issue body followed by every comment, paginated
 * explicitly so the page size and the page count are ours, not `gh`'s. The
 * final count is reconciled against the issue's own `comments` field.
 */
export async function fetchIssueThread(
  client: GitHubClient,
  ref: ThreadRef,
): Promise<IngestMessage[]> {
  const label = `issue ${threadRootId(ref)}`;
  const issue = RestIssue.parse(
    await client.rest(`repos/${ref.owner}/${ref.repo}/issues/${ref.number}`),
  );

  const sink = new MessageSink(label);
  sink.push(
    toMessage({
      id: threadRootId(ref),
      author: authorOf(issue.user),
      ts: issue.created_at,
      body: issue.body,
    }),
  );

  let fetched = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = RestComments.parse(
      await client.rest(
        `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=${REST_PAGE_SIZE}&page=${page}`,
      ),
    );
    for (const comment of batch) {
      fetched++;
      sink.push(
        toMessage({
          id: threadCommentId(ref, comment.id),
          author: authorOf(comment.user),
          ts: comment.created_at,
          body: comment.body,
        }),
      );
    }
    if (batch.length < REST_PAGE_SIZE) {
      reconcile(`${label} comment count`, issue.comments, fetched);
      return sink.messages;
    }
  }

  throw capReached(`${label} comments`);
}

const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $replies: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      number
      title
      body
      createdAt
      author { login }
      comments(first: $first, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          databaseId
          body
          createdAt
          author { login }
          replies(first: $replies) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id databaseId body createdAt author { login } }
          }
        }
      }
    }
  }
}`;

const REPLIES_QUERY = `query($id: ID!, $first: Int!, $after: String) {
  node(id: $id) {
    ... on DiscussionComment {
      replies(first: $first, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId body createdAt author { login } }
      }
    }
  }
}`;

/**
 * Every reply to one comment, following the reply cursor and reconciling the
 * result against the connection's `totalCount`.
 */
async function fetchReplies(
  client: GitHubClient,
  ref: ThreadRef,
  comment: DiscussionComment,
): Promise<z.infer<typeof DiscussionReply>[]> {
  const label = `replies to ${discussionItemId(ref, comment)}`;
  const expected = comment.replies.totalCount;
  const replies = [...comment.replies.nodes];
  let cursor = nextCursor(comment.replies.pageInfo, label);

  for (let page = 2; cursor !== null; page++) {
    if (page > MAX_PAGES) throw capReached(label);
    const response: z.infer<typeof RepliesResponse> = RepliesResponse.parse(
      await client.graphql(REPLIES_QUERY, {
        id: comment.id,
        first: GRAPHQL_REPLY_PAGE_SIZE,
        after: cursor,
      }),
    );
    const connection = response.data.node.replies;
    reconcile(`${label} totalCount`, expected, connection.totalCount);
    replies.push(...connection.nodes);
    cursor = nextCursor(connection.pageInfo, label);
  }

  reconcile(`${label} count`, expected, replies.length);
  return replies;
}

/**
 * Fetch a discussion thread: the opening post, its top-level comments, and
 * every reply (which carries `reply_to` pointing at its parent comment). Both
 * cursors are followed to exhaustion, and both levels are reconciled against
 * the API's `totalCount` before anything may be written.
 */
export async function fetchDiscussionThread(
  client: GitHubClient,
  ref: ThreadRef,
): Promise<IngestMessage[]> {
  const label = `discussion ${threadRootId(ref)}`;
  const sink = new MessageSink(label);
  let cursor: string | null = null;
  let expectedComments: number | undefined;
  let fetchedComments = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response: z.infer<typeof DiscussionResponse> = DiscussionResponse.parse(
      await client.graphql(DISCUSSION_QUERY, {
        owner: ref.owner,
        name: ref.repo,
        number: ref.number,
        first: GRAPHQL_PAGE_SIZE,
        replies: GRAPHQL_REPLY_PAGE_SIZE,
        after: cursor,
      }),
    );
    const discussion = response.data.repository.discussion;

    // A totalCount that moves between pages is itself a mid-fetch edit.
    if (expectedComments === undefined) expectedComments = discussion.comments.totalCount;
    else reconcile(`${label} comment totalCount`, expectedComments, discussion.comments.totalCount);

    if (page === 1) {
      sink.push(
        toMessage({
          id: threadRootId(ref),
          author: authorOf(discussion.author),
          ts: discussion.createdAt,
          body: discussion.body,
        }),
      );
    }

    for (const comment of discussion.comments.nodes) {
      fetchedComments++;
      const commentId = discussionItemId(ref, comment);
      sink.push(
        toMessage({
          id: commentId,
          author: authorOf(comment.author),
          ts: comment.createdAt,
          body: comment.body,
        }),
      );

      for (const reply of await fetchReplies(client, ref, comment)) {
        sink.push(
          toMessage({
            id: discussionItemId(ref, reply),
            author: authorOf(reply.author),
            ts: reply.createdAt,
            body: reply.body,
            replyTo: commentId,
          }),
        );
      }
    }

    cursor = nextCursor(discussion.comments.pageInfo, `${label} comments`);
    if (cursor === null) {
      reconcile(`${label} comment count`, expectedComments, fetchedComments);
      return sink.messages;
    }
  }

  throw capReached(`${label} comments`);
}
