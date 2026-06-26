const fs = require('fs');
const path = require('path');

function walkDir(dir, ext) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(full, ext));
      } else if (!ext || entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  } catch (e) {}
  return results;
}

function search(dir, term, ext) {
  const files = walkDir(dir, ext);
  const matches = {};
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const regex = new RegExp(term, 'g');
      const m = content.match(regex);
      if (m && m.length > 0) {
        matches[f] = m.length;
      }
    } catch (e) {}
  }
  return matches;
}

const root = 'g:/project/github/books';
const terms = ['天常前板交雄', '生添譠级'];

console.log('=== Searching entire project ===\n');

for (const term of terms) {
  console.log('### Term: ' + term);
  const all = search(root, term, '.json');
  const html = search(root, term, '.html');
  const allFiles = { ...all, ...html };
  
  if (Object.keys(allFiles).length === 0) {
    console.log('  No matches found\n');
    continue;
  }
  
  let total = 0;
  for (const [f, c] of Object.entries(allFiles).sort((a,b) => a.localeCompare(b[0], b[0]))) {
    const rel = f.replace(root + '/', '');
    console.log('  ' + rel + ': ' + c + ' match'(s));
    total += c;
  }
  console.log('  Total line matches: ' + total + ' in ' + Object.keys(allFiles).length + ' files\n');
}
