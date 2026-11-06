"""Action handlers for the orchestration runtime, one module per action family.

Each handler is a plain async function whose first argument is the RunRuntime. RunRuntime dispatches to them
through ACTION_HANDLERS in engine.py.
"""
