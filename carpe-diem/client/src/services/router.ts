import { useCallback, useEffect, useState } from 'react';

/**
 * The app has exactly two routes. A router library would be more code than
 * this and would ship on the landing page, so the History API is used directly.
 */
export type Route = { name: 'home' } | { name: 'room'; code: string };

const ROOM_PATH = /^\/room\/([A-Za-z0-9-]{1,16})\/?$/;

export function parseRoute(pathname: string): Route {
  const match = ROOM_PATH.exec(pathname);
  if (match?.[1]) return { name: 'room', code: match[1].toUpperCase() };
  return { name: 'home' };
}

export function roomPath(code: string): string {
  return `/room/${code}`;
}

export function roomUrl(code: string): string {
  return `${window.location.origin}${roomPath(code)}`;
}

export function useRoute(): { route: Route; navigate: (to: string, replace?: boolean) => void } {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string, replace = false) => {
    if (replace) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);
    setRoute(parseRoute(to));
  }, []);

  return { route, navigate };
}
