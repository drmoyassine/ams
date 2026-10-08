import { QueryClient } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import { authClient } from './lib/auth';
import { EngagementPage } from './pages/engagement';
import { NewEngagementPage } from './pages/engagement-new';
import { EngagementsPage } from './pages/engagements';
import { AppLayout } from './pages/layout';
import { EvidencePage } from './pages/evidence';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
import { FrameworksPage } from './pages/frameworks';
import { LoginPage } from './pages/login';
import { RequirementWorkspacePage } from './pages/requirement-workspace';
import { RequestsPage } from './pages/requests';
import { RespondPage } from './pages/respond';
import { AnswerFormPage, PublicFormPage } from './pages/answer-form';
import { OrganizationPage } from './pages/settings/organization';
import { ProgramsSettingsPage } from './pages/settings/programs';
import { SettingsLayout } from './pages/settings/layout';
import { AiSettingsPage } from './pages/settings/ai';
import { VersionPage } from './pages/version';

export const queryClient = new QueryClient();

const rootRoute = createRootRoute({ component: Outlet });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: () => <LoginPage /> });
// A one-time response link (DEC-018): outside the signed-in app, no session needed.
const respondRoute = createRoute({ getParentRoute: () => rootRoute, path: '/respond/$token', component: () => <RespondRoute /> });
function RespondRoute() { const { token } = respondRoute.useParams(); return <RespondPage key={token} token={token} />; }
// A public form link (DEC-020): outside the signed-in app.
const publicFormRoute = createRoute({ getParentRoute: () => rootRoute, path: '/f/$token', component: () => <PublicFormRoute /> });
function PublicFormRoute() { const { token } = publicFormRoute.useParams(); return <PublicFormPage key={token} token={token} />; }
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
// The glossary lives inside the internal quality framework page; the old address still works.
const glossaryRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/glossary', beforeLoad: () => { throw redirect({ to: '/settings/quality-framework' }); } });
const qualityRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/quality-framework', component: () => <QualityFrameworkPage /> });
const programsSettingsRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/programs', component: () => <ProgramsSettingsPage /> });
// External standards (accreditors' frameworks) live in Settings beside the internal one; the old addresses still work.
const aiSettingsRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/ai', component: () => <AiSettingsPage /> });
const frameworksRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/external-standards', component: () => <FrameworksPage /> });
const versionRoute = createRoute({
  getParentRoute: () => settingsRoute, path: '/versions/$versionId', component: () => <VersionRoute />,
  // ?tab=settings&section=details opens a version on its settings (the card's "Edit details").
  validateSearch: (s: Record<string, unknown>): { tab?: 'settings'; section?: 'details' | 'sources' } => ({
    ...(s.tab === 'settings' ? { tab: 'settings' as const } : {}), ...(s.section === 'details' || s.section === 'sources' ? { section: s.section } : {}),
  }),
});
const oldStandardsRoute = createRoute({ getParentRoute: () => appRoute, path: '/standards', beforeLoad: () => { throw redirect({ to: '/settings/external-standards' }); } });
const oldVersionRoute = createRoute({ getParentRoute: () => appRoute, path: '/versions/$versionId', beforeLoad: ({ params }) => { throw redirect({ to: '/settings/versions/$versionId', params }); } });
function VersionRoute() {
  const { versionId } = versionRoute.useParams();
  const { tab, section } = versionRoute.useSearch();
  return <VersionPage key={versionId} versionId={versionId} {...(tab ? { initialTab: tab } : {})} {...(section ? { initialSection: section } : {})} />;
}
const engagementsRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagements', component: () => <EngagementsPage /> });
const newEngagementRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagements/new', component: () => <NewEngagementPage /> });
const engagementRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagements/$id', component: () => <EngagementRoute /> });
function EngagementRoute() { const { id } = engagementRoute.useParams(); return <EngagementPage key={id} id={id} />; }
const workspaceRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagement-requirements/$id', component: () => <WorkspaceRoute /> });
function WorkspaceRoute() { const { id } = workspaceRoute.useParams(); return <RequirementWorkspacePage key={id} id={id} />; }
const evidenceRoute = createRoute({ getParentRoute: () => appRoute, path: '/evidence', component: () => <EvidencePage /> });
const answerFormRoute = createRoute({ getParentRoute: () => appRoute, path: '/forms/$id', component: () => <AnswerFormRoute /> });
function AnswerFormRoute() { const { id } = answerFormRoute.useParams(); return <AnswerFormPage key={id} itemId={id} />; }
const requestsRoute = createRoute({ getParentRoute: () => appRoute, path: '/requests', component: () => <RequestsPage /> });

const routeTree = rootRoute.addChildren([loginRoute, respondRoute, publicFormRoute, appRoute.addChildren([homeRoute, settingsRoute.addChildren([settingsIndexRoute, organizationRoute, programsSettingsRoute, qualityRoute, frameworksRoute, aiSettingsRoute, versionRoute, glossaryRoute]), oldStandardsRoute, oldVersionRoute, engagementsRoute, newEngagementRoute, engagementRoute, workspaceRoute, evidenceRoute, requestsRoute, answerFormRoute])]);
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
