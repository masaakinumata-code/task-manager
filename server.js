const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ストレージ抽象化（PostgreSQL or JSONファイル） ---
let storage;

const DEFAULT_COLUMNS = [
  { id: 'todo', name: 'To Do', color: '#6366f1' },
  { id: 'in_progress', name: '進行中', color: '#f59e0b' },
  { id: 'today', name: '今日マスト', color: '#ef4444' },
  { id: 'done', name: '完了', color: '#22c55e' },
  { id: 'ikeda', name: '池田さんタスク', color: '#ec4899' }
];

const DEFAULT_PROJECTS = [
  { id: 'proj_default1', name: '沼田', color: '#6366f1' },
  { id: 'proj_default2', name: '池田', color: '#ec4899' }
];

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ========== JSONファイルストレージ ==========
function createFileStorage() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
  const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
  const COLUMNS_FILE = path.join(DATA_DIR, 'columns.json');

  function loadJSON(file, defaultVal) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultVal, null, 2));
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  return {
    async init() {},
    async getProjects() { return loadJSON(PROJECTS_FILE, DEFAULT_PROJECTS); },
    async addProject(p) { const arr = loadJSON(PROJECTS_FILE, DEFAULT_PROJECTS); arr.push(p); saveJSON(PROJECTS_FILE, arr); },
    async deleteProject(id) { saveJSON(PROJECTS_FILE, loadJSON(PROJECTS_FILE, DEFAULT_PROJECTS).filter(p => p.id !== id)); },
    async getColumns() { return loadJSON(COLUMNS_FILE, DEFAULT_COLUMNS); },
    async addColumn(c) { const arr = loadJSON(COLUMNS_FILE, DEFAULT_COLUMNS); arr.push(c); saveJSON(COLUMNS_FILE, arr); },
    async deleteColumn(colId) {
      const columns = loadJSON(COLUMNS_FILE, DEFAULT_COLUMNS);
      const tasks = loadJSON(TASKS_FILE, []);
      const fallback = columns.find(c => c.id !== colId);
      if (fallback) {
        let changed = false;
        tasks.forEach(t => { if (t.status === colId) { t.status = fallback.id; changed = true; } });
        if (changed) saveJSON(TASKS_FILE, tasks);
      }
      saveJSON(COLUMNS_FILE, columns.filter(c => c.id !== colId));
    },
    async getTasks() { return loadJSON(TASKS_FILE, []); },
    async addTask(task) { const arr = loadJSON(TASKS_FILE, []); arr.unshift(task); saveJSON(TASKS_FILE, arr); },
    async updateTask(id, data) {
      const tasks = loadJSON(TASKS_FILE, []);
      const task = tasks.find(t => t.id === id);
      if (!task) return null;
      Object.keys(data).forEach(k => { if (data[k] !== undefined) task[k] = data[k]; });
      saveJSON(TASKS_FILE, tasks);
      return task;
    },
    async deleteTask(id) { saveJSON(TASKS_FILE, loadJSON(TASKS_FILE, []).filter(t => t.id !== id)); },
    async reorderTask(taskId, newStatus, insertIndex) {
      const tasks = loadJSON(TASKS_FILE, []);
      const task = tasks.find(t => t.id === taskId);
      if (!task) return false;
      task.status = newStatus;
      const colTasks = tasks.filter(t => t.status === newStatus && t.id !== taskId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      colTasks.splice(insertIndex, 0, task);
      colTasks.forEach((t, i) => { t.order = i; });
      saveJSON(TASKS_FILE, tasks);
      return true;
    },
    async getMinOrder(status) {
      const tasks = loadJSON(TASKS_FILE, []);
      return Math.min(0, ...tasks.filter(t => t.status === status).map(t => t.order ?? 0)) - 1;
    }
  };
}

// ========== PostgreSQLストレージ ==========
function createPgStorage() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  function toTask(r) {
    return {
      id: r.id, title: r.title, desc: r.description, category: r.category,
      priority: r.priority, due: r.due, assignee: r.assignee,
      status: r.status, projectId: r.project_id, order: r.sort_order,
      createdAt: r.created_at
    };
  }

  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS columns_ (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INT DEFAULT 0)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', category TEXT DEFAULT '', priority TEXT DEFAULT 'medium', due TEXT DEFAULT '', assignee TEXT DEFAULT '', status TEXT DEFAULT 'todo', project_id TEXT DEFAULT '', sort_order INT DEFAULT 0, created_at TEXT DEFAULT '')`);
      const { rows: colCount } = await pool.query('SELECT COUNT(*) FROM columns_');
      if (parseInt(colCount[0].count) === 0) {
        for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
          const c = DEFAULT_COLUMNS[i];
          await pool.query('INSERT INTO columns_ (id, name, color, sort_order) VALUES ($1,$2,$3,$4)', [c.id, c.name, c.color, i]);
        }
      }
      const { rows: projCount } = await pool.query('SELECT COUNT(*) FROM projects');
      if (parseInt(projCount[0].count) === 0) {
        for (const p of DEFAULT_PROJECTS) {
          await pool.query('INSERT INTO projects (id, name, color) VALUES ($1,$2,$3)', [p.id, p.name, p.color]);
        }
      }
    },
    async getProjects() { const { rows } = await pool.query('SELECT * FROM projects'); return rows; },
    async addProject(p) { await pool.query('INSERT INTO projects (id, name, color) VALUES ($1,$2,$3)', [p.id, p.name, p.color]); },
    async deleteProject(id) { await pool.query('DELETE FROM projects WHERE id = $1', [id]); },
    async getColumns() { const { rows } = await pool.query('SELECT id, name, color FROM columns_ ORDER BY sort_order'); return rows; },
    async addColumn(c) {
      const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM columns_');
      await pool.query('INSERT INTO columns_ (id, name, color, sort_order) VALUES ($1,$2,$3,$4)', [c.id, c.name, c.color, rows[0].next]);
    },
    async deleteColumn(colId) {
      const { rows } = await pool.query('SELECT id FROM columns_ WHERE id != $1 ORDER BY sort_order LIMIT 1', [colId]);
      if (rows.length > 0) await pool.query('UPDATE tasks SET status = $1 WHERE status = $2', [rows[0].id, colId]);
      await pool.query('DELETE FROM columns_ WHERE id = $1', [colId]);
    },
    async getTasks() {
      const { rows } = await pool.query('SELECT * FROM tasks ORDER BY sort_order');
      return rows.map(toTask);
    },
    async addTask(task) {
      await pool.query(
        'INSERT INTO tasks (id, title, description, category, priority, due, assignee, status, project_id, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [task.id, task.title, task.desc, task.category, task.priority, task.due, task.assignee, task.status, task.projectId, task.order, task.createdAt]
      );
    },
    async updateTask(id, data) {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
      if (rows.length === 0) return null;
      const t = rows[0];
      const u = {
        title: data.title !== undefined ? data.title : t.title,
        description: data.desc !== undefined ? data.desc : t.description,
        category: data.category !== undefined ? data.category : t.category,
        priority: data.priority !== undefined ? data.priority : t.priority,
        due: data.due !== undefined ? data.due : t.due,
        assignee: data.assignee !== undefined ? data.assignee : t.assignee,
        status: data.status !== undefined ? data.status : t.status,
        project_id: data.projectId !== undefined ? data.projectId : t.project_id
      };
      await pool.query(
        'UPDATE tasks SET title=$1, description=$2, category=$3, priority=$4, due=$5, assignee=$6, status=$7, project_id=$8 WHERE id=$9',
        [u.title, u.description, u.category, u.priority, u.due, u.assignee, u.status, u.project_id, id]
      );
      return { id, title: u.title, desc: u.description, category: u.category, priority: u.priority, due: u.due, assignee: u.assignee, status: u.status, projectId: u.project_id, order: t.sort_order, createdAt: t.created_at };
    },
    async deleteTask(id) { await pool.query('DELETE FROM tasks WHERE id = $1', [id]); },
    async reorderTask(taskId, newStatus, insertIndex) {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
      if (rows.length === 0) return false;
      await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [newStatus, taskId]);
      const { rows: colTasks } = await pool.query('SELECT id FROM tasks WHERE status = $1 AND id != $2 ORDER BY sort_order', [newStatus, taskId]);
      const ordered = colTasks.map(t => t.id);
      ordered.splice(insertIndex, 0, taskId);
      for (let i = 0; i < ordered.length; i++) {
        await pool.query('UPDATE tasks SET sort_order = $1 WHERE id = $2', [i, ordered[i]]);
      }
      return true;
    },
    async getMinOrder(status) {
      const { rows } = await pool.query('SELECT COALESCE(MIN(sort_order),0)-1 AS min_order FROM tasks WHERE status = $1', [status]);
      return rows[0].min_order;
    }
  };
}

// ========== API Routes ==========

// --- Projects ---
app.get('/api/projects', async (req, res) => {
  try { res.json(await storage.getProjects()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'メンバー名を入力してください' });
    const project = { id: 'proj_' + genId(), name: name.trim(), color: color || '#6366f1' };
    await storage.addProject(project);
    res.json(project);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try { await storage.deleteProject(req.params.id); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// --- Columns ---
app.get('/api/columns', async (req, res) => {
  try { res.json(await storage.getColumns()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/columns', async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'カラム名を入力してください' });
    const column = { id: 'col_' + genId(), name: name.trim(), color: color || '#6366f1' };
    await storage.addColumn(column);
    res.json(column);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.delete('/api/columns/:id', async (req, res) => {
  try { await storage.deleteColumn(req.params.id); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// --- Tasks ---
app.get('/api/tasks', async (req, res) => {
  try { res.json(await storage.getTasks()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.put('/api/tasks/reorder', async (req, res) => {
  try {
    const { taskId, newStatus, insertIndex } = req.body;
    const ok = await storage.reorderTask(taskId, newStatus, insertIndex);
    if (!ok) return res.status(404).json({ error: 'タスクが見つかりません' });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, desc, category, priority, due, assignee, status, projectId } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'タスク名を入力してください' });
    const taskStatus = status || 'todo';
    const order = await storage.getMinOrder(taskStatus);
    const task = {
      id: genId(), title: title.trim(), desc: desc || '', category: category || '',
      priority: priority || 'medium', due: due || '', assignee: assignee || '',
      status: taskStatus, projectId: projectId || '',
      order, createdAt: new Date().toISOString()
    };
    await storage.addTask(task);
    res.json(task);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const updated = await storage.updateTask(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'タスクが見つかりません' });
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try { await storage.deleteTask(req.params.id); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// --- 起動 ---
async function start() {
  if (process.env.DATABASE_URL) {
    console.log('PostgreSQL モードで起動します');
    storage = createPgStorage();
  } else {
    console.log('JSONファイル モードで起動します');
    storage = createFileStorage();
  }
  await storage.init();
  app.listen(PORT, () => {
    console.log(`ECタスク管理 が起動しました: http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('起動エラー:', err);
  process.exit(1);
});
