import { describe, expect, it, vi } from 'vitest';
import { roomRole } from '../src/workspace.js';

/**
 * The room-grant hook's role reading.
 *
 * Round 1 had `parseRole(role) ?? 'member'` here while `authorize()` denied the
 * very same string — the same input, two files, opposite fail directions. The
 * grant side now denies too, and says so in the log, because a role we cannot
 * read is either a bug or an attack and both want a line.
 */

describe('roomRole', () => {
  it('maps the three roles across unchanged', () => {
    expect(roomRole('owner')).toBe('owner');
    expect(roomRole('admin')).toBe('admin');
    expect(roomRole('member')).toBe('member');
  });

  it('reads better auth’s multi-role value', () => {
    expect(roomRole('member,admin')).toBe('admin');
  });

  it('denies an unrecognised role instead of quietly granting member', () => {
    expect(roomRole('superuser')).toBeNull();
    expect(roomRole('billing,admin')).toBeNull();
    expect(roomRole('')).toBeNull();
  });

  it('flags the denial so it is findable in the log', () => {
    const warn = vi.fn();
    expect(roomRole('billing,admin', { warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unrecognised'),
      expect.objectContaining({ unknownRole: true, role: 'billing,admin' }),
    );
  });

  it('says nothing when the role is fine', () => {
    const warn = vi.fn();
    expect(roomRole('admin', { warn })).toBe('admin');
    expect(warn).not.toHaveBeenCalled();
  });
});
