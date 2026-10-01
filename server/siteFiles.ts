/**
 * The website's files, from the build folder, minus the server's own.
 *
 * `npm run build` writes the server bundle (server.cjs, and server.cjs.map,
 * which holds the original source of every server file, comments and all)
 * into the same dist/ folder as the site. Serving that folder as it is let
 * anyone download the server's whole source from /server.cjs.map. The site
 * itself has no .cjs or .map files, so those are never served: such an
 * address gets the app page, like any other unknown one.
 *
 * The check is on the file the address would actually open, decoded and
 * normalised the way express.static does it, so /server%2Ecjs or
 * /assets/../server.cjs cannot slip past it.
 */
import express from "express";
import path from "path";

const SERVER_ONLY = new Set([".cjs", ".map"]);

export function isServerOnlyFile(root: string, urlPath: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return false; }
  const file = path.join(path.resolve(root), decoded);
  return SERVER_ONLY.has(path.extname(file).toLowerCase());
}

export function siteFiles(root: string): express.RequestHandler {
  const serve = express.static(root);
  return (req, res, next) => (isServerOnlyFile(root, req.path) ? next() : serve(req, res, next));
}
