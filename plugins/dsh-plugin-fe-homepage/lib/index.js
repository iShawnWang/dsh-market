/**
 * Host half of dsh-plugin-fe-homepage.
 *
 * The page is a static directory: every URL, step, and screenshot lives in the
 * browser half. Nothing is fetched at runtime and nothing is stored, so the
 * host entry only exists so the loader has a module to activate.
 */
export function apply() {}
