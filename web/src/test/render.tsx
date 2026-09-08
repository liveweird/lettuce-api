/* eslint-disable react-refresh/only-export-components -- test-only helper module (never HMR'd): exports renderWithProviders/renderAppAt plus a testing-library re-export barrel, not a component */
import { type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { appRoutes } from "../App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AppDatesProvider from "../components/AppDatesProvider";
import { theme } from "../theme";
import { cssVariablesResolver } from "../themeVariables";
import SessionCacheBoundary from "../api/SessionCacheBoundary";

interface Options extends Omit<RenderOptions, "wrapper"> {
  route?: string;
}

export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const { route = "/", ...rest } = options;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(ui, {
    wrapper: ({ children }) => (
      <MantineProvider env="test" theme={theme} cssVariablesResolver={cssVariablesResolver}>
        <AppDatesProvider>
          <QueryClientProvider client={queryClient}>
            <SessionCacheBoundary>
              <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
            </SessionCacheBoundary>
          </QueryClientProvider>
        </AppDatesProvider>
      </MantineProvider>
    ),
    ...rest,
  });
}

/**
 * The whole app (shell + route tree) at `route`, on the DATA router the real app uses
 * (`createMemoryRouter` over `appRoutes`) — the only way a test sees the route blocker.
 * Page tests keep `renderWithProviders` + their own `<Routes>` under the plain MemoryRouter.
 */
export function renderAppAt(route: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, { initialEntries: [route] });
  return render(
    <MantineProvider env="test" theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <AppDatesProvider>
        <QueryClientProvider client={queryClient}>
          <SessionCacheBoundary>
            <RouterProvider router={router} />
          </SessionCacheBoundary>
        </QueryClientProvider>
      </AppDatesProvider>
    </MantineProvider>,
  );
}

export * from "@testing-library/react";
