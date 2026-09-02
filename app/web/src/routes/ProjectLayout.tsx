import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useProject } from '../lib/queries.js';
import { ErrorState, LoadingBlock, Pill, formatDate } from '../ui/index.js';
import { ApiError } from '../lib/api.js';

export function ProjectLayout(): JSX.Element {
  const { orgSlug = '', projectKey = '' } = useParams();
  const project = useProject(orgSlug, projectKey);

  if (project.isLoading) return <LoadingBlock label="Loading project" />;
  if (project.error) {
    const err = project.error instanceof ApiError ? project.error : null;
    return (
      <ErrorState
        title={err?.isForbidden ? 'No access to this project' : err?.isNotFound ? 'Project not found' : 'Could not load project'}
        message={
          err?.isForbidden
            ? 'Ask a project lead to add you as a member.'
            : (err?.body.detail ?? 'Unexpected error loading this project.')
        }
        onRetry={err?.isForbidden ? undefined : () => void project.refetch()}
      />
    );
  }

  const base = `/o/${orgSlug}/p/${projectKey}`;
  const p = project.data!;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="row">
            <span className="ref">{p.key}</span>
            {p.state === 'archived' && <Pill tone="warn">Archived</Pill>}
          </div>
          <h1>{p.name}</h1>
          <div className="page-sub">
            {p.members.length} member{p.members.length === 1 ? '' : 's'}
            {p.targetDate && ` · target ${formatDate(p.targetDate)}`}
          </div>
        </div>
      </div>
      <nav className="tabs" aria-label="Project sections">
        <NavLink to={`${base}/board`} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
          Board
        </NavLink>
        <NavLink to={`${base}/backlog`} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
          Backlog
        </NavLink>
        <NavLink to={`${base}/blockers`} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
          Blockers
        </NavLink>
        <NavLink to={`${base}/activity`} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
          Activity
        </NavLink>
      </nav>
      <Outlet />
    </>
  );
}
