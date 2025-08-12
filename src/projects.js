import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';

const PROJECTS_DIR = path.resolve('src/projects');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadDoc(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return fs.readFile(filePath, 'utf8');
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  if (ext === '.url') {
    const url = await fs.readFile(filePath, 'utf8');
    const r = await fetch(url.trim());
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return r.text();
  }
  return '';
}

async function scanProjects() {
  await ensureDir(PROJECTS_DIR);
  const dirs = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });

  const projects = {};
  for (const dir of dirs) {
    if (dir.isDirectory()) {
      const projectPath = path.join(PROJECTS_DIR, dir.name);
      const files = await fs.readdir(projectPath);
      const docs = [];

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        if (['.txt', '.md', '.docx', '.url'].includes(path.extname(file).toLowerCase())) {
          docs.push({ type: 'file', path: filePath });
        }
      }

      projects[dir.name] = {
        title: dir.name,
        docs
      };
    }
  }
  return projects;
}

export async function listProjects() {
  const projects = await scanProjects();
  return Object.entries(projects).map(([key, v]) => ({ key, title: v.title }));
}

export async function assembleKB(projectKey) {
  const projects = await scanProjects();
  const p = projects[projectKey];
  if (!p) throw new Error('unknown project');
  const parts = await Promise.all(p.docs.map(d => loadDoc(d.path)));
  return { title: p.title, text: parts.join('\n\n---\n\n') };
}
