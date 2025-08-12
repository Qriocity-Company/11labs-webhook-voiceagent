// src/projects.js
import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECTS_DIR = path.resolve('src/projects');

async function dirExists(p) {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function loadDoc(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.md') return fs.readFile(filePath, 'utf8');
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ path: filePath });
    return r.value;
  }
  if (ext === '.url') {
    const url = (await fs.readFile(filePath, 'utf8')).trim();
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return r.text();
  }
  return '';
}

async function scanProjects() {
  // Vercel FS is read-only — don’t mkdir
  if (!(await dirExists(PROJECTS_DIR))) return {};
  const dirs = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = {};
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, d.name);
    const files = await fs.readdir(projectPath);
    const docs = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (['.txt', '.md', '.docx', '.url'].includes(ext)) {
        docs.push({ type: 'file', path: path.join(projectPath, f) });
      }
    }
    projects[d.name] = { title: d.name, docs };
  }
  return projects;
}

export async function listProjects() {
  const p = await scanProjects();
  return Object.entries(p).map(([key, v]) => ({ key, title: v.title }));
}

export async function assembleKB(key) {
  const p = await scanProjects();
  const proj = p[key];
  if (!proj) throw new Error(`project not found: ${key}`);
  const chunks = [];
  for (const d of proj.docs) {
    if (d.type === 'file') chunks.push(await loadDoc(d.path));
  }
  return { title: proj.title, text: chunks.join('\n\n') };
}

// no default export
