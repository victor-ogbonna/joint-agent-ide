/**
 * The Web Preview panel: pulling the page a sketch serves out of its
 * source, and showing it without raw, unexplained runtime tokens.
 */
import { extractHtml, fillRuntimePlaceholders } from "../src/components/WebPreviewPanel.tsx";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

console.log("Pulling the page out of a sketch");
{
  const code = `
    const char index_html[] PROGMEM = R"rawliteral(
      <!DOCTYPE html><html><body><h1>Hi</h1></body></html>
    )rawliteral";
  `;
  check(extractHtml(code)?.includes("<h1>Hi</h1>"), "a raw string literal is found");
}
{
  const code = `
    String html = "<!DOCTYPE html><html><body>";
    html += "<p>Reading: 42</p>";
    html += "</body></html>";
  `;
  check(extractHtml(code)?.includes("<p>Reading: 42</p>"), "concatenated literals are joined");
}
check(extractHtml("void loop() {}") === null, "no page: null, not an empty string");

console.log("Runtime tokens the board fills in at runtime");
{
  const out = fillRuntimePlaceholders("<p>Temp: %TEMPERATURE%&deg;C</p>");
  check(out === "<p>Temp: ⟨temperature⟩&deg;C</p>", "an ESPAsyncWebServer processor token reads as a named placeholder, not raw %...%", out);
}
{
  const out = fillRuntimePlaceholders("<p>Humidity: %HUMIDITY_PCT%%</p>");
  check(out === "<p>Humidity: ⟨humidity pct⟩%</p>", "an underscore in the name reads as a space", out);
}
{
  const out = fillRuntimePlaceholders("<p>Reading: %.1f&deg;C, battery %d%%</p>");
  check(out === "<p>Reading: ⟨value⟩&deg;C, battery ⟨value⟩%</p>", "a sprintf specifier reads as a placeholder; %% as the literal % it is", out);
}
{
  const out = fillRuntimePlaceholders("<div style=\"width: 50%;\">Battery 100% full</div>");
  check(out === "<div style=\"width: 50%;\">Battery 100% full</div>", "an ordinary percent sign (CSS width, \"100% full\") is left alone", out);
}
{
  const out = fillRuntimePlaceholders("<p id=\"%STATUS%\" class=\"led-%STATE%\">On</p>");
  check(out === "<p id=\"⟨status⟩\" class=\"led-⟨state⟩\">On</p>", "a token inside an attribute value substitutes in place, without breaking the quotes", out);
}
check(fillRuntimePlaceholders("<p>No tokens here.</p>") === "<p>No tokens here.</p>", "a page with nothing to fill in is unchanged");

console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
