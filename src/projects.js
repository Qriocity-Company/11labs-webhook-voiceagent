import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';

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
  if (!(await dirExists(PROJECTS_DIR))) return {};
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

async function listProjects() {
  const projects = await scanProjects();
  return Object.entries(projects).map(([key, v]) => ({ key, title: v.title }));
}

// CORS headers function
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, xi-api-key');
    res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
    // Set CORS headers for all requests
    setCorsHeaders(res);
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Only allow GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        console.log('📂 Fetching projects list...');
        const projects = await listProjects();
        console.log('✅ Projects fetched:', projects?.length || 0);
        
        res.status(200).json(projects);
    } catch (error) {
        console.error('❌ Projects error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch projects',
            message: error.message 
        });
    }
}
