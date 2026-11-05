import { createContext, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

type RouterValue = {
  path: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
};

const RouterContext = createContext<RouterValue | null>(null);

function currentPath() {
  return window.location.pathname || '/';
}

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const value = useMemo<RouterValue>(() => ({
    path,
    navigate(to, options = {}) {
      if (options.replace) window.history.replaceState(null, '', to);
      else window.history.pushState(null, '', to);
      setPath(currentPath());
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
  }), [path]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const value = useContext(RouterContext);
  if (!value) throw new Error('Router context is missing');
  return value;
}

export function useNavigate() {
  return useRouter().navigate;
}

export function useParams() {
  const { path } = useRouter();
  const match = path.match(/^\/run\/([^/]+)$/);
  return { runId: match ? decodeURIComponent(match[1]) : undefined };
}

export function Link({ to, onClick, children, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string }) {
  const { navigate } = useRouter();
  return <a href={to} {...props} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  }}>{children}</a>;
}

export function NavLink({ to, end = false, className, children, ...props }: Omit<Parameters<typeof Link>[0], 'className'> & {
  end?: boolean;
  className?: string | ((state: { isActive: boolean }) => string);
}) {
  const { path } = useRouter();
  const isActive = end ? path === to : path === to || path.startsWith(`${to}/`);
  const resolved = typeof className === 'function' ? className({ isActive }) : className;
  return <Link to={to} className={resolved} {...props}>{children}</Link>;
}
