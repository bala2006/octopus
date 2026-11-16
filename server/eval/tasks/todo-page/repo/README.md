# Todo page

A single page that keeps a list of todos. Put it in `index.html`, with the script in `app.js` and the styles in `style.css`.

## Behavior

- Typing a title in `#todo-input` and pressing Enter or clicking `#add-todo` adds a todo. Empty titles are ignored.
- Each todo is an `li` in `#todo-list`, with a checkbox `input.toggle` and a `button.delete`.
- Checking the box marks the todo done. Deleting removes it.
- Three filter buttons, `button[data-filter="all"]`, `button[data-filter="active"]` and `button[data-filter="done"]`, show the matching todos.
- Todos are kept in `localStorage`, so they survive a reload.
