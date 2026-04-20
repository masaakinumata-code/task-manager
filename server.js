const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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

// --- DB初期化 ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS columns_ (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      sort_order INT DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium',
      due TEXT DEFAULT '',
      assignee TEXT DEFAULT '',
      status TEXT DEFAULT 'todo',
      project_id TEXT DEFAULT '',
      sort_order INT DEFAULT 0,
      created_at TEXT DEFAULT ''
    )
  `);

  // デフォルトデータ挿入
  const { rows: cols } = await pool.query('SELECT COUNT(*) FROM columns_');
  if (parseInt(cols[0].count) === 0) {
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      const c = DEFAULT_COLUMNS[i];
      await pool.query('INSERT INTO columns_ (id, name, color, sort_order) VALUES ($1, $2, $3, $4)', [c.id, c.name, c.color, i]);
    }
  }

  const { rows: projs } = await pool.query('SELECT COUNT(*) FROM projects');
  if (parseInt(projs[0].count) === 0) {
    for (const p of DEFAULT_PROJECTS) {
      await pool.query('INSERT INTO projects (id, name, color) VALUES ($1, $2, $3)', [p.id, p.name, p.color]);
    }
  }
}

// --- ヘルパー ---
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ========== Projects ==========
app.get('/api/projects', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects');
  res.json(rows);
});

app.post('/api/projects', async (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'メンバー名を入力してください' });
  const project = { id: 'proj_' + genId(), name: name.trim(), color: color || '#6366f1' };
  await pool.query('INSERT INTO projects (id, name, color) VALUES ($1, $2, $3)', [project.id, project.name, project.color]);
  res.json(project);
});

app.delete('/api/projects/:id', async (req, res) => {
  await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ========== Columns ==========
app.get('/api/columns', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, color FROM columns_ ORDER BY sort_order');
  res.json(rows);
});

app.post('/api/columns', async (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'カラム名を入力してください' });
  const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM columns_');
  const column = { id: 'col_' + genId(), name: name.trim(), color: color || '#6366f1' };
  await pool.query('INSERT INTO columns_ (id, name, color, sort_order) VALUES ($1, $2, $3, $4)', [column.id, column.name, column.color, maxRows[0].next]);
  res.json(column);
});

app.delete('/api/columns/:id', async (req, res) => {
  const colId = req.params.id;
  const { rows: cols } = await pool.query('SELECT id FROM columns_ WHERE id != $1 ORDER BY sort_order LIMIT 1', [colId]);
  if (cols.length > 0) {
    await pool.query('UPDATE tasks SET status = $1 WHERE status = $2', [cols[0].id, colId]);
  }
  await pool.query('DELETE FROM columns_ WHERE id = $1', [colId]);
  res.json({ success: true });
});

// ========== Tasks ==========
app.get('/api/tasks', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks ORDER BY sort_order');
  const tasks = rows.map(r => ({
    id: r.id, title: r.title, desc: r.description, category: r.category,
    priority: r.priority, due: r.due, assignee: r.assignee,
    status: r.status, projectId: r.project_id, order: r.sort_order,
    createdAt: r.created_at
  }));
  res.json(tasks);
});

// タスク並び替え — :id より先に定義
app.put('/api/tasks/reorder', async (req, res) => {
  const { taskId, newStatus, insertIndex } = req.body;
  const { rows: taskRows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  if (taskRows.length === 0) return res.status(404).json({ error: 'タスクが見つかりません' });

  await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [newStatus, taskId]);
  const { rows: colTasks } = await pool.query(
    'SELECT id FROM tasks WHERE status = $1 AND id != $2 ORDER BY sort_order', [newStatus, taskId]
  );
  const ordered = colTasks.map(t => t.id);
  ordered.splice(insertIndex, 0, taskId);
  for (let i = 0; i < ordered.length; i++) {
    await pool.query('UPDATE tasks SET sort_order = $1 WHERE id = $2', [i, ordered[i]]);
  }
  res.json({ success: true });
});

app.post('/api/tasks', async (req, res) => {
  const { title, desc, category, priority, due, assignee, status, projectId } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'タスク名を入力してください' });
  const { rows: minRows } = await pool.query(
    'SELECT COALESCE(MIN(sort_order), 0) - 1 AS min_order FROM tasks WHERE status = $1', [status || 'todo']
  );
  const task = {
    id: genId(), title: title.trim(), desc: desc || '', category: category || '',
    priority: priority || 'medium', due: due || '', assignee: assignee || '',
    status: status || 'todo', projectId: projectId || '',
    order: minRows[0].min_order, createdAt: new Date().toISOString()
  };
  await pool.query(
    'INSERT INTO tasks (id, title, description, category, priority, due, assignee, status, project_id, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [task.id, task.title, task.desc, task.category, task.priority, task.due, task.assignee, task.status, task.projectId, task.order, task.createdAt]
  );
  res.json(task);
});

app.put('/api/tasks/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'タスクが見つかりません' });
  const { title, desc, category, priority, due, assignee, status, projectId } = req.body;
  const t = rows[0];
  const updated = {
    title: title !== undefined ? title : t.title,
    description: desc !== undefined ? desc : t.description,
    category: category !== undefined ? category : t.category,
    priority: priority !== undefined ? priority : t.priority,
    due: due !== undefined ? due : t.due,
    assignee: assignee !== undefined ? assignee : t.assignee,
    status: status !== undefined ? status : t.status,
    project_id: projectId !== undefined ? projectId : t.project_id
  };
  await pool.query(
    'UPDATE tasks SET title=$1, description=$2, category=$3, priority=$4, due=$5, assignee=$6, status=$7, project_id=$8 WHERE id=$9',
    [updated.title, updated.description, updated.category, updated.priority, updated.due, updated.assignee, updated.status, updated.project_id, req.params.id]
  );
  res.json({
    id: req.params.id, title: updated.title, desc: updated.description, category: updated.category,
    priority: updated.priority, due: updated.due, assignee: updated.assignee,
    status: updated.status, projectId: updated.project_id, order: t.sort_order, createdAt: t.created_at
  });
});

app.delete('/api/tasks/:id', async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- 起動 ---
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`ECタスク管理 が起動しました: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB初期化エラー:', err);
  process.exit(1);
});
