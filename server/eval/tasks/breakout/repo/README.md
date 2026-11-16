# Breakout

A breakout game on one `<canvas id="game">` in `index.html`, with the logic in `game.js`.

## Behavior

- Space starts the game from the ready state, and Space pauses and resumes it.
- The ball bounces off the walls, the paddle and the bricks. A brick it hits disappears and adds to the score.
- Losing the ball three times ends the game. Enter restarts from the ready state.

## Contract for the grader

`window.game.state()` returns `{ status, score, lives }`, where `status` is `"ready"`, `"playing"`, `"paused"` or `"over"`.
