import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useSession, useLogout } from '../lib/session.js';
import { useNotifications, useProjects } from '../lib/queries.js';
import { Button } from '../ui/index.js';

export function AppShell(): JSX.Element {
  const { orgSlug = '' } = useParams();
  const { me } = useSession();
  const logout = useLogout();
  const projects = useProjects(orgSlug);
  const notifications = useNotifications(orgSlug);
  const org = me?.orgs.find((o) => o.slug === orgSlug);
  const unread = notifications.data?.unreadCount ?? 0;

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" />
          Outcome
        </div>
        <NavLink to={`/o/${orgSlug}`} end className="nav-link">
          Dashboard
        </NavLink>
        <NavLink to={`/o/${orgSlug}/capture`} className="nav-link">
          Brain dump
        </NavLink>
        <NavLink to={`/o/${orgSlug}/assistant`} className="nav-link">
          Assistant
        </NavLink>
        <NavLink to={`/o/${orgSlug}/me`} className="nav-link">
          My work
        </NavLink>
        <NavLink to={`/o/${orgSlug}/inbox`} className="nav-link">
          <span>Inbox</span>
          {unread > 0 && <span className="nav-badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink to={`/o/${orgSlug}/search`} className="nav-link">
          Search
        </NavLink>

        <div className="nav-section">Projects</div>
        {projects.data?.slice(0, 12).map((p) => (
          <NavLink key={p.id} to={`/o/${orgSlug}/p/${p.key}/board`} className="nav-link">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            {p.openBlockerCount > 0 && (
              <span className="nav-badge" title={`${p.openBlockerCount} open blockers`}>
                {p.openBlockerCount}
              </span>
            )}
          </NavLink>
        ))}
        <NavLink to={`/o/${orgSlug}/projects`} className="nav-link">
          All projects…
        </NavLink>

        <div className="nav-section">Organization</div>
        <NavLink to={`/o/${orgSlug}/team`} className="nav-link">
          Team
        </NavLink>
        <NavLink to={`/o/${orgSlug}/activity`} className="nav-link">
          Activity
        </NavLink>
        <NavLink to={`/o/${orgSlug}/settings/integrations/jira`} className="nav-link">
          Import from Jira
        </NavLink>
      </nav>

      <div className="main">
        <header className="topbar">
          <strong style={{ fontSize: 13 }}>{org?.name ?? orgSlug}</strong>
          {org && <span className="chip">{org.role}</span>}
          <span className="spacer" />
          <NavLink to={`/o/${orgSlug}/capture`} className="btn btn-primary btn-sm">
            Brain dump
          </NavLink>
          <span className="page-sub">{me?.user.name}</span>
          <Button variant="ghost" size="sm" onClick={logout}>
            Sign out
          </Button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
