// Splits a .sql file written for the mysql client into single statements, as the client would:
// honours DELIMITER lines (used around triggers) and drops comments. Kept separate so it can be unit-tested.
export function splitSql(text) {
  const src = text.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  let delim = ';', buf = [];
  for (const line of src.split('\n')) {
    const d = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (d) { delim = d[1]; continue; }
    if (/^\s*(--|#)/.test(line)) continue;
    buf.push(line);
    const joined = buf.join('\n').trimEnd();
    if (joined.endsWith(delim)) {
      const stmt = joined.slice(0, -delim.length).trim();
      if (stmt) out.push(stmt);
      buf = [];
    }
  }
  const rest = buf.join('\n').trim();
  if (rest) out.push(rest);
  return out;
}
