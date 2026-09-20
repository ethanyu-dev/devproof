/** Even same-origin API requests require a manually entered service token. */
export function docsFetch(input: string | URL | Request, init?: RequestInit) {
  return fetch(input, { ...init, credentials: "omit", redirect: "error" });
}
