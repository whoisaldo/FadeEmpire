// A small iCalendar reader for the tests: enough to check what calendar apps
// need from the "Add to calendar" file. Throws on a bare LF line ending.

export function parseIcs(text) {
  if (!text.endsWith('\r\n')) throw new Error('the file must end with CRLF');
  if (/[^\r]\n/.test(text)) throw new Error('a line ends with a bare LF');
  const lines = text.slice(0, -2).split('\r\n')
    .reduce((out, line) => {                       // unfold, should a line ever be folded
      if (/^[ \t]/.test(line)) out[out.length - 1] += line.slice(1);
      else out.push(line);
      return out;
    }, []);
  const stack = [];
  const root = { type: 'ROOT', props: {}, children: [] };
  let cur = root;
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`not a content line: ${line}`);
    const name = line.slice(0, i).split(';')[0].toUpperCase();
    const value = line.slice(i + 1);
    if (name === 'BEGIN') {
      const comp = { type: value, props: {}, children: [] };
      cur.children.push(comp);
      stack.push(cur);
      cur = comp;
    } else if (name === 'END') {
      if (cur.type !== value) throw new Error(`END:${value} closes ${cur.type}`);
      cur = stack.pop();
    } else {
      cur.props[name] = value;
    }
  }
  if (cur !== root) throw new Error(`${cur.type} is never closed`);
  return root.children;
}

/** A TEXT value as written, unescaped. */
export function icsUnescape(v) {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** 20260708T153000Z → Date */
export function icsDate(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) throw new Error(`not a UTC date-time: ${v}`);
  return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}
