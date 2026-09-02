import { z } from 'zod';
import { ORG_ROLES } from '../enums.js';

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Use lowercase letters, numbers and dashes');

export const createOrgInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  slug: slug.optional(),
});
export type CreateOrgInput = z.infer<typeof createOrgInput>;

export const org = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(ORG_ROLES),
  createdAt: z.string(),
});
export type Org = z.infer<typeof org>;

export const orgMember = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ORG_ROLES),
  joinedAt: z.string(),
});
export type OrgMember = z.infer<typeof orgMember>;

export const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(['admin', 'member']),
});
export type InviteInput = z.infer<typeof inviteInput>;

export const updateMemberRoleInput = z.object({ role: z.enum(ORG_ROLES) });

export const createTeamInput = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(z.string().uuid()).default([]),
});
export type CreateTeamInput = z.infer<typeof createTeamInput>;

export const team = z.object({
  id: z.string().uuid(),
  name: z.string(),
  memberIds: z.array(z.string().uuid()),
});
export type Team = z.infer<typeof team>;
