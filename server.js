const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const COLUMNS_FILE = path.join(DATA_DIR, 'columns.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// データディレクトリ確保
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- ヘルパー ---
function loadJSON(file, defaultVal) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultVal, null, 2));
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_COLUMNS = [
  { id: 'todo', name: 'To Do', color: '#6366f1' },
  { id: 'in_progress', name: '進行中', color: '#f59e0b' },
  { id: 'today', name: '今日マスト', color: '#ef4444' },
  { id: 'done', name: '完了', color: '#22c55e' },
  { id: 'ikeda', name: '池田さんタスク', color: '#ec4899' }
];

const DEFAULT_PROJECTS = [
  { id: 'proj_default1', name: '個人プロジェクト', color: '#6366f1' },
  { id: 'proj_default2', name: '仕事', color: '#ec4899' }
];

// ========== Projects ==========
app.get('/api/projects', (req, res) => {
  res.json(loadJSON(PROJECTS_FILE, DEFAULT_PROJECTS));
});

app.post('/api/projects', (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'プロジェクト名を入力してください' });
  const projects = loadJSON(PROJECTS_FILE, DEFAULT_PROJECTS);
  const project = { id: 'proj_' + genId(), name: name.trim(), color: color || '#6366f1' };
  projects.push(project);
  saveJSON(PROJECTS_FILE, projects);
  res.json(project);
});

app.delete('/api/projects/:id', (req, res) => {
  let projects = loadJSON(PROJECTS_FILE, DEFAULT_PROJECTS);
  projects = projects.filter(p => p.id !== req.params.id);
  saveJSON(PROJECTS_FILE, projects);
  res.json({ success: true });
});

// ========== Columns ==========
app.get('/api/columns', (req, res) => {
  res.json(loadJSON(COLUMNS_FILE, DEFAULT_COLUMNS));
});

app.post('/api/columns', (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'カラム名を入力してください' });
  const columns = loadJSON(COLUMNS_FILE, DEFAULT_COLUMNS);
  const column = { id: 'col_' + genId(), name: name.trim(), color: color || '#6366f1' };
  columns.push(column);
  saveJSON(COLUMNS_FILE, columns);
  res.json(column);
});

app.delete('/api/columns/:id', (req, res) => {
  let columns = loadJSON(COLUMNS_FILE, DEFAULT_COLUMNS);
  const tasks = loadJSON(TASKS_FILE, []);
  const colId = req.params.id;

  // タスクを最初のカラムに移動
  const fallback = columns.find(c => c.id !== colId);
  if (fallback) {
    let changed = false;
    tasks.forEach(t => {
      if (t.status === colId) { t.status = fallback.id; changed = true; }
    });
    if (changed) saveJSON(TASKS_FILE, tasks);
  }

  columns = columns.filter(c => c.id !== colId);
  saveJSON(COLUMNS_FILE, columns);
  res.json({ success: true });
});

// ========== Tasks ==========
app.get('/api/tasks', (req, res) => {
  res.json(loadJSON(TASKS_FILE, []));
});

// タスク並び替え（ドラッグ＆ドロップ）— :id より先に定義
app.put('/api/tasks/reorder', (req, res) => {
  const { taskId, newStatus, insertIndex } = req.body;
  const tasks = loadJSON(TASKS_FILE, []);
  const task = tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });
  task.status = newStatus;
  const colTasks = tasks.filter(t => t.status === newStatus && t.id !== taskId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  colTasks.splice(insertIndex, 0, task);
  colTasks.forEach((t, i) => { t.order = i; });
  saveJSON(TASKS_FILE, tasks);
  res.json({ success: true });
});

app.post('/api/tasks', (req, res) => {
  const { title, desc, category, priority, due, assignee, status, projectId } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'タスク名を入力してください' });
  const tasks = loadJSON(TASKS_FILE, []);
  const minOrder = Math.min(0, ...tasks.filter(t => t.status === status).map(t => t.order ?? 0));
  const task = {
    id: genId(),
    title: title.trim(),
    desc: desc || '',
    category: category || '',
    priority: priority || 'medium',
    due: due || '',
    assignee: assignee || '',
    status: status || 'todo',
    projectId: projectId || '',
    order: minOrder - 1,
    createdAt: new Date().toISOString()
  };
  tasks.unshift(task);
  saveJSON(TASKS_FILE, tasks);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const tasks = loadJSON(TASKS_FILE, []);
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });
  const { title, desc, category, priority, due, assignee, status, projectId } = req.body;
  if (title !== undefined) task.title = title;
  if (desc !== undefined) task.desc = desc;
  if (category !== undefined) task.category = category;
  if (priority !== undefined) task.priority = priority;
  if (due !== undefined) task.due = due;
  if (assignee !== undefined) task.assignee = assignee;
  if (status !== undefined) task.status = status;
  if (projectId !== undefined) task.projectId = projectId;
  saveJSON(TASKS_FILE, tasks);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  let tasks = loadJSON(TASKS_FILE, []);
  tasks = tasks.filter(t => t.id !== req.params.id);
  saveJSON(TASKS_FILE, tasks);
  res.json({ success: true });
});

// ========== Utils ==========
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

app.listen(PORT, () => {
  console.log(`TaskBoard が起動しました: http://localhost:${PORT}`);
});
