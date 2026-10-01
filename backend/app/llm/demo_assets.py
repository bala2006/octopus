"""Real, runnable artifacts produced by the scripted Demo Mode run ("build a todo app")."""
from __future__ import annotations


def prd(goal: str) -> str:
    return f"""# Product Requirements: Todo App MVP

**Goal:** {goal}

## Problem
Individuals need a fast, private way to capture and complete personal tasks.

## Users
- *Solo professional*: captures tasks quickly, marks them done, cares about privacy.

## User stories & acceptance criteria
| # | Story | Acceptance criteria |
|---|-------|--------------------|
| 1 | As a user I can register and log in | Passwords are never stored in plaintext; wrong password is rejected |
| 2 | As a user I can create a todo | Empty titles are rejected; todo has title, done flag, optional due date |
| 3 | As a user I can list my todos | Users only ever see their own todos |
| 4 | As a user I can complete and delete todos | State changes persist for the session |
| 5 | As a user I can use dark mode | UI respects a theme toggle; WCAG AA contrast |

## Out of scope (v2)
- Sharing lists with teammates (agreed in the CEO ↔ PM scope debate)
- Push notifications, mobile apps

## Definition of done
All acceptance criteria covered by automated tests that pass in CI; Dockerfile + README provided.
"""


ARCHITECTURE = """# Architecture: Todo App MVP

## Components
| Component | File | Responsibility |
|-----------|------|----------------|
| Domain + auth service | `backend/todo_api.py` | Users, password hashing, tokens, todo CRUD with per-user isolation |
| Web UI | `frontend/index.html` | Single-page UI (vanilla JS, localStorage), dark mode |
| Tests | `tests/` | Unit tests for the service and static checks for the UI |

## Data model
- `User(username, password_hash, salt)`
- `Todo(id, owner, title, done, due)`

## Service API (`TodoService`)
| Method | Description |
|--------|-------------|
| `register(username, password)` | create user; raises `ValueError` if taken / weak |
| `login(username, password) -> token` | returns opaque session token; raises `PermissionError` |
| `create(token, title, due=None) -> Todo` | rejects empty titles |
| `list(token) -> list[Todo]` | only the caller's todos |
| `complete(token, todo_id)` / `delete(token, todo_id)` | owner-only |

## Decisions
- Standard library only (no dependencies) so tests run in the sandbox without network.
- PBKDF2-HMAC-SHA256 with per-user salt for passwords.
"""


BACKEND_V1 = '''"""Todo service with simple auth (v1)."""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from itertools import count


@dataclass
class Todo:
    id: int
    owner: str
    title: str
    done: bool = False
    due: str | None = None


@dataclass
class TodoService:
    users: dict[str, str] = field(default_factory=dict)  # username -> password
    sessions: dict[str, str] = field(default_factory=dict)
    todos: dict[int, Todo] = field(default_factory=dict)
    _ids: count = field(default_factory=lambda: count(1))

    def register(self, username: str, password: str) -> None:
        if username in self.users:
            raise ValueError("username taken")
        self.users[username] = password

    def login(self, username: str, password: str) -> str:
        if self.users.get(username) != password:
            raise PermissionError("invalid credentials")
        token = secrets.token_hex(16)
        self.sessions[token] = username
        return token

    def _user(self, token: str) -> str:
        if token not in self.sessions:
            raise PermissionError("invalid token")
        return self.sessions[token]

    def create(self, token: str, title: str, due: str | None = None) -> Todo:
        todo = Todo(id=next(self._ids), owner=self._user(token), title=title, due=due)
        self.todos[todo.id] = todo
        return todo

    def list(self, token: str) -> list[Todo]:
        user = self._user(token)
        return [t for t in self.todos.values() if t.owner == user]

    def complete(self, token: str, todo_id: int) -> Todo:
        todo = self.todos[todo_id]
        todo.done = True
        return todo

    def delete(self, token: str, todo_id: int) -> None:
        del self.todos[todo_id]
'''


BACKEND_V2 = '''"""Todo service with secure auth (v2: addresses architecture review)."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass, field
from itertools import count

PBKDF2_ROUNDS = 120_000


@dataclass
class Todo:
    id: int
    owner: str
    title: str
    done: bool = False
    due: str | None = None


@dataclass
class _User:
    salt: bytes
    password_hash: bytes


def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)


@dataclass
class TodoService:
    users: dict[str, _User] = field(default_factory=dict)
    sessions: dict[str, str] = field(default_factory=dict)
    todos: dict[int, Todo] = field(default_factory=dict)
    _ids: count = field(default_factory=lambda: count(1))

    # ---- auth ----
    def register(self, username: str, password: str) -> None:
        username = username.strip()
        if not username:
            raise ValueError("username required")
        if len(password) < 8:
            raise ValueError("password must be at least 8 characters")
        if username in self.users:
            raise ValueError("username taken")
        salt = secrets.token_bytes(16)
        self.users[username] = _User(salt=salt, password_hash=_hash(password, salt))

    def login(self, username: str, password: str) -> str:
        user = self.users.get(username)
        if user is None or not hmac.compare_digest(user.password_hash, _hash(password, user.salt)):
            raise PermissionError("invalid credentials")
        token = secrets.token_urlsafe(24)
        self.sessions[token] = username
        return token

    def logout(self, token: str) -> None:
        self.sessions.pop(token, None)

    def _user(self, token: str) -> str:
        try:
            return self.sessions[token]
        except KeyError:
            raise PermissionError("invalid token") from None

    def _owned(self, token: str, todo_id: int) -> Todo:
        user = self._user(token)
        todo = self.todos.get(todo_id)
        if todo is None or todo.owner != user:
            raise KeyError(f"todo {todo_id} not found")
        return todo

    # ---- todos ----
    def create(self, token: str, title: str, due: str | None = None) -> Todo:
        title = title.strip()
        if not title:
            raise ValueError("title required")
        todo = Todo(id=next(self._ids), owner=self._user(token), title=title[:200], due=due)
        self.todos[todo.id] = todo
        return todo

    def list(self, token: str) -> list[Todo]:
        user = self._user(token)
        return [t for t in self.todos.values() if t.owner == user]

    def complete(self, token: str, todo_id: int) -> Todo:
        todo = self._owned(token, todo_id)
        todo.done = True
        return todo

    def delete(self, token: str, todo_id: int) -> None:
        self._owned(token, todo_id)
        del self.todos[todo_id]
'''


TESTS_BACKEND = '''import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from todo_api import TodoService  # noqa: E402


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.svc = TodoService()
        self.svc.register("alice", "correct-horse")

    def test_password_not_stored_in_plaintext(self):
        stored = self.svc.users["alice"]
        self.assertNotEqual(stored, "correct-horse")
        self.assertNotIn(b"correct-horse", getattr(stored, "password_hash", b""))

    def test_login_success_and_failure(self):
        self.assertTrue(self.svc.login("alice", "correct-horse"))
        with self.assertRaises(PermissionError):
            self.svc.login("alice", "wrong-password")

    def test_weak_password_rejected(self):
        with self.assertRaises(ValueError):
            self.svc.register("bob", "123")


class TodoTests(unittest.TestCase):
    def setUp(self):
        self.svc = TodoService()
        self.svc.register("alice", "correct-horse")
        self.svc.register("mallory", "evil-password")
        self.alice = self.svc.login("alice", "correct-horse")
        self.mallory = self.svc.login("mallory", "evil-password")

    def test_create_and_list(self):
        self.svc.create(self.alice, "Write report", due="2026-10-01")
        self.assertEqual([t.title for t in self.svc.list(self.alice)], ["Write report"])

    def test_empty_title_rejected(self):
        with self.assertRaises(ValueError):
            self.svc.create(self.alice, "   ")

    def test_users_are_isolated(self):
        todo = self.svc.create(self.alice, "Private")
        self.assertEqual(self.svc.list(self.mallory), [])
        with self.assertRaises(KeyError):
            self.svc.delete(self.mallory, todo.id)

    def test_complete_and_delete(self):
        todo = self.svc.create(self.alice, "Ship MVP")
        self.assertTrue(self.svc.complete(self.alice, todo.id).done)
        self.svc.delete(self.alice, todo.id)
        self.assertEqual(self.svc.list(self.alice), [])


if __name__ == "__main__":
    unittest.main()
'''


TESTS_FRONTEND = '''import os
import unittest
from html.parser import HTMLParser

INDEX = os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html")


class _Collector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.labels = set(), 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        if "aria-label" in a or tag == "label":
            self.labels += 1


class FrontendStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(INDEX, encoding="utf-8") as f:
            cls.html = f.read()
        cls.c = _Collector()
        cls.c.feed(cls.html)

    def test_core_elements_present(self):
        for el in ("todo-form", "todo-input", "todo-list", "theme-toggle"):
            self.assertIn(el, self.c.ids)

    def test_accessibility_labels(self):
        self.assertGreaterEqual(self.c.labels, 3)

    def test_no_inline_eval(self):
        self.assertNotIn("eval(", self.html)
        self.assertNotIn("innerHTML =", self.html)


if __name__ == "__main__":
    unittest.main()
'''


STYLE_GUIDE = """# Style Guide: Todo App

## Palette
| Token | Light | Dark |
|-------|-------|------|
| background | `#f8fafc` | `#0b1020` |
| surface | `#ffffff` | `#141a2e` |
| text | `#0f172a` | `#e2e8f0` |
| accent | `#6366f1` | `#818cf8` |
| danger | `#dc2626` | `#f87171` |

## Typography
Inter / system-ui; base 16px; headings 600 weight; line-height 1.5.

## Spacing
4px scale: 4, 8, 12, 16, 24, 32.

## Components
- **Input + Add button** in a single row, 44px min height (touch target).
- **Todo row**: checkbox, title (strike-through when done), delete icon button with `aria-label`.
- **Empty state**: "Nothing to do. Enjoy your day ✨".

## Accessibility
All controls keyboard reachable; visible focus ring `2px solid accent`; contrast ≥ 4.5:1.
"""


FRONTEND_HTML = """<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Todo MVP</title>
  <style>
    :root { --bg:#f8fafc; --surface:#ffffff; --text:#0f172a; --muted:#64748b; --accent:#6366f1; --danger:#dc2626; }
    [data-theme="dark"] { --bg:#0b1020; --surface:#141a2e; --text:#e2e8f0; --muted:#94a3b8; --accent:#818cf8; --danger:#f87171; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, system-ui, sans-serif; background:var(--bg); color:var(--text); line-height:1.5; }
    main { max-width: 560px; margin: 48px auto; padding: 24px; background: var(--surface); border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.15); }
    header { display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px; }
    h1 { font-size: 24px; margin: 0; }
    form { display:flex; gap:8px; margin-bottom: 16px; }
    input[type=text], input[type=date] { flex:1; min-height:44px; padding: 0 12px; border-radius: 10px; border:1px solid var(--muted); background:transparent; color:var(--text); font-size:16px; }
    button { min-height:44px; padding: 0 16px; border-radius:10px; border:none; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
    button.ghost { background: transparent; color: var(--muted); border:1px solid var(--muted); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    ul { list-style:none; padding:0; margin:0; }
    li { display:flex; align-items:center; gap:12px; padding: 10px 4px; border-bottom: 1px solid rgba(148,163,184,.2); }
    li.done .title { text-decoration: line-through; color: var(--muted); }
    .title { flex:1; }
    .due { font-size: 12px; color: var(--muted); }
    .delete { background: transparent; color: var(--danger); padding: 0 10px; }
    .empty { text-align:center; color: var(--muted); padding: 24px 0; }
    .stats { margin-top: 12px; font-size: 13px; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>My Todos</h1>
      <button id="theme-toggle" class="ghost" aria-label="Toggle dark mode">Theme</button>
    </header>
    <form id="todo-form" aria-label="Add a todo">
      <label for="todo-input" hidden>New todo</label>
      <input id="todo-input" type="text" placeholder="What needs doing?" maxlength="200" required aria-label="Todo title" />
      <input id="todo-due" type="date" aria-label="Due date" />
      <button type="submit">Add</button>
    </form>
    <ul id="todo-list" aria-live="polite"></ul>
    <p class="stats" id="stats"></p>
  </main>
  <script>
    const KEY = "todo-mvp";
    const state = JSON.parse(localStorage.getItem(KEY) || '{"todos":[],"theme":"dark"}');
    const $ = (id) => document.getElementById(id);
    document.documentElement.dataset.theme = state.theme;

    function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

    function render() {
      const list = $("todo-list");
      list.replaceChildren();
      if (state.todos.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "Nothing to do. Enjoy your day \u2728";
        list.append(li);
      }
      for (const t of state.todos) {
        const li = document.createElement("li");
        if (t.done) li.classList.add("done");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = t.done; cb.setAttribute("aria-label", "Mark " + t.title + " done");
        cb.addEventListener("change", () => { t.done = cb.checked; save(); render(); });
        const title = document.createElement("span");
        title.className = "title"; title.textContent = t.title;
        const due = document.createElement("span");
        due.className = "due"; due.textContent = t.due ? "due " + t.due : "";
        const del = document.createElement("button");
        del.className = "delete"; del.textContent = "\u2715"; del.setAttribute("aria-label", "Delete " + t.title);
        del.addEventListener("click", () => { state.todos = state.todos.filter((x) => x.id !== t.id); save(); render(); });
        li.append(cb, title, due, del);
        list.append(li);
      }
      const open = state.todos.filter((t) => !t.done).length;
      $("stats").textContent = open + " open \u00b7 " + (state.todos.length - open) + " done";
    }

    $("todo-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const title = $("todo-input").value.trim();
      if (!title) return;
      state.todos.push({ id: Date.now(), title, done: false, due: $("todo-due").value || null });
      $("todo-input").value = ""; $("todo-due").value = "";
      save(); render();
    });
    $("theme-toggle").addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = state.theme; save();
    });
    render();
  </script>
</body>
</html>
"""


DOCKERFILE = """FROM python:3.11-slim
WORKDIR /app
RUN useradd --create-home app
COPY backend/ backend/
COPY frontend/ frontend/
COPY tests/ tests/
USER app
# Run the test-suite at build time so broken builds never ship
RUN python -m unittest discover -s tests -v
EXPOSE 8000
CMD ["python", "-m", "http.server", "8000", "--directory", "frontend"]
"""


def readme(goal: str) -> str:
    return f"""# Todo App MVP

Built by the Octopus virtual company for the goal: *{goal}*.

## Structure
```
backend/todo_api.py     # TodoService: auth (PBKDF2) + per-user todos
frontend/index.html     # Single-page UI with dark mode
tests/                  # unittest suite (service + static UI checks)
docs/CHANGES.md         # changelog of follow-up requests
```

The team's working documents (PRD, architecture, style guide) are in `.octopus/work/`.

## Run tests
```bash
python -m unittest discover -s tests -v
```

## Run the UI
```bash
python -m http.server 8000 --directory frontend
# open http://localhost:8000
```

## Docker
```bash
docker build -t todo-mvp . && docker run -p 8000:8000 todo-mvp
```
"""


DECISION = """# Moderator Decision

**Ruling:** Adopt the revised proposal with a phased rollout.

**Decisive arguments**
1. The compromise keeps the core value while addressing the Critic's primary risk.
2. A phased rollout creates a measurable checkpoint before committing further resources.

**Conditions**
- Define success metrics before phase 1 starts.
- Re-evaluate after phase 1 with real data.
"""
