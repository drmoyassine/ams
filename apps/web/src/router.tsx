import { QueryClient } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import { authClient } from './lib/auth';
import { can, useMe } from './lib/me';
import { defaultSettingsApi } from './lib/settings-api';
import { EngagementPage } from './pages/engagement';
import { NewEngagementPage } from './pages/engagement-new';
import { EngagementsPage } from './pages/engagements';
import { QualityManagementPage, QM_TABS, type QmTab } from './pages/quality-management';
import { CyclePage } from './pages/cycles/cycle-page';
import { AppLayout } from './pages/layout';
import { EvidencePage } from './pages/evidence';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
import { FrameworksPage } from './pages/frameworks';
import { LoginPage } from './pages/login';
import { RequirementWorkspacePage } from './pages/requirement-workspace';
import { RequestsPage } from './pages/requests';
import { RespondPage } from './pages/respond';
import { AnswerFormPage, PublicFormPage } from './pages/answer-form';
import { OrganizationPage, type OrganizationTab } from './pages/settings/organization';
import { SettingsLayout } from './pages/settings/layout';
import { AiSettingsPage } from './pages/settings/ai';
import { AssistantMemoryPage } from './pages/settings/assistant-memory';
import { TrashPage } from './pages/settings/trash';
import { DocumentsPage } from './pages/settings/documents';
import { QualityManagementSettingsPage } from './pages/settings/quality-management/templates-page';
import { TemplateEditorPage } from './pages/settings/quality-management/template-editor';
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
// The home page is the list of engagements; programs live in Settings -> Organization.
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', beforeLoad: () => { throw redirect({ to: '/engagements' }); } });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsLayout });
const settingsIndexRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/', beforeLoad: () => { throw redirect({ to: '/settings/organization' }); } });
// Organization: two tabs, deep-linkable as ?tab=institution|programs (the address follows the tab, replacing the entry).
const organizationRoute = createRoute({
  getParentRoute: () => settingsRoute, path: '/organization', component: () => <OrganizationRoute />,
  validateSearch: (s: Record<string, unknown>): { tab?: OrganizationTab } => (s.tab === 'institution' || s.tab === 'programs' ? { tab: s.tab } : {}),
});
function OrganizationRoute() {
  const { tab } = organizationRoute.useSearch();
  const navigate = organizationRoute.useNavigate();
  // The parent routes pass the raw address through, so an unknown value is dropped here as well.
  return <OrganizationPage tab={tab === 'programs' ? 'programs' : 'institution'} onTab={(t) => { void navigate({ search: { tab: t }, replace: true }); }} />;
}
// The glossary lives inside the internal quality framework page; the old address still works.
const glossaryRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/glossary', beforeLoad: () => { throw redirect({ to: '/settings/quality-framework' }); } });
const qualityRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/quality-framework', component: () => <QualityFrameworkPage /> });
// Programs moved under Organization; the old address still works.
const programsSettingsRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/programs', beforeLoad: () => { throw redirect({ to: '/settings/organization', search: { tab: 'programs' } }); } });
// External standards (accreditors' frameworks) live in Settings beside the internal one; the old addresses still work.
const documentsRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/documents', component: () => <DocumentsPage /> });
// The Trash is for people who can edit standards; anyone else who opens the address is told so (the menu hides it too).
const trashRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/trash', component: () => <TrashRoute /> });
function TrashRoute() {
  const me = useMe(defaultSettingsApi);
  if (!me.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!can(me.data, 'framework:write')) return <p role="note" className="text-sm text-muted-foreground">The Trash is only for people who can edit standards.</p>;
  return <TrashPage />;
}
const aiSettingsRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/ai', component: () => <AiSettingsPage /> });
// What the assistant remembers (DEC-027): anyone who can use the assistant sees their own and the shared notes they may read.
const assistantMemoryRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/assistant-memory', component: () => <AssistantMemoryPage /> });
const frameworksRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/external-standards', component: () => <FrameworksPage /> });
// Cycle templates (DEC-029, TASK-079): the list, and one template's editor (read-only for people who cannot manage cycles).
const qmSettingsRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/quality-management', component: () => <QmSettingsRoute /> });
function QmSettingsRoute() {
  const navigate = qmSettingsRoute.useNavigate();
  return <QualityManagementSettingsPage onOpen={(id) => { void navigate({ to: '/settings/quality-management/$templateId', params: { templateId: id } }); }} />;
}
const qmTemplateRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/quality-management/$templateId', component: () => <QmTemplateRoute /> });
function QmTemplateRoute() {
  const { templateId } = qmTemplateRoute.useParams();
  const navigate = qmTemplateRoute.useNavigate();
  return <TemplateEditorPage key={templateId} templateId={templateId} onBack={() => { void navigate({ to: '/settings/quality-management' }); }} />;
}
const versionRoute = createRoute({
  getParentRoute: () => settingsRoute, path: '/versions/$versionId', component: () => <VersionRoute />,
  // ?tab=settings&section=details opens a version on its settings (the card's "Edit details").
  // ?tab=report&run=<id> opens a version on the report of one analysis run, and can be opened again later.
  // ?req=<id> opens a version on one requirement's card, ?doc=<id>&page=<n> on a page of one source (the assistant's links).
  // ?tab=docs opens the Docs tab (the old ?tab=settings&section=sources is redirected there, see beforeLoad).
  beforeLoad: ({ params, search }) => {
    if (search.tab === 'settings' && search.section === 'sources') {
      const rest = { ...search };
      delete rest.tab;
      delete rest.section;
      throw redirect({ to: '/settings/versions/$versionId', params, search: { ...rest, tab: 'docs' }, replace: true });
    }
  },
  validateSearch: (s: Record<string, unknown>): { tab?: 'settings' | 'report' | 'mappings' | 'docs'; section?: 'details' | 'sources'; run?: string; req?: string; doc?: string; page?: number } => ({
    ...(typeof s.req === 'string' && /^[0-9a-f-]{36}$/i.test(s.req) ? { req: s.req } : {}), ...(typeof s.doc === 'string' && /^[0-9a-f-]{36}$/i.test(s.doc) && Number.isInteger(Number(s.page)) && Number(s.page) >= 1 ? { doc: s.doc, page: Number(s.page) } : {}),
    ...(s.tab === 'settings' || s.tab === 'report' || s.tab === 'mappings' || s.tab === 'docs' ? { tab: s.tab } : {}), ...(s.section === 'details' || s.section === 'sources' ? { section: s.section } : {}),
    ...(typeof s.run === 'string' && /^[0-9a-f-]{36}$/i.test(s.run) ? { run: s.run } : {}),
  }),
});
const oldStandardsRoute = createRoute({ getParentRoute: () => appRoute, path: '/standards', beforeLoad: () => { throw redirect({ to: '/settings/external-standards' }); } });
const oldVersionRoute = createRoute({ getParentRoute: () => appRoute, path: '/versions/$versionId', beforeLoad: ({ params }) => { throw redirect({ to: '/settings/versions/$versionId', params }); } });
function VersionRoute() {
  const { versionId } = versionRoute.useParams();
  const { tab, section, run, req, doc, page } = versionRoute.useSearch();
  const navigate = versionRoute.useNavigate();
  // The address follows the tab and the selected run (replacing the entry), so a report can be bookmarked and reopened.
  const onLocation = (where: { tab: 'requirements' | 'mappings' | 'report' | 'docs' | 'settings'; run?: string }) => {
    void navigate({ search: where.tab === 'requirements' ? {} : { tab: where.tab, ...(where.run ? { run: where.run } : {}) }, replace: true });
  };
  return <VersionPage key={versionId} versionId={versionId} onLocation={onLocation} {...(tab ? { initialTab: tab } : {})} {...(section ? { initialSection: section } : {})} {...(run ? { initialRunId: run } : {})} {...(req ? { initialFocusRequirement: req } : {})} {...(doc && page ? { initialFocusPage: { documentId: doc, page } } : {})} />;
}
// Quality Management: ?tab=standards|cycles|my-work (the address follows the tab, replacing the entry), and one cycle's own page, which
// ?stage=<id> opens on one stage (the links of My work).
const qualityManagementRoute = createRoute({
  getParentRoute: () => appRoute, path: '/quality-management', component: () => <QualityManagementRoute />,
  validateSearch: (s: Record<string, unknown>): { tab?: QmTab } => (QM_TABS.some((x) => x.id === s.tab) ? { tab: s.tab as QmTab } : {}),
});
function QualityManagementRoute() {
  const { tab } = qualityManagementRoute.useSearch();
  const navigate = qualityManagementRoute.useNavigate();
  return <QualityManagementPage tab={tab ?? 'standards'} onTab={(next) => { void navigate({ search: next === 'standards' ? {} : { tab: next }, replace: true }); }} />;
}
const cycleRoute = createRoute({
  getParentRoute: () => appRoute, path: '/quality-management/cycles/$id', component: () => <CycleRoute />,
  validateSearch: (s: Record<string, unknown>): { stage?: string } => (typeof s.stage === 'string' && /^[0-9a-f-]{36}$/i.test(s.stage) ? { stage: s.stage } : {}),
});
function CycleRoute() {
  const { id } = cycleRoute.useParams();
  const { stage } = cycleRoute.useSearch();
  const navigate = cycleRoute.useNavigate();
  return <CyclePage key={id} id={id} stageId={stage} onBack={() => { void navigate({ to: '/quality-management', search: { tab: 'cycles' } }); }} />;
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

const routeTree = rootRoute.addChildren([loginRoute, respondRoute, publicFormRoute, appRoute.addChildren([homeRoute, settingsRoute.addChildren([settingsIndexRoute, organizationRoute, programsSettingsRoute, qualityRoute, frameworksRoute, qmSettingsRoute, qmTemplateRoute, aiSettingsRoute, assistantMemoryRoute, trashRoute, documentsRoute, versionRoute, glossaryRoute]), oldStandardsRoute, oldVersionRoute, qualityManagementRoute, cycleRoute, engagementsRoute, newEngagementRoute, engagementRoute, workspaceRoute, evidenceRoute, requestsRoute, answerFormRoute])]);
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
