/* eslint-disable react-refresh/only-export-components -- deliberately mixes the RequireAuth/RedirectIfAuthed route-guard components with the flagSignedOut/consumeSignedOut session helpers; other files cite this as "the auth.tsx precedent" */
import { useSyncExternalStore, type ReactElement } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import {
  getSessionBoundaryRevision,
  getSessionRevision,
  getToken,
  subscribeSessionChange,
} from "./api/session";

let pendingSignedOutBanner = false;

export function flagSignedOut(): void {
  pendingSignedOutBanner = true;
}

export function consumeSignedOut(): boolean {
  const v = pendingSignedOutBanner;
  pendingSignedOutBanner = false;
  return v;
}

function useAuth(): { boundary: number; isAuthenticated: boolean } {
  useSyncExternalStore(subscribeSessionChange, getSessionRevision, () => 0);
  return {
    boundary: getSessionBoundaryRevision(),
    isAuthenticated: getToken() !== null,
  };
}

type LocationStateWithFrom = { from?: { pathname?: string } } | null;

export function RequireAuth(): ReactElement {
  const { boundary, isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <Outlet key={boundary} />;
}

export function RedirectIfAuthed({ children }: { children: ReactElement }): ReactElement {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (isAuthenticated) {
    const from = (location.state as LocationStateWithFrom)?.from?.pathname;
    return <Navigate to={from ?? "/"} replace />;
  }
  return children;
}
