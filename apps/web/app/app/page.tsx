import type { Metadata } from 'next';
import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { listWorkspacesFor } from '@/lib/workspaces';
import { createWorkspaceAction } from './actions';
import styles from './workspace.module.css';

export const metadata: Metadata = { title: 'Workspaces · Atrium' };
export const dynamic = 'force-dynamic';

const errors: Record<string, string> = {
  invalid_name: 'Give the workspace a name.',
  create_failed: 'Could not create that workspace. Try a different name.',
  no_such_workspace: 'That workspace does not exist, or you are not a member of it.',
};

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession('/app');
  const { error } = await searchParams;
  const workspaces = await listWorkspacesFor(session.userId);

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Workspaces</h1>
      </div>
      <p className={styles.lede}>
        Signed in as <span className={styles.rowMeta}>{session.email}</span>.
      </p>

      {error ? (
        <p className={styles.error} role="alert" data-testid="form-error">
          {errors[error] ?? 'Something went wrong.'}
        </p>
      ) : null}

      <section className={styles.section} aria-labelledby="your-workspaces">
        <h2 className={styles.sectionTitle} id="your-workspaces">
          Your workspaces
        </h2>
        {workspaces.length === 0 ? (
          <p className={styles.empty} data-testid="no-workspaces">
            None yet. Create one below and you will land in its first room.
          </p>
        ) : (
          <ul className={styles.list} data-testid="workspace-list">
            {workspaces.map((workspace) => (
              <li className={styles.row} key={workspace.id}>
                <span className={styles.rowMain}>
                  <Link className={styles.link} href={`/app/${workspace.slug}`}>
                    {workspace.name}
                  </Link>
                  <span className={styles.rowMeta}>/{workspace.slug}</span>
                </span>
                <span className={styles.roleTag}>{workspace.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="new-workspace">
        <h2 className={styles.sectionTitle} id="new-workspace">
          New workspace
        </h2>
        <form action={createWorkspaceAction} className={styles.inlineForm}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="workspace-name">
              Name
            </label>
            <input
              className={styles.input}
              id="workspace-name"
              maxLength={80}
              name="name"
              placeholder="Ada's team"
              required
              type="text"
            />
          </div>
          <button className={styles.button} type="submit">
            Create workspace
          </button>
        </form>
      </section>
    </main>
  );
}
