/**
 * Host half of dsh-hello-world.
 *
 * The bundle has nothing host-side to do: every pixel comes from the browser
 * module in `./client.js`. The function stays so the loader entry in
 * `cordis.patch.yml` has a valid module to activate.
 */
export function apply() {}
