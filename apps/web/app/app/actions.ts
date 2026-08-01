'use server';

import { authorize } from '@atrium/auth';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { requireSession } from '@/lib/session';
import { loadWorkspace, slugify } from '@/lib/workspaces';

/**
 * Workspace mutations.
 *
 * Two rules run through all of them. The membership is re-read from the
 * database inside the action and passed to `authorize()` — a hidden field
 * saying "I am an admin" is a claim, not a fact. And Better Auth performs the
 * actual write, so the invitation state machine and the transactional accept
 * stay the library's problem rather than becoming ours.
 */

const WorkspaceName = z.string().trim().min(1).max(80);
const InviteForm = z.object({
  email: z.email().max(320),
  role: z.enum(['member', 'admin']),
});

export async function createWorkspaceAction(formData: FormData): Promise<never> {
  const session = await requireSession('/app');
  const name = WorkspaceName.safeParse(formData.get('name'));
  if (!name.success) redirect('/app?error=invalid_name');

  const base = slugify(name.data) || 'workspace';
  // Slugs are unique across the table, so two people naming a workspace
  // "Design" is ordinary rather than exceptional. Take the clean slug if it is
  // free and a suffixed one if it is not, instead of making someone rename.
  const candidates = [base, `${base}-${randomSuffix()}`, `${base}-${randomSuffix()}`];

  let created: string | null = null;
  for (const slug of candidates) {
    try {
      await auth().api.createOrganization({
        body: { name: name.data, slug, userId: session.userId },
        headers: await headers(),
      });
      created = slug;
      break;
    } catch {
      // Almost certainly the unique index. Try the next candidate.
    }
  }

  if (!created) redirect('/app?error=create_failed');
  revalidatePath('/app');
  redirect(`/app/${created}`);
}

export async function inviteMemberAction(formData: FormData): Promise<never> {
  const session = await requireSession('/app');
  const workspaceSlug = String(formData.get('workspaceSlug') ?? '');
  const parsed = InviteForm.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
  });

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) redirect('/app?error=no_such_workspace');

  // The single authorization seam, on the workspace side of the fence.
  const decision = authorize('workspace.invite', workspace, { scope: 'workspace' });
  if (!decision.allowed) redirect(`/app/${workspaceSlug}?error=not_allowed`);
  if (!parsed.success) redirect(`/app/${workspaceSlug}?error=invalid_email`);

  let failure: string | null = null;
  try {
    await auth().api.createInvitation({
      body: {
        email: parsed.data.email,
        role: parsed.data.role,
        organizationId: workspace.id,
        resend: true,
      },
      headers: await headers(),
    });
  } catch {
    failure = 'invite_failed';
  }

  if (failure) redirect(`/app/${workspaceSlug}?error=${failure}`);
  revalidatePath(`/app/${workspaceSlug}`);
  redirect(`/app/${workspaceSlug}?invited=${encodeURIComponent(parsed.data.email)}`);
}

/**
 * Accepting an invitation. Better Auth moves the row out of `pending` with a
 * conditional update, which is what makes the link single-use — a second attempt
 * finds nothing pending and fails, whoever is holding it.
 */
export async function acceptInvitationAction(formData: FormData): Promise<never> {
  const invitationId = String(formData.get('invitationId') ?? '');
  if (!invitationId) redirect('/app');
  await requireSession(`/invite/${invitationId}`);

  let failure: string | null = null;
  try {
    await auth().api.acceptInvitation({
      body: { invitationId },
      headers: await headers(),
    });
  } catch {
    failure = 'accept_failed';
  }

  if (failure) redirect(`/invite/${invitationId}?error=${failure}`);
  revalidatePath('/app');
  redirect('/app');
}

/** 5 characters of base36 — enough to make a slug collision uninteresting. */
function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 5);
}
