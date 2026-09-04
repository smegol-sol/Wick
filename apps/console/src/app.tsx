import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { WickMark } from "@/components/mark";
import { isMock } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { EngineScreen } from "@/screens/engine";
import { NowScreen } from "@/screens/now";
import { TokenScreen } from "@/screens/token";

function Shell() {
  const tab =
    "h-10 rounded-sm px-3 text-sm font-medium text-muted hover:text-fg [&.active]:bg-elevated [&.active]:text-fg";
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 px-3 py-3 sm:px-4">
      <header className="flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-2">
          <WickMark className="size-6" />
          <span className="text-sm font-medium tracking-tight">WICK</span>
          {isMock() ? <span className="font-mono text-2xs text-accent">{t("mock")}</span> : null}
        </Link>
        <nav className="flex items-center gap-1">
          <Link to="/" className={cn(tab)} activeOptions={{ exact: true }}>
            {t("now")}
          </Link>
          <Link to="/engine" className={cn(tab)}>
            {t("engine")}
          </Link>
        </nav>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell });
const nowRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: NowScreen });
const engineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/engine",
  component: EngineScreen,
});
const tokenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/token/$mint",
  component: TokenScreen,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([nowRoute, engineRoute, tokenRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultQueries: { queries: { staleTime: 3000, refetchOnWindowFocus: true } },
} as never);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
