import { describe, expect, it, vi } from 'vitest';
import {
  assertKnownRole,
  atriumOrganizationOptions,
  isDemotion,
  type OrganizationOptionsInput,
  type OrganizationPorts,
  type RoomCleanupFailure,
} from '../src/org.js';
import { lowerOf } from '../src/workspace.js';

/**
 * The library-layer authorization, tested for what it decides.
 *
 * Round 1 shipped the policy in a Server Action only, so the same operation
 * performed through Better Auth's own API skipped it — a workspace admin could
 * mint an `owner` invitation. These tests call the hook the way Better Auth
 * calls it and assert the denial, which is the part that has to be true no
 * matter which caller gets there.
 */

const workspaceId = 'ws-1';

function ports(overrides: Partial<OrganizationPorts> = {}): OrganizationPorts {
  return {
    memberRole: async () => 'admin',
    createDefaultRoom: async () => undefined,
    joinWorkspaceRooms: async () => undefined,
    revokeWorkspaceRooms: async () => undefined,
    syncWorkspaceRoomRoles: async () => undefined,
    voidInvitation: async () => ({ outcome: 'voided' }),
    revokeAcceptedInvitation: async () => ({ removed: true, rooms: 1 }),
    ...overrides,
  };
}

function options(
  overrides: Partial<OrganizationPorts> = {},
  rest: Partial<
    Pick<OrganizationOptionsInput, 'logger' | 'onCleanupFailure' | 'cleanupReportTimeoutMs'>
  > = {},
) {
  return atriumOrganizationOptions({
    ports: ports(overrides),
    baseURL: 'https://atrium.test',
    mailer: async () => {},
    schema: {},
    ...rest,
  });
}

function invitation(role: string, inviterId = 'user-admin') {
  return {
    invitation: { email: 'grace@example.com', role, organizationId: workspaceId, inviterId },
    inviter: { id: inviterId },
    organization: { id: workspaceId },
  };
}

describe('beforeCreateInvitation — the escalation guard', () => {
  it('refuses an admin who tries to invite an owner', async () => {
    const hooks = options({ memberRole: async () => 'admin' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('owner'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('lets an owner invite an owner', async () => {
    const hooks = options({ memberRole: async () => 'owner' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('owner'))).resolves.toBeUndefined();
  });

  it('lets an admin invite an admin or a member', async () => {
    const hooks = options({ memberRole: async () => 'admin' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.beforeCreateInvitation(invitation('member'))).resolves.toBeUndefined();
  });

  it('refuses a plain member outright — inviting is an admin verb', async () => {
    const hooks = options({ memberRole: async () => 'member' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('member'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('refuses somebody who is not a member of the workspace at all', async () => {
    const hooks = options({ memberRole: async () => null }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('member'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('reads the inviter’s role from the database, not from the request', async () => {
    // The inviter id in the body is attacker-controlled in the general case;
    // what matters is that the role comes from a lookup keyed by the session's
    // user, which is what Better Auth passes as `inviter`.
    const memberRole = vi.fn(async () => 'member');
    const hooks = options({ memberRole }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('owner', 'user-x'))).rejects.toThrow();
    expect(memberRole).toHaveBeenCalledWith({ workspaceId, userId: 'user-x' });
  });

  it('refuses a role string it cannot read at all', async () => {
    const hooks = options({ memberRole: async () => 'owner' }).organizationHooks;
    for (const role of ['superuser', 'billing,admin', '', 'admin,owner,root']) {
      await expect(hooks.beforeCreateInvitation(invitation(role))).rejects.toMatchObject({
        status: 'BAD_REQUEST',
      });
    }
  });

  it('refuses an admin whose stored role carries an unknown component', async () => {
    // `"billing,admin"` must not read as admin on the granting side either.
    const hooks = options({ memberRole: async () => 'billing,admin' }).organizationHooks;
    await expect(hooks.beforeCreateInvitation(invitation('member'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });
});

describe('revocation hooks', () => {
  it('drops room membership before the workspace member row goes', async () => {
    const revokeWorkspaceRooms = vi.fn(async () => undefined);
    const hooks = options({ revokeWorkspaceRooms }).organizationHooks;

    await hooks.beforeRemoveMember({
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    });

    expect(revokeWorkspaceRooms).toHaveBeenCalledWith({ workspaceId, userId: 'user-2' });
  });

  it('sweeps again afterwards, so a join racing the removal does not survive it', async () => {
    const revokeWorkspaceRooms = vi.fn(async () => undefined);
    const hooks = options({ revokeWorkspaceRooms }).organizationHooks;

    await hooks.afterRemoveMember({
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    });

    expect(revokeWorkspaceRooms).toHaveBeenCalledTimes(1);
  });

  it('never turns a completed removal into an error when the second sweep fails', async () => {
    const hooks = options({
      revokeWorkspaceRooms: async () => {
        throw new Error('database is on fire');
      },
    }).organizationHooks;

    await expect(
      hooks.afterRemoveMember({
        member: { userId: 'user-2', organizationId: workspaceId },
        organization: { id: workspaceId },
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * Round 5 caught that failure and logged the message and the user id, and
   * that was the whole of it — the round-5 gauntlet called the combination
   * blocking, because at the time those orphaned room rows were still full
   * authority. Round 6 moved authorization onto the join, so the failure stops
   * being a security event and starts being one an operator has to be told
   * about clearly enough to act on.
   */
  it('reports a failed post-removal sweep loudly instead of absorbing it', async () => {
    /**
     * Catches, each on its own: dropping the stable `event` key (an alert rule
     * has nothing to match); logging only `error.message` again (round 5
     * learned the hard way that a `DrizzleQueryError`'s message says nothing
     * and the `PostgresError` is one `cause` down); dropping the workspace id
     * (there is then no way to find the orphaned rows).
     */
    const error = Object.assign(new Error('lock timeout'), {
      name: 'MemberLockTimeoutError',
      cause: new Error('55P03: lock_timeout'),
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const hooks = options(
      {
        revokeWorkspaceRooms: async () => {
          throw error;
        },
      },
      { logger },
    ).organizationHooks;

    await hooks.afterRemoveMember({
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [, fields] = logger.error.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      event: 'room_cleanup_failed',
      operation: 'revokeWorkspaceRooms',
      phase: 'afterRemoveMember',
      workspaceId,
      userId: 'user-2',
      errorName: 'MemberLockTimeoutError',
      error: 'lock timeout',
      cause: '55P03: lock_timeout',
    });
    expect(String((fields as { stack?: string }).stack)).toContain('Error: lock timeout');
    expect(String((fields as { consequence?: string }).consequence)).toContain('orphaned');
  });

  it('hands the failure to `onCleanupFailure` so a deployment can alert on it', async () => {
    /**
     * Catches: deleting the `input.onCleanupFailure?.(failure)` call. A log line
     * is where an operator looks *after* they know something is wrong; this is
     * the seam that tells them.
     */
    const seen: RoomCleanupFailure[] = [];
    const hooks = options(
      {
        revokeWorkspaceRooms: async () => {
          throw new Error('database is on fire');
        },
      },
      {
        logger: { warn: vi.fn(), error: vi.fn() },
        onCleanupFailure: (f) => {
          seen.push(f);
        },
      },
    ).organizationHooks;

    await hooks.afterRemoveMember({
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      operation: 'revokeWorkspaceRooms',
      phase: 'afterRemoveMember',
      workspaceId,
      userId: 'user-2',
    });
    expect(seen[0]?.error.message).toBe('database is on fire');
  });

  it('survives a reporter that throws, and says that it did', async () => {
    /**
     * A broken alerting hook must not undo a completed removal. Catches:
     * calling `onCleanupFailure` outside the try, which would let a paging
     * client's bug propagate out of the hook and fail the removal.
     */
    const logger = { warn: vi.fn(), error: vi.fn() };
    const hooks = options(
      {
        revokeWorkspaceRooms: async () => {
          throw new Error('database is on fire');
        },
      },
      {
        logger,
        onCleanupFailure: () => {
          throw new Error('pagerduty is also on fire');
        },
      },
    ).organizationHooks;

    await expect(
      hooks.afterRemoveMember({
        member: { userId: 'user-2', organizationId: workspaceId },
        organization: { id: workspaceId },
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[1]?.[1]).toMatchObject({
      event: 'room_cleanup_reporter_failed',
      error: 'pagerduty is also on fire',
    });
  });

  /**
   * The reporter is a *live crash path*, not an error-handling nicety.
   *
   * Round 6 called `onCleanupFailure` without awaiting it. For a synchronous
   * reporter that was fine; for the realistic one — a POST to a pager, an
   * enqueue onto pg-boss — the returned promise was dropped on the floor, and a
   * rejection on a dropped promise is an `unhandledRejection`. `apps/server`
   * exits the process on those *by design* (`src/index.ts`: "the process is in a
   * state nobody reasoned about"). So a member removal that fully succeeded
   * could take the realtime server down, by way of the alerting hook.
   *
   * Note what the removal-succeeds assertion alone does **not** catch: under
   * round 6's shape `afterRemoveMember` still resolves — the rejection escapes
   * *after* it. So these tests observe the rejection itself, and the awaiting,
   * rather than only the hook's return value.
   */
  describe('a reporter cannot escalate into a request failure or a process exit', () => {
    /** Everything Node reports as unhandled while `run` is in flight. */
    async function withUnhandledRejectionWatch(run: () => Promise<void>): Promise<unknown[]> {
      const seen: unknown[] = [];
      const listen = (reason: unknown) => seen.push(reason);
      process.on('unhandledRejection', listen);
      try {
        await run();
        // Node decides a rejection is unhandled at a microtask checkpoint, on a
        // later turn of the loop than the one that created it — so a real timer,
        // not `await Promise.resolve()`, which would run too early to see it.
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        process.off('unhandledRejection', listen);
      }
      return seen;
    }

    function failingSweep() {
      return {
        revokeWorkspaceRooms: async () => {
          throw new Error('database is on fire');
        },
      };
    }

    const removal = {
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    };

    it('awaits an async reporter that rejects, instead of leaking the rejection', async () => {
      /**
       * Catches: dropping the `await` in front of `input.onCleanupFailure?.(…)`.
       * Under that mutation the hook still resolves and the removal still
       * succeeds, so only the unhandled-rejection watch goes red — which is the
       * whole finding, since an unhandled rejection is a process exit here.
       */
      const logger = { warn: vi.fn(), error: vi.fn() };
      const hooks = options(failingSweep(), {
        logger,
        onCleanupFailure: async () => {
          await Promise.resolve();
          throw new Error('pagerduty returned 503');
        },
      }).organizationHooks;

      const unhandled = await withUnhandledRejectionWatch(async () => {
        await expect(hooks.afterRemoveMember(removal)).resolves.toBeUndefined();
      });

      expect(unhandled).toEqual([]);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls[1]?.[1]).toMatchObject({
        event: 'room_cleanup_reporter_failed',
        error: 'pagerduty returned 503',
      });
    });

    it('does not return before the reporter has finished', async () => {
      /**
       * Catches the same dropped `await`, from the other side and without any
       * dependence on Node's unhandled-rejection timing.
       *
       * The reporter waits on a **timer**, and that is not incidental. The first
       * draft of this test used `await Promise.resolve()` and passed against the
       * un-awaited round-6 code: the reporter's continuation is a microtask
       * queued before the hook returns, so it runs before the caller resumes and
       * the flag is set either way. It was measuring the microtask queue's order
       * rather than the `await`. A timer crosses a real turn of the event loop,
       * which nothing but an actual `await` can wait for.
       */
      let finished = false;
      const hooks = options(failingSweep(), {
        logger: { warn: vi.fn(), error: vi.fn() },
        onCleanupFailure: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          finished = true;
        },
      }).organizationHooks;

      await hooks.afterRemoveMember(removal);

      expect(finished).toBe(true);
    });

    it('survives a logger that throws, and still reaches the operator seam', async () => {
      /**
       * Catches: moving either `logger.error` back outside its guard. Round 6's
       * first call was unprotected entirely and its second sat in the reporter's
       * catch block, so a throwing log transport propagated out of
       * `afterRemoveMember` and failed a removal that had already committed.
       *
       * The second assertion is the one that makes this more than "it did not
       * throw": logging and reporting are independent, so a broken logger must
       * not also cost the seam a deployment pages on.
       */
      const seen: RoomCleanupFailure[] = [];
      const hooks = options(failingSweep(), {
        logger: {
          warn: vi.fn(),
          error: () => {
            throw new Error('log transport socket closed');
          },
        },
        onCleanupFailure: (failure) => {
          seen.push(failure);
        },
      }).organizationHooks;

      await expect(hooks.afterRemoveMember(removal)).resolves.toBeUndefined();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.workspaceId).toBe(workspaceId);
    });

    it('survives a throwing logger and a rejecting reporter at the same time', async () => {
      /**
       * The compound case, because the guards are separate: with the logger
       * broken there is nowhere to report the reporter's rejection, and the
       * fallback log is itself the thing that throws. Catches a `logSafely`
       * whose guard covers the call but not the construction of its fields, and
       * any arrangement that nests the two guards so one failure disables both.
       */
      const hooks = options(failingSweep(), {
        logger: {
          warn: vi.fn(),
          error: () => {
            throw new Error('log transport socket closed');
          },
        },
        onCleanupFailure: async () => {
          throw new Error('pagerduty is also on fire');
        },
      }).organizationHooks;

      const unhandled = await withUnhandledRejectionWatch(async () => {
        await expect(hooks.afterRemoveMember(removal)).resolves.toBeUndefined();
      });

      expect(unhandled).toEqual([]);
    });

    it('reports an async reporter that rejects with a non-Error', async () => {
      /**
       * Catches: the round-6 `(reporterError as Error).message`, which is
       * `undefined` for a string rejection — a cast is not a check, and a
       * `reject('timeout')` from a fetch wrapper is not exotic.
       */
      const logger = { warn: vi.fn(), error: vi.fn() };
      const hooks = options(failingSweep(), {
        logger,
        onCleanupFailure: () => Promise.reject('pager webhook timed out'),
      }).organizationHooks;

      const unhandled = await withUnhandledRejectionWatch(async () => {
        await hooks.afterRemoveMember(removal);
      });

      expect(unhandled).toEqual([]);
      expect(logger.error.mock.calls[1]?.[1]).toMatchObject({
        event: 'room_cleanup_reporter_failed',
        error: 'pager webhook timed out',
      });
    });

    /**
     * The hole round 7 left one line upstream of its own guard.
     *
     * Round 7 normalized the port's rejection at the *call site*:
     * `new Error(String(error))`, outside `reportCleanupFailure` and therefore
     * outside everything that catches. `String()` is not a total function — it
     * calls `toString`/`Symbol.toPrimitive` on the value — so a port that
     * rejected with one of the two shapes below threw *there*, after the removal
     * had already committed, and `afterRemoveMember` rejected. That is exactly
     * the failure mode round 7 existed to close, reached through the code that
     * formats the error rather than the code that reports it.
     *
     * Both shapes are real. `Object.create(null)` is what you get from a
     * prototype-less parse of a JSON error body; a throwing `Symbol.toPrimitive`
     * is what a hostile or merely clever wrapper object does.
     */
    describe('normalizing the rejection cannot itself become the failure', () => {
      /** A port that rejects with something that is not an `Error`. */
      function sweepRejectingWith(value: unknown) {
        return {
          revokeWorkspaceRooms: async () => {
            throw value;
          },
        };
      }

      /** No `toString`, no `Symbol.toPrimitive`, no prototype at all. */
      function nullPrototypeRejection(): object {
        return Object.create(null) as object;
      }

      /** Converting it to a primitive is the thing that throws. */
      function hostilePrimitiveRejection(): object {
        return {
          [Symbol.toPrimitive]() {
            throw new Error('conversion refused');
          },
        };
      }

      for (const [shape, make] of [
        ['a prototype-less object', nullPrototypeRejection],
        ['an object whose Symbol.toPrimitive throws', hostilePrimitiveRejection],
      ] as const) {
        it(`survives a port rejecting with ${shape}`, async () => {
          /**
           * Catches: normalizing outside the guard — round 7's
           * `error: error instanceof Error ? error : new Error(String(error))`
           * at the `reportCleanupFailure` call site. Under that shape this test
           * fails on the very first assertion, because the hook rejects.
           *
           * The assertions, in the order they matter: the removal is not turned
           * into an error (the hook resolves), the process is not taken down (no
           * unhandled rejection), and the operator still learns about it — a
           * guard that swallowed the whole report would pass the first two.
           */
          const logger = { warn: vi.fn(), error: vi.fn() };
          const seen: RoomCleanupFailure[] = [];
          const hooks = options(sweepRejectingWith(make()), {
            logger,
            onCleanupFailure: (failure) => {
              seen.push(failure);
            },
          }).organizationHooks;

          const unhandled = await withUnhandledRejectionWatch(async () => {
            await expect(hooks.afterRemoveMember(removal)).resolves.toBeUndefined();
          });

          expect(unhandled).toEqual([]);
          // The seam still fires, and it is handed a real `Error` rather than
          // the raw value — `RoomCleanupFailure.error` is typed `Error`, and a
          // reporter that reads `.message` off it must not be the next thing to
          // throw on this path.
          expect(seen).toHaveLength(1);
          expect(seen[0]?.error).toBeInstanceOf(Error);
          expect(typeof seen[0]?.error.message).toBe('string');
          expect(logger.error).toHaveBeenCalledTimes(1);
          expect(logger.error.mock.calls[0]?.[1]).toMatchObject({
            event: 'room_cleanup_failed',
          });
        });
      }

      it('survives a reporter that rejects with a prototype-less object too', async () => {
        /**
         * The same hole, in the other formatter. Round 7's reporter catch read
         * `reporterError instanceof Error ? … : String(reporterError)`, which is
         * inside `logSafely`'s thunk and therefore guarded — so this passes
         * against r7 and is here as the control that says so. What it protects
         * is the guard *staying* total if anyone lifts that expression out of
         * the thunk, which is precisely the move round 7 made one level up.
         */
        const logger = { warn: vi.fn(), error: vi.fn() };
        const hooks = options(failingSweep(), {
          logger,
          onCleanupFailure: () => Promise.reject(nullPrototypeRejection()),
        }).organizationHooks;

        const unhandled = await withUnhandledRejectionWatch(async () => {
          await expect(hooks.afterRemoveMember(removal)).resolves.toBeUndefined();
        });

        expect(unhandled).toEqual([]);
        expect(logger.error.mock.calls[1]?.[1]).toMatchObject({
          event: 'room_cleanup_reporter_failed',
        });
      });
    });

    /**
     * The availability half: a reporter that never answers.
     *
     * Round 7 fixed the crash by awaiting the reporter, and the await had no
     * deadline — so the same seam that could once exit the process could now
     * hang a removal that had already committed, and the request behind it, for
     * as long as a pager or a queue chose not to answer. `org.ts:316`, per the
     * round-7 delta.
     */
    describe('an unbounded reporter cannot hang a completed removal', () => {
      it('gives up on a reporter that never settles, and says so', async () => {
        /**
         * Catches: removing the deadline from the `await` on
         * `input.onCleanupFailure`. Under that mutation this test does not fail
         * with a wrong value — it never finishes, which vitest reports as a
         * timeout. The elapsed-time assertion is what makes the bound a
         * measurement rather than a claim: it fails if the hook waited longer
         * than the deadline it was given.
         */
        const logger = { warn: vi.fn(), error: vi.fn() };
        const hooks = options(failingSweep(), {
          logger,
          cleanupReportTimeoutMs: 40,
          // Never. Not slow — never.
          onCleanupFailure: () => new Promise<void>(() => {}),
        }).organizationHooks;

        const started = Date.now();
        await expect(hooks.afterRemoveMember(removal)).resolves.toBeUndefined();
        const elapsed = Date.now() - started;

        // Generous upper bound, because a loaded CI box schedules timers late.
        // It still fails by orders of magnitude against an undeadlined await,
        // which never resolves at all.
        expect(elapsed).toBeLessThan(2_000);
        expect(logger.error).toHaveBeenCalledTimes(2);
        expect(logger.error.mock.calls[1]?.[1]).toMatchObject({
          event: 'room_cleanup_reporter_timed_out',
          timeoutMs: 40,
        });
      });

      it('still catches a rejection that arrives after the deadline', async () => {
        /**
         * The half a deadline is easiest to get wrong: stopping waiting is not
         * the same as stopping listening. A reporter that rejects *after* losing
         * the race is still a rejected promise, and an unhandled rejection is a
         * process exit in `apps/server` — so trading the hang for a crash would
         * be no trade at all.
         *
         * Catches: implementing the deadline as a bare `Promise.race` whose
         * losing arm is left unhandled, or as an `AbortController` that drops
         * the original promise. Both pass the test above and fail this one.
         */
        const logger = { warn: vi.fn(), error: vi.fn() };
        const hooks = options(failingSweep(), {
          logger,
          cleanupReportTimeoutMs: 20,
          onCleanupFailure: () =>
            new Promise<void>((_, reject) => {
              setTimeout(() => reject(new Error('pagerduty answered 504, eventually')), 60);
            }),
        }).organizationHooks;

        const unhandled = await withUnhandledRejectionWatch(async () => {
          await expect(hooks.afterRemoveMember(removal)).resolves.toBeUndefined();
          // Past the reporter's own 60ms, so the late rejection has happened
          // inside the watch rather than after it.
          await new Promise((resolve) => setTimeout(resolve, 120));
        });

        expect(unhandled).toEqual([]);
        expect(
          logger.error.mock.calls.map((call) => (call[1] as { event?: string })?.event),
        ).toContain('room_cleanup_reporter_failed_late');
      });

      it('does not deadline a reporter that answers in time', async () => {
        /**
         * The control. A deadline implemented as "resolve immediately and log a
         * timeout" would satisfy both tests above and silently stop waiting for
         * every reporter — so this asserts the normal path is untouched: the
         * reporter finishes, the hook waited for it, and nothing is logged as a
         * timeout.
         */
        const logger = { warn: vi.fn(), error: vi.fn() };
        let finished = false;
        const hooks = options(failingSweep(), {
          logger,
          cleanupReportTimeoutMs: 2_000,
          onCleanupFailure: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            finished = true;
          },
        }).organizationHooks;

        await hooks.afterRemoveMember(removal);

        expect(finished).toBe(true);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(
          logger.error.mock.calls.map((call) => (call[1] as { event?: string })?.event),
        ).not.toContain('room_cleanup_reporter_timed_out');
      });
    });
  });

  it('reports nothing at all when the sweep succeeds', async () => {
    // The control. Without it, a `reportCleanupFailure` called unconditionally
    // would satisfy every assertion above.
    const logger = { warn: vi.fn(), error: vi.fn() };
    const seen: RoomCleanupFailure[] = [];
    const hooks = options(
      {},
      {
        logger,
        onCleanupFailure: (f) => {
          seen.push(f);
        },
      },
    ).organizationHooks;

    await hooks.afterRemoveMember({
      member: { userId: 'user-2', organizationId: workspaceId },
      organization: { id: workspaceId },
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('lets a failed pre-removal revoke abort the removal', async () => {
    const hooks = options({
      revokeWorkspaceRooms: async () => {
        throw new Error('database is on fire');
      },
    }).organizationHooks;

    await expect(
      hooks.beforeRemoveMember({
        member: { userId: 'user-2', organizationId: workspaceId },
        organization: { id: workspaceId },
      }),
    ).rejects.toThrow(/on fire/);
  });

  /**
   * Catches: deleting the `atMost: newRole` argument from
   * `beforeUpdateMemberRole` (the demotion would then read as "reconcile to
   * whatever is committed", which pre-commit is still the *old* role — a
   * demotion that demotes nothing).
   */
  it('follows a demotion down into the rooms, before the workspace role changes', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'admin',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member: { userId: 'user-2', organizationId: workspaceId },
      newRole: 'member',
      organization: { id: workspaceId },
    });

    // A ceiling, not a value: the port applies the lower of this and whatever is
    // committed, so this call can lower the rooms and can never raise them.
    expect(syncWorkspaceRoomRoles).toHaveBeenCalledWith({
      workspaceId,
      userId: 'user-2',
      atMost: 'member',
    });
  });

  it('refuses a role change to something it cannot read', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({ syncWorkspaceRoomRoles }).organizationHooks;

    await expect(
      hooks.beforeUpdateMemberRole({
        member: { userId: 'user-2', organizationId: workspaceId },
        newRole: 'root',
        organization: { id: workspaceId },
      }),
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' });
    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });
});

/**
 * Direction, which is the part round 2 got half right.
 *
 * Revoking early is correct: a crash between the two writes leaves somebody a
 * workspace member with no rooms, which is visible and repairable. Granting
 * early is the mirror image and is *not* correct — it hands out room authority
 * the workspace row does not yet carry, and leaves it handed out if the
 * library's write then fails.
 */
describe('role changes only move in the safe direction before the commit', () => {
  const member = { userId: 'user-2', organizationId: workspaceId };

  it('does not grant a promotion before Better Auth has committed it', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'member',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'admin',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });

  /**
   * Catches: re-adding `role: data.member.role` to the `afterUpdateMemberRole`
   * call. The hook must name only *who* — a hook that can pass a role can pass
   * a stale one, which is the whole of blocking finding 1 (see the interleaving
   * test below).
   */
  it('reconciles afterwards without telling the port which role to apply', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({ syncWorkspaceRoomRoles }).organizationHooks;

    await hooks.afterUpdateMemberRole({
      member: { ...member, role: 'admin' },
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).toHaveBeenCalledWith({ workspaceId, userId: 'user-2' });
    const [call] = syncWorkspaceRoomRoles.mock.calls as unknown as [[Record<string, unknown>]];
    expect(Object.keys(call[0]).sort()).toEqual(['userId', 'workspaceId']);
  });

  it('does nothing early for a role that is not changing', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'admin',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'admin',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });

  it('treats a promotion of somebody with no membership yet as a grant, not a revoke', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => null,
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'owner',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).not.toHaveBeenCalled();
  });

  it('revokes early when the role it is moving *from* is unreadable', async () => {
    const syncWorkspaceRoomRoles = vi.fn(async () => undefined);
    const hooks = options({
      memberRole: async () => 'billing,admin',
      syncWorkspaceRoomRoles,
    }).organizationHooks;

    await hooks.beforeUpdateMemberRole({
      member,
      newRole: 'admin',
      organization: { id: workspaceId },
    });

    expect(syncWorkspaceRoomRoles).toHaveBeenCalledWith({
      workspaceId,
      userId: 'user-2',
      atMost: 'admin',
    });
  });

  /**
   * Blocking finding 1 from round 3's gauntlet, as a test.
   *
   * The stub below is `workspace_members` and `memberships` with the timing
   * taken out: a committed workspace role, a room role, and a port that behaves
   * the way `syncWorkspaceRoomRoles` behaves — it reads the committed role and
   * applies it, capped by `atMost`. No sleeps, no scheduler, no chance of
   * passing by luck.
   *
   * Then the interleaving is written out longhand, in the order that breaks it:
   * a promotion and a demotion overlap, both writes land, both after-hooks run,
   * and the *promotion's* after-hook is last. Round 3's hook passed
   * `data.member.role` — `'admin'`, captured before the demotion existed — so the
   * room rows ended on `admin` while the workspace row said `member`, and the
   * realtime server authorizes from the room rows.
   *
   * Catches: passing any role from `afterUpdateMemberRole` (`role:
   * data.member.role`, `atMost: data.member.role`, or a port that honours one).
   * Restore round 3's hook and this assertion reads `admin`.
   */
  it('cannot leave the rooms above the workspace row when two role changes overlap', async () => {
    /** The two rows, as the database would hold them. */
    const store = { committed: 'member' as string | null, rooms: 'member' as string | null };

    const hooks = atriumOrganizationOptions({
      ports: ports({
        memberRole: async () => store.committed,
        // Exactly `syncWorkspaceRoomRoles`: read what is committed, apply it,
        // never above `atMost`. The lock is what makes this atomic in Postgres;
        // here the whole port is one synchronous step, which is the same thing.
        syncWorkspaceRoomRoles: async (input: { atMost?: string }) => {
          if (store.committed === null) {
            store.rooms = null;
            return;
          }
          store.rooms =
            input.atMost === undefined ? store.committed : lowerOf(store.committed, input.atMost);
        },
      }),
      baseURL: 'https://atrium.test',
      mailer: async () => {},
      schema: {},
    }).organizationHooks;

    const target = { userId: 'user-2', organizationId: workspaceId };
    const organization = { id: workspaceId };

    // ── the promotion starts: member → admin. Not a demotion, so nothing early.
    await hooks.beforeUpdateMemberRole({ member: target, newRole: 'admin', organization });
    store.committed = 'admin'; //                       …and its write lands.

    // ── the demotion overlaps it: admin → member, all the way through.
    await hooks.beforeUpdateMemberRole({ member: target, newRole: 'member', organization });
    store.committed = 'member'; //                      …and its write lands.
    await hooks.afterUpdateMemberRole({
      member: { ...target, role: 'member' },
      organization,
    });

    // ── and only now does the promotion's after-hook get its turn.
    await hooks.afterUpdateMemberRole({ member: { ...target, role: 'admin' }, organization });

    expect(store.committed).toBe('member');
    expect(store.rooms).toBe('member');
  });

  it('still lets a promotion reach the rooms when nothing is racing it', async () => {
    // The other half of the same property: reading the committed role must not
    // quietly turn every promotion into a no-op.
    // Catches: making `syncWorkspaceRoomRoles` a demotion-only path.
    const store = { committed: 'member' as string | null, rooms: 'member' as string | null };
    const hooks = atriumOrganizationOptions({
      ports: ports({
        memberRole: async () => store.committed,
        syncWorkspaceRoomRoles: async (input: { atMost?: string }) => {
          if (store.committed === null) return;
          store.rooms =
            input.atMost === undefined ? store.committed : lowerOf(store.committed, input.atMost);
        },
      }),
      baseURL: 'https://atrium.test',
      mailer: async () => {},
      schema: {},
    }).organizationHooks;

    const target = { userId: 'user-2', organizationId: workspaceId };
    const organization = { id: workspaceId };

    await hooks.beforeUpdateMemberRole({ member: target, newRole: 'admin', organization });
    store.committed = 'admin';
    await hooks.afterUpdateMemberRole({ member: { ...target, role: 'admin' }, organization });

    expect(store.rooms).toBe('admin');
  });

  /**
   * Catches: changing `lowerOf` to prefer the argument over the committed value
   * (i.e. treating `atMost` as an instruction rather than a ceiling). A demotion
   * hook that arrives after a *further* demotion already committed must not walk
   * the rooms back up.
   */
  it('never raises the rooms through the pre-write ceiling', () => {
    expect(lowerOf('admin', 'member')).toBe('member');
    expect(lowerOf('member', 'admin')).toBe('member');
    expect(lowerOf('owner', 'admin')).toBe('admin');
    expect(lowerOf('member', 'member')).toBe('member');
    // An unreadable role on either side wins, because everything else in this
    // package resolves "I cannot read this" downward.
    expect(lowerOf('billing,admin', 'owner')).toBe('billing,admin');
    expect(lowerOf('owner', 'root')).toBe('root');
  });

  it('ranks the three roles the way the rest of the system does', () => {
    expect(isDemotion('owner', 'admin')).toBe(true);
    expect(isDemotion('admin', 'member')).toBe(true);
    expect(isDemotion('owner', 'member')).toBe(true);
    expect(isDemotion('member', 'admin')).toBe(false);
    expect(isDemotion('admin', 'admin')).toBe(false);
    expect(isDemotion(null, 'member')).toBe(false);
    expect(isDemotion('admin', 'root')).toBe(true);
  });
});

/**
 * The invitation race, made deterministic.
 *
 * `beforeCreateInvitation` reads the inviter's role; Better Auth then writes the
 * invitation. Between those two statements the inviter can be demoted or
 * removed, and round 2's code had nothing to say about it — the invitation
 * landed carrying authority its author no longer held.
 *
 * The port below is the race with the timing taken out: the first `memberRole`
 * call (the before-hook's) answers `admin`, every later call answers whatever
 * the demotion left. Running the two hooks in the order Better Auth runs them
 * then reproduces the race exactly, every time, with no sleeps.
 */
describe('afterCreateInvitation — the time-of-check/time-of-use compensation', () => {
  function racingPorts(after: string | null, overrides: Partial<OrganizationPorts> = {}) {
    let asked = 0;
    return ports({
      memberRole: async () => {
        asked += 1;
        return asked === 1 ? 'admin' : after;
      },
      ...overrides,
    });
  }

  function optionsWith(portsValue: OrganizationPorts) {
    return atriumOrganizationOptions({
      ports: portsValue,
      baseURL: 'https://atrium.test',
      mailer: async () => {},
      schema: {},
    });
  }

  const created = {
    invitation: { id: 'inv-1', role: 'admin', organizationId: workspaceId },
    inviter: { id: 'user-admin' },
    organization: { id: workspaceId },
  };

  const voided = async () => ({ outcome: 'voided' }) as const;

  it('voids an invitation whose inviter was demoted mid-flight', async () => {
    const voidInvitation = vi.fn(voided);
    const hooks = optionsWith(racingPorts('member', { voidInvitation })).organizationHooks;

    // The check the invitation was minted under: at this instant it passes.
    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();

    // …and by the time the row exists, they are a plain member.
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
    expect(voidInvitation).toHaveBeenCalledWith({ invitationId: 'inv-1', workspaceId });
  });

  it('voids one whose inviter was removed from the workspace entirely', async () => {
    const voidInvitation = vi.fn(voided);
    const hooks = optionsWith(racingPorts(null, { voidInvitation })).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
    expect(voidInvitation).toHaveBeenCalledTimes(1);
  });

  it('leaves an invitation alone when nothing changed underneath it', async () => {
    const voidInvitation = vi.fn(voided);
    const hooks = optionsWith(racingPorts('admin', { voidInvitation })).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).resolves.toBeUndefined();
    expect(voidInvitation).not.toHaveBeenCalled();
  });

  it('voids when the inviter is demoted below the role they handed out', async () => {
    // owner → admin is still an inviter, but not one who may mint an owner.
    const voidInvitation = vi.fn(voided);
    const hooks = optionsWith(
      ports({
        memberRole: (() => {
          let asked = 0;
          return async () => {
            asked += 1;
            return asked === 1 ? 'owner' : 'admin';
          };
        })(),
        voidInvitation,
      }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('owner'))).resolves.toBeUndefined();
    await expect(
      hooks.afterCreateInvitation({
        ...created,
        invitation: { ...created.invitation, role: 'owner' },
      }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' });
    expect(voidInvitation).toHaveBeenCalledTimes(1);
  });

  it('fails loudly rather than quietly when the compensation itself fails', async () => {
    const hooks = optionsWith(
      racingPorts('member', {
        voidInvitation: async () => {
          throw new Error('database is on fire');
        },
      }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('still refuses the request when the invitation had vanished entirely', async () => {
    // Nothing to void and nothing granted. The caller is told no either way;
    // the log is what carries the difference.
    const hooks = optionsWith(
      racingPorts('member', { voidInvitation: async () => ({ outcome: 'missing' }) }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  /**
   * Major finding 5 from round 3's gauntlet: the acceptance that beats the void.
   *
   * `voidInvitation` only ever moved a `pending` row, so the one ordering that
   * costs something — created, inviter demoted, invitee accepts, compensation
   * arrives — hit nothing, returned `false`, and threw a FORBIDDEN at the
   * inviter while leaving an over-privileged member and their room rows exactly
   * where the acceptance put them. Compensating the *pending row* is not
   * compensating the *state*.
   *
   * Catches: deleting the `outcome === 'accepted'` branch from
   * `afterCreateInvitation`, or collapsing `InvitationVoidOutcome` back to a
   * boolean — with either, `revokeAcceptedInvitation` is never called and this
   * fails on the first assertion.
   */
  it('undoes the membership when the invitation was accepted before it could be voided', async () => {
    const revokeAcceptedInvitation = vi.fn(async () => ({ removed: true, rooms: 2 }));
    const hooks = optionsWith(
      racingPorts('member', {
        voidInvitation: async () => ({ outcome: 'accepted', email: 'grace@example.com' }),
        revokeAcceptedInvitation,
      }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });

    expect(revokeAcceptedInvitation).toHaveBeenCalledWith({
      workspaceId,
      email: 'grace@example.com',
    });
  });

  /**
   * Catches: swallowing an error from `revokeAcceptedInvitation` (a bare
   * `.catch(() => {})`, or letting the FORBIDDEN below run anyway). An
   * over-privileged member who could not be removed is a different failure from
   * "your permission changed", and telling the inviter the second one hides the
   * first.
   */
  it('says so loudly when the acceptance could not be undone', async () => {
    const hooks = optionsWith(
      racingPorts('member', {
        voidInvitation: async () => ({ outcome: 'accepted', email: 'grace@example.com' }),
        revokeAcceptedInvitation: async () => {
          throw new Error('database is on fire');
        },
      }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
    });
  });

  /**
   * Major finding 7: `voidInvitation` returning false surfaced a FORBIDDEN to
   * the inviter with no way to tell whether anything had been done about it.
   * An already-inert row genuinely needs nothing — and must not drag a
   * compensation over a member who was never created.
   *
   * Catches: compensating on any non-`voided` outcome (e.g. `if (!voided)
   * revokeAcceptedInvitation(...)`), which would evict somebody on the strength
   * of a *cancelled* invitation.
   */
  it('compensates nothing when the row was already inert', async () => {
    const revokeAcceptedInvitation = vi.fn(async () => ({ removed: false, rooms: 0 }));
    const hooks = optionsWith(
      racingPorts('member', {
        voidInvitation: async () => ({ outcome: 'already-inert', status: 'canceled' }),
        revokeAcceptedInvitation,
      }),
    ).organizationHooks;

    await expect(hooks.beforeCreateInvitation(invitation('admin'))).resolves.toBeUndefined();
    await expect(hooks.afterCreateInvitation(created)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
    expect(revokeAcceptedInvitation).not.toHaveBeenCalled();
  });

  /**
   * Catches: dropping the `logger.error` on the `missing` branch. The inviter
   * gets the same sentence either way, so the log is the only place the
   * difference between "cancelled" and "gone" exists at all.
   */
  it('records the difference between an inert invitation and a vanished one', async () => {
    const error = vi.fn();
    const build = (outcome: OrganizationPorts['voidInvitation']) =>
      atriumOrganizationOptions({
        ports: racingPorts('member', { voidInvitation: outcome }),
        baseURL: 'https://atrium.test',
        mailer: async () => {},
        schema: {},
        logger: { warn: () => {}, error },
      }).organizationHooks;

    const missing = build(async () => ({ outcome: 'missing' }));
    await missing.beforeCreateInvitation(invitation('admin'));
    await expect(missing.afterCreateInvitation(created)).rejects.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('vanished'),
      expect.objectContaining({ invitationId: 'inv-1' }),
    );

    error.mockClear();
    const inert = build(async () => ({ outcome: 'already-inert', status: 'canceled' }));
    await inert.beforeCreateInvitation(invitation('admin'));
    await expect(inert.afterCreateInvitation(created)).rejects.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('the options themselves', () => {
  it('makes invitation email verification explicit rather than inherited', () => {
    expect(options().requireEmailVerificationOnInvitation).toBe(true);
  });

  it('gives the workspace creator ownership and expires invitations', () => {
    expect(options().creatorRole).toBe('owner');
    expect(options().invitationExpiresIn).toBe(60 * 60 * 48);
    expect(options().cancelPendingInvitationsOnReInvite).toBe(true);
  });
});

describe('assertKnownRole', () => {
  it('accepts the three roles and nothing else', () => {
    expect(assertKnownRole('owner')).toBe('owner');
    expect(assertKnownRole('admin')).toBe('admin');
    expect(assertKnownRole('member')).toBe('member');
    expect(() => assertKnownRole('root')).toThrow();
    expect(() => assertKnownRole(['admin', 'billing'])).toThrow();
    expect(() => assertKnownRole(undefined)).toThrow();
    expect(() => assertKnownRole(42)).toThrow();
  });
});
