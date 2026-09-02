import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from '../lib/session.js';
import { LoadingBlock } from '../ui/index.js';
import { Login } from './Login.js';
import { Onboarding } from './Onboarding.js';
import { AppShell } from './AppShell.js';
import { Dashboard } from './Dashboard.js';
import { MyWork } from './MyWork.js';
import { Inbox } from './Inbox.js';
import { Search } from './Search.js';
import { Projects } from './Projects.js';
import { ProjectLayout } from './ProjectLayout.js';
import { Backlog } from './Backlog.js';
import { Blockers } from './Blockers.js';
import { Team } from './Team.js';
import { OrgActivity, ProjectActivity } from './Activity.js';
import { AcceptInvite } from './AcceptInvite.js';
import { Board } from '../features/board/Board.js';
import { Capture } from '../features/braindump/Capture.js';
import { JiraImport } from '../features/importer/JiraImport.js';
import { Assistant } from '../features/assistant/Assistant.js';
import { TaskDrawer } from '../features/tasks/TaskDrawer.js';

/** Gate for signed-in routes; sends unauthenticated users to /login. */
function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { me, loading } = useSession();
  if (loading) {
    return (
      <div className="content">
        <LoadingBlock label="Loading Outcome" />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

/** Sends the user to their first org, or to onboarding if they have none. */
function HomeRedirect(): JSX.Element {
  const { me, loading } = useSession();
  if (loading) {
    return (
      <div className="content">
        <LoadingBlock label="Loading" />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;
  const first = me.orgs[0];
  return <Navigate to={first ? `/o/${first.slug}` : '/onboarding'} replace />;
}

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<Login mode="login" />} />
      <Route path="/signup" element={<Login mode="signup" />} />
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <Onboarding />
          </RequireAuth>
        }
      />
      <Route
        path="/o/:orgSlug"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="me" element={<MyWork />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="search" element={<Search />} />
        <Route path="capture" element={<Capture />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="settings/integrations/jira" element={<JiraImport />} />
        <Route path="projects" element={<Projects />} />
        <Route path="team" element={<Team />} />
        <Route path="activity" element={<OrgActivity />} />
        <Route path="p/:projectKey" element={<ProjectLayout />}>
          <Route index element={<Navigate to="board" replace />} />
          {/* Pathless layout: the board stays mounted, and the canonical task
              URL /p/:key/t/:number renders the drawer over it (deep-linkable). */}
          <Route element={<Board />}>
            <Route path="board" element={null} />
            <Route path="t/:number" element={<TaskDrawer />} />
          </Route>
          <Route path="backlog" element={<Backlog />} />
          <Route path="blockers" element={<Blockers />} />
          <Route path="activity" element={<ProjectActivity />} />
        </Route>
      </Route>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}
