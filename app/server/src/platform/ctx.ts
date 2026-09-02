import type { OrgRole, ProjectRole } from '@outcome/shared';
import type { Queryable } from './db.js';

/**
 * Request context. Tenancy is an explicit argument everywhere — never
 * ambient — so a service method cannot accidentally read another org.
 */
export interface UserCtx {
  userId: string;
  sessionId: string | null;
  apiKeyId: string | null;
  requestId: string;
}

export interface OrgCtx extends UserCtx {
  orgId: string;
  orgRole: OrgRole;
}

export interface ProjectCtx extends OrgCtx {
  projectId: string;
  projectRole: ProjectRole;
}

export type Tx = Queryable;
