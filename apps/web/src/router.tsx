import { QueryClient } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import { authClient } from './lib/auth';
import { EngagementPage } from './pages/engagement';
import { NewEngagementPage } from './pages/engagement-new';
import { EngagementsPage } from './pages/engagements';
import { AppLayout, ComingSoon } from './pages/layout';
import { FrameworksPage } from './pages/frameworks';
import { LoginPage } from './pages/login';
import { RequirementWorkspacePage } from './pages/requirement-workspace';
import { GlossaryPage } from './pages/settings/glossary';
import { OrganizationPage } from './pages/settings/organization';
import { ProgramsSettingsPage } from './pages/settings/programs';
import { SettingsLayout } from './pages/settings/layout';
import { VersionPage } from './pages/version';

export const queryClient = new QueryClient();

const rootRoute = createRootRoute({ component: Outlet });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: () => <LoginPage /> });
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppLayout,
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: '/login' });
  },
});
// The home page is the list of engagements; programs live in Settings.
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', beforeLoad: () => { throw redirect({ to: '/engagements' }); } });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsLayout });
const settingsIndexRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/', beforeLoad: () => { throw redirect({ to: '/settings/organization' }); } });
const organizationRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/organization', component: () => <OrganizationPage /> });
const glossaryRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/glossary', component: () => <GlossaryPage /> });
const programsSettingsRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/programs', component: () => <ProgramsSettingsPage /> });
const frameworksRoute = createRoute({ getParentRoute: () => appRoute, path: '/standards', component: () => <FrameworksPage /> });
const versionRoute = createRoute({ getParentRoute: () => appRoute, path: '/versions/$versionId', component: () => <VersionRoute /> });
function VersionRoute() { const { versionId } = versionRoute.useParams(); return <VersionPage key={versionId} versionId={versionId} />; }
const engagementsRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagements', component: () => <EngagementsPage /> });
const newEngagementRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagements/new', component: () => <NewEngagementPage /> });
const engagementRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagements/$id', component: () => <EngagementRoute /> });
function EngagementRoute() { const { id } = engagementRoute.useParams(); return <EngagementPage key={id} id={id} />; }
const workspaceRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagement-requirements/$id', component: () => <WorkspaceRoute /> });
function WorkspaceRoute() { const { id } = workspaceRoute.useParams(); return <RequirementWorkspacePage key={id} id={id} />; }
const evidenceRoute = createRoute({ getParentRoute: () => appRoute, path: '/evidence', component: () => <ComingSoon title="Evidence" /> });

const routeTree = rootRoute.addChildren([loginRoute, appRoute.addChildren([homeRoute, settingsRoute.addChildren([settingsIndexRoute, organizationRoute, programsSettingsRoute, glossaryRoute]), frameworksRoute, versionRoute, engagementsRoute, newEngagementRoute, engagementRoute, workspaceRoute, evidenceRoute])]);
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
