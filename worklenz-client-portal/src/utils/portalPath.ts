/** Full-page redirects must stay in the client app, including deployments below /portal/. */
export const portalPath = (path: string, base = import.meta.env.BASE_URL): string =>
  `${base.replace(/\/?$/, '/')}${path.replace(/^\/+/, '')}`;
