import { z } from 'zod';
import { extractAttachments, normalizeText, normalizeTimestamp } from './text.js';
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

/** Guard against a pagination bug turning into an unbounded fetch loop. */
const MAX_PAGES = 200;
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
  databaseId: z.number().int().nullable(),
  body: z.string().nullish(),
  author: GraphQLAuthor,
  createdAt: z.string(),
});

const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });

const DiscussionComment = DiscussionReply.extend({
  id: z.string().min(1),
  replies: z.object({ pageInfo: PageInfo, nodes: z.array(DiscussionReply) }),
});

const DiscussionResponse = z.object({
  data: z.object({
    repository: z.object({
      discussion: z.object({
        number: z.number().int(),
        title: z.string(),
        body: z.string().nullish(),
        author: GraphQLAuthor,
        createdAt: z.string(),
        comments: z.object({ pageInfo: PageInfo, nodes: z.array(DiscussionComment) }),
      }),
    }),
  }),
});

const RepliesResponse = z.object({
  data: z.object({
    node: z.object({
      replies: z.object({ pageInfo: PageInfo, nodes: z.array(DiscussionReply) }),
    }),
  }),
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

function toMessage(input: {
  id: string;
  author: string;
  ts: string;
  body: string | null | undefined;
  replyTo?: string;
}): IngestMessage {
  const text = normalizeText(input.body ?? '');
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
 * Fetch an issue thread: the issue body followed by every comment, paginated
 * explicitly so the page size and the page count are ours, not `gh`'s.
 */
export async function fetchIssueThread(
  client: GitHubClient,
  ref: ThreadRef,
): Promise<IngestMessage[]> {
  const issue = RestIssue.parse(
    await client.rest(`repos/${ref.owner}/${ref.repo}/issues/${ref.number}`),
  );

  const messages: IngestMessage[] = [
    toMessage({
      id: threadRootId(ref),
      author: authorOf(issue.user),
      ts: issue.created_at,
      body: issue.body,
    }),
  ];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = RestComments.parse(
      await client.rest(
        `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=${REST_PAGE_SIZE}&page=${page}`,
      ),
    );
    for (const comment of batch) {
      messages.push(
        toMessage({
          id: threadCommentId(ref, comment.id),
          author: authorOf(comment.user),
          ts: comment.created_at,
          body: comment.body,
        }),
      );
    }
    if (batch.length < REST_PAGE_SIZE) return messages;
  }

  throw new Error(`issue ${threadRootId(ref)} exceeded ${MAX_PAGES} pages of comments`);
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
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          databaseId
          body
          createdAt
          author { login }
          replies(first: $replies) {
            pageInfo { hasNextPage endCursor }
            nodes { databaseId body createdAt author { login } }
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
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body createdAt author { login } }
      }
    }
  }
}`;

/**
 * Fetch a discussion thread: the opening post, its top-level comments, and
 * every reply (which carries `reply_to` pointing at its parent comment).
 */
export async function fetchDiscussionThread(
  client: GitHubClient,
  ref: ThreadRef,
): Promise<IngestMessage[]> {
  const messages: IngestMessage[] = [];
  let cursor: string | null = null;
  let rootAdded = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = DiscussionResponse.parse(
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

    if (!rootAdded) {
      messages.push(
        toMessage({
          id: threadRootId(ref),
          author: authorOf(discussion.author),
          ts: discussion.createdAt,
          body: discussion.body,
        }),
      );
      rootAdded = true;
    }

    for (const comment of discussion.comments.nodes) {
      const commentId = threadCommentId(ref, comment.databaseId ?? comment.id);
      messages.push(
        toMessage({
          id: commentId,
          author: authorOf(comment.author),
          ts: comment.createdAt,
          body: comment.body,
        }),
      );

      const replies = [...comment.replies.nodes];
      let replyCursor = comment.replies.pageInfo.hasNextPage
        ? (comment.replies.pageInfo.endCursor ?? null)
        : null;
      for (let replyPage = 1; replyCursor !== null && replyPage <= MAX_PAGES; replyPage++) {
        const more: z.infer<typeof RepliesResponse> = RepliesResponse.parse(
          await client.graphql(REPLIES_QUERY, {
            id: comment.id,
            first: GRAPHQL_REPLY_PAGE_SIZE,
            after: replyCursor,
          }),
        );
        replies.push(...more.data.node.replies.nodes);
        replyCursor = more.data.node.replies.pageInfo.hasNextPage
          ? (more.data.node.replies.pageInfo.endCursor ?? null)
          : null;
      }

      for (const reply of replies) {
        messages.push(
          toMessage({
            id: threadCommentId(ref, reply.databaseId ?? `${commentId}-reply`),
            author: authorOf(reply.author),
            ts: reply.createdAt,
            body: reply.body,
            replyTo: commentId,
          }),
        );
      }
    }

    if (!discussion.comments.pageInfo.hasNextPage) return messages;
    cursor = discussion.comments.pageInfo.endCursor ?? null;
    if (cursor === null) return messages;
  }

  throw new Error(`discussion ${threadRootId(ref)} exceeded ${MAX_PAGES} pages of comments`);
}
