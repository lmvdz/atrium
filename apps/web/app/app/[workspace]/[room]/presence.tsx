'use client';

import { useEffect, useState } from 'react';
import styles from '../../workspace.module.css';

/**
 * The presence stub.
 *
 * This is the smallest honest client of the realtime server: it opens the
 * WebSocket, sends one authorized command, and renders who else is here. The
 * session cookie rides along on the upgrade automatically — cookies ignore port
 * numbers, so the browser sends it to :4000 exactly as it does to :3000 — which
 * is why there is no token handling anywhere in this file.
 *
 * The message feed, the reconnect/resume protocol and the real event stream are
 * #22's. What must survive that work is the shape below: the server decides who
 * is present, the client only draws it.
 */

interface Member {
  userId: string;
  displayName: string;
}

type Status = 'connecting' | 'live' | 'denied' | 'offline' | 'unconfigured';

export function Presence({ roomId, wsUrl }: { roomId: string; wsUrl: string | null }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState<Status>(wsUrl ? 'connecting' : 'unconfigured');
  const [denial, setDenial] = useState<string | null>(null);

  useEffect(() => {
    // `null` means the deployment declared no realtime URL. The old code had a
    // `ws://localhost:4000/ws` fallback baked in at build time for exactly this
    // case, which is how a production browser ended up being told to open a
    // socket against itself. Saying "unconfigured" out loud is the honest
    // version of that, and it is a state the page can render.
    if (!wsUrl) {
      setStatus('unconfigured');
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      setStatus('offline');
      return;
    }

    const onOpen = () => {
      setStatus('live');
      socket.send(JSON.stringify({ type: 'command', command: 'room.join', roomId }));
    };

    const onMessage = (event: MessageEvent<string>) => {
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof frame !== 'object' || frame === null) return;
      const typed = frame as {
        type?: string;
        roomId?: string;
        members?: Member[];
        message?: string;
      };

      if (typed.type === 'presence' && typed.roomId === roomId && Array.isArray(typed.members)) {
        setMembers(typed.members);
        return;
      }
      if (typed.type === 'command_error') {
        // A refusal is information, not a crash: say so where a person can see it.
        setStatus('denied');
        setDenial(typed.message ?? 'that command was refused');
      }
    };

    // An upgrade the server refuses closes before it ever opens.
    const onClose = () => setStatus((current) => (current === 'denied' ? current : 'offline'));

    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onClose);

    return () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onClose);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    };
  }, [roomId, wsUrl]);

  return (
    <div
      className={styles.presence}
      data-testid="presence"
      data-status={status}
      data-room-id={roomId}
    >
      <span className={styles.presenceStatus}>
        {status === 'live' ? `here · ${members.length}` : status}
      </span>
      {members.map((member) => (
        <span className={styles.presenceMember} data-testid="presence-member" key={member.userId}>
          <span aria-hidden="true" className={styles.presenceDot} />
          {member.displayName}
        </span>
      ))}
      {denial ? (
        <span className={styles.presenceError} data-testid="presence-error">
          {denial}
        </span>
      ) : null}
    </div>
  );
}
