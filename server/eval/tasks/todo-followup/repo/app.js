const KEY = "todos";
let todos = JSON.parse(localStorage.getItem(KEY) ?? "[]");
let filter = "all";

const list = document.querySelector("#todo-list");
const input = document.querySelector("#todo-input");

function save() {
  localStorage.setItem(KEY, JSON.stringify(todos));
}

function render() {
  list.innerHTML = "";
  for (const todo of todos) {
    if (filter === "active" && todo.done) continue;
    if (filter === "done" && !todo.done) continue;
    const item = document.createElement("li");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "toggle";
    box.checked = todo.done;
    box.addEventListener("change", () => {
      todo.done = box.checked;
      save();
      render();
    });
    const text = document.createElement("span");
    text.textContent = todo.title;
    const remove = document.createElement("button");
    remove.className = "delete";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      todos = todos.filter((t) => t !== todo);
      save();
      render();
    });
    item.append(box, text, remove);
    list.append(item);
  }
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.classList.toggle("selected", button.dataset.filter === filter);
  }
}

document.querySelector("#todo-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  todos.push({ title, done: false });
  input.value = "";
  save();
  render();
});

for (const button of document.querySelectorAll("[data-filter]")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    render();
  });
}

render();
