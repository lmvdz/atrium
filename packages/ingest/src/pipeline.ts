import type { GitHubClient } from './github-thread.js';
import { fetchDiscussionThread, fetchIssueThread } from './github-thread.js';
import { serializeCorpus } from './jsonl.js';
import type { SourceDefinition } from './sources.js';
import type { IngestMessage } from './validate.js';
import { sortMessages } from './validate.js';

/** Fetch one registered source and return it in canonical order. */
export async function fetchSource(
  client: GitHubClient,
  source: SourceDefinition,
): Promise<IngestMessage[]> {
  const ref = { owner: source.owner, repo: source.repo, number: source.number };
  const messages =
    source.kind === 'github-issue'
      ? await fetchIssueThread(client, ref)
      : await fetchDiscussionThread(client, ref);
  return sortMessages(messages);
}

/** Fetch one registered source and render it as canonical JSONL. */
export async function buildCorpus(
  client: GitHubClient,
  source: SourceDefinition,
): Promise<{ messages: IngestMessage[]; jsonl: string }> {
  const messages = await fetchSource(client, source);
  return { messages, jsonl: serializeCorpus(messages, source.id) };
}
