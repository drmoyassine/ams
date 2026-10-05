import { QueryClient } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, redirect, Outlet } from '@tanstack/react-router';
import { authClient } from './lib/auth';
import { AppLayout, ComingSoon } from './pages/layout';
import { LoginPage } from './pages/login';
import { ProgramsPage } from './pages/programs';

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
const programsRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: () => <ProgramsPage /> });
const engagementsRoute = createRoute({ getParentRoute: () => appRoute, path: '/engagements', component: () => <ComingSoon title="Engagements" /> });
const evidenceRoute = createRoute({ getParentRoute: () => appRoute, path: '/evidence', component: () => <ComingSoon title="Evidence" /> });

const routeTree = rootRoute.addChildren([loginRoute, appRoute.addChildren([programsRoute, engagementsRoute, evidenceRoute])]);
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
