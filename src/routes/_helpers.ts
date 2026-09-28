export { all, get, run, parseJson } from "../core/db";
export { nowIso } from "../util/id";
export const nowIsoSafe = () => new Date().toISOString();
