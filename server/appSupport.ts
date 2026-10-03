import fs from "fs";
import path from "path";
import { appHelperFiles, usesAppHelper } from "../src/lib/appHeaders";
import { APP_ICON_PNG_BASE64 } from "./appIcon";

/**
 * A sketch made into a phone app with "Build App (PWA)" includes the app
 * helper (src/lib/appHeaders.ts). It isn't a library anyone installs, so
 * a compile writes its headers into the build's include folder, beside the
 * sketch. Nothing is written for any other sketch. Whether it was.
 */
export function addAppHelper(code: string, buildDir: string): boolean {
  if (!usesAppHelper(code)) return false;
  const dir = path.join(buildDir, "include");
  fs.mkdirSync(dir, { recursive: true });
  for (const file of appHelperFiles(Buffer.from(APP_ICON_PNG_BASE64, "base64"))) {
    fs.writeFileSync(path.join(dir, file.name), file.content);
  }
  return true;
}
