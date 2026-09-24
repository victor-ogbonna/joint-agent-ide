/**
 * Strip the build toolchain's own branding out of anything shown to a user.
 *
 * The compiler underneath is PlatformIO, which is an implementation detail of
 * this product rather than part of it. Only OUTPUT is rewritten — never the
 * commands, config keys or paths that actually drive the build, because
 * "platformio.ini", "pio run" and "~/.platformio" are real names on disk and
 * renaming them would stop builds working.
 */
export function scrubToolchainNames(text: string): string {
  if (!text) return text;
  return text
    // Longest first, so a general rule cannot eat a specific one.
    .replace(/PlatformIO Core(\s*\(Core\))?/gi, "Joint-Agent Engine")
    .replace(/PlatformIO Registry/gi, "Joint-Agent Library Registry")
    .replace(/PlatformIO Home/gi, "Joint-Agent Workspace")
    // Any doc link that names the toolchain, including the shortened
    // bit.ly/configure-pio-ldf that the dependency finder prints.
    .replace(/https?:\/\/\S*(?:platformio|[-\/.]pio(?=[-\/.]))\S*/gi, "https://jointagentide.com")
    .replace(/platformio\.ini/gi, "project.ini")
    .replace(/\.platformio\b/gi, ".joint-agent")
    // The build tree the size report quotes: .pio/build/<env>/firmware.elf.
    // Text only — the server locates artifacts by real filesystem paths.
    .replace(/\.pio\b/g, ".jagent")
    .replace(/\bPlatformIO\b/gi, "Joint-Agent")
    // Bare "pio" only as a standalone word, so "compio" or a path fragment is
    // left alone.
    .replace(/(^|[\s`'"(\[])pio(?=[\s`'")\].,:]|$)/g, "$1jagent");
}
