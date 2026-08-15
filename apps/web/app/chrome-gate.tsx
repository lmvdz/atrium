'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The global top bar (wordmark + account cluster) is chrome every route wants —
 * except the prototype, which is a full-bleed surface that owns its own identity
 * affordance (the user bar in its left pane). So the bar renders everywhere but
 * `/prototype`, keeping the account cluster on `/app` and the room routes that
 * assert it, and getting out of the prototype's way.
 */
export function ChromeGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/prototype')) return null;
  return <>{children}</>;
}
