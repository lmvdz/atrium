/* PROVIDER MARK — which lab a model/harness belongs to, as one small brand mark,
   so the tree can show a glyph instead of "opus-5 · claude-code".

   #151 marriage table: ProviderMark is **port-prototype** — a pure client
   projection over a `model` string, with no more-evolved shipped equivalent to
   defer to. It stays as the design shipped it. */

import { IconAnthropic, IconDot, IconOpenAI, IconXai } from './icons';
import styles from './prototype.module.css';

type Provider = 'anthropic' | 'openai' | 'xai' | 'other';

export function providerOf(name: string): Provider {
  const m = name.toLowerCase();
  if (/opus|sonnet|claude|haiku|fable/.test(m)) return 'anthropic';
  if (/gpt|codex|o[134]\b/.test(m)) return 'openai';
  if (/grok/.test(m)) return 'xai';
  return 'other';
}

export function ProviderMark({ model, title }: { model: string; title?: string }) {
  const p = providerOf(model);
  const cls =
    p === 'anthropic'
      ? styles.pAnthropic
      : p === 'openai'
        ? styles.pOpenai
        : p === 'xai'
          ? styles.pXai
          : styles.pOther;
  return (
    <span className={`${styles.pMark} ${cls}`} title={title ?? model} aria-label={p}>
      {p === 'anthropic' ? (
        <IconAnthropic />
      ) : p === 'openai' ? (
        <IconOpenAI />
      ) : p === 'xai' ? (
        <IconXai />
      ) : (
        <IconDot size={9} />
      )}
    </span>
  );
}
