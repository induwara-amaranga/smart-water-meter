/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin for hosted builds (no trailing slash). Leave unset for local dev. */
  readonly VITE_API_URL?: string;
}
